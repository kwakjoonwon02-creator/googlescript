/**
 * Rooms: lobby, round flow and live state exchange.
 *
 * Apps Script has no sockets, so the versus loop is a poll: every client
 * calls sync() a few times a second, which writes that client's own state
 * and returns everybody else's. Two rules keep this consistent:
 *
 *   1. A client only ever writes its OWN state key -> no write contention,
 *      no lock on the hot path.
 *   2. The SERVER owns the room state machine (countdown/playing/round over).
 *      Both clients drive it from sync(), transitions run under a short lock
 *      and are idempotent, so whoever gets there first performs it and the
 *      other simply sees the result.
 *
 * Piece order is not synced; each round carries a seed and both clients run
 * the same deterministic 7-bag from it.
 */

var ROOMS = {
  ROOM_TTL: 3600,
  STATE_TTL: 90,
  INDEX_KEY: 'rooms:index',
  INDEX_TTL: 3600,
  MAX_PLAYERS: 4,
  MAX_SPECTATORS: 12,
  CHAT_HISTORY: 40,
  CHAT_MAX_LEN: 200,
  CHAT_COOLDOWN_MS: 700,
  COUNTDOWN_MS: 3500,
  INTERLUDE_MS: 4000,
  // A client that has not synced for this long is treated as gone.
  DROP_MS: 9000,
  ATTACK_LOG: 24
};

/**
 * Two seams let this whole file run unchanged on the relay as well as here.
 * The relay assigns into ROOMS_OVERRIDES before it serves anything; on Apps
 * Script both stay empty and the local implementations are used. Neither
 * default is referenced until it is called, so the relay never needs the
 * files that define them.
 */
var ROOMS_OVERRIDES = {
  authenticate: null,   // payload -> {id, name, tr, rank, glicko, rd, vol}
  settle: null          // settlement request -> {ranked, delta, scores}
};

function Rooms_authenticate_(payload) {
  if (ROOMS_OVERRIDES.authenticate) return ROOMS_OVERRIDES.authenticate(payload);
  return Players_authenticate(payload);
}

function Rooms_settle_(request) {
  if (ROOMS_OVERRIDES.settle) return ROOMS_OVERRIDES.settle(request);
  return Match_settle(request);
}

function Rooms_key_(code) { return 'room:' + code; }
function Rooms_stateKey_(code, playerId) { return 'rs:' + code + ':' + playerId; }

function Rooms_load(code) {
  if (!code) return null;
  return Store_cacheGet(Rooms_key_(String(code).toUpperCase()));
}

function Rooms_save(room) {
  room.updated = Store_now();
  Store_cachePut(Rooms_key_(room.code), room, ROOMS.ROOM_TTL);
}

function Rooms_seed_() {
  return Math.floor(Math.random() * 2147483647) + 1;
}

function Rooms_playerIndex_(room, playerId) {
  for (var i = 0; i < room.players.length; i++) {
    if (String(room.players[i].id) === String(playerId)) return i;
  }
  return -1;
}

/**
 * Rules the room imposes on everybody in it. Everything here is enforced by
 * the clients (they all build their engine from this object), so it is the
 * single place a host changes how a room plays.
 */
var ROOM_RULES = {
  ft:                { type: 'int',  def: 3,    min: 1,   max: 9 },
  maxPlayers:        { type: 'int',  def: 2,    min: 2,   max: ROOMS.MAX_PLAYERS },
  targeting:         { type: 'enum', def: 'random', values: ['random', 'even', 'attackers', 'badges'] },
  gravity:           { type: 'num',  def: 1,    min: 0.1, max: 20 },
  gravityIncrease:   { type: 'num',  def: 0.45, min: 0,   max: 5 },
  gravityEvery:      { type: 'int',  def: 30000, min: 5000, max: 300000 },
  lockDelay:         { type: 'int',  def: 500,  min: 100, max: 3000 },
  lockResets:        { type: 'int',  def: 15,   min: 0,   max: 30 },
  nextCount:         { type: 'int',  def: 5,    min: 1,   max: 6 },
  allowHold:         { type: 'bool', def: true },
  garbageMultiplier: { type: 'num',  def: 1,    min: 0,   max: 5 },
  garbageDelayMs:    { type: 'int',  def: 500,  min: 0,   max: 5000 },
  garbageCap:        { type: 'int',  def: 8,    min: 1,   max: 40 },
  garbageHoleRepeat: { type: 'num',  def: 0.65, min: 0,   max: 1 }
};

