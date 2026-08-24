/* Accounts, matchmaking, the room state machine and rating settlement,
   driven through the same rpc() surface the client uses. */
const { makeGasSandbox: makeSandbox } = require('./lib/gas-sandbox');
const { test: t, assert, eq, section, note, finish } = require('./lib/report');

function ok(res) {
  if (!res.ok) throw new Error('rpc failed: ' + res.error);
  return res.data;
}

function newPlayer(s, name, password) {
  const d = ok(s.rpc('register', { name, password: password || 'hunter2!' }));
  return { id: d.credentials.id, token: d.credentials.token, name: d.profile.name, profile: d.profile };
}

function newGuest(s) {
  const d = ok(s.rpc('guest', {}));
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
t('registering issues distinct credentials', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo');
  assert(a.id !== b.id, 'ids collide');
  assert(a.token !== b.token, 'tokens collide');
  eq(a.profile.tr, 12500, 'starting TR');
  eq(a.profile.rank, 'Z', 'starts unranked');
  eq(a.profile.guest, false, 'a registered account is not a guest');
});

t('an existing session is restored, not duplicated', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  const again = ok(s.rpc('bootstrap', { id: a.id, token: a.token }));
  eq(again.authed, true, 'session restored');
  eq(again.credentials.id, a.id, 'same id');
  eq(again.profile.name, 'Alpha', 'same name');
});

t('bootstrap without credentials hands out nothing', () => {
  const s = makeSandbox();
  const d = ok(s.rpc('bootstrap', {}));
  eq(d.authed, false, 'nobody is signed in');
  eq(d.credentials, undefined, 'no account was created for a stranger');
  assert(d.ranks && d.rules, 'reference data still comes back for the sign-in screen');
});

t('signing in returns the same account', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha', 'correct horse');
  const back = ok(s.rpc('login', { name: 'Alpha', password: 'correct horse' }));
  eq(back.credentials.id, a.id, 'same account');
  eq(back.profile.name, 'Alpha', 'same name');
});

t('the name is not case sensitive to sign in with', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha', 'correct horse');
  eq(ok(s.rpc('login', { name: 'ALPHA', password: 'correct horse' })).credentials.id, a.id, 'same account');
});

t('a wrong password is refused, and says no more than that', () => {
  const s = makeSandbox();
  newPlayer(s, 'Alpha', 'correct horse');
  const wrong = s.rpc('login', { name: 'Alpha', password: 'wrong horse' });
  const missing = s.rpc('login', { name: 'Nobody', password: 'wrong horse' });
  eq(wrong.ok, false, 'wrong password should fail');
  eq(missing.ok, false, 'unknown name should fail');
  eq(wrong.error, missing.error, 'the two must not be distinguishable');
});

t('the password is not stored, and neither is anything reversible', () => {
  const s = makeSandbox();
  newPlayer(s, 'Alpha', 'correct horse');
  const row = s.Store_readAll('Players')[0];
  assert(row.pwHash && row.pwSalt, 'no hash was written');
  assert(String(row.pwHash).indexOf('correct') === -1, 'the password is in the sheet');
  assert(row.pwHash.length === 64, 'expected a 32-byte digest as hex');
  const other = ok(s.rpc('register', { name: 'Bravo', password: 'correct horse' }));
  const rows = s.Store_readAll('Players');
  assert(rows[0].pwHash !== rows[1].pwHash, 'the same password hashed the same way twice');
  assert(other.credentials.token !== rows[0].token, 'tokens collide');
});

t('repeated wrong guesses are throttled', () => {
  const s = makeSandbox();
  newPlayer(s, 'Alpha', 'correct horse');
  let refused = null;
  for (let i = 0; i < 14 && refused === null; i++) {
    const res = s.rpc('login', { name: 'Alpha', password: 'nope' });
    if (/너무 많/.test(res.error || '')) refused = i;
  }
  assert(refused !== null, 'guessing was never throttled');
  assert(refused <= 10, 'throttle kicked in too late: ' + refused);
  eq(s.rpc('login', { name: 'Alpha', password: 'correct horse' }).ok, false, 'the throttle let the right password through');
});

