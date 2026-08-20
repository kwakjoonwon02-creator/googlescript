/* Accounts, matchmaking, the room state machine and rating settlement,
   driven through the same rpc() surface the client uses. */
const { makeGasSandbox: makeSandbox } = require('./lib/gas-sandbox');
const { test: t, assert, eq, section, note, finish } = require('./lib/report');

function ok(res) {
  if (!res.ok) throw new Error('rpc failed: ' + res.error);
  return res.data;
}

function newPlayer(s, name) {
  const d = ok(s.rpc('bootstrap', { name }));
  return { id: d.credentials.id, token: d.credentials.token, name: d.profile.name, profile: d.profile };
}

function baseState(over) {
  return Object.assign({
    ready: false, round: 0, alive: true, b: '0'.repeat(200), p: null, h: null, g: 0,
    atk: [], stats: { apm: 0, pps: 0, vs: 0, lines: 0, pieces: 0, attack: 0 }
  }, over || {});
}

// Mirrors the real client: it echoes back the readyEpoch from the last room
// snapshot it saw, so a "ready" published before a match ended stays stale.
const seenEpoch = new Map();
function sync(s, pl, code, state) {
  const key = pl.id + ':' + code;
  const payload = baseState(state);
  if (payload.epoch === undefined) payload.epoch = seenEpoch.get(key) || 1;
  const res = ok(s.rpc('sync', { id: pl.id, token: pl.token, code, state: payload }));
  if (res.room) seenEpoch.set(key, Number(res.room.readyEpoch || 1));
  return res;
}

section('accounts');
t('bootstrap issues distinct credentials', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo');
  assert(a.id !== b.id, 'ids collide');
  assert(a.token !== b.token, 'tokens collide');
  eq(a.profile.tr, 12500, 'starting TR');
  eq(a.profile.rank, 'Z', 'starts unranked');
});

t('an existing session is restored, not duplicated', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  const again = ok(s.rpc('bootstrap', { id: a.id, token: a.token }));
  eq(again.credentials.id, a.id, 'same id');
  eq(again.profile.name, 'Alpha', 'same name');
});

t('a bad token is rejected', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  const res = s.rpc('profile', { id: a.id, token: 'forged' });
  eq(res.ok, false, 'should reject');
  assert(/token/i.test(res.error), 'unexpected error: ' + res.error);
});

t('invalid and duplicate names are rejected', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  const b = newPlayer(s, 'Bravo');
  eq(s.rpc('setName', { id: a.id, token: a.token, name: 'x' }).ok, false, 'too short');
  eq(s.rpc('setName', { id: a.id, token: a.token, name: 'has space' }).ok, false, 'space');
  eq(s.rpc('setName', { id: a.id, token: a.token, name: 'Bravo' }).ok, false, 'duplicate');
  eq(s.rpc('setName', { id: a.id, token: a.token, name: '한글닉네임' }).ok, true, 'hangul allowed');
});

section('matchmaking');
t('two queued players are paired into one ranked room', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo');
  const ra = ok(s.rpc('queueJoin', { id: a.id, token: a.token }));
  eq(ra.matched, false, 'first player waits');
  const rb = ok(s.rpc('queueJoin', { id: b.id, token: b.token }));
  eq(rb.matched, true, 'second player pairs immediately');
  eq(rb.room.mode, 'ranked', 'ranked room');
  eq(rb.room.config.ft, 3, 'first to 3');
  eq(rb.room.players.length, 2, 'two seats');
  const ra2 = ok(s.rpc('queuePoll', { id: a.id, token: a.token }));
  eq(ra2.matched, true, 'first player picks the match up on poll');
  eq(ra2.room.code, rb.room.code, 'same room for both');
});

t('the rating band widens the longer you wait', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  const first = ok(s.rpc('queueJoin', { id: a.id, token: a.token }));
  s.__clock.advance(6000);
  const later = ok(s.rpc('queuePoll', { id: a.id, token: a.token }));
  assert(later.band > first.band, 'band did not widen: ' + first.band + ' -> ' + later.band);
});

t('leaving the queue removes the entry', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo');
  ok(s.rpc('queueJoin', { id: a.id, token: a.token }));
  ok(s.rpc('queueLeave', { id: a.id, token: a.token }));
  const rb = ok(s.rpc('queueJoin', { id: b.id, token: b.token }));
  eq(rb.matched, false, 'should not match a player who left');
});

section('room state machine');
function pairUp(s) {
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo');
  ok(s.rpc('queueJoin', { id: a.id, token: a.token }));
  const r = ok(s.rpc('queueJoin', { id: b.id, token: b.token }));
  ok(s.rpc('queuePoll', { id: a.id, token: a.token }));
  return { a, b, code: r.room.code };
}

