/* The realtime relay: ticket auth, the room logic it borrows from src/, and
   a full ranked match played over two WebSockets with settlement stubbed. */
const path = require('path');
const { createRelay } = require('../relay/server');
const { mint } = require('../relay/lib/ticket');
const { testAsync: t, assert, eq, section, note, finish } = require('./lib/report');

const SECRET = 'test-secret-value';

function player(id, name, over) {
  return Object.assign({
    id: id, name: name, tr: 12500, rank: 'Z',
    glicko: 1500, rd: 350, vol: 0.06, games: 0
  }, over || {});
}

/** Minimal client: request/response over a socket, same shape as the app's. */
function connect(port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port);
  let seq = 0;
  const waiting = new Map();
  const closed = { code: null };

  ws.addEventListener('message', ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    const pending = waiting.get(msg.i);
    if (!pending) return;
    waiting.delete(msg.i);
    if (msg.ok) pending.resolve(msg.d);
    else pending.reject(new Error(msg.e));
  });
  ws.addEventListener('close', ev => { closed.code = ev.code; });

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('connection failed')));
  });

  return {
    ready,
    closed,
    call(method, payload) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        ws.send(JSON.stringify({ i: id, m: method, p: payload || {} }));
        setTimeout(() => {
          if (waiting.has(id)) { waiting.delete(id); reject(new Error('timed out: ' + method)); }
        }, 5000);
      });
    },
    close() { ws.close(); },
    raw: ws
  };
}

