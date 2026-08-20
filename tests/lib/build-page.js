/**
 * Assembles the client into a single standalone HTML page so a real browser
 * can drive the actual game code.
 *
 * Two flavours:
 *   'local'  — the mocked Apps Script backend runs inside the page, so one
 *              browser tab is a complete self-contained game.
 *   'shared' — RPC goes over HTTP to tests/serve.js, so two tabs can play
 *              each other against one backend.
 */
const fs = require('fs');
const path = require('path');
const { CLIENT_FILES, read, serverSource } = require('./sources');

const GAS_MOCK = `
<script>
/* In-page stand-ins for the Apps Script services (see tests/lib/gas-sandbox.js). */
(function () {
  var uuid = 0;
  function Sheet(name) { this.name = name; this.rows = []; }
  Sheet.prototype.getName = function () { return this.name; };
  Sheet.prototype.getLastRow = function () { return this.rows.length; };
  Sheet.prototype.setFrozenRows = function () { return this; };
  Sheet.prototype.appendRow = function (r) { this.rows.push(r.slice()); return this; };
  Sheet.prototype.getRange = function (row, col, nRows, nCols) {
    var sh = this;
    return {
      setValues: function (values) {
        for (var r = 0; r < values.length; r++) {
          var idx = row - 1 + r;
          while (sh.rows.length <= idx) sh.rows.push([]);
          for (var c = 0; c < values[r].length; c++) sh.rows[idx][col - 1 + c] = values[r][c];
        }
        return this;
      },
      getValues: function () {
        var out = [];
        for (var r = 0; r < nRows; r++) {
          var src = sh.rows[row - 1 + r] || [], line = [];
          for (var c = 0; c < nCols; c++) line.push(src[col - 1 + c] === undefined ? '' : src[col - 1 + c]);
          out.push(line);
        }
        return out;
      },
      setFontWeight: function () { return this; },
      setBackground: function () { return this; },
      setFontColor: function () { return this; }
    };
  };
  function SS(id) { this.id = id; this.sheets = [new Sheet('Sheet1')]; }
  SS.prototype.getId = function () { return this.id; };
  SS.prototype.getUrl = function () { return 'mock://' + this.id; };
  SS.prototype.getSheets = function () { return this.sheets.slice(); };
  SS.prototype.getSheetByName = function (n) {
    for (var i = 0; i < this.sheets.length; i++) if (this.sheets[i].name === n) return this.sheets[i];
    return null;
  };
  SS.prototype.insertSheet = function (n) { var s = new Sheet(n); this.sheets.push(s); return s; };
  SS.prototype.deleteSheet = function (s) {
    this.sheets = this.sheets.filter(function (x) { return x !== s; });
  };
  var books = {};
  window.SpreadsheetApp = {
    create: function () { var id = 'ss' + (++uuid); books[id] = new SS(id); return books[id]; },
    openById: function (id) { if (!books[id]) throw new Error('missing'); return books[id]; }
  };
  var cache = {};
  window.CacheService = { getScriptCache: function () { return {
    get: function (k) { return cache.hasOwnProperty(k) ? cache[k] : null; },
    put: function (k, v) { cache[k] = v; },
    remove: function (k) { delete cache[k]; },
    getAll: function (keys) {
      var o = {};
      keys.forEach(function (k) { if (cache.hasOwnProperty(k)) o[k] = cache[k]; });
      return o;
    }
  }; } };
  var props = {};
  window.PropertiesService = { getScriptProperties: function () { return {
    getProperty: function (k) { return props.hasOwnProperty(k) ? props[k] : null; },
    setProperty: function (k, v) { props[k] = v; }
  }; } };
  var held = false;
  window.LockService = { getScriptLock: function () { return {
    tryLock: function () { if (held) return false; held = true; return true; },
    waitLock: function () { if (held) throw new Error('lock already held'); held = true; },
    releaseLock: function () { held = false; }
  }; } };
  window.Utilities = { getUuid: function () {
    return 'uu-' + (++uuid) + '-' + Math.random().toString(16).slice(2, 10) + '-0123456789abcdef';
  } };
  window.Logger = { log: function () {} };
  window.ScriptApp = { getProjectTriggers: function () { return []; } };
  window.HtmlService = {};
})();
</script>
`;

const ERROR_TRAP = `
<script>
window.__errors = [];
window.addEventListener('error', function (e) {
  window.__errors.push(String(e.message) + ' @ ' + e.filename + ':' + e.lineno);
});
window.addEventListener('unhandledrejection', function (e) {
  window.__errors.push('unhandled rejection: ' + (e.reason && e.reason.message || e.reason));
});
</script>
`;

const RUNNER_LOCAL = `
<script>
/* google.script.run, answered by the in-page copy of the server. */
window.__rpcLog = [];
window.google = { script: {} };
Object.defineProperty(window.google.script, 'run', {
  get: function () {
    var onSuccess = null, onFailure = null;
    var api = {
      withSuccessHandler: function (fn) { onSuccess = fn; return api; },
      withFailureHandler: function (fn) { onFailure = fn; return api; },
      rpc: function (method, payload) {
        setTimeout(function () {
          var res;
          try { res = rpc(method, payload); }
          catch (e) { if (onFailure) onFailure(e); return; }
          window.__rpcLog.push({ method: method, ok: res.ok, error: res.error });
          if (onSuccess) onSuccess(res);
        }, window.__rpcDelay || 20);
      }
    };
    return api;
  }
});
</script>
`;

const RUNNER_SHARED = `
<script>
/* google.script.run, answered by tests/serve.js over HTTP. */
window.__rpcLog = [];
window.google = { script: {} };
Object.defineProperty(window.google.script, 'run', {
  get: function () {
    var onSuccess = null, onFailure = null;
    var api = {
      withSuccessHandler: function (fn) { onSuccess = fn; return api; },
      withFailureHandler: function (fn) { onFailure = fn; return api; },
      rpc: function (method, payload) {
        fetch('/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: method, payload: payload })
        }).then(function (r) { return r.json(); }).then(function (res) {
          window.__rpcLog.push({ method: method, ok: res.ok, error: res.error });
          if (onSuccess) onSuccess(res);
        }).catch(function (e) { if (onFailure) onFailure(e); });
      }
    };
    return api;
  }
});
</script>
`;

function buildPage(mode) {
  const shared = mode === 'shared';
  const parts = [
    '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">',
    '<title>TETRA.GS test</title>',
    read('css.html'),
    '</head><body>',
    '<div id="bg-layer"><div class="bg-grid"></div><div class="bg-glow"></div><div class="bg-stripes"></div></div>',
    read('ui.html'),
    ERROR_TRAP
  ];
  if (!shared) {
    parts.push(GAS_MOCK, '<script>' + serverSource() + '</script>', RUNNER_LOCAL);
  } else {
    parts.push(RUNNER_SHARED);
  }
  parts.push('<script>window.APP_INFO = { name: "TETRA.GS", version: "test" };</script>');
  CLIENT_FILES.forEach(f => parts.push(read(f)));
  parts.push('</body></html>');
  return parts.join('\n');
}

function writePage(mode, outPath) {
  const html = buildPage(mode);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');
  return outPath;
}

module.exports = { buildPage, writePage };
