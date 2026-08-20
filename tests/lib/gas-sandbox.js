/**
 * In-memory stand-ins for the Apps Script services the server uses, so the
 * real .gs files can be exercised in Node.
 *
 * Time runs for real (matching production) with an offset that tests can push
 * forward to skip countdowns and interludes.
 */
const vm = require('vm');
const crypto = require('crypto');
const { SERVER_FILES, read } = require('./sources');

function makeGasSandbox() {
  const RealDate = Date;
  let offset = 0;
  const nowMs = () => RealDate.now() + offset;

  function FakeDate(...args) { return new RealDate(...args); }
  FakeDate.now = nowMs;
  FakeDate.prototype = RealDate.prototype;

  let uuidCounter = 0;

  /* ---------------------------------------------------------- spreadsheet */

  class Sheet {
    constructor(name) { this.name = name; this.rows = []; }
    getName() { return this.name; }
    getLastRow() { return this.rows.length; }
    setFrozenRows() { return this; }
    appendRow(row) { this.rows.push(row.slice()); return this; }
    getRange(row, col, numRows, numCols) {
      const sheet = this;
      return {
        setValues(values) {
          for (let r = 0; r < values.length; r++) {
            const target = row - 1 + r;
            while (sheet.rows.length <= target) sheet.rows.push([]);
            for (let c = 0; c < values[r].length; c++) {
              sheet.rows[target][col - 1 + c] = values[r][c];
            }
          }
          return this;
        },
        getValues() {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const src = sheet.rows[row - 1 + r] || [];
            const line = [];
            for (let c = 0; c < numCols; c++) {
              line.push(src[col - 1 + c] === undefined ? '' : src[col - 1 + c]);
            }
            out.push(line);
          }
          return out;
        },
        setFontWeight() { return this; },
        setBackground() { return this; },
        setFontColor() { return this; }
      };
    }
  }

  class Spreadsheet {
    constructor(id) { this.id = id; this.sheets = [new Sheet('Sheet1')]; }
    getId() { return this.id; }
    getUrl() { return 'mock://' + this.id; }
    getSheets() { return this.sheets.slice(); }
    getSheetByName(name) { return this.sheets.find(s => s.name === name) || null; }
    insertSheet(name) { const s = new Sheet(name); this.sheets.push(s); return s; }
    deleteSheet(sheet) { this.sheets = this.sheets.filter(s => s !== sheet); }
  }

  const books = {};
  const SpreadsheetApp = {
    create() {
      const id = 'ss_' + (++uuidCounter);
      books[id] = new Spreadsheet(id);
      return books[id];
    },
    openById(id) {
      if (!books[id]) throw new Error('spreadsheet not found: ' + id);
      return books[id];
    }
  };

  /* ------------------------------------------------ cache / props / lock */

  const cache = new Map();
  const CacheService = {
    getScriptCache: () => ({
      get: k => (cache.has(k) ? cache.get(k) : null),
      put: (k, v) => { cache.set(k, v); },
      remove: k => { cache.delete(k); },
      getAll(keys) {
        const out = {};
        keys.forEach(k => { if (cache.has(k)) out[k] = cache.get(k); });
        return out;
      }
    })
  };

  const props = new Map();
  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: k => (props.has(k) ? props.get(k) : null),
      setProperty: (k, v) => { props.set(k, v); },
      deleteProperty: k => { props.delete(k); }
    })
  };

  // Apps Script serialises executions rather than threads, so a single
  // boolean models the script lock faithfully enough. A second acquisition
  // inside the same execution is a bug, and this surfaces it.
  let lockHeld = false;
  const LockService = {
    getScriptLock: () => ({
      tryLock() { if (lockHeld) return false; lockHeld = true; return true; },
      waitLock() { if (lockHeld) throw new Error('lock is already held by this execution'); lockHeld = true; },
      releaseLock() { lockHeld = false; }
    })
  };

  const Utilities = {
    getUuid: () => 'uuid-' + String(++uuidCounter).padStart(12, '0') + '-abcdef0123456789',

    // Apps Script hands back signed bytes (-128..127), and code that base64s
    // the result depends on that. Reproducing it exactly is the point: the
    // relay verifies these signatures with Node's crypto.
    computeHmacSha256Signature(value, key) {
      const digest = crypto.createHmac('sha256', key).update(String(value), 'utf8').digest();
      return Array.from(digest).map(b => (b > 127 ? b - 256 : b));
    },

    base64EncodeWebSafe(input) {
      const buffer = Array.isArray(input)
        ? Buffer.from(input.map(b => (b < 0 ? b + 256 : b)))
        : Buffer.from(String(input), 'utf8');
      return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    }
  };

  const ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput(text) {
      return {
        _text: text,
        setMimeType() { return this; },
        getContent() { return this._text; }
      };
    }
  };

  // rpc() logs every caught error, and several tests exercise failure paths
  // on purpose. Keep those stacks out of the report unless asked for.
  const quietConsole = Object.assign({}, console, {
    error: process.env.TETRA_VERBOSE ? console.error : function () {},
    warn: process.env.TETRA_VERBOSE ? console.warn : function () {}
  });

  const sandbox = {
    console: quietConsole,
    Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp,
    isFinite, isNaN, parseInt, parseFloat,
    Date: FakeDate,
    SpreadsheetApp, CacheService, PropertiesService, LockService, Utilities, ContentService,
    Logger: { log() {} },
    HtmlService: {},
    Session: {},
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() {} }) }) })
    },
    // test controls
    __clock: {
      now: nowMs,
      set(value) { offset = value - RealDate.now(); return nowMs(); },
      advance(ms) { offset += ms; return nowMs(); }
    },
    __cache: cache,
    __props: props,
    __lockHeld: () => lockHeld
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  SERVER_FILES.forEach(name => {
    vm.runInContext(read(name), sandbox, { filename: name });
  });

  return sandbox;
}

module.exports = { makeGasSandbox };
