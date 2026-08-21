/**
 * Player profiles and persistent stats.
 *
 * The web app is deployed anonymously, so identity is a client-held
 * (id, token) pair kept in localStorage. Every mutating call re-checks the
 * token against the sheet. Where that pair comes from — registration, login
 * or a guest session — is Accounts.gs.
 */

var PLAYERS = {
  NAME_MAX: 16,
  NAME_RE: /^[A-Za-z0-9가-힣_\-\.]{2,16}$/
};

function Players_cacheKey_(id) {
  return 'player:' + id;
}

/** Loads a player by id, cached briefly to keep sync() off the spreadsheet. */
function Players_get(id) {
  if (!id) return null;
  var cached = Store_cacheGet(Players_cacheKey_(id));
  if (cached) return cached;
  var rows = Store_readAll('Players');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(id)) {
      Store_cachePut(Players_cacheKey_(id), rows[i], STORE.PLAYER_CACHE_TTL);
      return rows[i];
    }
  }
  return null;
}

function Players_save(player) {
  Store_writeRow('Players', player._row, player);
  Store_cachePut(Players_cacheKey_(player.id), player, STORE.PLAYER_CACHE_TTL);
}

function Players_invalidate(id) {
  Store_cacheRemove(Players_cacheKey_(id));
}

/** Throws unless (id, token) matches a real account. */
function Players_authenticate(payload) {
  var player = Players_get(payload && payload.id);
  if (!player) throw new Error('Unknown player. Reload to create a new profile.');
  if (String(player.token) !== String(payload.token)) throw new Error('Invalid session token.');
  return player;
}

function Players_create_(name) {
  var now = Store_now();
  var player = {
    id: Store_uid('p_'),
    token: Store_uid('t_'),
    name: name,
    created: now,
    lastSeen: now,
    glicko: GLICKO.DEFAULT_RATING,
    rd: GLICKO.DEFAULT_RD,
    vol: GLICKO.DEFAULT_VOL,
    tr: Glicko_toTR(GLICKO.DEFAULT_RATING, GLICKO.DEFAULT_RD),
    peakTr: 0,
    rank: RANKS.UNRANKED.name,
    bestRank: RANKS.UNRANKED.name,
    games: 0, wins: 0, losses: 0,
    roundsWon: 0, roundsLost: 0,
    streak: 0, bestStreak: 0,
    apm: 0, pps: 0, vs: 0,
    sprintBest: 0, blitzBest: 0,
    totalLines: 0, totalPieces: 0,
    pwHash: '', pwSalt: '', guest: false
  };
  player._row = Store_appendRow('Players', player);
  Store_cachePut(Players_cacheKey_(player.id), player, STORE.PLAYER_CACHE_TTL);
  return player;
}

function Players_normalizeName_(raw) {
  var name = String(raw || '').trim().slice(0, PLAYERS.NAME_MAX);
  if (!PLAYERS.NAME_RE.test(name)) {
    throw new Error('닉네임은 2~16자의 한글/영문/숫자/_-. 만 사용할 수 있습니다.');
  }
  return name;
}

function Players_nameTaken_(name, exceptId) {
  var rows = Store_readAll('Players');
  var lowered = name.toLowerCase();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].name).toLowerCase() === lowered && String(rows[i].id) !== String(exceptId)) {
      return true;
    }
  }
  return false;
}

/** Public view of a player — never includes the token. */
function Players_publicView(player) {
  return {
    id: player.id,
    name: player.name,
    tr: Math.round(Number(player.tr)),
    peakTr: Math.round(Number(player.peakTr)),
    glicko: Math.round(Number(player.glicko)),
    rd: Math.round(Number(player.rd)),
    rank: player.rank,
    rankColor: Ranks_color(player.rank),
    bestRank: player.bestRank || RANKS.UNRANKED.name,
    games: Number(player.games),
    wins: Number(player.wins),
    losses: Number(player.losses),
    roundsWon: Number(player.roundsWon),
    roundsLost: Number(player.roundsLost),
    streak: Number(player.streak),
    bestStreak: Number(player.bestStreak),
    apm: Number(player.apm),
    pps: Number(player.pps),
    vs: Number(player.vs),
    sprintBest: Number(player.sprintBest),
    blitzBest: Number(player.blitzBest),
    totalLines: Number(player.totalLines),
    totalPieces: Number(player.totalPieces),
    placementsLeft: Math.max(0, GLICKO.PLACEMENT_GAMES - Number(player.games)),
    // An account with no password cannot be signed back into, so it is a
    // guest whatever the column says.
    guest: !Accounts_hasPassword_(player)
  };
}

