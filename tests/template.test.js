/* Renders index.html the way HtmlService would and checks the result is a
   valid page: no leftover scriptlets, every include resolved, and every
   script block still parses (which catches HTML-escaped JS literals). */
const vm = require('vm');
const { render } = require('./lib/gas-template');
const { read, CLIENT_FILES } = require('./lib/sources');
const { makeGasSandbox } = require('./lib/gas-sandbox');
const { test: t, assert, eq, section, note, finish } = require('./lib/report');

const server = makeGasSandbox();

function renderIndex() {
  // Mirror exactly what doGet() assigns to the template.
  const vars = {
    appName: server.APP.name,
    appInfoJson: JSON.stringify({ name: server.APP.name, version: server.APP.version })
  };
  return render(read('index.html'), vars, name => read(name + '.html'));
}

section('template rendering');

let page = '';

t('index.html renders without leaving scriptlets behind', () => {
  page = renderIndex();
  assert(page.length > 100000, 'page looks truncated: ' + page.length + ' bytes');
  assert(page.indexOf('<?') === -1, 'unrendered scriptlet remains');
  assert(page.indexOf('?>') === -1, 'unrendered scriptlet remains');
});

t('every include resolves to its file', () => {
  const includes = [];
  const re = /include\(\s*'([a-z_]+)'\s*\)/g;
  let m;
  const src = read('index.html');
  while ((m = re.exec(src)) !== null) includes.push(m[1]);
  assert(includes.length >= 11, 'expected the full include list, got ' + includes.length);
  // Match on whole file contents: several client files open with the same
  // banner comment, so a short prefix is not unique enough to locate them.
  includes.forEach(name => {
    assert(page.indexOf(read(name + '.html').trim()) !== -1,
      'include did not land in the page: ' + name);
  });
  // The client modules must all be present, in the order index.html lists.
  let cursor = -1;
  CLIENT_FILES.forEach(file => {
    const at = page.indexOf(read(file).trim());
    assert(at !== -1, 'missing client file: ' + file);
    assert(at > cursor, 'client files are out of order at ' + file);
    cursor = at;
  });
});

t('every script block in the rendered page still parses', () => {
  const blocks = [];
  const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(page)) !== null) blocks.push(m[1]);
  assert(blocks.length >= 10, 'expected the client modules, found ' + blocks.length + ' scripts');
  blocks.forEach((code, i) => {
    if (!code.trim()) return;
    try {
      new vm.Script(code, { filename: 'rendered-script-' + i + '.js' });
    } catch (err) {
      throw new Error('script block ' + i + ' does not parse: ' + err.message +
        '\n' + code.trim().slice(0, 160));
    }
  });
  note(blocks.length + ' script blocks parsed');
});

t('APP_INFO survives templating as real JSON', () => {
  const m = /window\.APP_INFO\s*=\s*([^;]+);/.exec(page);
  assert(m, 'APP_INFO assignment not found');
  assert(m[1].indexOf('&quot;') === -1, 'APP_INFO was HTML-escaped: ' + m[1]);
  const parsed = JSON.parse(m[1].trim());
  eq(parsed.name, server.APP.name, 'app name');
  eq(parsed.version, server.APP.version, 'app version');
});

t('the title is escaped as HTML, not printed raw', () => {
  const custom = render('<title><?= appName ?></title>', { appName: 'a<b>&"c"' }, () => '');
  eq(custom, '<title>a&lt;b&gt;&amp;&quot;c&quot;</title>', 'HTML context escaping');
});

t('the stylesheet and markup land in the right places', () => {
  const headEnd = page.indexOf('</head>');
  assert(headEnd > 0, 'no head');
  assert(page.indexOf('<style>') < headEnd, 'styles must be inside <head>');
  assert(page.indexOf('id="screen-menu"') > headEnd, 'markup must be inside <body>');
  assert(page.indexOf('id="board"') > headEnd, 'game canvas missing');
});

section('manifest');

t('the manifest is valid JSON and deploys as a public web app', () => {
  const manifest = JSON.parse(read('appsscript.json'));
  eq(manifest.runtimeVersion, 'V8', 'runtime');
  eq(manifest.webapp.executeAs, 'USER_DEPLOYING', 'must run as the deployer to share one database');
  eq(manifest.webapp.access, 'ANYONE_ANONYMOUS', 'players need access without signing in');
  assert(!manifest.oauthScopes,
    'scopes are left to Apps Script: an incomplete hardcoded list fails at runtime');
});

t('every RPC method the client calls exists on the server', () => {
  const called = new Set();
  CLIENT_FILES.forEach(file => {
    const src = read(file);
    // Matches call('x') and its transport-specific wrappers, e.g.
    // appsScriptCall('x'), so splitting the transport does not read as drift.
    const re = /[Cc]all\(\s*'([a-zA-Z]+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) called.add(m[1]);
  });
  assert(called.size >= 10, 'expected the client to call the API, found ' + called.size);
  const handlers = server.rpcHandlers_();
  called.forEach(method => {
    assert(typeof handlers[method] === 'function', 'client calls unknown method: ' + method);
  });
  Object.keys(handlers).forEach(method => {
    assert(called.has(method), 'server exposes a method nothing calls: ' + method);
  });
  note(called.size + ' methods, client and server agree');
});

process.exit(finish() ? 0 : 1);
