/* Glicko-2 and the TR transform, checked against the published example. */
const { makeGasSandbox } = require('./lib/gas-sandbox');
const { test: t, assert, close, section, note, finish } = require('./lib/report');

const s = makeGasSandbox();
const { Glicko_update, Glicko_toTR, Glicko_rateMatch, Glicko_winProbability, GLICKO } = s;

section('Glicko-2 reference (Glickman 2013, worked example)');
t('matches the published result within tolerance', () => {
  const r = Glicko_update({ glicko: 1500, rd: 200, vol: 0.06 }, [
    { glicko: 1400, rd: 30,  score: 1 },
    { glicko: 1550, rd: 100, score: 0 },
    { glicko: 1700, rd: 300, score: 0 }
  ]);
  note('rating=' + r.glicko.toFixed(2) + ' rd=' + r.rd.toFixed(2) + ' vol=' + r.vol.toFixed(6));
  close(r.glicko, 1464.06, 0.5, 'rating');
  close(r.rd, 151.52, 0.5, 'rd');
  close(r.vol, 0.05999, 0.0002, 'volatility');
});

section('behaviour');
t('winning raises the rating, losing lowers it', () => {
  const up = Glicko_update({ glicko: 1500, rd: 200, vol: 0.06 }, [{ glicko: 1500, rd: 200, score: 1 }]);
  const down = Glicko_update({ glicko: 1500, rd: 200, vol: 0.06 }, [{ glicko: 1500, rd: 200, score: 0 }]);
  if (!(up.glicko > 1500)) throw new Error('win did not raise rating');
  if (!(down.glicko < 1500)) throw new Error('loss did not lower rating');
});

t('rating deviation shrinks as games are played', () => {
  let p = { glicko: 1500, rd: 350, vol: 0.06 };
  const first = p.rd;
  for (let i = 0; i < 20; i++) {
    p = Glicko_update(p, [{ glicko: 1500, rd: 100, score: i % 2 }]);
  }
  if (!(p.rd < first)) throw new Error('rd did not shrink: ' + p.rd);
  if (p.rd < GLICKO.MIN_RD - 0.001) throw new Error('rd fell below the floor: ' + p.rd);
});

t('beating a stronger opponent gains more than beating a weaker one', () => {
  const vsStrong = Glicko_update({ glicko: 1500, rd: 150, vol: 0.06 }, [{ glicko: 1900, rd: 100, score: 1 }]);
  const vsWeak   = Glicko_update({ glicko: 1500, rd: 150, vol: 0.06 }, [{ glicko: 1100, rd: 100, score: 1 }]);
  if (!(vsStrong.glicko - 1500 > vsWeak.glicko - 1500)) throw new Error('upset was not rewarded more');
});

t('idle players only lose confidence, never rating', () => {
  const r = Glicko_update({ glicko: 1700, rd: 80, vol: 0.06 }, []);
  if (r.glicko !== 1700) throw new Error('rating moved without games');
  if (!(r.rd > 80)) throw new Error('rd did not grow while idle');
});

section('TR transform');
t('TR stays inside 0..25000 and rises with rating', () => {
  let prev = -1;
  for (let g = 0; g <= 3500; g += 250) {
    const tr = Glicko_toTR(g, 60);
    if (tr < 0 || tr > 25000) throw new Error('TR out of range at ' + g + ': ' + tr);
    if (tr < prev) throw new Error('TR not monotonic at ' + g);
    prev = tr;
  }
});

t('a fresh 1500/350 player sits mid-scale', () => {
  const tr = Glicko_toTR(1500, 350);
  note('fresh player TR = ' + tr.toFixed(0));
  close(tr, 12500, 1, 'default TR');
});

t('lower deviation pushes a strong player further up', () => {
  const unsure = Glicko_toTR(2000, 300);
  const sure = Glicko_toTR(2000, 60);
  note('2000 glicko: rd300 -> ' + unsure.toFixed(0) + ' TR, rd60 -> ' + sure.toFixed(0) + ' TR');
  if (!(sure > unsure)) throw new Error('confidence did not raise TR');
});

section('match rating');
t('only the match outcome counts, not the round score', () => {
  const a = { glicko: 1500, rd: 120, vol: 0.06 };
  const b = { glicko: 1500, rd: 120, vol: 0.06 };
  const sweep = Glicko_rateMatch(a, b, 3, 0);
  const close32 = Glicko_rateMatch(a, b, 3, 2);
  note('3-0 -> ' + sweep.p1.glicko.toFixed(1) + ',  3-2 -> ' + close32.p1.glicko.toFixed(1));
  close(sweep.p1.glicko, close32.p1.glicko, 0.001, 'round score must not change the rating');
});