/* --------------------------------------------------------------- endpoints */

/**
 * First call of every session. Restores the session the client already has,
 * or reports that there is none so the client can show the sign-in screen.
 * It no longer creates an account for whoever happens to load the page.
 *
 * The reference data comes back either way, so the sign-in screen and the
 * game behind it are one round trip apart rather than two.
 */
function Api_bootstrap(payload) {
  var base = {
    ranks: Ranks_clientTable(),
    rules: Rooms_ruleSchema(),
    server: { time: Store_now(), version: APP.version, name: APP.name }
  };

  var player = null;
  if (payload.id && payload.token) {
    var existing = Players_get(payload.id);
    if (existing && String(existing.token) === String(payload.token)) player = existing;
  }
  if (!player) return Object.assign(base, { authed: false });

  player.lastSeen = Store_now();
  player.rank = Ranks_resolve(Number(player.tr), Number(player.games));
  Players_save(player);

  return Object.assign(base, {
    authed: true,
    credentials: { id: player.id, token: player.token },
    profile: Players_publicView(player),
    isNew: Number(player.games) === 0 && Number(player.totalPieces) === 0
  });
}

function Api_setName(payload) {
  var player = Players_authenticate(payload);
  var name = Players_normalizeName_(payload.name);
  if (name.toLowerCase() !== String(player.name).toLowerCase() && Players_nameTaken_(name, player.id)) {
    throw new Error('이미 사용 중인 닉네임입니다.');
  }
  player.name = name;
  player.lastSeen = Store_now();
  Players_save(player);
  return { profile: Players_publicView(player) };
}

function Api_profile(payload) {
  var player = Players_authenticate(payload);
  return {
    profile: Players_publicView(player),
    history: Players_recentMatches_(player.id, 10)
  };
}

/**
 * Records a finished solo run. Solo modes never touch TR — only personal
 * bests and lifetime totals.
 */
function Api_submitSolo(payload) {
  var player = Players_authenticate(payload);
  var mode = String(payload.mode || '');
  var stats = payload.stats || {};
  var improved = false;

  if (mode === 'sprint' && payload.completed) {
    var ms = Number(payload.timeMs) || 0;
    var prev = Number(player.sprintBest) || 0;
    if (ms > 0 && (prev === 0 || ms < prev)) {
      player.sprintBest = ms;
      improved = true;
    }
  } else if (mode === 'blitz') {
    var score = Number(payload.score) || 0;
    if (score > (Number(player.blitzBest) || 0)) {
      player.blitzBest = score;
      improved = true;
    }
  }

  player.totalLines = (Number(player.totalLines) || 0) + (Number(stats.lines) || 0);
  player.totalPieces = (Number(player.totalPieces) || 0) + (Number(stats.pieces) || 0);
  player.lastSeen = Store_now();
  Players_save(player);

  return { profile: Players_publicView(player), improved: improved };
}

function Players_recentMatches_(playerId, limit) {
  var rows = Store_readAll('Matches');
  var mine = rows.filter(function (m) {
    return String(m.p1) === String(playerId) || String(m.p2) === String(playerId);
  });
  mine.sort(function (a, b) { return Number(b.ts) - Number(a.ts); });
  return mine.slice(0, limit || 10).map(function (m) {
    var isP1 = String(m.p1) === String(playerId);
    var before = Number(isP1 ? m.tr1Before : m.tr2Before);
    var after = Number(isP1 ? m.tr1After : m.tr2After);
    return {
      id: m.id,
      ts: Number(m.ts),
      mode: m.mode,
      opponent: isP1 ? m.p2name : m.p1name,
      score: (isP1 ? m.score1 : m.score2) + '-' + (isP1 ? m.score2 : m.score1),
      won: String(m.winner) === String(playerId),
      trBefore: Math.round(before),
      trAfter: Math.round(after),
      trDelta: Math.round(after - before)
    };
  });
}

function Api_leaderboard(payload) {
  return Leaderboard_top(Number(payload.limit) || 50, payload.id);
}
