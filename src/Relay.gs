/**
 * The bridge to the optional realtime relay.
 *
 * Apps Script stays the source of truth for identity, ratings and history.
 * The relay only needs to know who is connecting and to be able to report a
 * finished match, so this file does exactly two things: mint short-lived
 * signed tickets, and accept signed settlement requests over doPost.
 *
 * Both directions are authenticated with one shared secret held in script
 * properties. Nothing here is reachable without it, and if it is unset the
 * whole relay path simply stays off and the game runs on polling.
 */

var RELAY = {
  PROP_SECRET: 'RELAY_SECRET',
  PROP_URL: 'RELAY_URL',
  TICKET_TTL_SECONDS: 3600,
  MIN_SECRET_LENGTH: 16
};

function Relay_config() {
  var props = PropertiesService.getScriptProperties();
  return {
    secret: props.getProperty(RELAY.PROP_SECRET) || '',
    url: props.getProperty(RELAY.PROP_URL) || ''
  };
}

function Relay_enabled() {
  var cfg = Relay_config();
  return !!(cfg.secret && cfg.url);
}

/* ------------------------------------------------------------- signing */

/** base64url without padding, matching Node's 'base64url' encoding. */
function Relay_b64url_(value) {
  return Utilities.base64EncodeWebSafe(value).replace(/=+$/, '');
}

function Relay_sign_(data, secret) {
  return Relay_b64url_(Utilities.computeHmacSha256Signature(data, secret));
}

/** Length-safe, early-exit-free comparison. */
function Relay_sameSignature_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A ticket carries everything the relay needs about a player: who they are
 * and the rating fields matchmaking sorts on. That saves the relay a lookup
 * per connection, and means it never needs read access to the spreadsheet.
 */
function Relay_ticketFor(player) {
  var cfg = Relay_config();
  if (!cfg.secret) return null;
  var payload = {
    id: player.id,
    name: player.name,
    tr: Math.round(Number(player.tr)),
    rank: player.rank,
    glicko: Number(player.glicko),
    rd: Number(player.rd),
    vol: Number(player.vol),
    games: Number(player.games),
    exp: Store_now() + RELAY.TICKET_TTL_SECONDS * 1000
  };
  var body = Relay_b64url_(JSON.stringify(payload));
  return body + '.' + Relay_sign_(body, cfg.secret);
}

/** Relay details handed to the client at bootstrap, or null when disabled. */
function Relay_clientConfig(player) {
  if (!Relay_enabled()) return null;
  return {
    url: Relay_config().url,
    ticket: Relay_ticketFor(player),
    ttlSeconds: RELAY.TICKET_TTL_SECONDS
  };
}

/* ------------------------------------------------------- settlement in */

/**
 * Handles a signed settlement request from the relay.
 * The signature covers the exact JSON string the relay sent, not a
 * re-serialisation of it, so key ordering can never make a valid request
 * look forged.
 */
function Relay_handleSettle(message) {
  var cfg = Relay_config();
  if (!cfg.secret) throw new Error('relay is not configured');

  var raw = message && message.payloadJson;
  if (typeof raw !== 'string' || !raw) throw new Error('missing payload');
  if (!Relay_sameSignature_(Relay_sign_(raw, cfg.secret), String(message.sig || ''))) {
    throw new Error('bad signature');
  }

  var request = JSON.parse(raw);
  return Match_settle(request);
}

/**
 * Run once from the editor to switch the relay on. Generates a secret if one
 * does not exist yet and prints what to put in the relay's environment.
 */
function setupRelay(relayUrl) {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty(RELAY.PROP_SECRET);
  if (!secret || secret.length < RELAY.MIN_SECRET_LENGTH) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty(RELAY.PROP_SECRET, secret);
  }
  if (relayUrl) props.setProperty(RELAY.PROP_URL, String(relayUrl).trim());

  var url = props.getProperty(RELAY.PROP_URL) || '(not set)';
  Logger.log('RELAY_SECRET = ' + secret);
  Logger.log('RELAY_URL    = ' + url);
  Logger.log('');
  Logger.log('Set these on the relay host:');
  Logger.log('  RELAY_SECRET=' + secret);
  Logger.log('  SETTLE_URL=<this web app\'s /exec URL>');
  return { secret: secret, url: url };
}

/** Run from the editor to turn the relay off; clients fall back to polling. */
function disableRelay() {
  PropertiesService.getScriptProperties().deleteProperty(RELAY.PROP_URL);
  Logger.log('Relay disabled. Clients will use Apps Script polling.');
}
