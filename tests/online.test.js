/* Two real browser tabs playing each other against one shared backend:
   seed agreement, garbage delivery, round flow, and rating settlement. */
const { spawn } = require('child_process');
const path = require('path');
const { chromium, launchOptions } = require('./lib/browser');
const { testAsync: t, assert, eq, section, note, finish } = require('./lib/report');

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [path.join(__dirname, 'serve.js')], { cwd: __dirname });
    proc.stdout.on('data', d => {
      const m = /PORT=(\d+)/.exec(String(d));
      if (m) resolve({ proc, port: Number(m[1]) });
    });
    proc.stderr.on('data', d => console.error('server:', String(d).trim()));
    setTimeout(() => reject(new Error('server did not start')), 8000);
  });
}

async function setName(page, name) {
  await page.waitForSelector('#screen-menu.active', { timeout: 15000 });
  if (await page.isVisible('#modal-host.open')) {
    await page.fill('#modal-body input.input', name);
    await page.click('#modal-body button.primary');
    await page.waitForSelector('#modal-host:not(.open)', { state: 'attached', timeout: 8000 });
  }
}


/** Plays a match out by dropping a few pieces each round and then topping the
 *  loser out, until both clients land on the result screen. */
async function driveMatch(loser, winner, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 90000);
  let toppedRound = -1;
  while (Date.now() < deadline) {
    const st = await loser.evaluate(() => {
      const g = Game.state();
      return { phase: g.phase, round: g.room && g.room.round, state: g.room && g.room.state };
    });
    if (st.state === 'matchover') break;
    if (st.phase === 'playing' && st.round !== toppedRound) {
      toppedRound = st.round;
      // Put a known number of pieces on both boards so the match totals are
      // checkable. Driving the engine directly keeps the count exact; the
      // keyboard path is covered by the single-client suite.
      // Both clients must actually be in the round before either places a
      // piece, or the winner's drops land on an engine that is not live yet.
      await winner.waitForFunction(() => Game.state().phase === 'playing', null, { timeout: 20000 });
      const place = () => {
        const e = Game.state().engine;
        for (let i = 0; i < 4; i++) if (e.alive) e.hardDrop();
      };
      await winner.evaluate(place);
      await loser.evaluate(place);
      await loser.evaluate(() => Game.state().engine.topOut());
    }
    await loser.waitForTimeout(300);
  }
  await winner.waitForSelector('#screen-result.active', { timeout: 30000 });
  await loser.waitForSelector('#screen-result.active', { timeout: 30000 });
}

