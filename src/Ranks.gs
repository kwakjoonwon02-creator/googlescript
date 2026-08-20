/**
 * Ranks.
 *
 * TETR.IO assigns letter ranks by percentile of the ranked ladder, not by a
 * fixed TR threshold — so the same TR can be a different rank depending on
 * who else is playing. We do the same, and fall back to fixed TR cutoffs
 * while the ladder is too small for percentiles to mean anything.
 */

var RANKS = {
  // Ordered worst -> best. `pct` is the cumulative share of the ladder that
  // sits at this rank or below.
  LADDER: [
    { name: 'D',  pct: 1.000, color: '#856C84', tr: 0 },
    { name: 'D+', pct: 0.975, color: '#815880', tr: 1000 },
    { name: 'C-', pct: 0.950, color: '#6C417C', tr: 2000 },
    { name: 'C',  pct: 0.900, color: '#67287B', tr: 3000 },
    { name: 'C+', pct: 0.840, color: '#522278', tr: 4000 },
    { name: 'B-', pct: 0.780, color: '#5949BE', tr: 5000 },
    { name: 'B',  pct: 0.700, color: '#4357B5', tr: 6000 },
    { name: 'B+', pct: 0.620, color: '#4880B2', tr: 7000 },
    { name: 'A-', pct: 0.540, color: '#35AA8C', tr: 8500 },
    { name: 'A',  pct: 0.460, color: '#3EA750', tr: 10000 },
    { name: 'A+', pct: 0.380, color: '#43B536', tr: 11500 },
    { name: 'S-', pct: 0.300, color: '#B79E2B', tr: 13000 },
    { name: 'S',  pct: 0.230, color: '#D19E26', tr: 14500 },
    { name: 'S+', pct: 0.170, color: '#DBAF37', tr: 16000 },
    { name: 'SS', pct: 0.110, color: '#E39D3B', tr: 17500 },
    { name: 'U',  pct: 0.050, color: '#C75C2E', tr: 19000 },
    { name: 'X',  pct: 0.010, color: '#B852BF', tr: 21000 },
    { name: 'X+', pct: 0.001, color: '#FF3BFF', tr: 23000 }
  ],
  UNRANKED: { name: 'Z', color: '#666B7A' },
  CACHE_KEY: 'rank:cutoffs',
  CACHE_TTL: 300,
  // Below this many rated players, percentiles are noise — use TR cutoffs.
  MIN_LADDER: 20
};

function Ranks_byName(name) {
  for (var i = 0; i < RANKS.LADDER.length; i++) {
    if (RANKS.LADDER[i].name === name) return RANKS.LADDER[i];
  }
  return RANKS.UNRANKED;
}

function Ranks_index(name) {
  for (var i = 0; i < RANKS.LADDER.length; i++) {
    if (RANKS.LADDER[i].name === name) return i;
  }
  return -1;
}

/** Fixed-threshold fallback used before the ladder is populated. */
function Ranks_fromTR_(tr) {
  var best = RANKS.LADDER[0];
  for (var i = 0; i < RANKS.LADDER.length; i++) {
    if (tr >= RANKS.LADDER[i].tr) best = RANKS.LADDER[i];
  }
  return best.name;
}

/**
 * Recomputes the TR value that each rank begins at, from the current ladder.
 * Cached for a few minutes: it is a full sheet read.
 */
function Ranks_cutoffs(forceRefresh) {
  if (!forceRefresh) {
    var cached = Store_cacheGet(RANKS.CACHE_KEY);
    if (cached) return cached;
  }

  var players = Store_readAll('Players').filter(function (p) {
    return Number(p.games) >= GLICKO.PLACEMENT_GAMES;
  });

  var result = { count: players.length, cutoffs: null, ts: Store_now() };

  if (players.length >= RANKS.MIN_LADDER) {
    var trs = players.map(function (p) { return Number(p.tr) || 0; })
      .sort(function (a, b) { return b - a; }); // descending
    var cutoffs = {};
    RANKS.LADDER.forEach(function (rank) {
      if (rank.pct >= 1) {
        cutoffs[rank.name] = 0;
        return;
      }
      // The player at this percentile from the top defines the entry TR.
      var idx = Math.min(trs.length - 1, Math.max(0, Math.ceil(rank.pct * trs.length) - 1));
      cutoffs[rank.name] = trs[idx];
    });
    result.cutoffs = cutoffs;
  }

  Store_cachePut(RANKS.CACHE_KEY, result, RANKS.CACHE_TTL);
  return result;
}

/**
 * @param {number} tr
 * @param {number} games ranked games played
 * @return {string} rank name, or 'Z' while still in placements
 */
function Ranks_resolve(tr, games) {
  if (Number(games) < GLICKO.PLACEMENT_GAMES) return RANKS.UNRANKED.name;

  var info = Ranks_cutoffs();
  if (!info.cutoffs) return Ranks_fromTR_(tr);

  // Walk from the top rank down; the first cutoff we clear is our rank.
  for (var i = RANKS.LADDER.length - 1; i >= 0; i--) {
    var rank = RANKS.LADDER[i];
    if (tr >= info.cutoffs[rank.name]) return rank.name;
  }
  return RANKS.LADDER[0].name;
}

function Ranks_color(name) {
  var r = Ranks_byName(name);
  return r.color;
}

/** Everything the client needs to draw rank badges, sent once at bootstrap. */
function Ranks_clientTable() {
  return {
    ladder: RANKS.LADDER.map(function (r) {
      return { name: r.name, color: r.color, tr: r.tr, pct: r.pct };
    }),
    unranked: RANKS.UNRANKED,
    placementGames: GLICKO.PLACEMENT_GAMES
  };
}
