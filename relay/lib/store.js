/**
 * In-memory stand-in for the Store_* layer the room logic calls.
 *
 * Values are JSON round-tripped on the way in and out, exactly as
 * CacheService does. That matters: the room code loads an object, mutates
 * it, and expects the change to be invisible until it saves. Handing back a
 * live reference would make save() a no-op and hide real bugs.
 */
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createStore(clock) {
  const cache = new Map();   // key -> { json, expires }
  let lockDepth = 0;

  function alive(entry, now) {
    return entry && (entry.expires === 0 || entry.expires > now);
  }

  const api = {
    Store_now: () => clock.now(),

    Store_cacheGet(key) {
      const entry = cache.get(key);
      if (!alive(entry, clock.now())) { cache.delete(key); return null; }
      try { return JSON.parse(entry.json); } catch (e) { return null; }
    },

    Store_cachePut(key, value, ttlSeconds) {
      const ttl = ttlSeconds === undefined ? 600 : Number(ttlSeconds);
      cache.set(key, {
        json: JSON.stringify(value),
        expires: ttl > 0 ? clock.now() + ttl * 1000 : 0
      });
    },

    Store_cacheRemove(key) { cache.delete(key); },

    Store_cacheGetAll(keys) {
      const out = {};
      const now = clock.now();
      (keys || []).forEach(key => {
        const entry = cache.get(key);
        if (!alive(entry, now)) return;
        try { out[key] = JSON.parse(entry.json); } catch (e) {}
      });
      return out;
    },

    /**
     * The relay is single threaded and handles one message at a time, so
     * there is nothing to serialise against. Reentrancy is tracked only so
     * the semantics match Apps Script if the room code ever comes to depend
     * on them.
     */
    Store_withLock(timeoutMs, fn) {
      lockDepth++;
      try {
        return { ran: true, value: fn() };
      } finally {
        lockDepth--;
      }
    },

    Store_roomCode() {
      let out = '';
      for (let i = 0; i < 5; i++) {
        out += ROOM_CODE_ALPHABET.charAt(Math.floor(Math.random() * ROOM_CODE_ALPHABET.length));
      }
      return out;
    },

    // exposed for tests and diagnostics
    __cache: cache,
    __lockDepth: () => lockDepth
  };

  return api;
}

module.exports = { createStore };
