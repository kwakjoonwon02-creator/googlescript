/**
 * Serves the client with the mocked Apps Script backend behind /rpc, so two
 * real browser tabs can play each other. Started automatically by
 * tests/online.test.js; run directly to play the mock build by hand.
 */
const http = require('http');
const { makeGasSandbox } = require('./lib/gas-sandbox');
const { buildPage } = require('./lib/build-page');

const sandbox = makeGasSandbox();
const PAGE = buildPage('shared');

const server = http.createServer((req, res) => {
  if (req.url === '/rpc' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let out;
      try {
        const { method, payload } = JSON.parse(body || '{}');
        out = sandbox.rpc(method, payload);
      } catch (err) {
        out = { ok: false, error: String(err.message) };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

const port = Number(process.env.PORT) || 0;
server.listen(port, () => {
  console.log('PORT=' + server.address().port);
});
