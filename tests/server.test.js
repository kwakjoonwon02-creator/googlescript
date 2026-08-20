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
t('create, join by code, and reject a full room', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo'), c = newPlayer(s, 'Charlie');
  const room = ok(s.rpc('roomCreate', { id: a.id, token: a.token, config: { ft: 5, maxPlayers: 2 } })).room;
  eq(room.config.ft, 5, 'ft honoured');
  ok(s.rpc('roomJoin', { id: b.id, token: b.token, code: room.code }));
  const third = s.rpc('roomJoin', { id: c.id, token: c.token, code: room.code });
  eq(third.ok, false, 'third player should be refused');
  assert(/가득/.test(third.error), 'unexpected error: ' + third.error);
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

process.exit(finish() ? 0 : 1);
