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
  /* Two tests fail on purpose — a wrong password, and a duplicate name — so
     the error budget has to know the difference between a bug and a case the
     suite went out of its way to provoke. */
  const EXPECTED = /rpc\((login|register)\) failed/;
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

  await page.goto('file://' + pagePath);

  section('sign in');
  await t('a first visit lands on the sign-in screen, not in the game', async () => {
    await page.waitForSelector('#screen-auth.active', { timeout: 10000 });
    eq(await page.isVisible('#screen-menu'), false, 'the menu was reachable without an account');
    // Nothing was created for merely loading the page.
    const players = await page.evaluate(() => Store_readAll('Players').length);
    eq(players, 0, 'an account was made for a visitor who did nothing');
  });

  await t('a bad sign-in is refused and says so on the form', async () => {
    await page.click('[data-auth-tab="login"]');
    await page.fill('#auth-name', 'Nobody');
    await page.fill('#auth-pw', 'whatever');
    await page.click('#auth-submit');
    await page.waitForSelector('#auth-error.show', { timeout: 8000 });
    const message = await page.textContent('#auth-error');
    assert(/올바르지 않습니다/.test(message), 'unexpected message: ' + message);
    eq(await page.isVisible('#screen-menu'), false, 'a failed sign-in let us in anyway');
  });

  await t('registering signs the new account straight in', async () => {
    await page.click('[data-auth-tab="register"]');
    await page.waitForFunction(() => !document.querySelector('#auth-pw2-field').hidden);
    await page.fill('#auth-name', 'Tester');
    await page.fill('#auth-pw', 'hunter2!');
    await page.fill('#auth-pw2', 'hunter2!');
    await page.click('#auth-submit');
    await page.waitForSelector('#screen-menu.active', { timeout: 10000 });
    eq(await page.textContent('#me-name'), 'Tester', 'name did not stick');
    // TR counts up on load, so wait for it to settle rather than catching a
    // frame mid-animation.
    await page.waitForFunction(
      () => document.querySelector('#me-tr').textContent === '12,500',
      null, { timeout: 8000 });
  });

  await t('mistyping the second password never reaches the server', async () => {
    const before = await page.evaluate(() => Store_readAll('Players').length);
    await page.evaluate(() => { App.showScreen('auth'); });
    await page.click('[data-auth-tab="register"]');
    await page.fill('#auth-name', 'Mismatch');
    await page.fill('#auth-pw', 'hunter2!');
    await page.fill('#auth-pw2', 'hunter3!');
    await page.click('#auth-submit');
    await page.waitForSelector('#auth-error.show', { timeout: 5000 });
    assert(/서로 다릅니다/.test(await page.textContent('#auth-error')), 'wrong message');
    eq(await page.evaluate(() => Store_readAll('Players').length), before, 'an account was created anyway');
    await page.evaluate(() => { App.showScreen('menu'); });
  });

  await t('no uncaught errors during boot', async () => {
    const errs = await page.evaluate(() => window.__errors);
    assert(errs.length === 0, 'errors: ' + JSON.stringify(errs));
    const bad = consoleErrors.filter(
      e => !/favicon|fonts\.(googleapis|gstatic)|ERR_/.test(e) && !EXPECTED.test(e));
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

  await t('the well has walls you can see without looking for them', async () => {
    // The playfield is the one thing on screen you navigate by feel. A
    // hairline that disappears into the background is how you lose track of
    // which column you are over.
    const frame = await page.evaluate(() => {
      const page = getComputedStyle(document.body).backgroundColor;
      const parse = css => (css.match(/[\d.]+/g) || [0, 0, 0]).map(Number);
      const lum = (rgba, under) => {
        const [r, g, b, a = 1] = parse(rgba);
        const [br, bg, bb] = parse(under);
        const mix = [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
        const lin = mix.map(v => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
      };
      const el = document.querySelector('.board-frame');
      const cs = getComputedStyle(el);
      const inside = lum(cs.backgroundColor, page);
      return {
        wall: parseFloat(cs.borderLeftWidth),
        floor: parseFloat(cs.borderBottomWidth),
        wallContrast: (lum(cs.borderLeftColor, page) + 0.05) / (inside + 0.05),
        floorContrast: (lum(cs.borderBottomColor, page) + 0.05) / (inside + 0.05)
      };
    });
    note('wall ' + frame.wall + 'px ×' + frame.wallContrast.toFixed(1) +
         ' · floor ' + frame.floor + 'px ×' + frame.floorContrast.toFixed(1));
    assert(frame.wall >= 2, 'the side walls are ' + frame.wall + 'px');
    assert(frame.floor >= 2, 'the floor is ' + frame.floor + 'px');
    assert(frame.wallContrast >= 3, 'the walls sit at ' + frame.wallContrast.toFixed(1) + ':1 against the field');
    assert(frame.floorContrast >= frame.wallContrast, 'the floor should read at least as strongly as the walls');
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

  section('typography');

  await t('nothing that holds Hangul is letterspaced apart', async () => {
    // Wide tracking is what makes small uppercase Latin labels look
    // designed. Applied to Hangul it inserts a gap between every syllable,
    // so 계정으로 renders as 계 정 으 로. The rule is in the stylesheet
    // header; this is what stops it drifting back.
    const offenders = await page.evaluate(() => {
      const HANGUL = /[\uAC00-\uD7A3]/;
      const bad = [];
      const screens = ['auth', 'menu', 'solo', 'multi', 'room', 'queue',
                       'leaderboard', 'config', 'result'];
      for (const name of screens) {
        const screen = document.querySelector('#screen-' + name);
        if (!screen) continue;
        screen.classList.add('active');
        for (const el of screen.querySelectorAll('*')) {
          const own = Array.from(el.childNodes)
            .filter(n => n.nodeType === 3).map(n => n.textContent).join('');
          if (!HANGUL.test(own)) continue;
          const cs = getComputedStyle(el);
          const track = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing);
          const size = parseFloat(cs.fontSize) || 16;
          if (track / size > 0.06) {
            bad.push(name + ' ' + (el.id || el.className || el.tagName) +
                     ' @ ' + (track / size).toFixed(3) + 'em — "' + own.trim().slice(0, 18) + '"');
          }
        }
        screen.classList.remove('active');
      }
      document.querySelector('#screen-menu').classList.add('active');
      return bad;
    });
    assert(offenders.length === 0, offenders.join(' | '));
  });

  await t('hidden means hidden, whatever the class wants to display', async () => {
    // .field is display:flex, which beats the [hidden] attribute's own
    // display:none unless something says otherwise — so the confirm-password
    // field used to sit there in plain sight while signing in.
    const shown = await page.evaluate(() => {
      document.querySelector('#screen-menu').classList.remove('active');
      document.querySelector('#screen-auth').classList.add('active');
      const probe = document.querySelector('#auth-pw2-field');
      probe.hidden = true;
      const visible = probe.getClientRects().length > 0;
      document.querySelector('#screen-auth').classList.remove('active');
      document.querySelector('#screen-menu').classList.add('active');
      return visible;
    });
    eq(shown, false, 'a [hidden] element was still laid out');
  });

  await t('no decorative layer can swallow a click', async () => {
    // A pseudo-element that paints outside its owner will also take the
    // clicks meant for whatever is next to it, which is how the hover fill
    // once stole presses from the button beside it.
    const solid = await page.evaluate(() => {
      const bad = [];
      for (const el of document.querySelectorAll('.screen *, .modal *, .toast-host *')) {
        for (const which of ['::before', '::after']) {
          const cs = getComputedStyle(el, which);
          if (cs.content === 'none') continue;
          if (cs.pointerEvents !== 'none' && cs.position === 'absolute') {
            bad.push((el.id || el.className || el.tagName) + which);
          }
        }
      }
      return bad;
    });
    assert(solid.length === 0, 'clickable decoration: ' + solid.join(', '));
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

  section('account lifecycle');

  await t('signing out ends the session for good', async () => {
    await page.click('#btn-config');
    await page.waitForSelector('#screen-config.active');
    await page.click('#btn-logout');
    await page.waitForSelector('#screen-auth.active', { timeout: 8000 });
    // The credentials are gone from the browser, not just from the screen.
    eq(await page.evaluate(() => U.load('creds', null)), null, 'credentials survived sign-out');
  });

  await t('the account is still there to sign back into', async () => {
    await page.click('[data-auth-tab="login"]');
    await page.fill('#auth-name', 'Tester');
    await page.fill('#auth-pw', 'hunter2!');
    await page.click('#auth-submit');
    await page.waitForSelector('#screen-menu.active', { timeout: 8000 });
    eq(await page.textContent('#me-name'), 'Tester', 'landed on the wrong account');
    // The sprint record set earlier in this session came back with it.
    await page.waitForFunction(
      () => document.querySelector('#me-sprint').textContent !== '—', null, { timeout: 8000 });
  });

  await t('settings follow the account, not the browser', async () => {
    // Tune the handling and rebind a key the way a person would.
    await page.click('#btn-config');
    await page.waitForSelector('#screen-config.active');
    for (let i = 0; i < 4; i++) await page.click('[data-handling="das"][data-delta="-5"]');
    await page.click('[data-toggle="ghost"]');
    await page.click('[data-bind="hold"] .kbd');
    await page.keyboard.press('KeyV');
    await page.waitForTimeout(120);
    const tuned = await page.evaluate(() => ({
      das: CONFIG.das, ghost: CONFIG.ghost, hold: CONFIG.binds.hold
    }));
    eq(tuned.das, 80, 'DAS did not move');
    eq(tuned.ghost, false, 'ghost did not toggle off');
    eq(tuned.hold, 'KeyV', 'hold was not rebound');

    // Leaving the settings screen flushes the debounce.
    await page.click('#screen-config [data-nav="menu"]');
    await page.waitForSelector('#screen-menu.active');
    await page.waitForFunction(() => {
      const rows = Store_readAll('Players');
      return rows.some(p => p.name === 'Tester' && /"das":80/.test(String(p.settings)));
    }, null, { timeout: 8000 });

    // A different browser: sign out, wipe what the device remembers, and
    // come back with nothing but the name and the password.
    await page.click('#btn-config');
    await page.click('#btn-logout');
    await page.waitForSelector('#screen-auth.active', { timeout: 8000 });
    await page.evaluate(() => {
      U.save('config', {});
      CONFIG.das = 100; CONFIG.ghost = true;
      CONFIG.binds = Object.assign({}, DEFAULT_BINDS);
    });

    await page.click('[data-auth-tab="login"]');
    await page.fill('#auth-name', 'Tester');
    await page.fill('#auth-pw', 'hunter2!');
    await page.click('#auth-submit');
    await page.waitForSelector('#screen-menu.active', { timeout: 10000 });

    const restored = await page.evaluate(() => ({
      das: CONFIG.das, ghost: CONFIG.ghost, hold: CONFIG.binds.hold,
      // An action nobody rebound must still come back from the client's own
      // defaults rather than as undefined.
      left: CONFIG.binds.left
    }));
    eq(restored.das, 80, 'DAS did not come back');
    eq(restored.ghost, false, 'the toggle did not come back');
    eq(restored.hold, 'KeyV', 'the rebound key did not come back');
    eq(restored.left, 'ArrowLeft', 'an untouched bind lost its default');

    // ...and the settings screen shows what was restored, not what the
    // markup shipped with.
    await page.click('#btn-config');
    await page.waitForSelector('#screen-config.active');
    eq(await page.textContent('#h-das'), '80', 'the DAS readout is stale');
    eq(await page.textContent('[data-toggle="ghost"]'), 'OFF', 'the ghost toggle is stale');
    await page.click('#screen-config [data-nav="menu"]');
    await page.waitForSelector('#screen-menu.active');
  });

  await t('a guest is turned away from ranked and offered an account', async () => {
    await page.click('#btn-config');
    await page.waitForSelector('#screen-config.active');
    await page.click('#btn-logout');
    await page.waitForSelector('#screen-auth.active', { timeout: 8000 });
    await page.click('#auth-guest');
    await page.waitForSelector('#screen-menu.active', { timeout: 8000 });
    assert(/^Guest/.test(await page.textContent('#me-name')), 'not signed in as a guest');

    await page.click('[data-nav="ranked"]');
    await page.waitForSelector('#modal-host.open', { timeout: 5000 });
    eq(await page.isVisible('#screen-queue.active'), false, 'a guest reached the ranked queue');
    assert(/계정 만들기/.test(await page.textContent('#modal-body')), 'no account prompt');
  });

  await t('a guest keeps their session when they set a password', async () => {
    const inputs = await page.$$('#modal-body input.input');
    await inputs[0].fill('Claimed');
    await inputs[1].fill('hunter2!');
    await inputs[2].fill('hunter2!');
    await page.click('#modal-body button.primary');
    await page.waitForSelector('#modal-host:not(.open)', { state: 'attached', timeout: 8000 });
    eq(await page.textContent('#me-name'), 'Claimed', 'the new name did not stick');

    // Ranked is open to them now.
    await page.click('[data-nav="ranked"]');
    await page.waitForSelector('#screen-queue.active', { timeout: 8000 });
    await page.click('#btn-cancel-queue');
    await page.waitForSelector('#screen-menu.active', { timeout: 8000 });
  });

  section('tablets and the software keyboard');

  /* iOS does not shrink the layout viewport when the keyboard opens: it
     leaves the page full height, covers the bottom with the keyboard and
     scrolls the document. Playwright cannot raise an iPad keyboard, so these
     drive U.applyViewport with the numbers iOS would report. What is not
     covered here is the reading of window.visualViewport itself. */

  await t('every text field is big enough that iOS will not zoom the page', async () => {
    const small = await page.evaluate(() => {
      const bad = [];
      for (const screen of document.querySelectorAll('.screen')) {
        screen.classList.add('active');
        for (const f of screen.querySelectorAll('input, textarea, select')) {
          const size = parseFloat(getComputedStyle(f).fontSize);
          if (size < 16) bad.push((f.id || f.className) + ' @ ' + size + 'px');
        }
        screen.classList.remove('active');
      }
      document.querySelector('#screen-menu').classList.add('active');
      return bad;
    });
    // Safari zooms in on focus when a field is under 16px, and never zooms
    // back out — the page is left cropped for the rest of the session.
    assert(small.length === 0, small.join(', '));
  });

  await t('the app is sized from the visible area, not the window', async () => {
    const box = await page.evaluate(() => {
      U.applyViewport(370, 0);
      const root = getComputedStyle(document.documentElement);
      return {
        app: Math.round(document.querySelector('#app').getBoundingClientRect().height),
        appH: root.getPropertyValue('--app-h').trim(),
        kb: root.getPropertyValue('--kb-h').trim(),
        window: window.innerHeight,
        klass: document.body.classList.contains('keyboard-open')
      };
    });
    eq(box.app, 370, 'the app still filled the window');
    eq(box.appH, '370px', '--app-h');
    eq(box.kb, (box.window - 370) + 'px', '--kb-h should be what the keyboard covers');
    eq(box.klass, true, 'keyboard-open was not set');
  });

  await t('nothing on the sign-in card is left out of reach', async () => {
    const reach = await page.evaluate(() => {
      document.querySelector('#screen-menu').classList.remove('active');
      const screen = document.querySelector('#screen-auth');
      screen.classList.add('active');
      U.applyViewport(370, 0);
      // Both halves matter: an overflow:hidden box still answers scrollTop,
      // so content that fits nowhere would look reachable to a script and be
      // stuck for a person.
      const overflows = screen.scrollHeight > screen.clientHeight + 1;
      const scrolls = /auto|scroll/.test(getComputedStyle(screen).overflowY);
      const scrollable = overflows && scrolls;
      screen.scrollTop = screen.scrollHeight;
      const guest = document.querySelector('#auth-guest').getBoundingClientRect();
      const reached = guest.bottom <= 370 + 1 && guest.top >= -1;
      screen.scrollTop = 0;
      screen.classList.remove('active');
      document.querySelector('#screen-menu').classList.add('active');
      return { scrollable, reached };
    });
    eq(reach.scrollable, true, 'the screen cropped its content instead of scrolling');
    eq(reach.reached, true, 'the guest button could not be scrolled to');
  });

  await t('a toast is not posted behind the keyboard', async () => {
    const box = await page.evaluate(() => {
      U.applyViewport(370, 0);
      const host = document.querySelector('#toast-host');
      return {
        gap: window.innerHeight - host.getBoundingClientRect().bottom,
        covered: window.innerHeight - 370
      };
    });
    assert(box.gap >= box.covered,
      'a toast sits ' + box.gap + 'px off the bottom with ' + box.covered + 'px of keyboard under it');
  });

  await t('a dialog too tall for the visible area starts at its top', async () => {
    const box = await page.evaluate(() => {
      U.applyViewport(760, 0);
      document.querySelector('#btn-config').click();
      document.querySelector('#btn-password').click();
      U.applyViewport(300, 0);
      const host = document.querySelector('#modal-host');
      const dialog = document.querySelector('#modal-body');
      const h = host.getBoundingClientRect(), d = dialog.getBoundingClientRect();
      return {
        hostHeight: Math.round(h.height),
        cut: d.top < h.top - 1,
        scrollable: host.scrollHeight > host.clientHeight + 1
      };
    });
    eq(box.hostHeight, 300, 'the overlay ignored the visible area');
    eq(box.cut, false, 'the top of the dialog was pushed out of the overlay');
    eq(box.scrollable, true, 'the overlay cropped the dialog instead of scrolling');
    await page.evaluate(() => { U.closeModal(); App.showScreen('menu'); });
  });

  await t('the board is scaled down to fit, never cropped', async () => {
    await page.evaluate(() => U.applyViewport(window.innerHeight, 0));
    await page.click('[data-nav="cpu"]');
    await page.waitForSelector('#modal-host.open', { timeout: 8000 });
    const levels = await page.$$('#modal-body .menu-item');
    await levels[0].click();
    await page.waitForFunction(
      () => document.querySelector('#s-time').textContent !== '0:00', null, { timeout: 25000 });

    const sizes = [[1440, 900], [1024, 768], [1024, 600], [900, 560]];
    const results = [];
    for (const [w, h] of sizes) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(220);
      results.push(await page.evaluate(() => {
        const col = document.querySelector('.match-column');
        const r = col.getBoundingClientRect();
        return {
          size: innerWidth + 'x' + innerHeight,
          scale: +getComputedStyle(col).transform.split('(')[1].split(',')[0] || 1,
          inside: r.top >= -1 && r.bottom <= innerHeight + 1 &&
                  r.left >= -1 && r.right <= innerWidth + 1
        };
      }));
    }
    note(results.map(r => r.size + ' @ ' + r.scale.toFixed(2)).join('  '));
    results.forEach(r => assert(r.inside, 'the matrix is cropped at ' + r.size));
    assert(results[results.length - 1].scale < 0.95, 'a short window did not scale the board down');

    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('#screen-menu.active', { timeout: 8000 });
  });

  section('error budget');
  await t('no uncaught errors across the whole session', async () => {
    const errs = await page.evaluate(() => window.__errors);
    assert(errs.length === 0, 'page errors: ' + JSON.stringify(errs));
    const bad = consoleErrors.filter(
      e => !/favicon|fonts\.googleapis|ERR_/.test(e) && !EXPECTED.test(e));
    assert(bad.length === 0, 'console errors: ' + bad.join(' | '));
  });

  await t('every RPC the client made succeeded', async () => {
    const log = await page.evaluate(() => window.__rpcLog);
    const failed = log.filter(r => !r.ok && r.method !== 'login');
    assert(failed.length === 0, 'failed rpcs: ' + JSON.stringify(failed));
    const deliberate = log.filter(r => !r.ok).length;
    console.log('        ' + log.length + ' RPC calls, ' + deliberate + ' refused on purpose');
  });

  await browser.close();
  fs.rmSync(path.dirname(pagePath), { recursive: true, force: true });
  process.exit(finish() ? 0 : 1);
})();