function Rooms_coerceRule_(spec, value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (spec.type === 'bool') return !!value;
  if (spec.type === 'enum') return spec.values.indexOf(value) === -1 ? fallback : value;
  var n = Number(value);
  if (!isFinite(n)) return fallback;
  if (spec.type === 'int') n = Math.round(n);
  return Math.max(spec.min, Math.min(spec.max, n));
}

function Rooms_defaultConfig_(overrides) {
  var src = overrides || {};
  var cfg = { ranked: false, isPrivate: !!src.isPrivate, name: String(src.name || '').slice(0, 24) };
  if (src.ranked) cfg.ranked = true;
  Object.keys(ROOM_RULES).forEach(function (key) {
    cfg[key] = Rooms_coerceRule_(ROOM_RULES[key], src[key], ROOM_RULES[key].def);
  });
  return cfg;
}

/** Rule metadata for the client's room settings panel. */
function Rooms_ruleSchema() {
  var out = {};
  Object.keys(ROOM_RULES).forEach(function (key) {
    var spec = ROOM_RULES[key];
    out[key] = {
      type: spec.type, def: spec.def,
      min: spec.min, max: spec.max, values: spec.values
    };
  });
  return out;
}

function Rooms_create(player, config, mode) {
  var code = Store_roomCode();
  // Codes are short; retry on the rare collision.
  for (var attempt = 0; attempt < 5 && Rooms_load(code); attempt++) code = Store_roomCode();

  var room = {
    code: code,
    mode: mode || 'casual',
    host: player.id,
    created: Store_now(),
    updated: Store_now(),
    config: Rooms_defaultConfig_(config),
    players: [Rooms_seatFor_(player)],
    state: 'lobby',
    round: 0,
    spectators: [],
    chat: [],
    chatSeq: 0,
    // Bumped whenever a match ends. A client's readiness only counts if it
    // was published against the current epoch, so the "ready" flags left over
    // from the match that just finished cannot start the next one before
    // anybody has seen the result screen.
    readyEpoch: 1,
    seed: Rooms_seed_(),
    startAt: 0,
    nextRoundAt: 0,
    roundWinner: null,
    matchWinner: null,
    results: null
  };
  Rooms_save(room);
  Rooms_indexUpsert_(room);
  return room;
}

function Rooms_seatFor_(player) {
  return {
    id: player.id,
    name: player.name,
    tr: Math.round(Number(player.tr)),
    rank: player.rank,
    glicko: Number(player.glicko),
    rd: Number(player.rd),
    vol: Number(player.vol),
    joined: Store_now(),
    wins: 0,
    ko: 0        // eliminations this match, used for badge targeting
  };
}

function Rooms_spectatorIndex_(room, playerId) {
  var list = room.spectators || [];
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].id) === String(playerId)) return i;
  }
  return -1;
}

/* ------------------------------------------------------ public room index */

function Rooms_indexUpsert_(room) {
  Store_withLock(2000, function () {
    var index = Store_cacheGet(ROOMS.INDEX_KEY) || [];
    index = index.filter(function (r) { return r.code !== room.code; });
    // Rooms stay listed while a match runs so people can drop in and watch.
    if (!room.config.isPrivate && room.mode !== 'ranked') {
      index.push({
        code: room.code,
        name: room.config.name || (room.players[0] ? room.players[0].name + "'s room" : 'room'),
        players: room.players.length,
        max: room.config.maxPlayers,
        spectators: (room.spectators || []).length,
        ft: room.config.ft,
        targeting: room.config.targeting,
        state: room.state,
        ts: Store_now()
      });
    }
    Store_cachePut(ROOMS.INDEX_KEY, index, ROOMS.INDEX_TTL);
  });
}

function Rooms_indexRemove_(code) {
  Store_withLock(2000, function () {
    var index = Store_cacheGet(ROOMS.INDEX_KEY) || [];
    Store_cachePut(ROOMS.INDEX_KEY, index.filter(function (r) { return r.code !== code; }), ROOMS.INDEX_TTL);
  });
}

/* ---------------------------------------------------------- state machine */

/**
 * Advances the room if the world has moved on. Idempotent, and only called
 * while holding the script lock.
 * @return {boolean} true when the room changed and must be written back.
 */
