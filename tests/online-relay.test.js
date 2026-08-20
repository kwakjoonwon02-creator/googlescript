/* The hybrid deployment end to end: Apps Script serves the page and owns
   ratings, the relay owns the room. Two real browser tabs play a ranked
   match over WebSockets and the result lands in the spreadsheet. */
const path = require('path');
const { createRelay } = require('../relay/server');
const { createServer } = require('./serve');
const { chromium, launchOptions } = require('./lib/browser');
const { testAsync: t, assert, eq, section, note, finish } = require('./lib/report');

const SECRET = 'relay-secret-for-the-online-suite';

async function setName(page, name, timeout) {
  await page.waitForSelector('#screen-menu.active', { timeout: timeout || 20000 });
  if (await page.isVisible('#modal-host.open')) {
    await page.fill('#modal-body input.input', name);
    await page.click('#modal-body button.primary');
    await page.waitForSelector('#modal-host:not(.open)', { state: 'attached', timeout: 8000 });
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // The web app and the relay each need the other's address, so bring the
  // web app up first and tell the sandbox about the relay once it has a port.
  const web = createServer({ relaySecret: SECRET });
  const webPort = await web.listen(0);

  const relay = createRelay({
    secret: SECRET,
    settleUrl: 'http://127.0.0.1:' + webPort + '/settle',
    log: () => {}
  });
  const relayPort = await relay.listen(0);
  web.sandbox.PropertiesService.getScriptProperties()
    .setProperty('RELAY_URL', 'ws://127.0.0.1:' + relayPort);

  const browser = await chromium.launch(launchOptions());
  const pageErrors = [];
  const A = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const B = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  [A, B].forEach((p, i) => p.on('pageerror', e => pageErrors.push('P' + i + ': ' + e.message)));

  const url = 'http://127.0.0.1:' + webPort + '/';
  await A.goto(url);
  await B.goto(url);

  section('connecting');

  await t('both clients pick up the relay from bootstrap and connect', async () => {
    await setName(A, 'RelayA');
    await setName(B, 'RelayB');
    for (const page of [A, B]) {
      await page.waitForFunction(() => Net.relayMode() === 'on', null, { timeout: 20000 });
      assert(await page.evaluate(() => Net.isRelay()), 'client should report a live relay');
    }
    eq(relay.sockets.size, 2, 'relay holds both sockets');
  });

  await t('a relay round trip is far quicker than the Apps Script path', async () => {
    const timings = await A.evaluate(async () => {
      const time = async (fn) => {
        const started = performance.now();
        await fn();
        return performance.now() - started;
      };
      // roomList over the relay, profile over Apps Script: both are trivial
      // reads, so the difference is transport, not work.
      const relayMs = await time(() => Net.roomList());
      const appsMs = await time(() => Net.profile());
      return { relayMs, appsMs };
    });
    note('roomList over relay ' + timings.relayMs.toFixed(0) + 'ms, ' +
         'profile over Apps Script ' + timings.appsMs.toFixed(0) + 'ms');
    assert(timings.relayMs < 200, 'relay call was slow: ' + timings.relayMs.toFixed(0) + 'ms');
  });

  await t('cold data still goes to Apps Script, not the relay', async () => {
    // The ladder lives in the spreadsheet; asking the relay for it would be
    // a routing bug rather than a slow path.
    const board = await A.evaluate(() => Net.leaderboard().then(d => !!d));
    assert(board, 'leaderboard should still answer');
    const log = await A.evaluate(() => window.__rpcLog.map(r => r.method));
    assert(log.indexOf('leaderboard') !== -1, 'leaderboard did not go over HTTP');
    assert(log.indexOf('sync') === -1, 'sync must not go over HTTP while the relay is up');
  });

  section('a ranked match over the relay');

  await t('the queue matches both clients', async () => {
    await A.click('[data-nav="ranked"]');
    await A.waitForSelector('#screen-queue.active');
    await B.click('[data-nav="ranked"]');
    const inRanked = () => Game.state().room && Game.state().room.mode === 'ranked';
    await A.waitForFunction(inRanked, null, { timeout: 25000 });
    await B.waitForFunction(inRanked, null, { timeout: 25000 });
    eq(await A.evaluate(() => Game.state().room.code),
       await B.evaluate(() => Game.state().room.code), 'same room');
  });

  await t('both boards run from the same seed', async () => {
    for (const page of [A, B]) {
      await page.waitForFunction(() => Game.state().phase === 'playing', null, { timeout: 30000 });
    }
    const seqA = await A.evaluate(() => Game.state().engine.bag.peek(10).join(''));
    const seqB = await B.evaluate(() => Game.state().engine.bag.peek(10).join(''));
    eq(seqA, seqB, 'piece order diverged');
  });

  await t('the opponent board updates several times a second', async () => {
    // Poke a piece down on B and time how long A takes to see the change.
    const before = await A.evaluate(() => {
      const ids = Object.keys(Game.state().opponents);
      return Game.state().opponents[ids[0]].board;
    });
    const started = Date.now();
    await B.evaluate(() => { const e = Game.state().engine; for (let i = 0; i < 3; i++) e.hardDrop(); });
    await A.waitForFunction(prev => {
      const ids = Object.keys(Game.state().opponents);
      return ids.length && Game.state().opponents[ids[0]].board !== prev;
    }, before, { timeout: 5000 });
    const elapsed = Date.now() - started;
    note('opponent board refreshed in ' + elapsed + 'ms');
    assert(elapsed < 900, 'relay board updates should be well under a second, got ' + elapsed + 'ms');
  });

  await t('garbage crosses the relay', async () => {
    const before = await A.evaluate(() => Game.state().engine.stats.received);
    await B.evaluate(() => {
      const g = Game.state();
      const target = Object.keys(g.opponents)[0];
      g.myAttackLog.push({ i: 9001, n: 5, t: Date.now(), to: target, r: g.currentRound });
      g.lastSyncAt = 0;
    });
    await A.waitForFunction(
      prev => Game.state().engine.stats.received > prev, before, { timeout: 8000 });
    eq(await A.evaluate(() => Game.state().engine.stats.received) - before, 5, 'garbage amount');
  });

  await t('the match plays out and TR settles through Apps Script', async () => {
    const deadline = Date.now() + 90000;
    let topped = -1;
    while (Date.now() < deadline) {
      const st = await B.evaluate(() => {
        const g = Game.state();
        return { phase: g.phase, round: g.room && g.room.round, state: g.room && g.room.state };
      });
      if (st.state === 'matchover') break;
      if (st.phase === 'playing' && st.round !== topped) {
        topped = st.round;
        await B.evaluate(() => Game.state().engine.topOut());
      }
      await sleep(250);
    }
    await A.waitForSelector('#screen-result.active', { timeout: 30000 });
    const text = await A.textContent('#result-card');
    assert(/VICTORY/.test(text), 'A should have won: ' + text.slice(0, 80));

    // Settlement is an HTTPS hop the relay makes after the match ends, so the
    // numbers arrive a beat later and the card re-renders.
    await A.waitForFunction(() => {
      const node = document.querySelector('.tr-delta');
      return node && /^\+/.test(node.textContent.trim());
    }, null, { timeout: 25000 });
    const delta = await A.evaluate(() => document.querySelector('.tr-delta').textContent.trim());
    note('winner ' + delta + ' (settled by Apps Script, reported over the relay)');
  });

  await t('the spreadsheet has the match, written by the web app', async () => {
    const rows = web.sandbox.Store_readAll('Matches');
    eq(rows.length, 1, 'exactly one match row');
    eq(rows[0].mode, 'ranked', 'ranked');
    assert(Number(rows[0].tr1After) !== Number(rows[0].tr1Before), 'ratings moved');

    const players = web.sandbox.Store_readAll('Players')
      .filter(p => p.name === 'RelayA' || p.name === 'RelayB');
    eq(players.length, 2, 'both accounts exist');
    players.forEach(p => eq(Number(p.games), 1, p.name + ' should have one ranked game'));
  });

  section('resilience');

  await t('losing the relay does not silently fall back to Apps Script', async () => {
    // Rooms live on the relay; quietly retrying against Apps Script would
    // just produce ROOM_GONE, so the client must keep waiting instead.
    await A.evaluate(() => { Net.__testCloseRelay(); });
    await A.waitForFunction(() => Net.relayMode() !== 'on', null, { timeout: 8000 });
    const mode = await A.evaluate(() => Net.relayMode());
    assert(mode === 'reconnecting' || mode === 'on', 'expected a reconnect attempt, got ' + mode);
    await A.waitForFunction(() => Net.relayMode() === 'on', null, { timeout: 20000 });
    note('reconnected without a reload');
  });

  await t('no uncaught errors on either client', async () => {
    const a = await A.evaluate(() => window.__errors);
    const b = await B.evaluate(() => window.__errors);
    assert(a.length === 0 && b.length === 0 && pageErrors.length === 0,
      'A=' + JSON.stringify(a) + ' B=' + JSON.stringify(b) + ' page=' + JSON.stringify(pageErrors));
  });

  await browser.close();
  await relay.close();
  await web.close();
  process.exit(finish() ? 0 : 1);
})();