t('both players ready starts the countdown', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  let r = sync(s, a, code, { ready: true });
  eq(r.room.state, 'lobby', 'one player ready is not enough');
  r = sync(s, b, code, { ready: true });
  eq(r.room.state, 'countdown', 'both ready starts countdown');
  eq(r.room.round, 1, 'round 1');
  assert(r.room.seed > 0, 'a seed was issued');
  assert(r.room.startAt > r.serverTime, 'startAt is in the future');
});

t('the countdown becomes play once startAt passes', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  sync(s, a, code, { ready: true });
  let r = sync(s, b, code, { ready: true });
  s.__clock.set(r.room.startAt + 10);
  r = sync(s, a, code, { ready: true, round: 1 });
  eq(r.room.state, 'playing', 'should be playing');
});

t('both clients get the same seed', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  sync(s, a, code, { ready: true });
  const rb = sync(s, b, code, { ready: true });
  const ra = sync(s, a, code, { ready: true });
  eq(ra.room.seed, rb.room.seed, 'seeds differ');
});

t('a top-out ends the round and awards it to the survivor', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  sync(s, a, code, { ready: true });
  let r = sync(s, b, code, { ready: true });
  s.__clock.set(r.room.startAt + 10);
  sync(s, a, code, { ready: true, round: 1 });

  r = sync(s, b, code, { ready: true, round: 1, alive: false });
  eq(r.room.state, 'roundover', 'round should end');
  eq(r.room.roundWinner, a.id, 'survivor wins');
  eq(r.room.players.filter(p => p.id === a.id)[0].wins, 1, 'win recorded');
});

t('a new round starts after the interlude with a fresh seed', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  sync(s, a, code, { ready: true });
  let r = sync(s, b, code, { ready: true });
  const seed1 = r.room.seed;
  s.__clock.set(r.room.startAt + 10);
  sync(s, a, code, { ready: true, round: 1 });
  r = sync(s, b, code, { ready: true, round: 1, alive: false });
  s.__clock.set(r.room.nextRoundAt + 10);
  r = sync(s, a, code, { ready: true, round: 1 });
  eq(r.room.state, 'countdown', 'next countdown');
  eq(r.room.round, 2, 'round 2');
  assert(r.room.seed !== seed1, 'seed was not regenerated');
});

t('a disconnected player is treated as dead after the timeout', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  sync(s, a, code, { ready: true });
  let r = sync(s, b, code, { ready: true });
  s.__clock.set(r.room.startAt + 10);
  sync(s, a, code, { ready: true, round: 1 });
  sync(s, b, code, { ready: true, round: 1 });
  // B goes silent; A keeps playing.
  s.__clock.advance(10000);
  r = sync(s, a, code, { ready: true, round: 1 });
  eq(r.room.state, 'roundover', 'silence should end the round');
  eq(r.room.roundWinner, a.id, 'the connected player wins');
});

section('attacks over the wire');
t('attack events are relayed verbatim to the opponent', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  sync(s, a, code, { ready: true });
  let r = sync(s, b, code, { ready: true });
  s.__clock.set(r.room.startAt + 10);
  sync(s, a, code, { ready: true, round: 1, atk: [{ i: 1, n: 4, t: 1, to: b.id }] });
  r = sync(s, b, code, { ready: true, round: 1 });
  const from = r.others.filter(o => o.id === a.id)[0];
  eq(from.state.atk.length, 1, 'one attack relayed');
  eq(from.state.atk[0].n, 4, 'amount preserved');
  eq(from.state.atk[0].to, b.id, 'target preserved');
});

t('the attack log is capped so a stuck client cannot bloat the cache', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  const many = [];
  for (let i = 1; i <= 60; i++) many.push({ i, n: 1, t: i, to: b.id });
  sync(s, a, code, { ready: false, atk: many });
  const r = sync(s, b, code, {});
  const from = r.others.filter(o => o.id === a.id)[0];
  assert(from.state.atk.length <= 24, 'log not trimmed: ' + from.state.atk.length);
  eq(from.state.atk[from.state.atk.length - 1].i, 60, 'kept the newest entries');
});