function Rooms_advance_(room, states, now) {
  var changed = false;

  if (room.state === 'lobby' || room.state === 'matchover') {
    if (Rooms_allReady_(room, states)) {
      room.state = 'countdown';
      room.round = 1;
      room.seed = Rooms_seed_();
      room.startAt = now + ROOMS.COUNTDOWN_MS;
      room.roundWinner = null;
      room.matchWinner = null;
      room.results = null;
      room.players.forEach(function (p) { p.wins = 0; p.ko = 0; });
      changed = true;
    }
  } else if (room.state === 'countdown') {
    if (now >= room.startAt) {
      room.state = 'playing';
      changed = true;
    }
  } else if (room.state === 'playing') {
    var alive = [];
    room.players.forEach(function (p) {
      var st = states[p.id];
      var connected = st && (now - Number(st.ts)) < ROOMS.DROP_MS;
      // No state yet on a just-started round means still loading, not dead.
      var isAlive = connected && (!st.round || st.round !== room.round || st.alive !== false);
      if (isAlive) alive.push(p);
    });

    if (alive.length <= 1 && room.players.length >= 2) {
      var winner = alive.length === 1 ? alive[0] : null;
      room.roundWinner = winner ? winner.id : null;
      if (winner) winner.wins = Number(winner.wins || 0) + 1;
      Rooms_creditKnockouts_(room, states, alive);
      changed = true;

      if (winner && winner.wins >= room.config.ft) {
        room.state = 'matchover';
        room.matchWinner = winner.id;
        room.readyEpoch = Number(room.readyEpoch || 1) + 1;
        room.results = Rooms_finishMatch_(room, states);
      } else {
        room.state = 'roundover';
        room.nextRoundAt = now + ROOMS.INTERLUDE_MS;
      }
    }
  } else if (room.state === 'roundover') {
    if (now >= room.nextRoundAt) {
      room.state = 'countdown';
      room.round = Number(room.round) + 1;
      room.seed = Rooms_seed_();
      room.startAt = now + ROOMS.COUNTDOWN_MS;
      room.roundWinner = null;
      changed = true;
    }
  }

  return changed;
}

/**
 * Credits an elimination to whoever last sent the dying player garbage.
 * Runs once per round, in the same transition that ends it, so a death is
 * never counted twice. Feeds the badge targeting strategy and the KO display.
 */
function Rooms_creditKnockouts_(room, states, alive) {
  var aliveIds = {};
  alive.forEach(function (p) { aliveIds[p.id] = true; });

  room.players.forEach(function (victim) {
    if (aliveIds[victim.id]) return;
    var st = states[victim.id];
    if (!st || !st.killer) return;
    var idx = Rooms_playerIndex_(room, st.killer);
    // No self-credit: topping yourself out is not somebody else's knockout.
    if (idx === -1 || String(st.killer) === String(victim.id)) return;
    room.players[idx].ko = Number(room.players[idx].ko || 0) + 1;
  });
}

/**
 * Settles a finished match: writes history, and for ranked 1v1 runs the
 * Glicko-2 update. Called exactly once, inside the transition lock.
 */
/**
 * Turns a finished match into a settlement request and hands it to whoever
 * owns the durable data. On Apps Script that is Match_settle right here; on
 * the relay it is a signed POST back to the web app, which answers with the
 * same shape.
 */
function Rooms_finishMatch_(room, states) {
  var statsFor = function (id) {
    var st = states[id] || {};
    return st.stats || {};
  };

  var request = {
    code: room.code,
    mode: room.mode,
    winner: room.matchWinner,
    players: room.players.map(function (p) {
      return { id: p.id, name: p.name, wins: Number(p.wins || 0), stats: statsFor(p.id) };
    })
  };

  var settled = Rooms_settle_(request) || {};
  return {
    winner: room.matchWinner,
    scores: settled.scores || {},
    ranked: !!settled.ranked,
    delta: settled.delta || {},
    pending: !!settled.pending,
    ts: Store_now()
  };
}

/* --------------------------------------------------------------- endpoints */

function Api_roomCreate(payload) {
  var player = Rooms_authenticate_(payload);
  var room = Rooms_create(player, payload.config || {}, 'casual');
  return { room: Rooms_publicView_(room) };
}

/**
 * Joins a room, as a player or as a spectator.
 *
 * Asking to spectate always works while there is room on the bench. Asking
 * for a seat falls back to spectating when the room is full or a match is
 * already running, rather than failing outright — that is the behaviour
 * people expect from a shared room code.
 */
