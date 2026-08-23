/**
 * Sign-up, sign-in, and the guest path.
 *
 * What travels on the wire is unchanged — an (id, token) pair the client
 * keeps in localStorage and re-checks on every call — but a token is now
 * something you are given in exchange for a password rather than something
 * handed out to whoever shows up. The account name is the display name:
 * one field to remember, already unique, already validated.
 *
 * Accounts created before this still work. They simply have no password,
 * which makes them guests until they set one from the settings screen.
 */

var ACCOUNTS = {
  PW_MIN: 6,
  PW_MAX: 72,
  /**
   * Apps Script has no bcrypt, scrypt or PBKDF2, so this is HMAC-SHA256
   * chained on itself with a per-account salt. It is not memory hard and it
   * does not pretend to be: it costs somebody who has stolen the sheet this
   * many hashes per guess instead of one, and it costs a login about a
   * tenth of a second. Nothing here should be reused as a banking password.
   */
  PW_ROUNDS: 1200,
  // Wrong-password throttle, per account name.
  FAIL_WINDOW: 900,
  FAIL_MAX: 10
};

/* ------------------------------------------------------------- hashing */

function Accounts_hex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var v = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    out += (v < 16 ? '0' : '') + v.toString(16);
  }
  return out;
}

function Accounts_hash_(password, salt) {
  var acc = String(password) + ':' + String(salt);
  for (var i = 0; i < ACCOUNTS.PW_ROUNDS; i++) {
    acc = Accounts_hex_(Utilities.computeHmacSha256Signature(acc, String(salt)));
  }
  return acc;
}

/** Comparison that does not return early, so it cannot be timed character by character. */
function Accounts_equal_(a, b) {
  var x = String(a), y = String(b);
  if (x.length !== y.length) return false;
  var diff = 0;
  for (var i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function Accounts_normalizePassword_(raw) {
  var pw = String(raw === undefined || raw === null ? '' : raw);
  if (pw.length < ACCOUNTS.PW_MIN) {
    throw new Error('비밀번호는 ' + ACCOUNTS.PW_MIN + '자 이상이어야 합니다.');
  }
  if (pw.length > ACCOUNTS.PW_MAX) {
    throw new Error('비밀번호는 ' + ACCOUNTS.PW_MAX + '자를 넘을 수 없습니다.');
  }
  return pw;
}

function Accounts_applyPassword_(player, password) {
  var salt = Store_uid('s_') + Store_uid('');
  player.pwSalt = salt;
  player.pwHash = Accounts_hash_(password, salt);
  player.guest = false;
}

function Accounts_hasPassword_(player) {
  return !!(player && player.pwHash && player.pwSalt);
}

/* ------------------------------------------------------------ throttle */

function Accounts_failKey_(name) {
  return 'login:fail:' + String(name).toLowerCase();
}

function Accounts_checkThrottle_(name) {
  var tries = Number(Store_cacheGet(Accounts_failKey_(name)) || 0);
  if (tries >= ACCOUNTS.FAIL_MAX) {
    throw new Error('로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.');
  }
}

function Accounts_noteFailure_(name) {
  var key = Accounts_failKey_(name);
  Store_cachePut(key, Number(Store_cacheGet(key) || 0) + 1, ACCOUNTS.FAIL_WINDOW);
}

function Accounts_clearFailures_(name) {
  Store_cacheRemove(Accounts_failKey_(name));
}

/* ------------------------------------------------------------- lookups */

/** Finds an account by display name, case insensitively. */
function Accounts_byName_(name) {
  var wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  var rows = Store_readAll('Players');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].name).toLowerCase() === wanted) return rows[i];
  }
  return null;
}

function Accounts_session_(player) {
  player.lastSeen = Store_now();
  player.rank = Ranks_resolve(Number(player.tr), Number(player.games));
  Players_save(player);
  return {
    credentials: { id: player.id, token: player.token },
    profile: Players_publicView(player),
    settings: Settings_load(player)
  };
}