section('full ranked match');
function playMatch(s, winner, loser, code, winnerRounds, loserRounds) {
  const order = [];
  for (let i = 0; i < winnerRounds; i++) order.push('w');
  for (let i = 0; i < loserRounds; i++) order.splice(Math.min(order.length, i * 2 + 1), 0, 'l');
  let r = null;
  let round = 0;
  for (const outcome of order) {
    round++;
    sync(s, winner, code, { ready: true, round });
    r = sync(s, loser, code, { ready: true, round });
    if (r.room.state === 'countdown') {
      s.__clock.set(r.room.startAt + 10);
      sync(s, winner, code, { ready: true, round });
      r = sync(s, loser, code, { ready: true, round });
    }
    if (r.room.state !== 'playing') throw new Error('round ' + round + ' did not start (state=' + r.room.state + ')');
    const dying = outcome === 'w' ? loser : winner;
    const living = outcome === 'w' ? winner : loser;
    sync(s, living, code, { ready: true, round, stats: { apm: 60, pps: 2.1, vs: 90, lines: 40, pieces: 120, attack: 40 } });
    r = sync(s, dying, code, { ready: true, round, alive: false, stats: { apm: 40, pps: 1.8, vs: 70, lines: 30, pieces: 100, attack: 25 } });
    if (r.room.state === 'roundover') {
      s.__clock.set(r.room.nextRoundAt + 10);
      sync(s, winner, code, { ready: true, round });
      r = sync(s, loser, code, { ready: true, round });
    }
  }
  return r;
}

t('an FT3 match ends and settles both ratings', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  const r = playMatch(s, a, b, code, 3, 1);
  eq(r.room.state, 'matchover', 'match should be over');
  eq(r.room.matchWinner, a.id, 'winner');

  const pa = ok(s.rpc('profile', { id: a.id, token: a.token })).profile;
  const pb = ok(s.rpc('profile', { id: b.id, token: b.token })).profile;
  note('winner ' + pa.tr + ' TR (glicko ' + pa.glicko + '), loser ' + pb.tr + ' TR (glicko ' + pb.glicko + ')');
  assert(pa.tr > 12500, 'winner TR did not rise: ' + pa.tr);
  assert(pb.tr < 12500, 'loser TR did not fall: ' + pb.tr);
  eq(pa.games, 1, 'winner game count');
  eq(pa.wins, 1, 'winner wins');
  eq(pb.losses, 1, 'loser losses');
  eq(pa.roundsWon, 3, 'rounds won');
  eq(pa.roundsLost, 1, 'rounds lost');
  assert(pa.apm > 0, 'winner APM not recorded');
});

t('the match is written to history exactly once', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  playMatch(s, a, b, code, 3, 0);
  // Extra syncs after the match must not re-settle it.
  sync(s, a, code, { ready: false });
  sync(s, b, code, { ready: false });
  const hist = ok(s.rpc('profile', { id: a.id, token: a.token })).history;
  eq(hist.length, 1, 'exactly one match row');
  eq(hist[0].won, true, 'recorded as a win');
  eq(hist[0].score, '3-0', 'score');
  assert(hist[0].trDelta > 0, 'TR delta not positive: ' + hist[0].trDelta);
  const profile = ok(s.rpc('profile', { id: a.id, token: a.token })).profile;
  eq(profile.games, 1, 'settled only once');
});

t('a finished match never restarts before both players see the result', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  let r = playMatch(s, a, b, code, 3, 0);
  eq(r.room.state, 'matchover');
  // Both clients are still publishing the "ready" they set before the match
  // ended. Those must not count for the next one.
  r = sync(s, a, code, { ready: true, epoch: 1 });
  eq(r.room.state, 'matchover', 'stale ready restarted the match');
  r = sync(s, b, code, { ready: true, epoch: 1 });
  eq(r.room.state, 'matchover', 'stale ready restarted the match');
});

t('a rematch runs once both ready up against the new epoch', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  let r = playMatch(s, a, b, code, 3, 0);
  eq(r.room.state, 'matchover');
  const epoch = r.room.readyEpoch;
  sync(s, a, code, { ready: true, epoch });
  r = sync(s, b, code, { ready: true, epoch });
  eq(r.room.state, 'countdown', 'rematch did not start');
  eq(r.room.round, 1, 'round counter reset');
  eq(r.room.players[0].wins, 0, 'scores reset');
  eq(r.room.matchWinner, null, 'previous winner cleared');
});

section('custom rooms');
t('create and join by code', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo');
  const room = ok(s.rpc('roomCreate', { id: a.id, token: a.token, config: { ft: 5, maxPlayers: 2 } })).room;
  eq(room.config.ft, 5, 'ft honoured');
  const joined = ok(s.rpc('roomJoin', { id: b.id, token: b.token, code: room.code }));
  eq(joined.role, 'player', 'second player gets a seat');
  eq(joined.room.players.length, 2, 'two seats');
});