t('winning a match never costs the winner rating', () => {
  // The regression this guards: rating each round separately made a heavy
  // favourite lose TR for a 3-1 win (-178 TR) because 75% fell short of their
  // 90% expected round win rate. Rating the match outcome alone fixes that.
  //
  // TR is allowed a hair of slack. It folds RD into the number, and a win
  // against someone hundreds of points below carries so little information
  // that RD grows slightly — worth about half a TR point on a 1200-point
  // mismatch, and invisible once rounded for display.
  const TR_SLACK = 1;
  const matchups = [[1500, 1500], [1900, 1500], [1500, 1900], [2400, 1200]];
  const scores = [[3, 0], [3, 1], [3, 2]];
  matchups.forEach(function (pair) {
    scores.forEach(function (score) {
      const winner = { glicko: pair[0], rd: 60, vol: 0.06 };
      const loser = { glicko: pair[1], rd: 60, vol: 0.06 };
      const res = Glicko_rateMatch(winner, loser, score[0], score[1]);
      const label = pair[0] + ' beat ' + pair[1] + ' ' + score.join('-');
      // The rating must rise. TR only has to not fall: a 1200-point favourite
      // gains so little that the displayed value can round to the same number.
      if (!(res.p1.glicko > winner.glicko)) {
        throw new Error(label + ' but rating went ' + winner.glicko + ' -> ' + res.p1.glicko);
      }
      if (!(res.p2.glicko < loser.glicko)) {
        throw new Error(label + ' but the loser gained rating');
      }
      const before = Glicko_toTR(winner.glicko, winner.rd);
      const after = Glicko_toTR(res.p1.glicko, res.p1.rd);
      if (after < before - TR_SLACK) {
        throw new Error(label + ' but TR fell ' + before.toFixed(1) + ' -> ' + after.toFixed(1));
      }
      if (Glicko_toTR(res.p2.glicko, res.p2.rd) > Glicko_toTR(loser.glicko, loser.rd) + TR_SLACK) {
        throw new Error(label + ' but the loser gained TR');
      }
    });
  });
  const heavy = Glicko_rateMatch({ glicko: 1900, rd: 60, vol: 0.06 }, { glicko: 1500, rd: 60, vol: 0.06 }, 3, 2);
  note('favourite beating an underdog 3-2: +' +
    Math.round(Glicko_toTR(heavy.p1.glicko, heavy.p1.rd) - Glicko_toTR(1900, 60)) + ' TR');
});

t('an upset still pays far more than an expected win', () => {
  const upset = Glicko_rateMatch({ glicko: 1500, rd: 60, vol: 0.06 }, { glicko: 1900, rd: 60, vol: 0.06 }, 3, 1);
  const expected = Glicko_rateMatch({ glicko: 1900, rd: 60, vol: 0.06 }, { glicko: 1500, rd: 60, vol: 0.06 }, 3, 1);
  const upsetGain = Glicko_toTR(upset.p1.glicko, upset.p1.rd) - Glicko_toTR(1500, 60);
  const expectedGain = Glicko_toTR(expected.p1.glicko, expected.p1.rd) - Glicko_toTR(1900, 60);
  note('upset +' + Math.round(upsetGain) + ' TR vs expected win +' + Math.round(expectedGain) + ' TR');
  if (!(upsetGain > expectedGain * 4)) throw new Error('upset was not rewarded enough');
});

t('the two sides move in opposite directions', () => {
  const res = Glicko_rateMatch(
    { glicko: 1500, rd: 120, vol: 0.06 },
    { glicko: 1500, rd: 120, vol: 0.06 }, 3, 1);
  if (!(res.p1.glicko > 1500 && res.p2.glicko < 1500)) throw new Error('winner/loser not symmetric');
});

t('win probability is 50% for identical players and ordered otherwise', () => {
  const even = Glicko_winProbability({ glicko: 1500, rd: 100 }, { glicko: 1500, rd: 100 });
  close(even, 0.5, 0.001, 'even matchup');
  const favoured = Glicko_winProbability({ glicko: 1900, rd: 100 }, { glicko: 1500, rd: 100 });
  if (!(favoured > 0.75)) throw new Error('favourite not favoured enough: ' + favoured);
});

t('a long ladder of results converges near the true strength', () => {
  // A player who beats 1600-rated opponents 75% of the time should settle
  // somewhere above 1600.
  let p = { glicko: 1500, rd: 350, vol: 0.06 };
  for (let period = 0; period < 40; period++) {
    const results = [];
    for (let g = 0; g < 4; g++) results.push({ glicko: 1600, rd: 60, score: g < 3 ? 1 : 0 });
    p = Glicko_update(p, results);
  }
  note('converged to ' + p.glicko.toFixed(0) + ' (rd ' + p.rd.toFixed(0) + ')');
  if (!(p.glicko > 1650 && p.glicko < 2100)) throw new Error('did not converge sensibly: ' + p.glicko);
});

process.exit(finish() ? 0 : 1);