/* ----------------------------------------------------------- endpoints */

/**
 * Creates an account. The name is the login, so it goes through the same
 * validation and uniqueness check as a rename.
 *
 * Under the lock throughout: appendRow followed by getLastRow only tells us
 * our own row number if nothing else can append between the two, and the
 * name check is only worth anything if nobody can take the name while we
 * are writing it.
 */
function Api_register(payload) {
  var password = Accounts_normalizePassword_(payload.password);
  var name = Players_normalizeName_(payload.name);

  var created = Store_withLock(20000, function () {
    if (Players_nameTaken_(name)) throw new Error('이미 사용 중인 닉네임입니다.');
    var player = Players_create_(name);
    Accounts_applyPassword_(player, password);
    Players_save(player);
    return player;
  });
  if (!created.ran) throw new Error('서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.');

  return Accounts_session_(created.value);
}

function Api_login(payload) {
  var name = String(payload.name || '').trim();
  if (!name) throw new Error('닉네임을 입력해 주세요.');
  Accounts_checkThrottle_(name);

  var player = Accounts_byName_(name);
  var wrong = '닉네임 또는 비밀번호가 올바르지 않습니다.';

  // Same message and the same work either way: whether the name exists is
  // not something a stranger should be able to read off the response.
  if (!player || !Accounts_hasPassword_(player)) {
    Accounts_hash_(String(payload.password || ''), 'no-such-account');
    Accounts_noteFailure_(name);
    throw new Error(wrong);
  }

  var hash = Accounts_hash_(String(payload.password || ''), player.pwSalt);
  if (!Accounts_equal_(hash, player.pwHash)) {
    Accounts_noteFailure_(name);
    throw new Error(wrong);
  }

  Accounts_clearFailures_(name);
  return Accounts_session_(player);
}

/**
 * Starts a throwaway account so somebody can try solo, CPU and custom rooms
 * without signing up. Ranked is the one thing it cannot do, because a rating
 * nobody can come back to is not a rating.
 */
function Api_guest(payload) {
  var created = Store_withLock(20000, function () {
    var name = 'Guest' + Math.floor(Math.random() * 9000 + 1000);
    for (var i = 0; i < 6 && Players_nameTaken_(name); i++) {
      name = 'Guest' + Math.floor(Math.random() * 9000 + 1000);
    }
    var player = Players_create_(name);
    player.guest = true;
    Players_save(player);
    return player;
  });
  if (!created.ran) throw new Error('서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.');
  return Accounts_session_(created.value);
}

/** Signs out of every device by making the current token worthless. */
function Api_logout(payload) {
  var player = Players_authenticate(payload);
  player.token = Store_uid('t_');
  Players_save(player);
  return { out: true };
}

/**
 * Sets or changes a password. This is also how a guest keeps their account:
 * they pick a real name, set a password, and stop being a guest — with the
 * records and ratings they already earned intact.
 */
function Api_setPassword(payload) {
  var player = Players_authenticate(payload);
  var password = Accounts_normalizePassword_(payload.password);

  if (Accounts_hasPassword_(player)) {
    var current = Accounts_hash_(String(payload.current || ''), player.pwSalt);
    if (!Accounts_equal_(current, player.pwHash)) {
      throw new Error('현재 비밀번호가 올바르지 않습니다.');
    }
  }

  var wantName = payload.name ? Players_normalizeName_(payload.name) : null;

  var done = Store_withLock(20000, function () {
    if (wantName && wantName.toLowerCase() !== String(player.name).toLowerCase()) {
      if (Players_nameTaken_(wantName, player.id)) throw new Error('이미 사용 중인 닉네임입니다.');
      player.name = wantName;
    }
    Accounts_applyPassword_(player, password);
    Players_save(player);
    return player;
  });
  if (!done.ran) throw new Error('서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.');

  return { profile: Players_publicView(done.value) };
}