t('getting it right clears the count against you', () => {
  const s = makeSandbox();
  newPlayer(s, 'Alpha', 'correct horse');
  // A few fat-fingered attempts, then a success, then a few more. Somebody
  // who keeps mistyping their own password must not lock themselves out.
  for (let i = 0; i < 6; i++) s.rpc('login', { name: 'Alpha', password: 'nope' });
  ok(s.rpc('login', { name: 'Alpha', password: 'correct horse' }));
  for (let i = 0; i < 6; i++) s.rpc('login', { name: 'Alpha', password: 'nope' });
  eq(ok(s.rpc('login', { name: 'Alpha', password: 'correct horse' })).profile.name, 'Alpha', 'locked out');
});

t('signing out makes the old token worthless', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  ok(s.rpc('logout', { id: a.id, token: a.token }));
  eq(s.rpc('profile', { id: a.id, token: a.token }).ok, false, 'the old token still works');
  const back = ok(s.rpc('login', { name: 'Alpha', password: 'hunter2!' }));
  assert(back.credentials.token !== a.token, 'a new token was not issued');
  eq(ok(s.rpc('profile', back.credentials)).profile.name, 'Alpha', 'cannot sign back in');
});

t('a name cannot be registered twice', () => {
  const s = makeSandbox();
  newPlayer(s, 'Alpha');
  eq(s.rpc('register', { name: 'Alpha', password: 'hunter2!' }).ok, false, 'duplicate name');
  eq(s.rpc('register', { name: 'alpha', password: 'hunter2!' }).ok, false, 'duplicate but for case');
  eq(s.rpc('register', { name: 'Alpha', password: 'sh0rt' }).ok, false, 'short password');
  eq(s.rpc('register', { name: 'x', password: 'hunter2!' }).ok, false, 'short name');
});

section('settings');

const HANDLING = {
  das: 83, arr: 0, sdf: 41, ghost: false, grid: true, shake: false,
  effects: true, transitions: false, sound: true, cpuLevel: 5,
  binds: { left: 'KeyJ', right: 'KeyL', hardDrop: 'Space' }
};

t('settings are handed back with the next session', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  eq(ok(s.rpc('bootstrap', { id: a.id, token: a.token })).settings, null,
     'a new account should report no settings, not defaults');

  ok(s.rpc('saveSettings', { id: a.id, token: a.token, settings: HANDLING }));

  const back = ok(s.rpc('bootstrap', { id: a.id, token: a.token })).settings;
  eq(back.das, 83, 'DAS');
  eq(back.ghost, false, 'a false toggle must survive');
  eq(back.cpuLevel, 5, 'CPU level');
  eq(back.binds.left, 'KeyJ', 'rebound key');
});

t('signing in on another device restores them', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha', 'correct horse');
  ok(s.rpc('saveSettings', { id: a.id, token: a.token, settings: HANDLING }));
  // A different browser: no stored credentials, just the name and password.
  const fresh = ok(s.rpc('login', { name: 'Alpha', password: 'correct horse' }));
  eq(fresh.settings.das, 83, 'DAS did not follow the account');
  eq(fresh.settings.binds.right, 'KeyL', 'keybinds did not follow the account');
});

t('one account cannot see or set another\'s', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo');
  ok(s.rpc('saveSettings', { id: a.id, token: a.token, settings: HANDLING }));
  eq(ok(s.rpc('bootstrap', { id: b.id, token: b.token })).settings, null, 'leaked into another account');
  eq(s.rpc('saveSettings', { id: a.id, token: 'forged', settings: HANDLING }).ok, false, 'forged token');
});

t('values are clamped and unknown keys are dropped', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  const kept = ok(s.rpc('saveSettings', {
    id: a.id, token: a.token,
    settings: { das: 99999, arr: -40, sdf: 0, cpuLevel: 12, ghost: 'yes', evil: '<script>', binds: {} }
  })).settings;
  eq(kept.das, 300, 'DAS clamped to its ceiling');
  eq(kept.arr, 0, 'ARR clamped to its floor');
  eq(kept.sdf, 1, 'SDF clamped to its floor');
  eq(kept.cpuLevel, 5, 'CPU level clamped');
  eq(kept.ghost, true, 'a truthy string is a true toggle');
  eq(kept.evil, undefined, 'an unknown key was stored');
  eq(JSON.stringify(kept.binds), '{}', 'binds');
});

