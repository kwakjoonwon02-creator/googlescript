/**
 * Relay tickets.
 *
 * Apps Script owns identity; the relay must not have to ask it who someone
 * is on every connection. So Apps Script mints a short-lived ticket signed
 * with a shared secret, and the relay verifies it locally. The ticket also
 * carries the rating fields matchmaking needs, which saves a lookup.
 *
 * Format: base64url(payload JSON) "." base64url(HMAC-SHA256 of that string)
 */
const crypto = require('crypto');

function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function mint(player, secret, ttlSeconds) {
  const payload = Object.assign({}, player, {
    exp: Date.now() + (ttlSeconds || 3600) * 1000
  });
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return body + '.' + sign(body, secret);
}

/**
 * @return {{ok: true, player: object} | {ok: false, error: string}}
 */
function verify(ticket, secret, now) {
  if (typeof ticket !== 'string' || ticket.indexOf('.') === -1) {
    return { ok: false, error: 'malformed ticket' };
  }
  const cut = ticket.lastIndexOf('.');
  const body = ticket.slice(0, cut);
  const given = ticket.slice(cut + 1);
  const expected = sign(body, secret);

  // Constant-time compare; timingSafeEqual throws on a length mismatch.
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'bad signature' };
  }

  let player;
  try {
    player = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) {
    return { ok: false, error: 'unreadable ticket' };
  }
  if (!player || !player.id) return { ok: false, error: 'ticket has no player' };
  if (Number(player.exp) < (now === undefined ? Date.now() : now)) {
    return { ok: false, error: 'ticket expired' };
  }
  return { ok: true, player: player };
}

module.exports = { mint, verify, sign };
