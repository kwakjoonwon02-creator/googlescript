/**
 * Glicko-2 rating system (Glickman, 2013) plus the TR transform.
 *
 * TETR.IO rates players with Glicko-2 and displays a derived 0-25000 number
 * called TR (Tetra Rating). We do the same: glicko/rd/vol are the truth,
 * TR is what the player sees.
 */

var GLICKO = {
  DEFAULT_RATING: 1500,
  DEFAULT_RD: 350,
  DEFAULT_VOL: 0.06,
  TAU: 0.5,          // system volatility constraint; smaller = steadier ratings
  SCALE: 173.7178,   // Glicko-2 conversion constant
  EPSILON: 0.000001,
  MIN_RD: 45,        // floor so established players still move a little
  MAX_RD: 350,
  PLACEMENT_GAMES: 10
};

/**
 * Updates one player against a list of opponents.
 *
 * @param {{glicko:number, rd:number, vol:number}} player
 * @param {Array<{glicko:number, rd:number, score:number}>} results
 *        score is 1 win / 0.5 draw / 0 loss.
 * @return {{glicko:number, rd:number, vol:number}}
 */
function Glicko_update(player, results) {
  var mu = (player.glicko - GLICKO.DEFAULT_RATING) / GLICKO.SCALE;
  var phi = player.rd / GLICKO.SCALE;
  var sigma = player.vol;

  if (!results || !results.length) {
    // No games: uncertainty grows toward the maximum.
    var phiStar0 = Math.sqrt(phi * phi + sigma * sigma);
    return {
      glicko: player.glicko,
      rd: Math.min(GLICKO.MAX_RD, phiStar0 * GLICKO.SCALE),
      vol: sigma
    };
  }

  var opponents = results.map(function (r) {
    return {
      mu: (r.glicko - GLICKO.DEFAULT_RATING) / GLICKO.SCALE,
      phi: r.rd / GLICKO.SCALE,
      score: r.score
    };
  });

  // Step 3: estimated variance of the rating based only on game outcomes.
  var vInv = 0;
  opponents.forEach(function (o) {
    var g = Glicko_g_(o.phi);
    var e = Glicko_E_(mu, o.mu, o.phi);
    vInv += g * g * e * (1 - e);
  });
  var v = 1 / vInv;

  // Step 4: estimated improvement.
  var sum = 0;
  opponents.forEach(function (o) {
    sum += Glicko_g_(o.phi) * (o.score - Glicko_E_(mu, o.mu, o.phi));
  });
  var delta = v * sum;

  // Step 5: new volatility via the Illinois variant of regula falsi.
  var sigmaPrime = Glicko_volatility_(phi, v, delta, sigma);

  // Step 6-7: new rating deviation and rating.
  var phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime);
  var phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  var muPrime = mu + phiPrime * phiPrime * sum;

  var rd = phiPrime * GLICKO.SCALE;
  return {
    glicko: muPrime * GLICKO.SCALE + GLICKO.DEFAULT_RATING,
    rd: Math.max(GLICKO.MIN_RD, Math.min(GLICKO.MAX_RD, rd)),
    vol: sigmaPrime
  };
}

function Glicko_g_(phi) {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function Glicko_E_(mu, muJ, phiJ) {
  return 1 / (1 + Math.exp(-Glicko_g_(phiJ) * (mu - muJ)));
}

function Glicko_volatility_(phi, v, delta, sigma) {
  var a = Math.log(sigma * sigma);
  var tau = GLICKO.TAU;
  var phi2 = phi * phi;
  var delta2 = delta * delta;

  var f = function (x) {
    var ex = Math.exp(x);
    var num = ex * (delta2 - phi2 - v - ex);
    var den = 2 * Math.pow(phi2 + v + ex, 2);
    return num / den - (x - a) / (tau * tau);
  };

  var A = a;
  var B;
  if (delta2 > phi2 + v) {
    B = Math.log(delta2 - phi2 - v);
  } else {
    var k = 1;
    while (f(a - k * tau) < 0 && k < 100) k++;
    B = a - k * tau;
  }

  var fA = f(A);
  var fB = f(B);
  var guard = 0;
  while (Math.abs(B - A) > GLICKO.EPSILON && guard++ < 200) {
    var C = A + ((A - B) * fA) / (fB - fA);
    var fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }
  return Math.exp(A / 2);
}

/**
 * TETR.IO's published glicko -> TR transform. Confidence (rd) is folded in,
 * so a provisional player sits closer to the middle of the scale than their
 * raw rating alone would suggest.
 */
function Glicko_toTR(glicko, rd) {
  var ln10 = Math.LN10;
  var denom = Math.sqrt(
    3 * ln10 * ln10 * rd * rd +
    2500 * (64 * Math.PI * Math.PI + 147 * ln10 * ln10)
  );
  var exponent = ((GLICKO.DEFAULT_RATING - glicko) * Math.PI) / denom;
  var tr = 25000 / (1 + Math.pow(10, exponent));
  return Math.max(0, Math.min(25000, tr));
}

/** Expected score of A against B, used for the pre-match win probability. */
function Glicko_winProbability(a, b) {
  var muA = (a.glicko - GLICKO.DEFAULT_RATING) / GLICKO.SCALE;
  var muB = (b.glicko - GLICKO.DEFAULT_RATING) / GLICKO.SCALE;
  var phi = Math.sqrt((a.rd * a.rd + b.rd * b.rd) / 2) / GLICKO.SCALE;
  return Glicko_E_(muA, muB, phi);
}

/**
 * Rates one finished match. A best-of series is fed in as one Glicko-2
 * rating period: each round is a separate result against the same opponent,
 * which is what TETR.IO does for its FT matches.
 */
function Glicko_rateMatch(p1, p2, score1, score2) {
  var r1 = [];
  var r2 = [];
  for (var i = 0; i < score1; i++) {
    r1.push({ glicko: p2.glicko, rd: p2.rd, score: 1 });
    r2.push({ glicko: p1.glicko, rd: p1.rd, score: 0 });
  }
  for (var j = 0; j < score2; j++) {
    r1.push({ glicko: p2.glicko, rd: p2.rd, score: 0 });
    r2.push({ glicko: p1.glicko, rd: p1.rd, score: 1 });
  }
  return {
    p1: Glicko_update(p1, r1),
    p2: Glicko_update(p2, r2)
  };
}