t('a nonsense keybind is dropped rather than stored', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  const kept = ok(s.rpc('saveSettings', {
    id: a.id, token: a.token,
    settings: { binds: {
      left: 'KeyJ',
      right: 'x'.repeat(400),
      hold: { nope: true },
      fly: 'KeyF'
    } }
  })).settings;
  eq(kept.binds.left, 'KeyJ', 'a valid bind should survive');
  eq(kept.binds.right, undefined, 'an over-long code was stored');
  eq(kept.binds.hold, undefined, 'a non-string code was stored');
  eq(kept.binds.fly, undefined, 'an unknown action was stored');
});

t('garbage in the column reads as no settings, not as an error', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  const row = s.Store_readAll('Players')[0];
  s.Store_writeRow('Players', row._row, Object.assign(row, { settings: '{not json' }));
  s.__evict('player:');
  eq(ok(s.rpc('bootstrap', { id: a.id, token: a.token })).settings, null, 'should fall back cleanly');
});

t('a guest keeps their settings through becoming an account', () => {
  const s = makeSandbox();
  const g = newGuest(s);
  ok(s.rpc('saveSettings', { id: g.id, token: g.token, settings: HANDLING }));
  ok(s.rpc('setPassword', { id: g.id, token: g.token, name: 'Charlie', password: 'hunter2!' }));
  const back = ok(s.rpc('login', { name: 'Charlie', password: 'hunter2!' }));
  eq(back.settings.das, 83, 'handling was lost in the upgrade');
});

t('an account from before settings existed still signs in', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  const row = s.Store_readAll('Players')[0];
  s.Store_writeRow('Players', row._row, Object.assign(row, { settings: '' }));
  s.__evict('player:');
  const session = ok(s.rpc('bootstrap', { id: a.id, token: a.token }));
  eq(session.authed, true, 'the session broke');
  eq(session.settings, null, 'an empty column is no settings');
});

section('guests');
t('a guest can play, but not ranked', () => {
  const s = makeSandbox();
  const g = newGuest(s);
  eq(g.profile.guest, true, 'flagged as a guest');
  const res = s.rpc('queueJoin', { id: g.id, token: g.token });
  eq(res.ok, false, 'a guest got into the ranked queue');
  assert(/계정/.test(res.error), 'unexpected error: ' + res.error);

  // Everything else is open to them.
  const room = ok(s.rpc('roomCreate', { id: g.id, token: g.token }));
  assert(room.room.code, 'a guest cannot make a room');
  ok(s.rpc('submitSolo', { id: g.id, token: g.token, mode: 'sprint', completed: true, timeMs: 41000, stats: { lines: 40, pieces: 100 } }));
});

t('a guest keeps everything when they set a password', () => {
  const s = makeSandbox();
  const g = newGuest(s);
  ok(s.rpc('submitSolo', {
    id: g.id, token: g.token, mode: 'sprint', completed: true,
    timeMs: 41000, stats: { lines: 40, pieces: 100 }
  }));

  const claimed = ok(s.rpc('setPassword', {
    id: g.id, token: g.token, name: 'Charlie', password: 'hunter2!'
  }));
  eq(claimed.profile.guest, false, 'still a guest');
  eq(claimed.profile.name, 'Charlie', 'name not taken');
  eq(claimed.profile.sprintBest, 41000, 'the record was lost');

  const back = ok(s.rpc('login', { name: 'Charlie', password: 'hunter2!' }));
  eq(back.credentials.id, g.id, 'signing in landed on a different account');
  eq(back.profile.sprintBest, 41000, 'the record did not survive the round trip');
  eq(ok(s.rpc('queueJoin', back.credentials)).matched, false, 'ranked is still refused');
});

t('changing a password needs the current one', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha', 'correct horse');
  eq(s.rpc('setPassword', { id: a.id, token: a.token, password: 'new one!' }).ok, false, 'no current password given');
  eq(s.rpc('setPassword', { id: a.id, token: a.token, current: 'wrong', password: 'new one!' }).ok, false, 'wrong current password');
  ok(s.rpc('setPassword', { id: a.id, token: a.token, current: 'correct horse', password: 'new one!' }));
  eq(s.rpc('login', { name: 'Alpha', password: 'correct horse' }).ok, false, 'the old password still works');
  eq(ok(s.rpc('login', { name: 'Alpha', password: 'new one!' })).profile.name, 'Alpha', 'the new one does not');
});