function Api_roomJoin(payload) {
  var player = Rooms_authenticate_(payload);
  var code = String(payload.code || '').toUpperCase().trim();
  var wantSpectate = !!payload.spectate;

  var result = Store_withLock(5000, function () {
    var room = Rooms_load(code);
    if (!room) throw new Error('방을 찾을 수 없습니다: ' + code);
    room.spectators = room.spectators || [];

    var seated = Rooms_playerIndex_(room, player.id) !== -1;
    if (seated && !wantSpectate) return { room: room, role: 'player' };

    var canSit = !wantSpectate &&
      room.players.length < room.config.maxPlayers &&
      (room.state === 'lobby' || room.state === 'matchover');

    if (canSit) {
      var wasSpectating = Rooms_spectatorIndex_(room, player.id);
      if (wasSpectating !== -1) room.spectators.splice(wasSpectating, 1);
      room.players.push(Rooms_seatFor_(player));
      // A room can outlive its host while spectators keep it open; whoever
      // sits down next inherits the settings.
      if (Rooms_playerIndex_(room, room.host) === -1) room.host = room.players[0].id;
      Rooms_save(room);
      Rooms_indexUpsert_(room);
      return { room: room, role: 'player' };
    }

    if (seated) {
      // Moving from a seat to the bench.
      room.players.splice(Rooms_playerIndex_(room, player.id), 1);
      Store_cacheRemove(Rooms_stateKey_(code, player.id));
      if (String(room.host) === String(player.id) && room.players.length) {
        room.host = room.players[0].id;
      }
    }

    if (Rooms_spectatorIndex_(room, player.id) === -1) {
      if (room.spectators.length >= ROOMS.MAX_SPECTATORS) throw new Error('관전 인원이 가득 찼습니다.');
      room.spectators.push({ id: player.id, name: player.name, ts: Store_now() });
    }
    Rooms_save(room);
    Rooms_indexUpsert_(room);
    return {
      room: room,
      role: 'spectator',
      reason: wantSpectate ? 'requested'
        : (room.players.length >= room.config.maxPlayers ? 'full' : 'in-progress')
    };
  });

  if (!result.ran) throw new Error('서버가 혼잡합니다. 다시 시도해 주세요.');
  return {
    room: Rooms_publicView_(result.value.room),
    role: result.value.role,
    reason: result.value.reason || null
  };
}

function Api_roomLeave(payload) {
  var player = Rooms_authenticate_(payload);
  var code = String(payload.code || '').toUpperCase().trim();

  Store_withLock(5000, function () {
    var room = Rooms_load(code);
    if (!room) return;

    var watching = Rooms_spectatorIndex_(room, player.id);
    if (watching !== -1) {
      room.spectators.splice(watching, 1);
      Rooms_save(room);
      return;
    }

    var idx = Rooms_playerIndex_(room, player.id);
    if (idx === -1) return;
    room.players.splice(idx, 1);
    Store_cacheRemove(Rooms_stateKey_(code, player.id));

    if (!room.players.length && !(room.spectators || []).length) {
      Store_cacheRemove(Rooms_key_(code));
      Rooms_indexRemove_(code);
      return;
    }
    if (room.players.length && String(room.host) === String(player.id)) {
      room.host = room.players[0].id;
    }
    // A walkout mid-match ends it rather than leaving the survivor waiting.
    if (room.state === 'playing' || room.state === 'countdown' || room.state === 'roundover') {
      room.state = 'lobby';
      room.round = 0;
      room.players.forEach(function (p) { p.wins = 0; });
    }
    Rooms_save(room);
    Rooms_indexUpsert_(room);
  });

  return { left: true };
}

function Api_roomConfig(payload) {
  var player = Rooms_authenticate_(payload);
  var code = String(payload.code || '').toUpperCase().trim();
  var result = Store_withLock(5000, function () {
    var room = Rooms_load(code);
    if (!room) throw new Error('방을 찾을 수 없습니다.');
    if (String(room.host) !== String(player.id)) throw new Error('방장만 설정을 바꿀 수 있습니다.');
    if (room.state !== 'lobby' && room.state !== 'matchover') throw new Error('경기 중에는 설정을 바꿀 수 없습니다.');
    room.config = Rooms_defaultConfig_(Object.assign({}, room.config, payload.config || {}));
    Rooms_save(room);
    Rooms_indexUpsert_(room);
    return room;
  });
  if (!result.ran) throw new Error('서버가 혼잡합니다. 다시 시도해 주세요.');
  return { room: Rooms_publicView_(result.value) };
}

