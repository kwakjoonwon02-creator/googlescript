/**
 * Storage layer.
 *
 * Two tiers, chosen by how hot the data is:
 *   - CacheService  : per-player live state, the matchmaking queue, and a
 *                     read-through copy of everything below. Sub-50ms,
 *                     shared across users, and explicitly best-effort:
 *                     Google may drop any entry at any moment.
 *   - SpreadsheetApp: players, rooms, ratings, match history, leaderboard.
 *                     Slow (100-800ms) but durable, and readable by a human.
 *
 * Nothing that has to survive lives only in the cache. Anything the cache
 * loses is rebuilt from the sheet on the next read.
 */

var STORE = {
  PROP_SS_ID: 'TETRA_SS_ID',
  PLAYER_CACHE_TTL: 120,
  SHEETS: {
    Players: [
      'id', 'token', 'name', 'created', 'lastSeen',
      'glicko', 'rd', 'vol', 'tr', 'peakTr', 'rank', 'bestRank',
      'games', 'wins', 'losses', 'roundsWon', 'roundsLost', 'streak', 'bestStreak',
      'apm', 'pps', 'vs', 'sprintBest', 'blitzBest', 'totalLines', 'totalPieces'
    ],
    Matches: [
      'id', 'ts', 'mode', 'p1', 'p1name', 'p2', 'p2name',
      'score1', 'score2', 'winner', 'tr1Before', 'tr1After', 'tr2Before', 'tr2After', 'stats'
    ],
    // The durable copy of every live room. One row per room, deleted when
    // the room empties or goes stale.
    Rooms: ['code', 'updated', 'state', 'mode', 'players', 'json']
  }
};

/**
 * Opens (or creates on first use) the backing spreadsheet.
 *
 * Creation goes through Store_withLock rather than taking the lock directly:
 * this function is reached from inside already-locked sections, and a second
 * direct waitLock there would deadlock the execution against itself.
 */
function Store_spreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(STORE.PROP_SS_ID);
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (e) {
      // Deleted or inaccessible — fall through and make a new one.
    }
  }

  var result = Store_withLock(30000, function () {
    // Re-read inside the lock: another request may have created it already.
    var existing = props.getProperty(STORE.PROP_SS_ID);
    if (existing) {
      try { return SpreadsheetApp.openById(existing); } catch (e) {}
    }
    var ss = SpreadsheetApp.create('TETRA.GS Database');
    Object.keys(STORE.SHEETS).forEach(function (name) {
      Store_ensureSheet_(ss, name, STORE.SHEETS[name]);
    });
    var first = ss.getSheets()[0];
    if (first.getName() === 'Sheet1' || first.getName() === '시트1') ss.deleteSheet(first);
    props.setProperty(STORE.PROP_SS_ID, ss.getId());
    return ss;
  });

  if (!result.ran) throw new Error('데이터베이스를 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  return result.value;
}

function Store_ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#20222e').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

function Store_sheet(name) {
  var ss = Store_spreadsheet();
  return Store_ensureSheet_(ss, name, STORE.SHEETS[name]);
}

/** Reads a whole sheet as an array of objects keyed by the header row. */
function Store_readAll(name) {
  var sh = Store_sheet(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var headers = STORE.SHEETS[name];
  var values = sh.getRange(2, 1, last - 1, headers.length).getValues();
  return values.map(function (row, i) {
    var obj = { _row: i + 2 };
    for (var c = 0; c < headers.length; c++) obj[headers[c]] = row[c];
    return obj;
  });
}

function Store_appendRow(name, obj) {
  var sh = Store_sheet(name);
  var headers = STORE.SHEETS[name];
  var row = headers.map(function (h) {
    var v = obj[h];
    return v === undefined || v === null ? '' : v;
  });
  sh.appendRow(row);
  return sh.getLastRow();
}

function Store_writeRow(name, rowIndex, obj) {
  var sh = Store_sheet(name);
  var headers = STORE.SHEETS[name];
  var row = headers.map(function (h) {
    var v = obj[h];
    return v === undefined || v === null ? '' : v;
  });
  sh.getRange(rowIndex, 1, 1, headers.length).setValues([row]);
}

/**
 * Row number of the first row whose `header` column equals `value`, or 0.
 * Reads one column rather than the whole sheet, which matters for tables
 * that carry a large JSON payload in another column.
 */
function Store_findRow(name, header, value) {
  var sh = Store_sheet(name);
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var col = STORE.SHEETS[name].indexOf(header) + 1;
  if (col < 1) throw new Error('no such column: ' + name + '.' + header);
  var values = sh.getRange(2, col, last - 1, 1).getValues();
  var wanted = String(value);
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === wanted) return i + 2;
  }
  return 0;
}