t('an account from before passwords existed still works', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  // Blank out the credentials columns, which is what an older sheet holds.
  const row = s.Store_readAll('Players')[0];
  s.Store_writeRow('Players', row._row, Object.assign(row, { pwHash: '', pwSalt: '', guest: '' }));
  s.__evict('player:');

  const session = ok(s.rpc('bootstrap', { id: a.id, token: a.token }));
  eq(session.authed, true, 'the stored session stopped working');
  eq(session.profile.guest, true, 'an account with no password is a guest');
  ok(s.rpc('setPassword', { id: a.id, token: a.token, password: 'hunter2!' }));
  eq(ok(s.rpc('login', { name: 'Alpha', password: 'hunter2!' })).credentials.id, a.id, 'could not adopt the account');
});

t('a bad token is rejected', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  const res = s.rpc('profile', { id: a.id, token: 'forged' });
  eq(res.ok, false, 'should reject');
  assert(/token/i.test(res.error), 'unexpected error: ' + res.error);
});

t('sync will not publish state under somebody else\'s id', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo');
  ok(s.rpc('queueJoin', { id: a.id, token: a.token }));
  const code = ok(s.rpc('queueJoin', { id: b.id, token: b.token })).room.code;
  // Knowing a player id is not enough: the token has to match the account.
  const res = s.rpc('sync', { id: a.id, token: 'forged', code, state: baseState() });
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

section('one player, one ranked match');

/* Every one of these is a way the same player ended up committed to two
   ranked rooms at once — which from the other side looks like being matched
   against somebody who never turns up. */

t('a slow poller collects the match they already have', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo'), c = newPlayer(s, 'Charlie');

  ok(s.rpc('queueJoin', { id: a.id, token: a.token }));
  const paired = ok(s.rpc('queueJoin', { id: b.id, token: b.token }));
  eq(paired.matched, true, 'Bravo should pair with Alpha');

  // Alpha has not polled since joining. Their entry is older than a waiting
  // entry is allowed to be, but it is a matched entry, so it stands.
  s.__clock.advance(20000);
  ok(s.rpc('queueJoin', { id: c.id, token: c.token }));

  const mine = ok(s.rpc('queuePoll', { id: a.id, token: a.token }));
  eq(mine.matched, true, 'Alpha was never told about their own match');
  eq(mine.room.code, paired.room.code, 'Alpha was sent to a different room than Bravo');

  const room = s.Rooms_load(paired.room.code);
  eq(room.players.length, 2, 'the ranked room does not hold exactly two');
  eq(ok(s.rpc('queuePoll', { id: c.id, token: c.token })).matched, false, 'Charlie should still be waiting');
});

t('...even when the cache has lost the seat it was holding', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo'), c = newPlayer(s, 'Charlie');
  ok(s.rpc('queueJoin', { id: a.id, token: a.token }));
  const paired = ok(s.rpc('queueJoin', { id: b.id, token: b.token }));

  // The seat key is the belt; the queue entry is the braces. Drop the belt.
  assert(s.__evict('mm:seat:') > 0, 'expected seat keys to evict');
  s.__clock.advance(20000);
  ok(s.rpc('queueJoin', { id: c.id, token: c.token }));

  const mine = ok(s.rpc('queuePoll', { id: a.id, token: a.token }));
  eq(mine.matched, true, 'Alpha lost the match they had been given');
  eq(mine.room.code, paired.room.code, 'Alpha was paired a second time, into a second room');
});

t('pressing ranked again during a match returns the same room', () => {
  const s = makeSandbox();
  const { a, code } = pairUp(s);
  // A reload, a lost response, or an impatient second press.
  const again = ok(s.rpc('queueJoin', { id: a.id, token: a.token }));
  eq(again.matched, true, 'should be handed the match already in progress');
  eq(again.room.code, code, 'a second room was created');
  eq(s.Store_readAll('Rooms').filter(r => r.mode === 'ranked').length, 1, 'more than one ranked room exists');
});

t('cancelling really cancels', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo');
  ok(s.rpc('queueJoin', { id: a.id, token: a.token }));
  ok(s.rpc('queueJoin', { id: b.id, token: b.token }));

  // Alpha presses cancel in the moment between being paired and hearing so.
  ok(s.rpc('queueLeave', { id: a.id, token: a.token }));
  ok(s.rpc('roomLeave', { id: a.id, token: a.token, code: s.Store_readAll('Rooms')[0].code }));

  const fresh = ok(s.rpc('queueJoin', { id: a.id, token: a.token }));
  eq(fresh.matched, false, 'a cancelled player was dragged back into the match');
});