function Api_roomList(payload) {
  var index = Store_cacheGet(ROOMS.INDEX_KEY) || [];
  var now = Store_now();
  var live = index.filter(function (r) { return (now - r.ts) < ROOMS.ROOM_TTL * 1000; });
  live.sort(function (a, b) { return b.ts - a.ts; });
  return { rooms: live.slice(0, 30) };
}

/**
 * The hot path. One call per client tick:
 *   - stores this client's state
 *   - runs the room state machine when something needs to change
 *   - returns the room plus every other player's latest state
 */
function Api_sync(payload) {
  // Through the seam like every other endpoint: this used to accept any
  // non-empty token, which let anyone who knew a player id publish state as
  // them. On the relay it resolves to the socket's verified ticket.
  var id = Rooms_authenticate_(payload).id;
  var code = String(payload.code || '').toUpperCase().trim();

  var room = Rooms_load(code);
  if (!room) throw new Error('ROOM_GONE');

  var seated = Rooms_playerIndex_(room, id) !== -1;
  var watching = Rooms_spectatorIndex_(room, id) !== -1;
  if (!seated && !watching) throw new Error('ROOM_GONE');

  var now = Store_now();
  var mine = null;

  // 1. Publish our own state. Only we write this key, so no lock is needed.
  //    Spectators have no board, so they publish nothing at all.
  if (seated) {
    mine = payload.state || {};
    mine.id = id;
    mine.ts = now;
    if (mine.atk && mine.atk.length > ROOMS.ATTACK_LOG) {
      mine.atk = mine.atk.slice(-ROOMS.ATTACK_LOG);
    }
    Store_cachePut(Rooms_stateKey_(code, id), mine, ROOMS.STATE_TTL);
  }

  // 2. Read everyone (including ourselves, so transitions see a full picture).
  var keys = room.players.map(function (p) { return Rooms_stateKey_(code, p.id); });
  var rawStates = Store_cacheGetAll(keys);
  var states = {};
  room.players.forEach(function (p) {
    var st = rawStates[Rooms_stateKey_(code, p.id)];
    if (st) states[p.id] = st;
  });
  if (mine) states[id] = mine;

  // 3. Advance the room if needed. Under contention we simply skip: the next
  //    tick (ours or the opponent's) performs the transition instead.
  if (Rooms_needsAdvance_(room, states, now)) {
    var res = Store_withLock(1200, function () {
      var fresh = Rooms_load(code);
      if (!fresh) return null;
      if (Rooms_advance_(fresh, states, now)) {
        Rooms_save(fresh);
        Rooms_indexUpsert_(fresh);
      }
      return fresh;
    });
    if (res.ran && res.value) room = res.value;
  }

  // A spectator watches everybody; a player sees the others.
  var others = [];
  room.players.forEach(function (p) {
    if (seated && String(p.id) === String(id)) return;
    var st = states[p.id] || null;
    others.push({
      id: p.id,
      name: p.name,
      rank: p.rank,
      tr: p.tr,
      wins: Number(p.wins || 0),
      ko: Number(p.ko || 0),
      connected: !!(st && (now - Number(st.ts)) < ROOMS.DROP_MS),
      state: st
    });
  });

  // Spectators keep their bench slot alive by syncing, same as players.
  if (watching) Rooms_touchSpectator_(code, id, now);

  return {
    serverTime: now,
    room: Rooms_publicView_(room),
    others: others,
    role: seated ? 'player' : 'spectator',
    chat: Rooms_chatSince_(room, payload.chatSince)
  };
}

/**
 * Refreshes a spectator's heartbeat. Cheap and lock-free in the common case:
 * the timestamp is only written back when it has drifted far enough to
 * matter for the sweep.
 */
function Rooms_touchSpectator_(code, id, now) {
  var room = Rooms_load(code);
  if (!room) return;
  var idx = Rooms_spectatorIndex_(room, id);
  if (idx === -1) return;
  if (now - Number(room.spectators[idx].ts) < ROOMS.DROP_MS / 2) return;
  Store_withLock(600, function () {
    var fresh = Rooms_load(code);
    if (!fresh) return;
    var at = Rooms_spectatorIndex_(fresh, id);
    if (at === -1) return;
    fresh.spectators[at].ts = now;
    Rooms_save(fresh);
  });
}

function Rooms_chatSince_(room, since) {
  var from = Number(since) || 0;
  return (room.chat || []).filter(function (m) { return Number(m.i) > from; });
}