/** Reads a single row as an object keyed by the header row. */
function Store_readRow(name, rowIndex) {
  var sh = Store_sheet(name);
  if (rowIndex < 2 || rowIndex > sh.getLastRow()) return null;
  var headers = STORE.SHEETS[name];
  var row = sh.getRange(rowIndex, 1, 1, headers.length).getValues()[0];
  var obj = { _row: rowIndex };
  for (var c = 0; c < headers.length; c++) obj[headers[c]] = row[c];
  return obj;
}

/** Two columns of a sheet, as {a, b, _row} triples. Used for cheap sweeps. */
function Store_readPairs(name, headerA, headerB) {
  var sh = Store_sheet(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var headers = STORE.SHEETS[name];
  var ca = headers.indexOf(headerA) + 1;
  var cb = headers.indexOf(headerB) + 1;
  var lo = Math.min(ca, cb), hi = Math.max(ca, cb);
  var values = sh.getRange(2, lo, last - 1, hi - lo + 1).getValues();
  return values.map(function (row, i) {
    return { a: row[ca - lo], b: row[cb - lo], _row: i + 2 };
  });
}

/** Deletes rows by number. Sorted descending first so indexes stay valid. */
function Store_deleteRows(name, rowIndexes) {
  if (!rowIndexes || !rowIndexes.length) return 0;
  var sh = Store_sheet(name);
  var sorted = rowIndexes.slice().sort(function (a, b) { return b - a; });
  sorted.forEach(function (r) { sh.deleteRow(r); });
  return sorted.length;
}

/* ------------------------------------------------------------------ cache */

function Store_cache() {
  return CacheService.getScriptCache();
}

function Store_cacheGet(key) {
  var raw = Store_cache().get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// CacheService rejects anything past 100KB. Dropping the write is always
// better than throwing out of a call that would otherwise have succeeded:
// everything cached here is either rebuildable or re-sent next tick.
var STORE_CACHE_MAX_ = 96 * 1024;

function Store_cachePut(key, value, ttlSeconds) {
  var raw = JSON.stringify(value);
  if (raw.length > STORE_CACHE_MAX_) return false;
  Store_cache().put(key, raw, ttlSeconds || 600);
  return true;
}

function Store_cacheRemove(key) {
  Store_cache().remove(key);
}

/** Batch read; returns a plain object of key -> parsed value (misses omitted). */
function Store_cacheGetAll(keys) {
  if (!keys || !keys.length) return {};
  var raw = Store_cache().getAll(keys);
  var out = {};
  Object.keys(raw).forEach(function (k) {
    try { out[k] = JSON.parse(raw[k]); } catch (e) {}
  });
  return out;
}

/**
 * Runs fn while holding the script lock.
 * Returns {ran:false} instead of throwing when the lock is busy, so callers
 * on a polling loop can simply try again on the next tick.
 *
 * Nesting is allowed: an execution that already holds the lock just runs the
 * inner section. Without this, a locked section that calls another locked
 * helper (room creation from inside matchmaking, say) would silently skip it.
 */
var STORE_LOCK_DEPTH_ = 0;

function Store_withLock(timeoutMs, fn) {
  if (STORE_LOCK_DEPTH_ > 0) {
    STORE_LOCK_DEPTH_++;
    try {
      return { ran: true, value: fn() };
    } finally {
      STORE_LOCK_DEPTH_--;
    }
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(timeoutMs === undefined ? 4000 : timeoutMs)) return { ran: false };
  STORE_LOCK_DEPTH_++;
  try {
    return { ran: true, value: fn() };
  } finally {
    STORE_LOCK_DEPTH_--;
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------- misc */

function Store_uid(prefix) {
  return (prefix || '') + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function Store_roomCode() {
  // Ambiguous characters (0/O, 1/I) are excluded so codes can be read aloud.
  var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var out = '';
  for (var i = 0; i < 5; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return out;
}

function Store_now() {
  return Date.now();
}