function baseState(over) {
  return Object.assign({
    ready: false, epoch: 1, round: 0, alive: true,
    b: '0'.repeat(200), p: null, h: null, g: 0, atk: [],
    stats: { apm: 0, pps: 0, vs: 0, lines: 0, pieces: 0, attack: 0 }
  }, over || {});
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // Settlement is stubbed: this suite is about the relay, and Match_settle
  // itself is covered by the server suite.
  const settleCalls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    body.payload = JSON.parse(body.payloadJson);
    settleCalls.push(body);
    return {
      json: async () => ({
        ok: true,
        data: {
          ranked: body.payload.mode === 'ranked',
          scores: {},
          delta: body.payload.players.reduce((acc, p, i) => {
            acc[p.id] = { trBefore: 12500, trAfter: i === 0 ? 15750 : 9250, rank: 'Z', games: 1 };
            return acc;
          }, {})
        }
      })
    };
  };

  const relay = createRelay({
    secret: SECRET,
    settleUrl: 'https://example.invalid/exec',
    fetchImpl: fetchImpl,
    log: () => {}
  });
  const port = await relay.listen(0);

  section('tickets');

  await t('a valid ticket is accepted', async () => {
    const c = connect(port);
    await c.ready;
    const hello = await c.call('hello', { ticket: mint(player('p_a', 'Alpha'), SECRET) });
    eq(hello.you.id, 'p_a', 'identified');
    eq(hello.you.name, 'Alpha', 'name carried in the ticket');
    c.close();
  });

  await t('a ticket signed with the wrong secret is refused', async () => {
    const c = connect(port);
    await c.ready;
    let error = null;
    try { await c.call('hello', { ticket: mint(player('p_x', 'Mallory'), 'other-secret') }); }
    catch (e) { error = e.message; }
    assert(/signature/.test(error || ''), 'expected a signature failure, got ' + error);
    c.close();
  });

  await t('an expired ticket is refused', async () => {
    const c = connect(port);
    await c.ready;
    let error = null;
    try { await c.call('hello', { ticket: mint(player('p_y', 'Late'), SECRET, -60) }); }
    catch (e) { error = e.message; }
    assert(/expired/.test(error || ''), 'expected an expiry failure, got ' + error);
    c.close();
  });

  await t('nothing works before hello', async () => {
    const c = connect(port);
    await c.ready;
    let error = null;
    try { await c.call('roomCreate', { config: {} }); } catch (e) { error = e.message; }
    assert(/hello/.test(error || ''), 'expected a hello requirement, got ' + error);
    c.close();
  });

  section('identity cannot be claimed by the client');

  await t('a spoofed id in the payload is ignored', async () => {
    const a = connect(port); await a.ready;
    await a.call('hello', { ticket: mint(player('p_real', 'Real'), SECRET) });
    // Claim to be somebody else while creating a room.
    const res = await a.call('roomCreate', { id: 'p_someone_else', config: {} });
    eq(res.room.players[0].id, 'p_real', 'the socket ticket wins over the payload');
    eq(res.room.host, 'p_real', 'host is the real player');
    await a.call('roomLeave', { code: res.room.code });
    a.close();
  });

  section('a match over two sockets');

  let matchRoom = null;

  await t('two players meet in a room and start', async () => {
    const a = connect(port); await a.ready;
    const b = connect(port); await b.ready;
    await a.call('hello', { ticket: mint(player('p_1', 'One'), SECRET) });
    await b.call('hello', { ticket: mint(player('p_2', 'Two'), SECRET) });

    const created = await a.call('roomCreate', { config: { maxPlayers: 2, ft: 1 } });
    matchRoom = { code: created.room.code, a, b };
    const joined = await b.call('roomJoin', { code: matchRoom.code });
    eq(joined.role, 'player', 'second seat taken');

    await a.call('sync', { code: matchRoom.code, state: baseState({ ready: true }) });
    const r = await b.call('sync', { code: matchRoom.code, state: baseState({ ready: true }) });
    eq(r.room.state, 'countdown', 'both ready starts the countdown');
    assert(r.room.seed > 0, 'a seed was issued');
  });

  await t('the countdown gives way to play, then a top-out ends it', async () => {
    const { code, a, b } = matchRoom;
    // The countdown is real time; wait it out rather than faking the clock.
    await sleep(relay.runtime.sandbox.ROOMS.COUNTDOWN_MS + 150);
    let r = await a.call('sync', { code, state: baseState({ ready: true, round: 1 }) });
    eq(r.room.state, 'playing', 'match is live');

    await a.call('sync', { code, state: baseState({ ready: true, round: 1 }) });
    r = await b.call('sync', {
      code,
      state: baseState({ ready: true, round: 1, alive: false, killer: 'p_1' })
    });
    eq(r.room.state, 'matchover', 'first to 1 ends the match');
    eq(r.room.matchWinner, 'p_1', 'survivor wins');
    eq(r.room.players.filter(p => p.id === 'p_1')[0].ko, 1, 'knockout credited');
  });

  await t('the result is reported to Apps Script and patched back in', async () => {
    const { code, a } = matchRoom;
    eq(settleCalls.length, 1, 'exactly one settlement request');
    const request = settleCalls[0].payload;
    eq(request.code, code, 'room code');
    eq(request.winner, 'p_1', 'winner');
    eq(request.players.length, 2, 'both players reported');
    assert(settleCalls[0].sig && settleCalls[0].sig.length > 20, 'request was signed');

    // The state machine cannot block on the network, so the first answer is
    // a placeholder that the real numbers replace a moment later.
    await sleep(120);
    const r = await a.call('sync', { code, state: baseState() });
    eq(r.room.results.pending, false, 'results settled');
    eq(r.room.results.delta.p_1.trAfter, 15750, 'winner TR came back from Apps Script');
    eq(r.room.results.delta.p_2.trAfter, 9250, 'loser TR came back');
    matchRoom.a.close();
    matchRoom.b.close();
  });

  section('matchmaking and spectating');

  await t('two queued players are paired', async () => {
    const a = connect(port); await a.ready;
    const b = connect(port); await b.ready;
    await a.call('hello', { ticket: mint(player('p_q1', 'Q1'), SECRET) });
    await b.call('hello', { ticket: mint(player('p_q2', 'Q2'), SECRET) });

    const first = await a.call('queueJoin', {});
    eq(first.matched, false, 'first player waits');
    const second = await b.call('queueJoin', {});
    eq(second.matched, true, 'second player pairs immediately');
    eq(second.room.mode, 'ranked', 'ranked room');
    const poll = await a.call('queuePoll', {});
    eq(poll.matched, true, 'first player picks it up');
    eq(poll.room.code, second.room.code, 'same room');

    await a.call('roomLeave', { code: poll.room.code });
    await b.call('roomLeave', { code: poll.room.code });
    a.close(); b.close();
  });

  await t('a spectator watches without holding a seat', async () => {
    const a = connect(port); await a.ready;
    const w = connect(port); await w.ready;
    await a.call('hello', { ticket: mint(player('p_h', 'Host'), SECRET) });
    await w.call('hello', { ticket: mint(player('p_w', 'Watcher'), SECRET) });

    const room = (await a.call('roomCreate', { config: { maxPlayers: 2 } })).room;
    const joined = await w.call('roomJoin', { code: room.code, spectate: true });
    eq(joined.role, 'spectator', 'on the bench');

    await a.call('chatSend', { code: room.code, text: 'hello relay' });
    const view = await w.call('sync', { code: room.code, state: baseState() });
    eq(view.role, 'spectator', 'reported as spectator');
    eq(view.chat.length, 1, 'chat delivered');
    eq(view.chat[0].text, 'hello relay', 'chat text');
    eq(view.room.spectators.length, 1, 'listed on the bench');

    await w.call('roomLeave', { code: room.code });
    await a.call('roomLeave', { code: room.code });
    a.close(); w.close();
  });

  section('connection handling');

  await t('a reconnect replaces the old socket instead of ghosting a seat', async () => {
    const first = connect(port); await first.ready;
    await first.call('hello', { ticket: mint(player('p_dup', 'Dup'), SECRET) });
    const second = connect(port); await second.ready;
    await second.call('hello', { ticket: mint(player('p_dup', 'Dup'), SECRET) });
    await sleep(120);
    eq(first.closed.code, 4000, 'the earlier socket was closed');
    eq(relay.sockets.size, 1, 'one socket per player');
    second.close();
    await sleep(60);
  });

  await t('leaving a lobby on disconnect frees the seat', async () => {
    const host = connect(port); await host.ready;
    const guest = connect(port); await guest.ready;
    await host.call('hello', { ticket: mint(player('p_lh', 'LobbyHost'), SECRET) });
    await guest.call('hello', { ticket: mint(player('p_lg', 'LobbyGuest'), SECRET) });

    const room = (await host.call('roomCreate', { config: { maxPlayers: 2 } })).room;
    await guest.call('roomJoin', { code: room.code });
    guest.close();
    await sleep(200);

    const after = await host.call('sync', { code: room.code, state: baseState() });
    eq(after.room.players.length, 1, 'seat released on a lobby disconnect');
    host.close();
  });

  await t('the health endpoint answers', async () => {
    const res = await fetch('http://127.0.0.1:' + port + '/health');
    const body = await res.json();
    eq(body.ok, true, 'healthy');
    eq(body.settle, 'configured', 'settlement target reported');
    note('connections at end: ' + body.connections);
  });

  await relay.close();
  process.exit(finish() ? 0 : 1);
})();