t('a full room seats the next arrival as a spectator instead of refusing', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo'), c = newPlayer(s, 'Charlie');
  const room = ok(s.rpc('roomCreate', { id: a.id, token: a.token, config: { maxPlayers: 2 } })).room;
  ok(s.rpc('roomJoin', { id: b.id, token: b.token, code: room.code }));
  const third = ok(s.rpc('roomJoin', { id: c.id, token: c.token, code: room.code }));
  eq(third.role, 'spectator', 'third player should land on the bench');
  eq(third.reason, 'full', 'reason reported');
  eq(third.room.players.length, 2, 'seats unchanged');
  eq(third.room.spectators.length, 1, 'one spectator');
});

t('public rooms are listed, private ones are not', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo');
  const open = ok(s.rpc('roomCreate', { id: a.id, token: a.token, config: {} })).room;
  const hidden = ok(s.rpc('roomCreate', { id: b.id, token: b.token, config: { isPrivate: true } })).room;
  const list = ok(s.rpc('roomList', { id: a.id, token: a.token })).rooms.map(r => r.code);
  assert(list.indexOf(open.code) !== -1, 'public room missing from the list');
  eq(list.indexOf(hidden.code), -1, 'private room should be hidden');
});

t('only the host can change the rules', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo');
  const room = ok(s.rpc('roomCreate', { id: a.id, token: a.token, config: {} })).room;
  ok(s.rpc('roomJoin', { id: b.id, token: b.token, code: room.code }));
  eq(s.rpc('roomConfig', { id: b.id, token: b.token, code: room.code, config: { ft: 9 } }).ok, false, 'guest changed rules');
  const updated = ok(s.rpc('roomConfig', { id: a.id, token: a.token, code: room.code, config: { ft: 7 } })).room;
  eq(updated.config.ft, 7, 'host change did not apply');
});

t('leaving mid-match sends the room back to the lobby', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  sync(s, a, code, { ready: true });
  let r = sync(s, b, code, { ready: true });
  s.__clock.set(r.room.startAt + 10);
  sync(s, a, code, { ready: true, round: 1 });
  ok(s.rpc('roomLeave', { id: b.id, token: b.token, code }));
  r = sync(s, a, code, { ready: false, round: 1 });
  eq(r.room.state, 'lobby', 'should reset to lobby');
  eq(r.room.players.length, 1, 'one seat left');
});

t('syncing to a dead room reports ROOM_GONE', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  const res = s.rpc('sync', { id: a.id, token: a.token, code: 'ZZZZZ', state: baseState() });
  eq(res.ok, false, 'should fail');
  eq(res.error, 'ROOM_GONE', 'error code');
});

section('ranks & leaderboard');
t('players stay unranked until placements are done', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  playMatch(s, a, b, code, 3, 0);
  const pa = ok(s.rpc('profile', { id: a.id, token: a.token })).profile;
  eq(pa.rank, 'Z', 'ranked too early');
  eq(pa.placementsLeft, 9, 'placement countdown');
  const lb = ok(s.rpc('leaderboard', { id: a.id, token: a.token }));
  eq(lb.ranked.length, 0, 'unranked players should not be on the ladder');
});

t('percentile ranks kick in once the ladder is populated', () => {
  const s = makeSandbox();
  // Seed a ladder directly through the sheet, then re-derive the cutoffs.
  for (let i = 0; i < 40; i++) {
    const p = newPlayer(s, 'Ladder' + i);
    const rec = s.Players_get(p.id);
    rec.games = 15;
    rec.glicko = 1200 + i * 25;
    rec.rd = 60;
    rec.tr = s.Glicko_toTR(rec.glicko, rec.rd);
    s.Players_save(rec);
  }
  s.Leaderboard_invalidate();
  const info = s.Ranks_cutoffs(true);
  assert(info.cutoffs, 'cutoffs were not computed with 40 players');
  const top = s.Ranks_resolve(25000, 15);
  const bottom = s.Ranks_resolve(0, 15);
  note('top-of-ladder rank = ' + top + ', bottom = ' + bottom);
  eq(top, 'X+', 'best TR should be the top rank');
  eq(bottom, 'D', 'worst TR should be the bottom rank');
  const lb = s.Leaderboard_top(100, null);
  eq(lb.rankedPlayers, 40, 'ladder size');
  eq(lb.ranked[0].pos, 1, 'positions assigned');
  assert(lb.ranked[0].tr >= lb.ranked[39].tr, 'ladder not sorted');
});

