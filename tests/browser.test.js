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
    // TR counts up on load, so wait for it to settle rather than catching a
    // frame mid-animation.
    await page.waitForFunction(
      () => document.querySelector('#me-tr').textContent === '12,500',
      null, { timeout: 8000 });
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

  await t('a hard drop leaves a trail and a landing flash', async () => {
    const fx = await page.evaluate(() => {
      const g = Game.state();
      g.fx = [];
      g.engine.hardDrop();
      return g.fx.map(f => ({ type: f.type, cells: f.cells.length, dist: f.dist || 0 }));
    });
    const kinds = fx.map(f => f.type);
    assert(kinds.indexOf('drop') !== -1, 'no drop trail: ' + JSON.stringify(fx));
    assert(kinds.indexOf('lock') !== -1, 'no landing flash: ' + JSON.stringify(fx));
    eq(fx.filter(f => f.type === 'lock')[0].cells, 4, 'flash should cover the whole piece');

    // They must expire on their own rather than accumulating forever.
    await page.waitForFunction(() => Game.state().fx.length === 0, null, { timeout: 4000 });
  });

  await t('effects can be turned off', async () => {
    const count = await page.evaluate(() => {
      CONFIG.effects = false;
      const g = Game.state();
      g.fx = [];
      g.engine.hardDrop();
      const n = g.fx.length;
      CONFIG.effects = true;
      return n;
    });
    eq(count, 0, 'effects were still produced with the toggle off');
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
    const toggles = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-toggle]')).map(b => b.getAttribute('data-toggle')));
    ['ghost', 'grid', 'shake', 'effects', 'sound'].forEach(function (key) {
      assert(toggles.indexOf(key) !== -1, 'missing toggle: ' + key);
    });
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

  section('room rules and chat');

  await t('the rule editor is built from the server schema', async () => {
    await page.click('#screen-multi [data-nav="menu"]');
    await page.waitForSelector('#screen-menu.active');
    await page.click('[data-nav="multi"]');
    await page.waitForSelector('#screen-multi.active');
    await page.click('#btn-create-room');
    await page.waitForSelector('#screen-room.active', { timeout: 8000 });
    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#room-rules .rule-row')).map(r =>
        r.querySelector('.rule-name b').textContent));
    assert(rows.length >= 12, 'expected the full rule list, got ' + rows.length);
    assert(rows.includes('타겟팅'), 'targeting rule missing');
    assert(rows.includes('홀드 허용'), 'hold rule missing');
    assert(rows.includes('넥스트 개수'), 'preview rule missing');
  });

  const clickRule = (label, which) => page.evaluate(([label, which]) => {
    const row = Array.from(document.querySelectorAll('#room-rules .rule-row'))
      .find(r => r.querySelector('.rule-name b').textContent === label);
    if (!row) throw new Error('no rule row: ' + label);
    const buttons = row.querySelectorAll('button');
    buttons[which === undefined ? 0 : which].click();
  }, [label, which]);

  await t('the host can change a numeric rule and the server confirms it', async () => {
    const before = await page.evaluate(() => Game.state().room.config.nextCount);
    await clickRule('넥스트 개수', 1);            // the "+" of the stepper
    await page.waitForFunction(
      b => Game.state().room.config.nextCount === b + 1, before, { timeout: 8000 });
    // Re-render from the server's copy to prove it was not just optimistic.
    const confirmed = await page.evaluate(async () => {
      const room = Game.state().room;
      const res = await new Promise(r => google.script.run.withSuccessHandler(r).rpc(
        'roomJoin', { id: Net.creds().id, token: Net.creds().token, code: room.code }));
      return res.ok ? res.data.room.config.nextCount : -1;
    });
    eq(confirmed, before + 1, 'server did not store the new preview count');
  });

  await t('toggling a boolean rule works', async () => {
    const before = await page.evaluate(() => Game.state().room.config.allowHold);
    await clickRule('홀드 허용');
    await page.waitForFunction(
      b => Game.state().room.config.allowHold !== b, before, { timeout: 8000 });
  });

  await t('cycling the targeting strategy walks all four options', async () => {
    const seen = new Set();
    for (let i = 0; i < 5; i++) {
      seen.add(await page.evaluate(() => Game.state().room.config.targeting));
      await clickRule('타겟팅');
      await page.waitForTimeout(400);
    }
    eq(seen.size, 4, 'expected four strategies, saw ' + Array.from(seen).join(','));
  });

  await t('chat posts, renders, and escapes markup', async () => {
    await page.fill('#chat-input', '안녕하세요 <b>test</b>');
    await page.click('#btn-chat-send');
    await page.waitForFunction(
      () => document.querySelectorAll('#chat-log .chat-msg').length === 1, null, { timeout: 8000 });
    const msg = await page.textContent('#chat-log .chat-msg');
    assert(/안녕하세요/.test(msg), 'message text missing: ' + msg);
    assert(/<b>test<\/b>/.test(msg), 'markup should survive as text: ' + msg);
    eq(await page.evaluate(() => document.querySelectorAll('#chat-log .chat-msg b').length), 0,
      'raw markup was rendered instead of escaped');
    eq(await page.inputValue('#chat-input'), '', 'input should clear after sending');
  });

  await t('the rule editor is read-only for a non-host', async () => {
    await page.evaluate(() => {
      const room = Game.state().room;
      App.renderRoom(Object.assign({}, room, { host: 'someone-else' }), {}, false);
    });
    const editable = await page.evaluate(() =>
      document.querySelectorAll('#room-rules button').length);
    eq(editable, 0, 'a guest must not get rule controls');
    const locked = await page.evaluate(() =>
      document.querySelectorAll('#room-rules .rule-row.locked').length);
    assert(locked >= 12, 'rows should be marked locked, got ' + locked);
    await page.evaluate(() => App.renderRoom(Game.state().room, {}, false));
  });

  await t('the room shows an empty spectator bench', async () => {
    eq(await page.textContent('#room-spectator-count'), '(0)', 'spectator count');
    assert(/없음/.test(await page.textContent('#room-spectators')), 'bench should read empty');
    assert(await page.isVisible('#btn-toggle-seat'), 'seat toggle should be offered');
  });

  await t('leaving the rules room returns to the browser', async () => {
    await page.click('#btn-leave-room');
    await page.waitForSelector('#screen-multi.active', { timeout: 8000 });
  });

  section('targeting strategies');

  await t('each strategy picks the opponent it promises', async () => {
    const result = await page.evaluate(() => {
      const g = Game.state();
      const saved = { room: g.room, opponents: g.opponents, sentTo: g.sentTo, attackedMeAt: g.attackedMeAt };

      // Three living opponents with distinct histories.
      g.opponents = {
        alice: { id: 'alice', connected: true, alive: true, ko: 0 },
        bob:   { id: 'bob',   connected: true, alive: true, ko: 3 },
        carol: { id: 'carol', connected: true, alive: true, ko: 1 }
      };
      g.sentTo = { alice: 20, bob: 5, carol: 40 };
      g.attackedMeAt = { alice: 1000, bob: 2000, carol: 9000 };

      const sample = (strategy, n) => {
        g.room = { config: { targeting: strategy } };
        const picks = {};
        for (let i = 0; i < n; i++) {
          const id = Game.pickTarget();
          picks[id] = (picks[id] || 0) + 1;
        }
        return picks;
      };

      const out = {
        even: sample('even', 30),
        attackers: sample('attackers', 30),
        badges: sample('badges', 30),
        random: sample('random', 300)
      };

      // Dead and disconnected players must never be targeted.
      g.opponents.bob.alive = false;
      g.opponents.carol.connected = false;
      out.badgesWithBobDead = sample('badges', 20);

      Object.assign(g, saved);
      return out;
    });

    eq(Object.keys(result.even).join(), 'bob', 'even should pick the least-attacked (bob)');
    eq(Object.keys(result.attackers).join(), 'carol', 'attackers should pick the most recent (carol)');
    eq(Object.keys(result.badges).join(), 'bob', 'badges should pick the KO leader (bob)');
    assert(Object.keys(result.random).length === 3,
      'random should spread over everyone, saw ' + Object.keys(result.random).join());
    eq(Object.keys(result.badgesWithBobDead).join(), 'alice',
      'a dead or disconnected player must never be targeted');
  });

  await t('ties are broken at random rather than always the same player', async () => {
    const picks = await page.evaluate(() => {
      const g = Game.state();
      const saved = { room: g.room, opponents: g.opponents, sentTo: g.sentTo };
      g.opponents = {
        p1: { id: 'p1', connected: true, alive: true, ko: 2 },
        p2: { id: 'p2', connected: true, alive: true, ko: 2 }
      };
      g.sentTo = {};
      g.room = { config: { targeting: 'badges' } };
      const out = {};
      for (let i = 0; i < 200; i++) {
        const id = Game.pickTarget();
        out[id] = (out[id] || 0) + 1;
      }
      Object.assign(g, saved);
      return out;
    });
    eq(Object.keys(picks).length, 2, 'a tie should reach both players');
    assert(picks.p1 > 40 && picks.p2 > 40, 'tie-break looks lopsided: ' + JSON.stringify(picks));
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

  section('screen transition comfort');

  await t('nothing large and bright sweeps the screen on navigation', async () => {
    const panels = await page.evaluate(() => {
      const luminance = (css) => {
        const m = css.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
        const lin = m.map(v => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
      };
      // offsetWidth, not getBoundingClientRect: the wipe is skewed, and the
      // bounding box of a sheared element includes the overhang.
      return Array.from(document.querySelectorAll('#wipe span')).map(el => ({
        width: el.offsetWidth,
        lum: +luminance(getComputedStyle(el).backgroundColor).toFixed(4)
      }));
    });
    note(JSON.stringify(panels));
    eq(panels.length, 3, 'wipe panels');
    panels.forEach(function (p) {
      // A panel wide enough to fill the view must be near-black; only a thin
      // leading edge is allowed to carry the accent.
      if (p.width > 40) {
        assert(p.lum < 0.02,
          'a ' + p.width + 'px panel has luminance ' + p.lum + ' — too bright to sweep the screen');
      } else {
        assert(p.width <= 12, 'the accent edge should be a hairline, got ' + p.width + 'px');
      }
    });
    assert(panels.some(p => p.width <= 12), 'the accent leading edge is missing');
  });

  await t('the transition can be switched off', async () => {
    const ran = await page.evaluate(async () => {
      CONFIG.transitions = false;
      const wipe = document.querySelector('#wipe');
      wipe.classList.remove('run');
      App.showScreen('menu');
      App.showScreen('solo');
      const off = wipe.classList.contains('run');
      CONFIG.transitions = true;
      App.showScreen('menu');
      const on = wipe.classList.contains('run');
      App.showScreen('menu');
      return { off: off, on: on };
    });
    eq(ran.off, false, 'the wipe still ran with transitions off');
    eq(ran.on, true, 'the wipe should run when enabled');
  });

  await t('the app is left on the menu for whatever runs next', async () => {
    await page.evaluate(() => App.showScreen('menu'));
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
