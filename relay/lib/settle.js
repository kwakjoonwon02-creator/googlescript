/**
 * Reports a finished match back to Apps Script, which owns ratings and
 * history.
 *
 * The room state machine is synchronous, so this returns a placeholder
 * immediately and patches the real numbers into the room once the web app
 * answers. Clients show the result screen straight away and the TR figures
 * count up when they land, which is what the result screen animates anyway.
 */
const crypto = require('crypto');

function createSettler(options) {
  const { url, secret, onSettled, fetchImpl, log } = options;
  const send = fetchImpl || globalThis.fetch;
  const note = log || (() => {});

  function post(request) {
    // Sign the exact string that travels, and send that string rather than
    // the object: re-serialising on the far side would make the signature
    // depend on key ordering surviving a parse.
    const payloadJson = JSON.stringify(request);
    const sig = crypto.createHmac('sha256', secret).update(payloadJson).digest('base64url');
    return send(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Apps Script answers a POST with a 302 to googleusercontent; following
      // it as a GET is the documented behaviour and returns the real body.
      redirect: 'follow',
      body: JSON.stringify({ op: 'settle', payloadJson: payloadJson, sig: sig })
    }).then(res => res.json());
  }

  /** Installed as ROOMS_OVERRIDES.settle. Must stay synchronous. */
  function settle(request) {
    if (!url || !secret) {
      note('settle skipped: relay is not configured to reach Apps Script');
      return { pending: false, ranked: false, delta: {}, scores: scoresOf(request) };
    }

    post(request).then(res => {
      if (!res || res.ok === false) throw new Error((res && res.error) || 'settle failed');
      onSettled(request.code, {
        winner: request.winner,
        scores: res.data.scores || scoresOf(request),
        ranked: !!res.data.ranked,
        delta: res.data.delta || {},
        pending: false,
        ts: Date.now()
      });
    }).catch(err => {
      note('settle failed for room ' + request.code + ': ' + err.message);
      onSettled(request.code, {
        winner: request.winner,
        scores: scoresOf(request),
        ranked: false,
        delta: {},
        pending: false,
        failed: true,
        ts: Date.now()
      });
    });

    return { pending: true, ranked: request.mode === 'ranked', delta: {}, scores: scoresOf(request) };
  }

  return { settle, post };
}

function scoresOf(request) {
  const out = {};
  (request.players || []).forEach(p => { out[p.id] = Number(p.wins || 0); });
  return out;
}

module.exports = { createSettler };