t('solo runs record personal bests without touching TR', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  let res = ok(s.rpc('submitSolo', {
    id: a.id, token: a.token, mode: 'sprint', completed: true, timeMs: 62000,
    stats: { lines: 40, pieces: 100, apm: 50, pps: 2, vs: 80 }
  }));
  eq(res.improved, true, 'first run is a best');
  eq(res.profile.sprintBest, 62000, 'time stored');
  eq(res.profile.tr, 12500, 'TR must not move in solo');

  res = ok(s.rpc('submitSolo', {
    id: a.id, token: a.token, mode: 'sprint', completed: true, timeMs: 70000,
    stats: { lines: 40, pieces: 100 }
  }));
  eq(res.improved, false, 'slower run is not a best');
  eq(res.profile.sprintBest, 62000, 'best unchanged');

  res = ok(s.rpc('submitSolo', {
    id: a.id, token: a.token, mode: 'blitz', score: 45000,
    stats: { lines: 60, pieces: 200 }
  }));
  eq(res.profile.blitzBest, 45000, 'blitz best stored');
  eq(res.profile.totalLines, 140, 'lifetime lines accumulate');
});

section('spectating');

t('a spectator sees every board and never affects the match', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo'), watcher = newPlayer(s, 'Watcher');
  const room = ok(s.rpc('roomCreate', { id: a.id, token: a.token, config: { maxPlayers: 2 } })).room;
  ok(s.rpc('roomJoin', { id: b.id, token: b.token, code: room.code }));
  const joined = ok(s.rpc('roomJoin', { id: watcher.id, token: watcher.token, code: room.code, spectate: true }));
  eq(joined.role, 'spectator', 'asked to spectate');

  // Both players ready up. The spectator publishes no readiness at all, and
  // the match must still start.
  sync(s, a, room.code, { ready: true });
  let r = sync(s, b, room.code, { ready: true });
  eq(r.room.state, 'countdown', 'spectator must not block the start');

  const view = ok(s.rpc('sync', {
    id: watcher.id, token: watcher.token, code: room.code, state: baseState({ ready: true })
  }));
  eq(view.role, 'spectator', 'reported as spectator');
  eq(view.others.length, 2, 'a spectator sees both players');
  assert(view.others.some(o => o.name === 'Alpha'), 'Alpha missing');
  assert(view.others.some(o => o.name === 'Bravo'), 'Bravo missing');
  eq(view.room.players.length, 2, 'spectator is not a player');
});

t('a spectator that claims to be ready cannot start a match alone', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), watcher = newPlayer(s, 'Watcher');
  const room = ok(s.rpc('roomCreate', { id: a.id, token: a.token, config: { maxPlayers: 2 } })).room;
  ok(s.rpc('roomJoin', { id: watcher.id, token: watcher.token, code: room.code, spectate: true }));
  sync(s, a, room.code, { ready: true });
  const r = ok(s.rpc('sync', {
    id: watcher.id, token: watcher.token, code: room.code, state: baseState({ ready: true })
  }));
  eq(r.room.state, 'lobby', 'one player plus a spectator is not two players');
});

t('a spectator can take an open seat, and a player can move to the bench', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo');
  const room = ok(s.rpc('roomCreate', { id: a.id, token: a.token, config: { maxPlayers: 2 } })).room;
  let r = ok(s.rpc('roomJoin', { id: b.id, token: b.token, code: room.code, spectate: true }));
  eq(r.role, 'spectator');
  r = ok(s.rpc('roomJoin', { id: b.id, token: b.token, code: room.code }));
  eq(r.role, 'player', 'spectator should be able to sit down');
  eq(r.room.spectators.length, 0, 'bench cleared');
  r = ok(s.rpc('roomJoin', { id: b.id, token: b.token, code: room.code, spectate: true }));
  eq(r.role, 'spectator', 'player should be able to stand up');
  eq(r.room.players.length, 1, 'seat released');
});

t('a room with only spectators left is torn down when the last player leaves', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), watcher = newPlayer(s, 'Watcher');
  const room = ok(s.rpc('roomCreate', { id: a.id, token: a.token, config: {} })).room;
  ok(s.rpc('roomJoin', { id: watcher.id, token: watcher.token, code: room.code, spectate: true }));
  ok(s.rpc('roomLeave', { id: a.id, token: a.token, code: room.code }));
  // The room survives for the spectator rather than vanishing mid-view.
  const r = ok(s.rpc('sync', {
    id: watcher.id, token: watcher.token, code: room.code, state: baseState()
  }));
  eq(r.room.players.length, 0, 'no players left');
  ok(s.rpc('roomLeave', { id: watcher.id, token: watcher.token, code: room.code }));
  const gone = s.rpc('sync', {
    id: watcher.id, token: watcher.token, code: room.code, state: baseState()
  });
  eq(gone.ok, false, 'room should be gone once everyone left');
});

