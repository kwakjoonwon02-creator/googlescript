/**
 * TETRA.GS — Google Apps Script multiplayer Tetris
 * ------------------------------------------------
 * Entry points and the single RPC surface used by the client.
 *
 * The client never calls individual functions; it calls rpc(method, payload)
 * so that adding an endpoint is a one-line change and every call gets the
 * same error envelope.
 */

var APP = {
  name: 'TETRA.GS',
  version: '1.0.0'
};

/** Web app entry point. */
function doGet(e) {
  var t = HtmlService.createTemplateFromFile('index');
  t.appName = APP.name;
  // Pre-serialised because <?= ?> HTML-escapes, which would corrupt the
  // string literals if this were interpolated inside the <script> block.
  t.appInfoJson = JSON.stringify({ name: APP.name, version: APP.version });
  return t.evaluate()
    .setTitle(APP.name)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Used by index.html to inline the other client files. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * Handlers are resolved at call time (not load time) so that this file does
 * not depend on the order Apps Script evaluates the other .gs files in.
 */
function rpcHandlers_() {
  return {
    bootstrap: Api_bootstrap,
    register: Api_register,
    login: Api_login,
    logout: Api_logout,
    guest: Api_guest,
    setPassword: Api_setPassword,
    setName: Api_setName,
    profile: Api_profile,
    submitSolo: Api_submitSolo,
    leaderboard: Api_leaderboard,

    queueJoin: Api_queueJoin,
    queuePoll: Api_queuePoll,
    queueLeave: Api_queueLeave,

    roomCreate: Api_roomCreate,
    roomJoin: Api_roomJoin,
    roomLeave: Api_roomLeave,
    roomConfig: Api_roomConfig,
    roomList: Api_roomList,
    chatSend: Api_chatSend,
    sync: Api_sync
  };
}

/**
 * Single entry point for every client call.
 * Always resolves to {ok, data} or {ok:false, error} — never throws across
 * the google.script.run boundary, so the client only needs one failure path.
 */
function rpc(method, payload) {
  var started = Date.now();
  try {
    var handler = rpcHandlers_()[method];
    if (!handler) throw new Error('Unknown RPC method: ' + method);
    var data = handler(payload || {});
    return { ok: true, data: data, t: Date.now(), ms: Date.now() - started };
  } catch (err) {
    console.error('rpc(' + method + ') failed: ' + (err && err.stack || err));
    return { ok: false, error: String((err && err.message) || err), t: Date.now() };
  }
}

/**
 * Run once from the Apps Script editor to create the backing spreadsheet and
 * print the web app checklist. Safe to run repeatedly.
 */
function setup() {
  var ss = Store_spreadsheet();
  Logger.log('Database ready: ' + ss.getUrl());
  Logger.log('Sheets: ' + ss.getSheets().map(function (s) { return s.getName(); }).join(', '));
  return ss.getUrl();
}

/** Removes stale rooms and queue entries. Wire to a time-driven trigger (10 min). */
function janitor() {
  var removedRooms = Rooms_sweep();
  var removedQueue = Matchmaking_sweep();
  Logger.log('janitor: rooms=' + removedRooms + ' queue=' + removedQueue);
}

/** Installs the janitor trigger. Run once from the editor. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'janitor') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('janitor').timeBased().everyMinutes(10).create();
  Logger.log('janitor trigger installed');
}
