/**
 * Reads the Apps Script project straight out of src/ so the tests always run
 * against the files that get deployed — no build step, no copies to drift.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');

/** Server files, in the order Apps Script would evaluate them. */
const SERVER_FILES = [
  'Store.gs', 'Glicko.gs', 'Ranks.gs', 'Players.gs', 'Accounts.gs',
  'Settings.gs', 'Leaderboard.gs', 'Rooms.gs', 'Matchmaking.gs', 'Code.gs'
];

/** Client files, in the order index.html includes them. */
const CLIENT_FILES = [
  'js_util.html', 'js_engine.html', 'js_attack.html', 'js_render.html',
  'js_input.html', 'js_ai.html', 'js_net.html', 'js_game.html', 'js_app.html'
];

function read(name) {
  return fs.readFileSync(path.join(SRC, name), 'utf8');
}

/** Pulls the JavaScript out of a `<script>`-wrapped client file. */
function scriptOf(name) {
  const html = read(name);
  const blocks = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  if (!blocks.length) throw new Error('no <script> block in ' + name);
  return blocks.join('\n');
}

function serverSource() {
  return SERVER_FILES.map(read).join('\n');
}

module.exports = { SRC, SERVER_FILES, CLIENT_FILES, read, scriptOf, serverSource };