t('a room that outlives its host hands the settings to whoever sits down', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), watcher = newPlayer(s, 'Watcher');
  const room = ok(s.rpc('roomCreate', { id: a.id, token: a.token, config: {} })).room;
  eq(room.host, a.id, 'creator hosts');
  ok(s.rpc('roomJoin', { id: watcher.id, token: watcher.token, code: room.code, spectate: true }));
  ok(s.rpc('roomLeave', { id: a.id, token: a.token, code: room.code }));

  const seated = ok(s.rpc('roomJoin', { id: watcher.id, token: watcher.token, code: room.code }));
  eq(seated.role, 'player', 'spectator takes the empty seat');
  eq(seated.room.host, watcher.id, 'and becomes the host');
  const changed = ok(s.rpc('roomConfig', {
    id: watcher.id, token: watcher.token, code: room.code, config: { ft: 5 }
  })).room;
  eq(changed.config.ft, 5, 'new host can change the rules');
});

section('chat');

t('messages are delivered to everyone in the room, once', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  ok(s.rpc('chatSend', { id: a.id, token: a.token, code, text: '안녕' }));
  const r = sync(s, b, code, {});
  eq(r.chat.length, 1, 'one message');
  eq(r.chat[0].text, '안녕', 'text');
  eq(r.chat[0].name, 'Alpha', 'author');
  // chatSince acknowledges what we already have.
  const again = ok(s.rpc('sync', {
    id: b.id, token: b.token, code, state: baseState(), chatSince: r.chat[0].i
  }));
  eq(again.chat.length, 0, 'already-seen messages are not resent');
});

t('spectators can chat and are marked as such', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), watcher = newPlayer(s, 'Watcher');
  const room = ok(s.rpc('roomCreate', { id: a.id, token: a.token, config: {} })).room;
  ok(s.rpc('roomJoin', { id: watcher.id, token: watcher.token, code: room.code, spectate: true }));
  ok(s.rpc('chatSend', { id: watcher.id, token: watcher.token, code: room.code, text: 'gl hf' }));
  const r = sync(s, a, room.code, {});
  eq(r.chat.length, 1, 'delivered');
  eq(r.chat[0].spectator, true, 'flagged as a spectator message');
});

t('chat is rate limited, length capped and stripped of control characters', () => {
  const s = makeSandbox();
  const { a, code } = pairUp(s);
  ok(s.rpc('chatSend', { id: a.id, token: a.token, code, text: 'one' }));
  const tooFast = s.rpc('chatSend', { id: a.id, token: a.token, code, text: 'two' });
  eq(tooFast.ok, false, 'second message should be throttled');

  s.__clock.advance(2000);
  ok(s.rpc('chatSend', { id: a.id, token: a.token, code, text: 'a\u0000b\nc   d' }));
  s.__clock.advance(2000);
  ok(s.rpc('chatSend', { id: a.id, token: a.token, code, text: 'x'.repeat(500) }));

  const r = sync(s, a, code, {});
  const stripped = r.chat[1];
  eq(stripped.text, 'a b c d', 'control characters and runs of whitespace collapsed');
  eq(r.chat[2].text.length, 200, 'length capped');

  s.__clock.advance(2000);
  eq(s.rpc('chatSend', { id: a.id, token: a.token, code, text: '   ' }).ok, false, 'empty message refused');
});

t('history is capped so the room entry cannot grow without bound', () => {
  const s = makeSandbox();
  const { a, code } = pairUp(s);
  for (let i = 0; i < 60; i++) {
    s.__clock.advance(1000);
    ok(s.rpc('chatSend', { id: a.id, token: a.token, code, text: 'msg' + i }));
  }
  const r = sync(s, a, code, {});
  assert(r.chat.length <= 40, 'history not capped: ' + r.chat.length);
  eq(r.chat[r.chat.length - 1].text, 'msg59', 'newest kept');
});

t('someone outside the room cannot post to it', () => {
  const s = makeSandbox();
  const { code } = pairUp(s);
  const outsider = newPlayer(s, 'Outsider');
  const res = s.rpc('chatSend', { id: outsider.id, token: outsider.token, code, text: 'hello' });
  eq(res.ok, false, 'should be refused');
});

section('room rules');

t('the host can set every rule, and values are clamped to their range', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  const room = ok(s.rpc('roomCreate', {
    id: a.id, token: a.token,
    config: { gravity: 3, lockDelay: 250, nextCount: 2, allowHold: false, targeting: 'badges' }
  })).room;
  eq(room.config.gravity, 3, 'gravity');
  eq(room.config.lockDelay, 250, 'lock delay');
  eq(room.config.nextCount, 2, 'preview count');
  eq(room.config.allowHold, false, 'hold disabled');
  eq(room.config.targeting, 'badges', 'targeting');

  const clamped = ok(s.rpc('roomConfig', {
    id: a.id, token: a.token, code: room.code,
    config: { nextCount: 99, gravity: -5, lockDelay: 999999, garbageCap: 0 }
  })).room;
  eq(clamped.config.nextCount, 6, 'preview clamped to the maximum');
  eq(clamped.config.gravity, 0.1, 'gravity clamped to the minimum');
  eq(clamped.config.lockDelay, 3000, 'lock delay clamped');
  eq(clamped.config.garbageCap, 1, 'garbage cap clamped');
});