t('a finished match does not trap you in it', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  const res = playMatch(s, a, b, code, 3, 0);
  eq(res.room.state, 'matchover', 'match should be over');

  // Play again: the old room is finished, so this is a new search.
  const next = ok(s.rpc('queueJoin', { id: a.id, token: a.token }));
  eq(next.matched, false, 'was handed the match that just ended');
});

t('nobody is ever handed a room they are not seated in', () => {
  const s = makeSandbox();
  const players = [];
  for (let i = 0; i < 6; i++) players.push(newPlayer(s, 'P' + i));

  // Join staggered, then poll on a slow, uneven timer — the shape that
  // produced the double booking.
  players.forEach(p => { s.__clock.advance(8000); ok(s.rpc('queueJoin', { id: p.id, token: p.token })); });
  const seen = new Map();
  for (let tick = 0; tick < 8; tick++) {
    s.__clock.advance(9000);
    players.forEach(p => {
      if (seen.has(p.id)) return;
      const r = ok(s.rpc('queuePoll', { id: p.id, token: p.token }));
      if (r.matched) seen.set(p.id, r.room.code);
    });
  }

  const byRoom = {};
  seen.forEach((code, id) => { (byRoom[code] = byRoom[code] || []).push(id); });
  Object.keys(byRoom).forEach(code => {
    const room = s.Rooms_load(code);
    eq(room.players.length, 2, code + ' holds ' + room.players.length + ' players');
    eq(byRoom[code].length, 2, code + ' was handed to ' + byRoom[code].length + ' clients');
    room.players.forEach(seat => {
      assert(byRoom[code].indexOf(seat.id) !== -1,
        code + ' seats somebody who was told about a different room');
    });
  });
  note(Object.keys(byRoom).length + ' rooms, ' + seen.size + ' of 6 matched');
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

section('surviving a cold cache');

/* CacheService is best-effort. Everything here wipes it on purpose, because
   that is what broke live deployments: rooms only existed in the cache, so
   when Google dropped them every client got ROOM_GONE and was thrown out of
   the match. */

t('a match in progress survives the cache being wiped', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  sync(s, a, code, { ready: true });
  let r = sync(s, b, code, { ready: true });
  s.__clock.set(r.room.startAt + 10);
  r = sync(s, a, code, { ready: true, round: 1 });
  eq(r.room.state, 'playing', 'match under way');

  assert(s.__evict() > 0, 'nothing was cached to evict');

  r = sync(s, a, code, { ready: true, round: 1 });
  eq(r.room.state, 'playing', 'the round carried on');
  eq(r.room.code, code, 'same room');
  eq(r.room.players.length, 2, 'both players still seated');
  eq(r.room.seed > 0, true, 'the piece order survived');
});

t('one lost state key does not kill the player it belonged to', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  sync(s, a, code, { ready: true });
  let r = sync(s, b, code, { ready: true });
  s.__clock.set(r.room.startAt + 10);
  sync(s, a, code, { ready: true, round: 1 });
  sync(s, b, code, { ready: true, round: 1 });

  assert(s.__evict('rs:' + code + ':' + b.id) === 1, 'expected one key to go');

  r = sync(s, a, code, { ready: true, round: 1 });
  eq(r.room.state, 'playing', 'Bravo was declared dead by a cache miss');
});

t('a player who really is gone is still dropped after a wipe', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  sync(s, a, code, { ready: true });
  let r = sync(s, b, code, { ready: true });
  s.__clock.set(r.room.startAt + 10);
  sync(s, a, code, { ready: true, round: 1 });
  sync(s, b, code, { ready: true, round: 1 });

  s.__evict();
  // Bravo never comes back. The grace the restore buys runs out.
  r = sync(s, a, code, { ready: true, round: 1 });
  eq(r.room.state, 'playing', 'not judged during the grace window');
  s.__clock.advance(10000);
  r = sync(s, a, code, { ready: true, round: 1 });
  eq(r.room.state, 'roundover', 'silence should still end the round');
  eq(r.room.roundWinner, a.id, 'the player who stayed wins');
});

