/**
 * TETRA.GS realtime relay.
 *
 * Apps Script keeps serving the page and owns accounts, ratings, ranks and
 * history. This process owns only the part that is latency bound: rooms,
 * matchmaking, live board state, chat and spectating. It runs the very same
 * Rooms.gs and Matchmaking.gs the Apps Script deployment does — see
 * lib/sources.js — so there is one implementation, not two.
 *
 * Transport is request/response over a WebSocket, deliberately the same
 * shape the client already speaks to google.script.run. That keeps the
 * client a transport swap rather than a rewrite, and lets a deployment run
 * with no relay at all.
 */
const http = require('http');
const { WebSocketServer } = require('ws');

const { createRuntime, RELAY_METHODS } = require('./lib/runtime');
const { verify } = require('./lib/ticket');
const { createSettler } = require('./lib/settle');

const HELLO_TIMEOUT_MS = 8000;
const SWEEP_INTERVAL_MS = 30000;
const MAX_MESSAGE_BYTES = 64 * 1024;

function createRelay(config) {
  const log = config.log || ((...args) => console.log('[relay]', ...args));
  const clock = config.clock || { now: () => Date.now() };

  const settler = createSettler({
    url: config.settleUrl,
    secret: config.secret,
    fetchImpl: config.fetchImpl,
    log: log,
    onSettled: (code, results) => {
      const room = runtime.sandbox.Rooms_load(code);
      if (!room) return;
      room.results = results;
      runtime.sandbox.Rooms_save(room);
    }
  });

  const runtime = createRuntime({
    clock: clock,
    authenticate: payload => {
      if (!payload || !payload.__player) throw new Error('Not authenticated.');
      return payload.__player;
    },
    settle: settler.settle
  });

  const sockets = new Map();   // playerId -> ws

  function dispatch(socket, method, payload) {
    const name = RELAY_METHODS[method];
    if (!name) throw new Error('Unknown method: ' + method);
    const args = Object.assign({}, payload || {});
    // The socket's verified ticket is the only identity that counts; anything
    // the client claims about who it is gets overwritten here.
    args.__player = socket.player;
    args.id = socket.player.id;
    const data = runtime.sandbox[name](args);
    if (method === 'roomJoin' || method === 'roomCreate') {
      socket.roomCode = (data && data.room && data.room.code) || socket.roomCode;
    }
    if (method === 'roomLeave') socket.roomCode = null;
    return data;
  }

  function send(socket, message) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  function onMessage(socket, raw) {
    if (raw.length > MAX_MESSAGE_BYTES) {
      send(socket, { i: 0, ok: false, e: 'message too large' });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      send(socket, { i: 0, ok: false, e: 'malformed message' });
      return;
    }

    if (msg.m === 'hello') {
      const result = verify(msg.p && msg.p.ticket, config.secret, clock.now());
      if (!result.ok) {
        send(socket, { i: msg.i, ok: false, e: result.error });
        socket.close(4001, 'unauthenticated');
        return;
      }
      socket.player = result.player;
      clearTimeout(socket.helloTimer);

      // One connection per player: a reconnect replaces the old socket
      // rather than leaving a ghost holding the seat.
      const previous = sockets.get(socket.player.id);
      if (previous && previous !== socket) previous.close(4000, 'replaced');
      sockets.set(socket.player.id, socket);

      send(socket, { i: msg.i, ok: true, d: { you: publicPlayer(socket.player), t: clock.now() } });
      return;
    }

    if (!socket.player) {
      send(socket, { i: msg.i, ok: false, e: 'say hello first' });
      return;
    }

    try {
      send(socket, { i: msg.i, ok: true, d: dispatch(socket, msg.m, msg.p), t: clock.now() });
    } catch (err) {
      send(socket, { i: msg.i, ok: false, e: String((err && err.message) || err), t: clock.now() });
    }
  }

  function onClose(socket) {
    if (!socket.player) return;
    if (sockets.get(socket.player.id) === socket) sockets.delete(socket.player.id);

    // Dropping out of a lobby should free the seat immediately. Dropping out
    // of a live match must not: the room's own disconnect timeout decides
    // that, so the behaviour matches the pure Apps Script deployment.
    if (!socket.roomCode) return;
    try {
      const room = runtime.sandbox.Rooms_load(socket.roomCode);
      if (!room) return;
      if (room.state === 'lobby' || room.state === 'matchover') {
        dispatch(socket, 'roomLeave', { code: socket.roomCode });
      }
    } catch (e) {
      log('cleanup failed for ' + socket.player.id + ': ' + e.message);
    }
  }

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        connections: sockets.size,
        settle: config.settleUrl ? 'configured' : 'missing',
        uptimeSeconds: Math.round(process.uptime())
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('TETRA.GS relay. The game itself is served by Apps Script.\n');
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', socket => {
    socket.player = null;
    socket.roomCode = null;
    socket.helloTimer = setTimeout(() => {
      if (!socket.player) socket.close(4001, 'no ticket');
    }, HELLO_TIMEOUT_MS);

    socket.on('message', data => onMessage(socket, data));
    socket.on('close', () => { clearTimeout(socket.helloTimer); onClose(socket); });
    socket.on('error', () => {});
  });

  const sweeper = setInterval(() => {
    try {
      runtime.sandbox.Rooms_sweep();
      runtime.sandbox.Matchmaking_sweep();
    } catch (e) {
      log('sweep failed: ' + e.message);
    }
  }, SWEEP_INTERVAL_MS);
  if (sweeper.unref) sweeper.unref();

  return {
    runtime,
    httpServer,
    wss,
    sockets,
    listen(port) {
      return new Promise(resolve => {
        httpServer.listen(port, () => resolve(httpServer.address().port));
      });
    },
    close() {
      clearInterval(sweeper);
      wss.close();
      return new Promise(resolve => httpServer.close(resolve));
    }
  };
}

function publicPlayer(player) {
  return { id: player.id, name: player.name, tr: player.tr, rank: player.rank };
}

module.exports = { createRelay };

/* ------------------------------------------------------------------ main */

if (require.main === module) {
  const secret = process.env.RELAY_SECRET;
  if (!secret) {
    console.error('RELAY_SECRET is required. Set the same value in the Apps Script project properties.');
    process.exit(1);
  }
  if (!process.env.SETTLE_URL) {
    console.warn('SETTLE_URL is not set: ranked results will not reach the spreadsheet.');
  }
  const relay = createRelay({
    secret: secret,
    settleUrl: process.env.SETTLE_URL
  });
  relay.listen(Number(process.env.PORT) || 8080).then(port => {
    console.log('[relay] listening on ' + port);
  });
}
