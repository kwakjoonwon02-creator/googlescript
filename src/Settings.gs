/**
 * Per-account settings.
 *
 * Handling, toggles and keybinds used to live in localStorage and nowhere
 * else, so they were a property of the browser rather than of the player:
 * a second device, a cleared cache or a different profile meant setting DAS
 * and ARR all over again. They belong to the account now, and the browser
 * copy is the offline cache in front of it.
 *
 * Everything is validated here rather than trusted. The client is the only
 * thing that writes these, but "the client is the only writer" has never
 * been a reason to store whatever arrives — a bad value here would be
 * handed straight back to the game engine, and the column has a size limit.
 */

var SETTINGS = {
  das:         { type: 'int',  def: 100, min: 0, max: 300 },
  arr:         { type: 'int',  def: 0,   min: 0, max: 100 },
  sdf:         { type: 'int',  def: 41,  min: 1, max: 41 },
  ghost:       { type: 'bool', def: true },
  grid:        { type: 'bool', def: true },
  shake:       { type: 'bool', def: true },
  effects:     { type: 'bool', def: true },
  transitions: { type: 'bool', def: true },
  sound:       { type: 'bool', def: true },
  cpuLevel:    { type: 'int',  def: 3,   min: 1, max: 5 }
};

/**
 * The actions a key can be bound to. Defaults are deliberately not repeated
 * here: an entry that fails validation is dropped, and the client fills the
 * gap from its own defaults, so there is one list of default keys and it
 * lives where the keys are actually read.
 */
var SETTINGS_ACTIONS = [
  'left', 'right', 'softDrop', 'hardDrop',
  'rotateCW', 'rotateCCW', 'rotate180', 'hold', 'retry', 'exit'
];

// KeyboardEvent.code: ArrowLeft, KeyZ, Space, Digit1, NumpadEnter...
var SETTINGS_CODE_RE = /^[A-Za-z][A-Za-z0-9]{0,23}$/;

function Settings_coerce_(spec, value) {
  if (value === undefined || value === null || value === '') return spec.def;
  if (spec.type === 'bool') return !!value;
  var n = Number(value);
  if (!isFinite(n)) return spec.def;
  n = Math.round(n);
  return Math.max(spec.min, Math.min(spec.max, n));
}

/** Whatever arrives, in, and only known keys in known ranges, out. */
function Settings_sanitize(raw) {
  var src = (raw && typeof raw === 'object') ? raw : {};
  var out = {};
  Object.keys(SETTINGS).forEach(function (key) {
    out[key] = Settings_coerce_(SETTINGS[key], src[key]);
  });

  var binds = (src.binds && typeof src.binds === 'object') ? src.binds : {};
  var kept = {};
  SETTINGS_ACTIONS.forEach(function (action) {
    var code = binds[action];
    if (typeof code === 'string' && SETTINGS_CODE_RE.test(code)) kept[action] = code;
  });
  out.binds = kept;

  return out;
}

/**
 * The account's settings, or null if it has never saved any. The difference
 * matters: null means the client should offer up whatever the device is
 * already using rather than have it replaced by defaults, which is what
 * makes a guest's handling survive registering.
 */
function Settings_load(player) {
  var raw = player && player.settings;
  if (!raw) return null;
  var parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  return Settings_sanitize(parsed);
}

/* --------------------------------------------------------------- endpoint */

function Api_saveSettings(payload) {
  var player = Players_authenticate(payload);
  var clean = Settings_sanitize(payload.settings);
  player.settings = JSON.stringify(clean);
  player.lastSeen = Store_now();
  Players_save(player);
  // Handed back so the client can see what was actually kept rather than
  // assume its own copy is what the account now holds.
  return { settings: clean };
}
