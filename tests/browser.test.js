/* Drives the real client in Chromium: boot, a full solo run, a CPU match,
   every menu screen, and the settings/keybind UI. */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium, launchOptions } = require('./lib/browser');
const { writePage } = require('./lib/build-page');
const { testAsync: t, assert, eq, section, note, finish } = require('./lib/report');

(async () => {
  const pagePath = writePage('local', path.join(os.tmpdir(), 'tetra-gs-test', 'local.html'));
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

  await page.goto('file://' + pagePath);

  section('boot');
  await t('the menu appears after bootstrap', async () => {
    await page.waitForSelector('#screen-menu.active', { timeout: 10000 });
    const name = await page.textContent('#me-name');
    assert(name && name !== '—', 'profile name not filled in: ' + name);
    const tr = await page.textContent('#me-tr');
    eq(tr, '12,500', 'starting TR');
  });

  await t('a nickname prompt is shown to a brand new player', async () => {
    const open = await page.isVisible('#modal-host.open');
    assert(open, 'no nickname modal for a new account');
    await page.fill('#modal-body input.input', 'Tester');
    await page.click('#modal-body button.primary');
    await page.waitForSelector('#modal-host:not(.open)', { state: 'attached', timeout: 5000 });
    eq(await page.textContent('#me-name'), 'Tester', 'name did not stick');
  });

  await t('no uncaught errors during boot', async () => {
    const errs = await page.evaluate(() => window.__errors);
    assert(errs.length === 0, 'errors: ' + JSON.stringify(errs));
    const bad = consoleErrors.filter(e => !/favicon|fonts\.(googleapis|gstatic)|ERR_/.test(e));
    assert(bad.length === 0, 'console: ' + bad.join(' | '));
  });

  section('solo: 40 lines');
  await t('sprint starts and the countdown clears', async () => {
    await page.click('[data-nav="solo"]');
    await page.waitForSelector('#screen-solo.active');
    await page.click('[data-solo="sprint"]');
    await page.waitForSelector('#screen-game.active');
    await page.waitForFunction(() => Game.state().phase === 'playing', null, { timeout: 8000 });
  });

  await t('the board canvas actually paints', async () => {
    const blank = await page.evaluate(() => {
      const c = document.querySelector('#board');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let nonTransparent = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nonTransparent++;
      return nonTransparent;
    });
    assert(blank > 10000, 'board looks empty (' + blank + ' painted pixels)');
  });

  await t('hard drop places pieces and updates the HUD', async () => {
    const before = await page.evaluate(() => Game.state().engine.stats.pieces);
    for (let i = 0; i < 5; i++) { await page.keyboard.press('Space'); await page.waitForTimeout(60); }
    const after = await page.evaluate(() => Game.state().engine.stats.pieces);
    eq(after - before, 5, 'pieces locked');
    eq(await page.textContent('#s-pieces'), String(after), 'HUD piece counter');
  });

  await t('left/right move the active piece', async () => {
    const x0 = await page.evaluate(() => Game.state().engine.piece.x);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(40);
    const x1 = await page.evaluate(() => Game.state().engine.piece.x);
    eq(x1, x0 - 1, 'left move');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(40);
    eq(await page.evaluate(() => Game.state().engine.piece.x), x0, 'right move');
  });

  await t('DAS slides the piece to the wall', async () => {
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(400);
    await page.keyboard.up('ArrowLeft');
    const minX = await page.evaluate(() => Math.min.apply(null, Game.state().engine.pieceCells().map(c => c[0])));
    eq(minX, 0, 'did not reach the left wall');
  });

  await t('rotation and hold work', async () => {
    const r0 = await page.evaluate(() => Game.state().engine.piece.rotation);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(40);
    const r1 = await page.evaluate(() => Game.state().engine.piece.rotation);
    assert(r1 !== r0 || (await page.evaluate(() => Game.state().engine.piece.type)) === 'O', 'rotation did nothing');

    const type = await page.evaluate(() => Game.state().engine.piece.type);
    await page.keyboard.press('KeyC');
    await page.waitForTimeout(60);
    eq(await page.evaluate(() => Game.state().engine.hold), type, 'hold did not take the piece');
  });

  await t('the next queue and hold boxes paint', async () => {
    const painted = await page.evaluate(() => {
      function count(sel) {
        const c = document.querySelector(sel), ctx = c.getContext('2d');
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n;
      }
      return { next: count('#next-canvas'), hold: count('#hold-canvas') };
    });
    assert(painted.next > 500, 'next queue blank (' + painted.next + ')');
    assert(painted.hold > 200, 'hold box blank (' + painted.hold + ')');
  });

  await t('finishing 40 lines shows the result screen', async () => {
    await page.evaluate(() => {
      const e = Game.state().engine;
      e.stats.lines = 39;
      e.elapsed = 41230;
    });
    // Clear a line for real so the goal check fires through the normal path.
    await page.evaluate(() => {
      const e = Game.state().engine;
      e.cells.fill(0);
      for (let x = 0; x < 10; x++) if (x !== 4) e.cells[(BOARD_H - 1) * BOARD_W + x] = 8;
      e.spawn('I'); e.piece.rotation = 1; e.piece.x = 2;
    });
    await page.keyboard.press('Space');
    await page.waitForSelector('#screen-result.active', { timeout: 8000 });
    const text = await page.textContent('#result-card');
    assert(/40 LINES/.test(text), 'result headline missing: ' + text.slice(0, 120));
    assert(/APM/.test(text) && /PPS/.test(text), 'stat grid missing');
  });

  await t('the personal best is persisted to the profile', async () => {
    await page.click('#btn-result-menu');
    await page.waitForSelector('#screen-menu.active');
    const best = await page.textContent('#me-sprint');
    assert(best !== '—', 'sprint best not shown: ' + best);
  });

  section('vs cpu');
  await t('a CPU match starts and both boards run', async () => {
    await page.click('[data-nav="cpu"]');
    await page.waitForSelector('#modal-host.open');
    await page.click('#modal-body .menu-item:nth-child(6)');   // level 5
    await page.waitForSelector('#screen-game.active');
    await page.waitForFunction(() => Game.state().phase === 'playing', null, { timeout: 8000 });
    await page.waitForFunction(() => Game.state().aiEngine.stats.pieces > 3, null, { timeout: 15000 });
    const painted = await page.evaluate(() => {
      const c = document.querySelector('#op-canvas-cpu');
      if (!c) return -1;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    });
    assert(painted > 1000, 'opponent board not painted (' + painted + ')');
  });

  await t('the score strip and pips render for versus', async () => {
    assert(await page.isVisible('#score-strip'), 'score strip hidden');
    const pips = await page.evaluate(() => document.querySelectorAll('#ss-my-pips .pip').length);
    eq(pips, 3, 'FT3 pips');
  });

  await t('CPU attacks reach the player as garbage', async () => {
    const got = await page.evaluate(async () => {
      // Fire an attack from the bot and let the game loop route it.
      const g = Game.state();
      g.aiEngine.outbox.push({ i: 999, n: 4, t: Date.now() });
      await new Promise(r => setTimeout(r, 250));
      return g.engine.pendingGarbageCount() + g.engine.stats.received;
    });
    assert(got >= 4, 'garbage did not arrive (' + got + ')');
  });

  await t('the garbage meter reflects pending lines', async () => {
    const h = await page.evaluate(() => document.querySelector('#garbage-fill').style.height);
    assert(h && parseFloat(h) > 0, 'meter empty: ' + h);
  });

  await t('escape leaves the CPU match', async () => {
    await page.keyboard.press('Escape');
    await page.waitForSelector('#screen-menu.active', { timeout: 5000 });
  });

  section('other screens');
  await t('leaderboard renders', async () => {
    await page.click('[data-nav="leaderboard"]');
    await page.waitForSelector('#screen-leaderboard.active');
    await page.waitForFunction(() => !/불러오는 중/.test(document.querySelector('#lb-body').textContent), null, { timeout: 8000 });
    await page.click('[data-lb="sprint"]');
    const body = await page.textContent('#lb-body');
    assert(/Tester/.test(body), 'sprint board missing our record: ' + body.slice(0, 160));
  });

  await t('settings screen builds the keybind list and toggles', async () => {
    await page.click('#screen-leaderboard [data-nav="menu"]');
    await page.waitForSelector('#screen-menu.active');
    await page.click('#btn-config');
    await page.waitForSelector('#screen-config.active');
    const rows = await page.evaluate(() => document.querySelectorAll('#keybinds .keybind-row').length);
    eq(rows, 10, 'keybind rows');
    const before = await page.evaluate(() => CONFIG.ghost);
    await page.click('[data-toggle="ghost"]');
    eq(await page.evaluate(() => CONFIG.ghost), !before, 'ghost toggle');
    await page.click('[data-handling="das"][data-delta="5"]');
    eq(await page.evaluate(() => CONFIG.das), 105, 'DAS stepper');
  });

  await t('rebinding a key updates the config', async () => {
    await page.click('#keybinds .keybind-row:first-child .kbd');
    await page.keyboard.press('KeyJ');
    await page.waitForTimeout(120);
    eq(await page.evaluate(() => CONFIG.binds.left), 'KeyJ', 'rebind');
    await page.click('#btn-reset-config');
    eq(await page.evaluate(() => CONFIG.binds.left), 'ArrowLeft', 'reset');
  });

  section('multiplayer room');
  await t('creating a room shows the lobby with a join code', async () => {
    await page.click('#screen-config [data-nav="menu"]');
    await page.waitForSelector('#screen-menu.active');
    await page.click('[data-nav="multi"]');
    await page.waitForSelector('#screen-multi.active');
    await page.click('#btn-create-room');
    await page.waitForSelector('#screen-room.active', { timeout: 8000 });
    const code = await page.textContent('#room-code-big');
    assert(/^[A-Z0-9]{5}$/.test(code), 'bad room code: ' + code);
    const players = await page.evaluate(() => document.querySelectorAll('#room-players .switch-row').length);
    eq(players, 1, 'host seat');
  });

  await t('the ready button toggles', async () => {
    await page.click('#btn-ready');
    assert(await page.evaluate(() => Game.isReady()), 'ready not set');
    await page.click('#btn-ready');
    assert(!(await page.evaluate(() => Game.isReady())), 'ready not cleared');
  });

  await t('leaving the room returns to the browser', async () => {
    await page.click('#btn-leave-room');
    await page.waitForSelector('#screen-multi.active', { timeout: 5000 });
  });

  section('ranked queue');
  await t('ranked queue starts and can be cancelled', async () => {
    await page.click('#screen-multi [data-nav="menu"]');
    await page.waitForSelector('#screen-menu.active');
    await page.click('[data-nav="ranked"]');
    await page.waitForSelector('#screen-queue.active');
    await page.waitForFunction(() => document.querySelector('#queue-count').textContent === '1', null, { timeout: 8000 });
    await page.click('#btn-cancel-queue');
    await page.waitForSelector('#screen-menu.active', { timeout: 5000 });
  });

  section('error budget');
  await t('no uncaught errors across the whole session', async () => {
    const errs = await page.evaluate(() => window.__errors);
    assert(errs.length === 0, 'page errors: ' + JSON.stringify(errs));
    const bad = consoleErrors.filter(e => !/favicon|fonts\.googleapis|ERR_/.test(e));
    assert(bad.length === 0, 'console errors: ' + bad.join(' | '));
  });

  await t('every RPC the client made succeeded', async () => {
    const log = await page.evaluate(() => window.__rpcLog);
    const failed = log.filter(r => !r.ok);
    assert(failed.length === 0, 'failed rpcs: ' + JSON.stringify(failed));
    console.log('        ' + log.length + ' RPC calls, all ok');
  });

  await browser.close();
  fs.rmSync(path.dirname(pagePath), { recursive: true, force: true });
  process.exit(finish() ? 0 : 1);
})();
