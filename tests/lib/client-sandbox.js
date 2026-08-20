/**
 * Loads the browser-side game modules into a Node VM context.
 * Only the handful of browser globals the simulation touches are stubbed —
 * anything that needs a real DOM belongs in the Playwright suites instead.
 */
const vm = require('vm');
const { CLIENT_FILES, scriptOf } = require('./sources');

/** @param {string[]} files subset of CLIENT_FILES to load (default: engine set) */
function makeClientSandbox(files) {
  const wanted = files || ['js_util.html', 'js_engine.html', 'js_attack.html', 'js_ai.html'];

  const sandbox = {
    console,
    Math, JSON, Date, Object, Array, String, Number, Boolean, Error, RegExp,
    Uint8Array, Promise, parseInt, parseFloat, isFinite, isNaN,
    performance: { now: () => Date.now() },
    setTimeout, clearTimeout, setInterval, clearInterval,
    window: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    document: {
      addEventListener() {},
      readyState: 'complete',
      querySelector: () => null,
      querySelectorAll: () => []
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  wanted.forEach(function (name) {
    if (CLIENT_FILES.indexOf(name) === -1) throw new Error('unknown client file: ' + name);
    vm.runInContext(scriptOf(name), sandbox, { filename: name });
  });

  return sandbox;
}

module.exports = { makeClientSandbox };