t('nonsense rule values fall back rather than corrupting the room', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  const room = ok(s.rpc('roomCreate', {
    id: a.id, token: a.token,
    config: { gravity: 'fast', targeting: 'nonsense', nextCount: null, bogusKey: 42 }
  })).room;
  eq(room.config.gravity, 1, 'default gravity');
  eq(room.config.targeting, 'random', 'unknown strategy rejected');
  eq(room.config.nextCount, 5, 'default preview');
  assert(room.config.bogusKey === undefined, 'unknown keys must not be stored');
});

t('the rule schema is published so the client can build its editor', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  const boot = ok(s.rpc('bootstrap', { id: a.id, token: a.token }));
  assert(boot.rules, 'no rule schema in bootstrap');
  eq(boot.rules.targeting.type, 'enum', 'targeting is an enum');
  eq(boot.rules.targeting.values.length, 4, 'four targeting strategies');
  eq(boot.rules.nextCount.max, 6, 'preview range');
  eq(boot.rules.allowHold.type, 'bool', 'hold is a toggle');
});

section('knockouts');

t('an elimination is credited to whoever last sent the garbage', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  sync(s, a, code, { ready: true });
  let r = sync(s, b, code, { ready: true });
  s.__clock.set(r.room.startAt + 10);
  sync(s, a, code, { ready: true, round: 1 });
  r = sync(s, b, code, { ready: true, round: 1, alive: false, killer: a.id });
  eq(r.room.state, 'roundover', 'round ended');
  const attacker = r.room.players.filter(p => p.id === a.id)[0];
  eq(attacker.ko, 1, 'knockout credited');
});

t('topping yourself out is nobody\'s knockout', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  sync(s, a, code, { ready: true });
  let r = sync(s, b, code, { ready: true });
  s.__clock.set(r.room.startAt + 10);
  sync(s, a, code, { ready: true, round: 1 });
  r = sync(s, b, code, { ready: true, round: 1, alive: false, killer: b.id });
  eq(r.room.players.filter(p => p.id === a.id)[0].ko, 0, 'no credit for a self-inflicted top-out');
  eq(r.room.players.filter(p => p.id === b.id)[0].ko, 0, 'and none for the victim either');
});

section('relay bridge');

const crypto = require('crypto');
const { verify: verifyTicket } = require('../relay/lib/ticket');

const RELAY_SECRET = 'a-shared-secret-at-least-16';

function withRelay(s) {
  const props = s.PropertiesService.getScriptProperties();
  props.setProperty('RELAY_SECRET', RELAY_SECRET);
  props.setProperty('RELAY_URL', 'wss://relay.example/ws');
  return s;
}

function nodeSign(payloadJson, secret) {
  return crypto.createHmac('sha256', secret).update(payloadJson).digest('base64url');
}

function postSettle(s, request, secret) {
  const payloadJson = JSON.stringify(request);
  const body = JSON.stringify({
    op: 'settle',
    payloadJson: payloadJson,
    sig: nodeSign(payloadJson, secret === undefined ? RELAY_SECRET : secret)
  });
  return JSON.parse(s.doPost({ postData: { contents: body } }).getContent());
}

t('the relay stays off until it is configured', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  const boot = ok(s.rpc('bootstrap', { id: a.id, token: a.token }));
  eq(boot.relay, null, 'no relay config is advertised');
  eq(s.Relay_enabled(), false, 'relay reports disabled');
});

t('a ticket minted here verifies in the relay', () => {
  const s = withRelay(makeSandbox());
  const a = newPlayer(s, 'Alpha');
  const boot = ok(s.rpc('bootstrap', { id: a.id, token: a.token }));
  assert(boot.relay, 'bootstrap should advertise the relay');
  eq(boot.relay.url, 'wss://relay.example/ws', 'relay url');

  // This is the contract that matters: two runtimes, one HMAC.
  const result = verifyTicket(boot.relay.ticket, RELAY_SECRET);
  assert(result.ok, 'relay rejected our ticket: ' + result.error);
  eq(result.player.id, a.id, 'player id');
  eq(result.player.name, 'Alpha', 'name');
  eq(result.player.glicko, 1500, 'rating fields ride along so the relay needs no lookup');
  assert(result.player.exp > Date.now(), 'ticket should be in date');
});