/** Posts a message to the room. Rate limited per player. */
function Api_chatSend(payload) {
  var player = Rooms_authenticate_(payload);
  var code = String(payload.code || '').toUpperCase().trim();
  // Collapse whitespace and drop control characters before anything stores it.
  var text = String(payload.text || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ROOMS.CHAT_MAX_LEN);
  if (!text) throw new Error('보낼 내용이 없습니다.');

  var result = Store_withLock(4000, function () {
    var room = Rooms_load(code);
    if (!room) throw new Error('ROOM_GONE');
    var inRoom = Rooms_playerIndex_(room, player.id) !== -1 ||
                 Rooms_spectatorIndex_(room, player.id) !== -1;
    if (!inRoom) throw new Error('ROOM_GONE');

    room.chat = room.chat || [];
    var now = Store_now();
    for (var i = room.chat.length - 1; i >= 0; i--) {
      if (String(room.chat[i].id) === String(player.id)) {
        if (now - Number(room.chat[i].ts) < ROOMS.CHAT_COOLDOWN_MS) {
          throw new Error('조금 천천히 보내주세요.');
        }
        break;
      }
    }

    room.chatSeq = Number(room.chatSeq || 0) + 1;
    room.chat.push({
      i: room.chatSeq,
      id: player.id,
      name: player.name,
      text: text,
      ts: now,
      spectator: Rooms_playerIndex_(room, player.id) === -1
    });
    if (room.chat.length > ROOMS.CHAT_HISTORY) {
      room.chat = room.chat.slice(-ROOMS.CHAT_HISTORY);
    }
    Rooms_save(room);
    return room.chatSeq;
  });

  if (!result.ran) throw new Error('서버가 혼잡합니다. 다시 시도해 주세요.');
  return { seq: result.value };
}

/** Every seat has published readiness against the room's current epoch. */
function Rooms_allReady_(room, states) {
  if (room.players.length < 2) return false;
  var epoch = Number(room.readyEpoch || 1);
  return room.players.every(function (p) {
    var st = states[p.id];
    return st && st.ready && Number(st.epoch || 1) === epoch;
  });
}

/** Cheap pre-check so we only take the lock when a transition is actually due. */
function Rooms_needsAdvance_(room, states, now) {
  switch (room.state) {
    case 'lobby':
    case 'matchover':
      return Rooms_allReady_(room, states);
    case 'countdown':
      return now >= room.startAt;
    case 'roundover':
      return now >= room.nextRoundAt;
    case 'playing':
      var alive = 0;
      room.players.forEach(function (p) {
        var st = states[p.id];
        var connected = st && (now - Number(st.ts)) < ROOMS.DROP_MS;
        if (connected && (!st.round || st.round !== room.round || st.alive !== false)) alive++;
      });
      return alive <= 1 && room.players.length >= 2;
    default:
      return false;
  }
}

function Rooms_publicView_(room) {
  return {
    code: room.code,
    mode: room.mode,
    host: room.host,
    config: room.config,
    players: room.players.map(function (p) {
      return {
        id: p.id, name: p.name, tr: p.tr, rank: p.rank,
        wins: Number(p.wins || 0), ko: Number(p.ko || 0)
      };
    }),
    spectators: (room.spectators || []).map(function (v) {
      return { id: v.id, name: v.name };
    }),
    chatSeq: Number(room.chatSeq || 0),
    state: room.state,
    round: room.round,
    readyEpoch: Number(room.readyEpoch || 1),
    seed: room.seed,
    startAt: room.startAt,
    nextRoundAt: room.nextRoundAt,
    roundWinner: room.roundWinner,
    matchWinner: room.matchWinner,
    results: room.results
  };
}

/** Drops rooms whose index entry has gone stale. Called by the janitor. */
function Rooms_sweep() {
  var removed = 0;
  var now = Store_now();
  Store_withLock(10000, function () {
    var index = Store_cacheGet(ROOMS.INDEX_KEY) || [];
    var kept = [];
    index.forEach(function (entry) {
      var room = Rooms_load(entry.code);
      if (!room) { removed++; return; }

      // Spectators who stopped syncing free their bench slot.
      var before = (room.spectators || []).length;
      room.spectators = (room.spectators || []).filter(function (v) {
        return (now - Number(v.ts)) < ROOMS.DROP_MS * 3;
      });
      if (room.spectators.length !== before) Rooms_save(room);

      kept.push(entry);
    });
    Store_cachePut(ROOMS.INDEX_KEY, kept, ROOMS.INDEX_TTL);
  });
  return removed;
}
