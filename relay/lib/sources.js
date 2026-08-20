/**
 * Reads the realtime layer straight out of ../src.
 *
 * The relay does not own a copy of the room logic. It loads the same .gs
 * files the Apps Script deployment runs, so the two can never drift apart.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');

/** Only the realtime layer. Accounts, ratings and history stay on Apps Script. */
const RELAY_FILES = ['Rooms.gs', 'Matchmaking.gs'];

function read(name) {
  return fs.readFileSync(path.join(SRC, name), 'utf8');
}

module.exports = { SRC, RELAY_FILES, read };