t('a ticket does not verify under a different secret', () => {
  const s = withRelay(makeSandbox());
  const a = newPlayer(s, 'Alpha');
  const boot = ok(s.rpc('bootstrap', { id: a.id, token: a.token }));
  const result = verifyTicket(boot.relay.ticket, 'some-other-secret');
  eq(result.ok, false, 'must not verify');
});

t('a signed settlement from the relay updates ratings and history', () => {
  const s = withRelay(makeSandbox());
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo');

  const res = postSettle(s, {
    code: 'AB12C',
    mode: 'ranked',
    winner: a.id,
    players: [
      { id: a.id, name: 'Alpha', wins: 3, stats: { apm: 60, pps: 2.1, vs: 90, lines: 40, pieces: 120 } },
      { id: b.id, name: 'Bravo', wins: 1, stats: { apm: 40, pps: 1.8, vs: 70, lines: 30, pieces: 100 } }
    ]
  });

  eq(res.ok, true, 'settlement accepted: ' + res.error);
  eq(res.data.ranked, true, 'reported as ranked');
  assert(res.data.delta[a.id].trAfter > res.data.delta[a.id].trBefore, 'winner gained TR');
  assert(res.data.delta[b.id].trAfter < res.data.delta[b.id].trBefore, 'loser lost TR');

  const winner = ok(s.rpc('profile', { id: a.id, token: a.token })).profile;
  eq(winner.games, 1, 'game recorded');
  eq(winner.wins, 1, 'win recorded');
  eq(winner.roundsWon, 3, 'rounds recorded');
  assert(winner.apm > 0, 'career stats blended');
  eq(ok(s.rpc('profile', { id: a.id, token: a.token })).history.length, 1, 'history row written');
});

t('an unsigned or wrongly signed settlement is refused', () => {
  const s = withRelay(makeSandbox());
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo');
  const request = {
    code: 'AB12C', mode: 'ranked', winner: a.id,
    players: [{ id: a.id, wins: 3, stats: {} }, { id: b.id, wins: 0, stats: {} }]
  };

  const forged = postSettle(s, request, 'not-the-secret');
  eq(forged.ok, false, 'a forged signature must be refused');
  assert(/signature/.test(forged.error), 'unexpected error: ' + forged.error);

  const unsigned = JSON.parse(s.doPost({
    postData: { contents: JSON.stringify({ op: 'settle', payloadJson: JSON.stringify(request) }) }
  }).getContent());
  eq(unsigned.ok, false, 'a missing signature must be refused');

  eq(ok(s.rpc('profile', { id: a.id, token: a.token })).profile.games, 0, 'nothing was written');
});

t('the signature covers the exact bytes, not a re-serialisation', () => {
  const s = withRelay(makeSandbox());
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo');
  const request = {
    code: 'AB12C', mode: 'ranked', winner: a.id,
    players: [{ id: a.id, wins: 3, stats: {} }, { id: b.id, wins: 0, stats: {} }]
  };
  const payloadJson = JSON.stringify(request);
  const sig = nodeSign(payloadJson, RELAY_SECRET);

  // Same object, different key order: the signature must not still pass.
  const reordered = JSON.stringify({
    players: request.players, winner: request.winner,
    mode: request.mode, code: request.code
  });
  const res = JSON.parse(s.doPost({
    postData: { contents: JSON.stringify({ op: 'settle', payloadJson: reordered, sig: sig }) }
  }).getContent());
  eq(res.ok, false, 'a re-ordered payload must not verify against the original signature');
});

t('doPost refuses anything that is not a settlement', () => {
  const s = withRelay(makeSandbox());
  const res = JSON.parse(s.doPost({
    postData: { contents: JSON.stringify({ op: 'drop-database' }) }
  }).getContent());
  eq(res.ok, false, 'unknown ops are refused');
  const junk = JSON.parse(s.doPost({ postData: { contents: 'not json' } }).getContent());
  eq(junk.ok, false, 'malformed bodies are refused');
});

t('setupRelay generates a secret and reports the wiring', () => {
  const s = makeSandbox();
  const out = s.setupRelay('wss://relay.example/ws');
  assert(out.secret.length >= 32, 'a usable secret was generated');
  eq(out.url, 'wss://relay.example/ws', 'url stored');
  eq(s.Relay_enabled(), true, 'relay is now on');
  s.disableRelay();
  eq(s.Relay_enabled(), false, 'and can be turned back off');
});

process.exit(finish() ? 0 : 1);
