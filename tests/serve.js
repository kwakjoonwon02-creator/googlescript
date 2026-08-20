/**
 * Serves the client with the mocked Apps Script backend behind /rpc, so two
 * real browser tabs can play each other. Started automatically by the online
 * suites; run directly to play the mock build by hand.
 *
 * With a relay configured it also exposes /settle, which is how the relay
 * reports finished matches back — the same doPost the real deployment uses.
 */
const http = require('http');
const { makeGasSandbox } = require('./lib/gas-sandbox');
const { buildPage } = require('./lib/build-page');

function createServer(options) {
  const opts = options || {};
  const sandbox = makeGasSandbox();
  const PAGE = buildPage('shared');

  if (opts.relaySecret) {
    const props = sandbox.PropertiesService.getScriptProperties();
    props.setProperty('RELAY_SECRET', opts.relaySecret);
    if (opts.relayUrl) props.setProperty('RELAY_URL', opts.relayUrl);
  }

  const server = http.createServer((req, res) => {
    const json = payload => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'POST' && (req.url === '/rpc' || req.url === '/settle')) {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          if (req.url === '/settle') {
            json(JSON.parse(sandbox.doPost({ postData: { contents: body } }).getContent()));
            return;
          }
          const { method, payload } = JSON.parse(body || '{}');
          json(sandbox.rpc(method, payload));
        } catch (err) {
          json({ ok: false, error: String(err.message) });
        }
      });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });

  return {
    sandbox,
    server,
    listen(port) {
      return new Promise(resolve => {
        server.listen(port === undefined ? 0 : port, () => resolve(server.address().port));
      });
    },
    close() { return new Promise(resolve => server.close(resolve)); }
  };
}

module.exports = { createServer };

if (require.main === module) {
  createServer({}).listen(Number(process.env.PORT) || 0).then(port => {
    console.log('PORT=' + port);
  });
}
