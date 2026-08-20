/**
 * Match settlement: ratings, career stats and history.
 *
 * This is deliberately separate from Rooms.gs. Rooms is the realtime layer
 * and runs either here or on the relay; settlement always runs here, because
 * it is the only part that touches the spreadsheet. The relay calls
 * Match_settle over HTTPS with a signed payload and gets the same answer a
 * local call would produce.
 */

/**
 * @param {{mode:string, winner:string,
 *          players:Array<{id:string, wins:number, stats:object}>}} request
 * @return {{ranked:boolean, delta:object, scores:object}}
 */
function Match_settle(request) {
  var players = (request && request.players) || [];
  var result = { ranked: false, delta: {}, scores: {}, ts: Store_now() };
  players.forEach(function (p) { result.scores[p.id] = Number(p.wins || 0); });

  if (players.length !== 2) return result;

  var rec1 = Players_get(players[0].id);
  var rec2 = Players_get(players[1].id);
  if (!rec1 || !rec2) return result;

  var s1 = Number(players[0].wins || 0);
  var s2 = Number(players[1].wins || 0);
  var stats1 = players[0].stats || {};
  var stats2 = players[1].stats || {};

  var before = {
    tr1: Number(rec1.tr), tr2: Number(rec2.tr),
    rank1: rec1.rank, rank2: rec2.rank
  };

  if (request.mode === 'ranked') {
    result.ranked = true;
    var rated = Glicko_rateMatch(
      { glicko: Number(rec1.glicko), rd: Number(rec1.rd), vol: Number(rec1.vol) },
      { glicko: Number(rec2.glicko), rd: Number(rec2.rd), vol: Number(rec2.vol) },
      s1, s2
    );
    Match_applyRating_(rec1, rated.p1, s1 > s2, s1, s2, stats1);
    Match_applyRating_(rec2, rated.p2, s2 > s1, s2, s1, stats2);
    Leaderboard_invalidate();
  } else {
    Match_applyCasual_(rec1, s1, s2, stats1);
    Match_applyCasual_(rec2, s2, s1, stats2);
  }

  result.delta[rec1.id] = {
    trBefore: Math.round(before.tr1), trAfter: Math.round(Number(rec1.tr)),
    rankBefore: before.rank1, rank: rec1.rank, games: Number(rec1.games)
  };
  result.delta[rec2.id] = {
    trBefore: Math.round(before.tr2), trAfter: Math.round(Number(rec2.tr)),
    rankBefore: before.rank2, rank: rec2.rank, games: Number(rec2.games)
  };

  Store_appendRow('Matches', {
    id: Store_uid('m_'),
    ts: Store_now(),
    mode: request.mode,
    p1: rec1.id, p1name: rec1.name,
    p2: rec2.id, p2name: rec2.name,
    score1: s1, score2: s2,
    winner: request.winner,
    tr1Before: Math.round(before.tr1), tr1After: Math.round(Number(rec1.tr)),
    tr2Before: Math.round(before.tr2), tr2After: Math.round(Number(rec2.tr)),
    stats: JSON.stringify({ p1: stats1, p2: stats2 })
  });

  return result;
}

/** Rolling average of the player's performance stats over their career. */
function Match_blendStats_(record, stats) {
  var n = Number(record.games) || 0;
  var blend = function (oldValue, sample) {
    var prev = Number(oldValue) || 0;
    var next = Number(sample);
    if (!isFinite(next) || next <= 0) return prev;
    if (n === 0) return next;
    // Weight recent games a little more heavily than a pure mean would.
    var w = Math.min(0.25, 1 / (n + 1) + 0.05);
    return prev * (1 - w) + next * w;
  };
  record.apm = Math.round(blend(record.apm, stats.apm) * 100) / 100;
  record.pps = Math.round(blend(record.pps, stats.pps) * 100) / 100;
  record.vs = Math.round(blend(record.vs, stats.vs) * 100) / 100;
  record.totalLines = (Number(record.totalLines) || 0) + (Number(stats.lines) || 0);
  record.totalPieces = (Number(record.totalPieces) || 0) + (Number(stats.pieces) || 0);
}

function Match_applyRating_(record, rated, won, myRounds, theirRounds, stats) {
  Match_blendStats_(record, stats);

  record.glicko = rated.glicko;
  record.rd = rated.rd;
  record.vol = rated.vol;
  record.tr = Glicko_toTR(rated.glicko, rated.rd);
  record.games = (Number(record.games) || 0) + 1;
  record.wins = (Number(record.wins) || 0) + (won ? 1 : 0);
  record.losses = (Number(record.losses) || 0) + (won ? 0 : 1);
  record.roundsWon = (Number(record.roundsWon) || 0) + Number(myRounds || 0);
  record.roundsLost = (Number(record.roundsLost) || 0) + Number(theirRounds || 0);

  var streak = Number(record.streak) || 0;
  record.streak = won ? (streak >= 0 ? streak + 1 : 1) : (streak <= 0 ? streak - 1 : -1);
  record.bestStreak = Math.max(Number(record.bestStreak) || 0, record.streak);

  if (Number(record.tr) > (Number(record.peakTr) || 0)) record.peakTr = Number(record.tr);
  record.rank = Ranks_resolve(Number(record.tr), Number(record.games));
  if (Ranks_index(record.rank) > Ranks_index(record.bestRank)) record.bestRank = record.rank;
  record.lastSeen = Store_now();

  Players_save(record);
}

function Match_applyCasual_(record, myRounds, theirRounds, stats) {
  Match_blendStats_(record, stats);
  record.roundsWon = (Number(record.roundsWon) || 0) + Number(myRounds || 0);
  record.roundsLost = (Number(record.roundsLost) || 0) + Number(theirRounds || 0);
  record.lastSeen = Store_now();
  Players_save(record);
}
