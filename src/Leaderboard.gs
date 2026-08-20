/**
 * Ladder and personal-best boards.
 * Cached, because every one of these is a full sheet read.
 */

var LEADERBOARD = {
  CACHE_KEY: 'lb:v1',
  CACHE_TTL: 60
};

function Leaderboard_top(limit, viewerId) {
  var cached = Store_cacheGet(LEADERBOARD.CACHE_KEY);
  var board;

  if (cached) {
    board = cached;
  } else {
    var rows = Store_readAll('Players');

    var ranked = rows
      .filter(function (p) { return Number(p.games) >= GLICKO.PLACEMENT_GAMES; })
      .sort(function (a, b) { return Number(b.tr) - Number(a.tr); })
      .map(function (p, i) {
        return {
          pos: i + 1,
          id: p.id,
          name: p.name,
          tr: Math.round(Number(p.tr)),
          rank: p.rank,
          rankColor: Ranks_color(p.rank),
          games: Number(p.games),
          wins: Number(p.wins),
          losses: Number(p.losses),
          apm: Number(p.apm),
          pps: Number(p.pps),
          vs: Number(p.vs)
        };
      });

    var sprint = rows
      .filter(function (p) { return Number(p.sprintBest) > 0; })
      .sort(function (a, b) { return Number(a.sprintBest) - Number(b.sprintBest); })
      .slice(0, 20)
      .map(function (p, i) {
        return { pos: i + 1, id: p.id, name: p.name, value: Number(p.sprintBest) };
      });

    var blitz = rows
      .filter(function (p) { return Number(p.blitzBest) > 0; })
      .sort(function (a, b) { return Number(b.blitzBest) - Number(a.blitzBest); })
      .slice(0, 20)
      .map(function (p, i) {
        return { pos: i + 1, id: p.id, name: p.name, value: Number(p.blitzBest) };
      });

    board = {
      ranked: ranked,
      sprint: sprint,
      blitz: blitz,
      totalPlayers: rows.length,
      rankedPlayers: ranked.length,
      updated: Store_now()
    };
    Store_cachePut(LEADERBOARD.CACHE_KEY, board, LEADERBOARD.CACHE_TTL);
  }

  // The viewer's own row is returned separately so it can be pinned even when
  // they are far outside the visible slice.
  var me = null;
  if (viewerId) {
    for (var i = 0; i < board.ranked.length; i++) {
      if (String(board.ranked[i].id) === String(viewerId)) {
        me = board.ranked[i];
        break;
      }
    }
  }

  return {
    ranked: board.ranked.slice(0, limit || 50),
    sprint: board.sprint,
    blitz: board.blitz,
    me: me,
    totalPlayers: board.totalPlayers,
    rankedPlayers: board.rankedPlayers,
    updated: board.updated
  };
}

function Leaderboard_invalidate() {
  Store_cacheRemove(LEADERBOARD.CACHE_KEY);
}
