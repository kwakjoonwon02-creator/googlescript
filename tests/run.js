#!/usr/bin/env node
/**
 * Runs the test suites.
 *
 *   node tests/run.js          every suite (browser suites need Playwright)
 *   node tests/run.js fast     the Node-only suites
 *   node tests/run.js engine   one suite by name
 */
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  { name: 'engine', file: 'engine.test.js', browser: false },
  { name: 'rating', file: 'rating.test.js', browser: false },
  { name: 'server', file: 'server.test.js', browser: false },
  { name: 'template', file: 'template.test.js', browser: false },
  { name: 'relay', file: 'relay.test.js', browser: false },
  { name: 'browser', file: 'browser.test.js', browser: true },
  { name: 'online', file: 'online.test.js', browser: true },
  { name: 'online-relay', file: 'online-relay.test.js', browser: true }
];

const arg = process.argv[2];
let selected = SUITES;
if (arg === 'fast') selected = SUITES.filter(s => !s.browser);
else if (arg) {
  selected = SUITES.filter(s => s.name === arg);
  if (!selected.length) {
    console.error('unknown suite: ' + arg);
    console.error('available: ' + SUITES.map(s => s.name).join(', ') + ', fast');
    process.exit(2);
  }
}

let failed = 0;
for (const suite of selected) {
  console.log('\n──────── ' + suite.name + ' ────────');
  const res = spawnSync(process.execPath, [path.join(__dirname, suite.file)], { stdio: 'inherit' });
  if (res.status !== 0) failed++;
}

console.log(failed ? '\n' + failed + ' suite(s) failed\n' : '\nall suites passed\n');
process.exit(failed ? 1 : 0);
