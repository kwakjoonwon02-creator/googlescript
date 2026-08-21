/**
 * Ranked matchmaking.
 *
 * The queue is a single cache entry guarded by the script lock. Clients ping
 * it every couple of seconds; each ping also runs the pairing pass, so no
 * background trigger is needed and an empty queue costs nothing.
 */

var MM = {
  QUEUE_KEY: 'mm:queue:ranked',
  QUEUE_TTL: 900,
  // Entries stop being refreshed the moment a client stops polling.
  STALE_MS: 12000,
  BASE_BAND: 800,        // TR difference accepted immediately
  BAND_PER_SEC: 450,     // ...widened by this much for every second waited
  MAX_BAND: 30000,
  FT: 3
};

function MM_read_() {
  return Store_cacheGet(MM.QUEUE_KEY) || [];
}

function MM_write_(queue) {
  Store_cachePut(MM.QUEUE_KEY, queue, MM.QUEUE_TTL);
}

function MM_prune_(queue, now) {
  return queue.filter(function (e) { return (now - Number(e.ts)) < MM.STALE_MS; });
}

function MM_entryFor_(player, now) {
  return {
    id: player.id,
    name: player.name,
    tr: Math.round(Number(player.tr)),
    rank: player.rank,
    glicko: Number(player.glicko),
    rd: Number(player.rd),
    vol: Number(player.vol),
    games: Number(player.games),
    joinedAt: now,
    ts: now,
    room: null
  };
}

/**
 * Pairs everyone it can, closest ratings first. Each waiting player's
 * acceptable TR gap grows with time spent in the queue, so a lonely
 * high-rated player eventually gets a game.
 */
function MM_pair_(queue, now) {
  var waiting = queue.filter(function (e) { return !e.room; });
  waiting.sort(function (a, b) { return a.tr - b.tr; });

  var bandFor = function (entry) {
    var waited = Math.max(0, (now - Number(entry.joinedAt)) / 1000);
    return Math.min(MM.MAX_BAND, MM.BASE_BAND + waited * MM.BAND_PER_SEC);
  };

  for (var i = 0; i < waiting.length - 1; i++) {
    var a = waiting[i];
    if (a.room) continue;
    var b = waiting[i + 1];
    if (!b || b.room) continue;

    var gap = Math.abs(a.tr - b.tr);
    if (gap > Math.max(bandFor(a), bandFor(b))) continue;

    var room = Rooms_create(a, {
      ft: MM.FT,
      maxPlayers: 2,
      ranked: true,
      isPrivate: true,
      name: 'RANKED'
    }, 'ranked');
    room.players.push(Rooms_seatFor_(b));
    Rooms_save(room);

    a.room = room.code;
    b.room = room.code;
    i++; // b is taken; skip past it
  }
  return queue;
}

/* --------------------------------------------------------------- endpoints */

/**
 * Enters the queue if needed, runs a pairing pass, and reports back. Used by
 * both join and poll so the two behave identically — in particular, a join
 * that pairs straight away returns the room instead of making the client
 * wait for its next poll.
 */
function MM_enterAndResolve_(player, now) {
  return Store_withLock(6000, function () {
    var queue = MM_prune_(MM_read_(), now);
    var mine = null;
    for (var i = 0; i < queue.length; i++) {
      if (String(queue[i].id) === String(player.id)) { mine = queue[i]; break; }
    }
    if (!mine) {
      mine = MM_entryFor_(player, now);
      queue.push(mine);
    } else {
      mine.ts = now;
    }

    if (!mine.room) queue = MM_pair_(queue, now);

    if (mine.room) {
      // Matched: take our entry out of the queue and hand over the room.
      queue = queue.filter(function (e) { return String(e.id) !== String(player.id); });
      MM_write_(queue);
      return { queue: queue, room: Rooms_load(mine.room), joinedAt: mine.joinedAt };
    }

    MM_write_(queue);
    return { queue: queue, room: null, joinedAt: mine.joinedAt };
  });
}

function Api_queueJoin(payload) {
  var player = Players_authenticate(payload);
  // A rating nobody can sign back in to is not a rating.
  if (!Accounts_hasPassword_(player)) {
    throw new Error('경쟁 모드는 계정이 필요합니다. 설정에서 비밀번호를 등록해 주세요.');
  }
  var now = Store_now();
  var result = MM_enterAndResolve_(player, now);
  if (!result.ran) throw new Error('매치메이킹 서버가 혼잡합니다. 다시 시도해 주세요.');
  return MM_response_(result.value, player.id, now);
}

function Api_queuePoll(payload) {
  var player = Players_authenticate(payload);
  var now = Store_now();
  var result = MM_enterAndResolve_(player, now);
  if (!result.ran) return { matched: false, busy: true, waiting: 0 };
  return MM_response_(result.value, player.id, now);
}

function MM_response_(value, playerId, now) {
  if (value.room) {
    return {
      matched: true,
      room: Rooms_publicView_(value.room),
      waitedMs: Math.max(0, now - Number(value.joinedAt))
    };
  }
  return MM_statusFor_(value.queue, playerId, now);
}

function Api_queueLeave(payload) {
  var player = Players_authenticate(payload);
  Store_withLock(6000, function () {
    var queue = MM_read_().filter(function (e) { return String(e.id) !== String(player.id); });
    MM_write_(queue);
  });
  return { left: true };
}

function MM_statusFor_(queue, playerId, now) {
  var mine = null;
  for (var i = 0; i < queue.length; i++) {
    if (String(queue[i].id) === String(playerId)) { mine = queue[i]; break; }
  }
  var waited = mine ? Math.max(0, now - Number(mine.joinedAt)) : 0;
  return {
    matched: false,
    waiting: queue.filter(function (e) { return !e.room; }).length,
    waitedMs: waited,
    band: Math.round(Math.min(MM.MAX_BAND, MM.BASE_BAND + (waited / 1000) * MM.BAND_PER_SEC)),
    ft: MM.FT
  };
}

/** Called by the janitor trigger. */
function Matchmaking_sweep() {
  var now = Store_now();
  var removed = 0;
  Store_withLock(10000, function () {
    var queue = MM_read_();
    var kept = MM_prune_(queue, now);
    removed = queue.length - kept.length;
    MM_write_(kept);
  });
  return removed;
}