(async () => {
  const { proc, port } = await startServer();
  const browser = await chromium.launch(launchOptions());
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const errs = [];
  [A, B].forEach((p, i) => p.on('pageerror', e => errs.push('P' + i + ': ' + e.message)));

  const url = 'http://127.0.0.1:' + port + '/';
  await A.goto(url);
  await B.goto(url);

  section('two clients, one room');
  let code = null;

  await t('both clients boot with separate profiles', async () => {
    await setName(A, 'PlayerA');
    await setName(B, 'PlayerB');
    eq(await A.textContent('#me-name'), 'PlayerA');
    eq(await B.textContent('#me-name'), 'PlayerB');
  });

  await t('A creates a room and B joins by code', async () => {
    await A.click('[data-nav="multi"]');
    await A.waitForSelector('#screen-multi.active');
    await A.click('#btn-create-room');
    await A.waitForSelector('#screen-room.active', { timeout: 10000 });
    code = (await A.textContent('#room-code-big')).trim();
    assert(/^[A-Z0-9]{5}$/.test(code), 'bad code: ' + code);

    await B.click('[data-nav="multi"]');
    await B.waitForSelector('#screen-multi.active');
    await B.fill('#join-code', code);
    await B.click('#btn-join-code');
    await B.waitForSelector('#screen-room.active', { timeout: 10000 });
  });

  await t('each client sees the other in the lobby', async () => {
    await A.waitForFunction(() => document.querySelectorAll('#room-players .switch-row').length === 2, null, { timeout: 12000 });
    await B.waitForFunction(() => document.querySelectorAll('#room-players .switch-row').length === 2, null, { timeout: 12000 });
    const list = await A.textContent('#room-players');
    assert(/PlayerB/.test(list), 'A cannot see B: ' + list);
  });

  await t('readying up starts the countdown on both sides', async () => {
    await A.click('#btn-ready');
    await B.click('#btn-ready');
    await A.waitForFunction(() => Game.state().room && Game.state().room.state !== 'lobby', null, { timeout: 15000 });
    await B.waitForFunction(() => Game.state().room && Game.state().room.state !== 'lobby', null, { timeout: 15000 });
  });

  await t('both clients reach the playing phase', async () => {
    await A.waitForFunction(() => Game.state().phase === 'playing', null, { timeout: 20000 });
    await B.waitForFunction(() => Game.state().phase === 'playing', null, { timeout: 20000 });
    await A.waitForSelector('#screen-game.active');
    await B.waitForSelector('#screen-game.active');
  });

  await t('both clients generate the identical piece sequence from the shared seed', async () => {
    const seqA = await A.evaluate(() => Game.state().engine.piece.type + ':' + Game.state().engine.bag.peek(12).join(''));
    const seqB = await B.evaluate(() => Game.state().engine.piece.type + ':' + Game.state().engine.bag.peek(12).join(''));
    eq(seqA, seqB, 'piece order diverged');
    note('shared queue: ' + seqA);
  });

  await t('each client renders the opponent board', async () => {
    await A.waitForFunction(() => {
      const ids = Object.keys(Game.state().opponents);
      return ids.length === 1 && Game.state().opponents[ids[0]].board;
    }, null, { timeout: 15000 });
    const painted = await A.evaluate(() => {
      const c = document.querySelector('.opponent canvas');
      if (!c) return -1;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    });
    assert(painted > 500, 'opponent board not painted: ' + painted);
  });

  await t('an attack sent by A arrives as garbage on B', async () => {
    const before = await B.evaluate(() => Game.state().engine.stats.received);
    await A.evaluate(() => {
      const g = Game.state();
      const target = Object.keys(g.opponents)[0];
      g.myAttackLog.push({ i: 9001, n: 6, t: Date.now(), to: target, r: g.currentRound });
      g.lastSyncAt = 0;   // push it out on the next frame
    });
    await B.waitForFunction(
      (before) => Game.state().engine.stats.received > before,
      before, { timeout: 15000 });
    const got = await B.evaluate(() => Game.state().engine.stats.received);
    eq(got - before, 6, 'garbage amount');
  });

  await t('a top-out awards the round to the survivor on both clients', async () => {
    await A.evaluate(() => Game.state().engine.topOut());
    await B.waitForFunction(() => Game.state().room.state === 'roundover' || Game.state().room.state === 'countdown',
      null, { timeout: 20000 });
    const winner = await B.evaluate(() => Game.state().room.roundWinner);
    const myId = await B.evaluate(() => Net.creds().id);
    eq(winner, myId, 'B should have won the round');
    const pipsOn = await B.evaluate(() => document.querySelectorAll('#ss-my-pips .pip.on').length);
    eq(pipsOn, 1, 'B score pip');
    const pipsOnA = await A.evaluate(() => document.querySelectorAll('#ss-op-pips .pip.on').length);
    eq(pipsOnA, 1, 'A sees the opponent pip');
  });

  await t('the next round restarts both clients with a new seed', async () => {
    const prevSeed = await B.evaluate(() => Game.state().room.seed);
    await A.waitForFunction(() => Game.state().room.round === 2, null, { timeout: 25000 });
    await B.waitForFunction(() => Game.state().room.round === 2, null, { timeout: 25000 });
    const newSeed = await B.evaluate(() => Game.state().room.seed);
    assert(newSeed !== prevSeed, 'seed was reused');
    await A.waitForFunction(() => Game.state().phase === 'playing', null, { timeout: 25000 });
    await B.waitForFunction(() => Game.state().phase === 'playing', null, { timeout: 25000 });
    const a = await A.evaluate(() => Game.state().engine.bag.peek(8).join(''));
    const b = await B.evaluate(() => Game.state().engine.bag.peek(8).join(''));
    eq(a, b, 'round 2 queues diverged');
    eq(await A.evaluate(() => Game.state().engine.stats.pieces), 0, 'board was not reset');
  });

  await t('B takes the match and both clients land on the result screen', async () => {
    await driveMatch(A, B);
    const bText = await B.textContent('#result-card');
    const aText = await A.textContent('#result-card');
    assert(/VICTORY/.test(bText), 'B result: ' + bText.slice(0, 80));
    assert(/DEFEAT/.test(aText), 'A result: ' + aText.slice(0, 80));
    assert(/3\s*—\s*0/.test(bText), 'score line missing: ' + bText.slice(0, 160));
  });

  await t('the result screen reports totals for the whole match, not one round', async () => {
    const stats = await B.evaluate(() => {
      const cells = {};
      document.querySelectorAll('#result-card .stat-cell').forEach(c => {
        cells[c.querySelector('.k').textContent] = c.querySelector('.v').textContent;
      });
      return cells;
    });
    note(JSON.stringify(stats));
    // driveMatch places exactly 4 pieces per round it drives. Round 1 was
    // already played by the tests above, so this match contributes 2 rounds:
    // anything above 4 proves more than the final round is being counted.
    const pieces = Number(stats.Pieces);
    eq(pieces % 4, 0, 'unexpected piece count ' + pieces);
    assert(pieces > 4, 'pieces did not accumulate across rounds: ' + pieces);
    assert(Number(stats.PPS) > 0, 'PPS is zero: ' + stats.PPS);
  });

  await t('a casual match leaves TR untouched', async () => {
    const bText = await B.textContent('#result-card');
    assert(!/\bTR\b/.test(bText), 'casual match should not show a TR change');
    await B.click('#btn-result-menu');
    await B.waitForSelector('#screen-menu.active', { timeout: 10000 });
    eq(await B.textContent('#me-tr'), '12,500', 'TR moved in a casual match');
  });

  section('ranked, end to end');
  await t('two queued clients are matched into a ranked room', async () => {
    await A.click('#btn-result-menu');
    await A.waitForSelector('#screen-menu.active', { timeout: 10000 });
    await A.click('[data-nav="ranked"]');
    await A.waitForSelector('#screen-queue.active');
    await B.click('[data-nav="ranked"]');
    // Ranked auto-readies, so both clients pass through the lobby in well
    // under a second. Wait on the room they hold, not the screen they are on.
    const inRanked = () => Game.state().room && Game.state().room.mode === 'ranked';
    await A.waitForFunction(inRanked, null, { timeout: 30000 });
    await B.waitForFunction(inRanked, null, { timeout: 30000 });
    eq(await A.evaluate(() => Game.state().room.code),
       await B.evaluate(() => Game.state().room.code), 'same ranked room');
    eq(await A.evaluate(() => Game.state().room.config.ft), 3, 'ranked is FT3');
    eq(await A.textContent('#room-mode-badge'), 'RANKED', 'room mode badge');
    assert(await A.evaluate(() => Game.isReady()), 'ranked should auto-ready');
  });

  await t('the ranked match plays out and settles TR on both sides', async () => {
    await A.waitForFunction(() => Game.state().phase === 'playing', null, { timeout: 40000 });
    await driveMatch(B, A);
    const aText = await A.textContent('#result-card');
    assert(/VICTORY/.test(aText), 'A should win: ' + aText.slice(0, 80));
    assert(/TR/.test(aText), 'TR change not shown: ' + aText.slice(0, 240));
    const trLine = await A.evaluate(() => {
      const n = document.querySelector('.tr-delta');
      return n ? n.textContent.trim() : null;
    });
    const bDelta = await B.evaluate(() => {
      const n = document.querySelector('.tr-delta');
      return n ? n.textContent.trim() : null;
    });
    note('winner ' + trLine + ' / loser ' + bDelta);
    assert(trLine && /^\+/.test(trLine), 'winner did not gain TR: ' + trLine);
    assert(bDelta && /^-/.test(bDelta), 'loser did not lose TR: ' + bDelta);
  });

  await t('placement progress is surfaced to the player', async () => {
    const aText = await A.textContent('#result-card');
    assert(/배치 경기 1\/10/.test(aText), 'placement line missing: ' + aText.slice(-200));
  });

  await t('no uncaught errors on either client', async () => {
    const a = await A.evaluate(() => window.__errors);
    const b = await B.evaluate(() => window.__errors);
    assert(a.length === 0 && b.length === 0 && errs.length === 0,
      'A=' + JSON.stringify(a) + ' B=' + JSON.stringify(b) + ' page=' + JSON.stringify(errs));
  });

  await t('no RPC failed on either client', async () => {
    const bad = [];
    for (const p of [A, B]) {
      const log = await p.evaluate(() => window.__rpcLog);
      log.filter(r => !r.ok).forEach(r => bad.push(r));
    }
    // A sync issued right as a room is torn down can legitimately 404.
    const real = bad.filter(r => r.error !== 'ROOM_GONE');
    assert(real.length === 0, 'failed rpcs: ' + JSON.stringify(real.slice(0, 5)));
  });

  await browser.close();
  proc.kill();
  process.exit(finish() ? 0 : 1);
})();