t('the match still finishes and settles after a wipe', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  s.__evict();
  const res = playMatch(s, a, b, code, 3, 1);
  eq(res.room.state, 'matchover', 'match finished');
  eq(res.room.matchWinner, a.id, 'right winner');
  eq(res.room.results.ranked, true, 'settled as ranked');
  const after = ok(s.rpc('profile', { id: a.id, token: a.token }));
  eq(after.profile.games, 1, 'the result reached the sheet');
});

t('scores and chat come back with the room', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha'), b = newPlayer(s, 'Bravo');
  const room = ok(s.rpc('roomCreate', { id: a.id, token: a.token, config: { ft: 5 } })).room;
  ok(s.rpc('roomJoin', { id: b.id, token: b.token, code: room.code }));
  ok(s.rpc('chatSend', { id: a.id, token: a.token, code: room.code, text: 'gl hf' }));

  s.__evict();

  const r = sync(s, b, room.code, {});
  eq(r.room.config.ft, 5, 'the rules came back');
  eq(r.chat.length, 1, 'the chat history came back');
  eq(r.chat[0].text, 'gl hf', 'same message');
});

t('the public room list rebuilds itself', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  const room = ok(s.rpc('roomCreate', { id: a.id, token: a.token, config: { name: 'OPEN' } })).room;
  eq(ok(s.rpc('roomList', {})).rooms.length, 1, 'listed to start with');

  s.__evict();

  const list = ok(s.rpc('roomList', {})).rooms;
  eq(list.length, 1, 'still listed after the wipe');
  eq(list[0].code, room.code, 'same room');
  eq(list[0].name, 'OPEN', 'name preserved');
});

t('a private ranked room is never listed, wipe or no wipe', () => {
  const s = makeSandbox();
  const { code } = pairUp(s);
  s.__evict();
  const list = ok(s.rpc('roomList', {})).rooms;
  eq(list.filter(r => r.code === code).length, 0, 'ranked rooms stay hidden');
});

t('an empty room leaves nothing behind', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  const room = ok(s.rpc('roomCreate', { id: a.id, token: a.token })).room;
  ok(s.rpc('roomLeave', { id: a.id, token: a.token, code: room.code }));

  s.__evict();

  eq(s.Rooms_load(room.code), null, 'the room is gone for good');
  eq(ok(s.rpc('roomList', {})).rooms.length, 0, 'and not listed');
});

t('a quiet room keeps its row alive so the janitor leaves it be', () => {
  const s = makeSandbox();
  const { a, b, code } = pairUp(s);
  const rowOf = () => s.Store_readRow('Rooms', s.Store_findRow('Rooms', 'code', code));

  // Nobody readies up for an hour and a half; they just sit there syncing.
  for (let minutes = 5; minutes <= 90; minutes += 5) {
    s.__clock.advance(5 * 60 * 1000);
    sync(s, a, code, {});
    sync(s, b, code, {});
  }

  const age = s.__clock.now() - Number(rowOf().updated);
  assert(age < 2 * s.ROOMS.HEARTBEAT_MS, 'the row went stale: ' + Math.round(age / 1000) + 's old');

  s.Rooms_sweep();
  assert(s.Rooms_load(code), 'a room people are sitting in was swept away');
});

t('the janitor deletes rooms nobody touched for an hour', () => {
  const s = makeSandbox();
  const a = newPlayer(s, 'Alpha');
  const live = ok(s.rpc('roomCreate', { id: a.id, token: a.token, config: { name: 'LIVE' } })).room;
  const old = ok(s.rpc('roomCreate', { id: a.id, token: a.token, config: { name: 'OLD' } })).room;

  // Age the old one past the TTL by rewriting its row in place.
  const row = s.Store_findRow('Rooms', 'code', old.code);
  const rec = s.Store_readRow('Rooms', row);
  const aged = JSON.parse(rec.json);
  aged.updated = s.__clock.now() - 2 * 3600 * 1000;
  s.Store_writeRow('Rooms', row, Object.assign(rec, { updated: aged.updated, json: JSON.stringify(aged) }));

  s.__evict();
  s.Rooms_sweep();

  assert(s.Rooms_load(live.code), 'the live room was swept away');
  eq(s.Rooms_load(old.code), null, 'the stale room survived');
  eq(s.Store_findRow('Rooms', 'code', old.code), 0, 'its row is still there');
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

process.exit(finish() ? 0 : 1);
