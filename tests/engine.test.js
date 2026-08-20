/* Tetris engine: rules, scoring, garbage, and a full bot game. */
const { makeClientSandbox } = require('./lib/client-sandbox');
const { test: t, assert, eq, section, note, finish } = require('./lib/report');

const s = makeClientSandbox();
const { Engine, Attack, BOARD_W, BOARD_H, VISIBLE_ROWS } = s;

section('bag');
t('7-bag contains each piece exactly once per bag', () => {
  const e = new Engine({ seed: 12345 });
  const seen = [e.piece.type].concat(e.bag.peek(20));
  for (let b = 0; b < 2; b++) {
    const chunk = seen.slice(b * 7, b * 7 + 7).sort().join('');
    eq(chunk, 'IJLOSTZ', 'bag ' + b + ' = ' + chunk);
  }
});

t('same seed produces the same piece order', () => {
  const a = new Engine({ seed: 999 }), b = new Engine({ seed: 999 });
  eq(a.piece.type, b.piece.type);
  eq(a.bag.peek(20).join(''), b.bag.peek(20).join(''));
});

t('different seeds diverge', () => {
  const a = new Engine({ seed: 1 }), b = new Engine({ seed: 2 });
  assert(a.bag.peek(14).join('') !== b.bag.peek(14).join(''));
});

section('geometry / spawn');
t('every piece spawns without collision on an empty board', () => {
  for (const type of ['I','J','L','O','S','T','Z']) {
    const e = new Engine({ seed: 1 });
    e.cells.fill(0);
    e.spawn(type);
    assert(e.alive, type + ' topped out on spawn');
    const cells = e.pieceCells();
    eq(cells.length, 4, type + ' cell count');
    for (const [x, y] of cells) assert(x >= 0 && x < BOARD_W, type + ' spawn x out of range: ' + x);
  }
});

t('rotating four times returns to the original position', () => {
  for (const type of ['I','J','L','O','S','T','Z']) {
    const e = new Engine({ seed: 5 });
    e.cells.fill(0);
    e.spawn(type);
    const before = JSON.stringify(e.piece);
    for (let i = 0; i < 4; i++) e.rotate(1);
    eq(JSON.stringify(e.piece), before, type + ' rotation cycle');
  }
});

t('pieces cannot pass through walls', () => {
  const e = new Engine({ seed: 7 });
  e.cells.fill(0); e.spawn('I');
  let moves = 0;
  while (e.move(-1)) { moves++; if (moves > 30) throw new Error('runaway'); }
  const xs = e.pieceCells().map(c => c[0]);
  eq(Math.min(...xs), 0, 'left wall');
  while (e.move(1)) {}
  eq(Math.max(...e.pieceCells().map(c => c[0])), BOARD_W - 1, 'right wall');
});

section('line clears');
function fillRow(e, y, exceptX) {
  for (let x = 0; x < BOARD_W; x++) if (x !== exceptX) e.cells[y * BOARD_W + x] = 8;
}

t('a full row is cleared', () => {
  const e = new Engine({ seed: 3 });
  e.cells.fill(0);
  fillRow(e, BOARD_H - 1, 4);
  e.spawn('I');
  e.piece.rotation = 1; e.piece.x = 2;  // vertical I over column 4
  e.hardDrop();
  eq(e.stats.lines, 1, 'lines cleared');
});

t('a quad clears four rows and sends 4 garbage', () => {
  const e = new Engine({ seed: 3 });
  e.cells.fill(0);
  for (let y = BOARD_H - 4; y < BOARD_H; y++) fillRow(e, y, 0);
  e.cells[(BOARD_H - 6) * BOARD_W + 5] = 5;   // keeps this from being a perfect clear
  e.spawn('I');
  e.piece.rotation = 1; e.piece.x = -2;   // vertical I lands in column 0
  const before = e.stats.attack;
  e.hardDrop();
  eq(e.stats.lines, 4, 'four rows');
  eq(e.stats.attack - before, 4, 'quad attack');
  eq(e.stats.quads, 1, 'quad counter');
});

t('a quad that empties the board also pays the perfect-clear bonus', () => {
  const e = new Engine({ seed: 3 });
  e.cells.fill(0);
  for (let y = BOARD_H - 4; y < BOARD_H; y++) fillRow(e, y, 0);
  e.spawn('I');
  e.piece.rotation = 1; e.piece.x = -2;
  e.hardDrop();
  eq(e.stats.perfectClears, 1, 'perfect clear detected');
  eq(e.stats.attack, 14, 'quad 4 + perfect clear 10');
});

t('cleared rows compact downward correctly', () => {
  const e = new Engine({ seed: 3 });
  e.cells.fill(0);
  fillRow(e, BOARD_H - 2, 4);            // this row will be cleared
  e.cells[(BOARD_H - 3) * BOARD_W + 0] = 5;  // marker above it
  e.cells[(BOARD_H - 1) * BOARD_W + 9] = 6;  // marker below it
  e.spawn('I'); e.piece.rotation = 1; e.piece.x = 2;
  e.hardDrop();
  eq(e.stats.lines, 1);
  eq(e.cells[(BOARD_H - 2) * BOARD_W + 0], 5, 'marker fell by one row');
  eq(e.cells[(BOARD_H - 1) * BOARD_W + 9], 6, 'row below untouched');
});

section('t-spin');
t('T-spin double: rotating into the slot is detected and sends 4', () => {
  const e = new Engine({ seed: 3 });
  e.cells.fill(0);
  const yA = BOARD_H - 1, yB = BOARD_H - 2, yC = BOARD_H - 3;
  // Bottom row open at col 4; row above open at cols 3-5; an overhang at
  // (3, yC) means the only way into the slot is a rotation.
  for (let x = 0; x < BOARD_W; x++) {
    if (x !== 4) e.cells[yA * BOARD_W + x] = 8;
    if (x !== 3 && x !== 4 && x !== 5) e.cells[yB * BOARD_W + x] = 8;
  }
  e.cells[yC * BOARD_W + 3] = 8;

  e.spawn('T');
  e.piece.rotation = 1;          // pointing right, resting beside the overhang
  e.piece.x = 3;
  e.piece.y = yC;
  assert(!e.collides(e.piece), 'setup position is blocked');
  assert(e.isGrounded(), 'setup position is not grounded');

  assert(e.rotate(1), 'rotation into the slot failed');
  eq(e.detectSpin_(), 'full', 'spin type');

  const before = e.stats.attack;
  e.lockPiece();
  eq(e.stats.lines, 2, 'rows cleared');
  eq(e.stats.tspins, 1, 't-spin counter');
  eq(e.stats.attack - before, 4, 't-spin double attack');
});

t('T-spin corner rule needs three occupied corners', () => {
  const e = new Engine({ seed: 3 });
  e.cells.fill(0);
  e.spawn('T');
  e.piece.x = 3; e.piece.y = BOARD_H - 3; e.piece.rotation = 2;
  e.lastMoveWasRotation = true;
  eq(e.detectSpin_(), null, 'open board is not a spin');
  // Two bottom corners plus one top corner = full spin for rotation 2.
  e.cells[(BOARD_H - 1) * BOARD_W + 3] = 8;
  e.cells[(BOARD_H - 1) * BOARD_W + 5] = 8;
  e.cells[(BOARD_H - 3) * BOARD_W + 3] = 8;
  eq(e.detectSpin_(), 'full', 'three corners with both front corners');
});

t('a plain drop is never a T-spin', () => {
  const e = new Engine({ seed: 3 });
  e.cells.fill(0);
  e.spawn('T');
  e.hardDrop();
  eq(e.stats.tspins, 0);
});

section('attack table');
t('base values match the table', () => {
  const c = (lines, spin, combo, b2b, pc) =>
    Attack.compute({ lines, spin, combo: combo === undefined ? -1 : combo,
                     b2b: b2b === undefined ? -1 : b2b, perfect: !!pc, multiplier: 1 }).attack;
  eq(c(1), 0, 'single');
  eq(c(2), 1, 'double');
  eq(c(3), 2, 'triple');
  eq(c(4), 4, 'quad');
  eq(c(1, 'full'), 2, 'tss');
  eq(c(2, 'full'), 4, 'tsd');
  eq(c(3, 'full'), 6, 'tst');
  eq(c(2, 'mini'), 1, 'mini double');
});
t('back-to-back and combo add on top', () => {
  const c = (o) => Attack.compute(Object.assign({ lines: 4, spin: null, combo: -1, b2b: -1, perfect: false, multiplier: 1 }, o)).attack;
  eq(c({}), 4, 'no bonus');
  eq(c({ b2b: 1 }), 5, 'b2b adds 1');
  assert(c({ combo: 4 }) > 4, 'combo raises attack');
  eq(c({ perfect: true }), 14, 'perfect clear adds 10');
});
t('a line clear with no bonuses never returns negative', () => {
  for (let lines = 1; lines <= 4; lines++)
    for (let combo = -1; combo < 12; combo++)
      for (let b2b = -1; b2b < 8; b2b++) {
        const a = Attack.compute({ lines, spin: null, combo, b2b, perfect: false, multiplier: 1 }).attack;
        assert(a >= 0 && isFinite(a), 'bad attack ' + a);
      }
});

section('garbage');
t('garbage rows are inserted with exactly one hole', () => {
  const e = new Engine({ seed: 11 });
  e.rules.garbageDelay = 0;
  e.receiveGarbage(3);
  e.spawn('O'); e.piece.x = 0;
  e.hardDrop();   // O on top of garbage clears nothing -> garbage lands
  let garbageRows = 0;
  for (let y = 0; y < BOARD_H; y++) {
    let holes = 0, filled = 0;
    for (let x = 0; x < BOARD_W; x++) {
      if (e.cells[y * BOARD_W + x] === 8) filled++; else holes++;
    }
    if (filled === BOARD_W - 1 && holes === 1) garbageRows++;
  }
  eq(garbageRows, 3, 'garbage rows present');
});

t('outgoing attack cancels queued garbage instead of stacking it', () => {
  const e = new Engine({ seed: 13 });
  e.cells.fill(0);
  e.rules.garbageDelay = 0;
  e.receiveGarbage(4);
  eq(e.pendingGarbageCount(), 4);
  for (let y = BOARD_H - 4; y < BOARD_H; y++) fillRow(e, y, 0);
  e.cells[(BOARD_H - 6) * BOARD_W + 5] = 5;   // not a perfect clear
  e.spawn('I'); e.piece.rotation = 1; e.piece.x = -2;
  e.hardDrop();                     // quad -> 4 attack, exactly cancels the queue
  eq(e.pendingGarbageCount(), 0, 'queue drained');
  eq(e.stats.cancelled, 4, 'cancelled counter');
  eq(e.outbox.length, 0, 'nothing sent outward');
});

t('garbage respects the per-lock cap', () => {
  const e = new Engine({ seed: 17 });
  e.rules.garbageDelay = 0;
  e.rules.garbageCap = 8;
  e.receiveGarbage(20);
  e.spawn('O'); e.hardDrop();
  const rows = countGarbageRows(e);
  eq(rows, 8, 'capped at 8 this lock');
  assert(e.pendingGarbageCount() === 12, 'rest stays queued');
});

function countGarbageRows(e) {
  let n = 0;
  for (let y = 0; y < BOARD_H; y++) {
    let g = 0;
    for (let x = 0; x < BOARD_W; x++) if (e.cells[y * BOARD_W + x] === 8) g++;
    if (g === BOARD_W - 1) n++;
  }
  return n;
}

t('garbage delay holds rows back until it elapses', () => {
  const e = new Engine({ seed: 19 });
  e.rules.garbageDelay = 5000;
  e.receiveGarbage(2);
  e.spawn('O'); e.hardDrop();
  eq(countGarbageRows(e), 0, 'not yet inserted');
  eq(e.pendingGarbageCount(), 2, 'still queued');
});

section('serialization');
t('board snapshot round-trips the visible field', () => {
  const e = new Engine({ seed: 23 });
  e.cells.fill(0);
  e.cells[(BOARD_H - 1) * BOARD_W + 3] = 5;
  const str = e.serializeBoard();
  eq(str.length, VISIBLE_ROWS * BOARD_W, 'length');
  eq(str.charAt((VISIBLE_ROWS - 1) * BOARD_W + 3), '5', 'cell preserved');
});

section('topout');
t('stacking to the ceiling tops out', () => {
  const e = new Engine({ seed: 29 });
  for (let y = 5; y < BOARD_H; y++) for (let x = 0; x < BOARD_W; x++) e.cells[y * BOARD_W + x] = 8;
  e.spawn('T');
  assert(!e.alive, 'should have topped out');
});

t('zen mode never tops out', () => {
  const e = new Engine({ seed: 31, rules: { infiniteMode: true } });
  for (let y = 5; y < BOARD_H; y++) for (let x = 0; x < BOARD_W; x++) e.cells[y * BOARD_W + x] = 8;
  e.spawn('T');
  assert(e.alive, 'zen should survive');
});

section('full games');
t('AI plays 300 pieces without crashing', () => {
  const e = new Engine({ seed: 41 });
  const ai = new s.AI.Controller(e, 5);
  let guard = 0;
  while (e.stats.pieces < 300 && e.alive && guard++ < 20000) ai.update(1000);
  assert(e.stats.pieces >= 100, 'only placed ' + e.stats.pieces + ' pieces');
  assert(e.stats.lines > 20, 'AI cleared only ' + e.stats.lines + ' lines');
  note('AI: ' + e.stats.pieces + ' pieces, ' + e.stats.lines +
              ' lines, ' + e.stats.attack + ' attack, ' + e.stats.quads + ' quads, alive=' + e.alive);
  assert(e.stats.attack >= 20, 'AI is too passive: only ' + e.stats.attack + ' attack in 300 pieces');
});

t('two AI engines exchange garbage until someone dies', () => {
  const a = new Engine({ seed: 77 }), b = new Engine({ seed: 78 });
  a.rules.garbageDelay = 0; b.rules.garbageDelay = 0;
  const ca = new s.AI.Controller(a, 5), cb = new s.AI.Controller(b, 1);
  let guard = 0;
  while (a.alive && b.alive && guard++ < 4000) {
    ca.update(400); cb.update(400);
    a.drainOutbox().forEach(x => b.receiveGarbage(x.n));
    b.drainOutbox().forEach(x => a.receiveGarbage(x.n));
  }
  note('strong: ' + a.stats.attack + ' atk / weak: ' + b.stats.attack +
              ' atk, loser=' + (a.alive ? 'weak' : 'strong'));
  assert(!a.alive || !b.alive, 'nobody died in ' + guard + ' iterations');
  assert(!b.alive, 'the stronger bot should win');
});

t('gravity alone eventually locks pieces', () => {
  const e = new Engine({ seed: 43 });
  // Default gravity is 1 row/s, so a piece needs ~20s to reach the floor.
  for (let i = 0; i < 60 * 240; i++) e.tick(16.7, 1);
  assert(e.stats.pieces > 5, 'only ' + e.stats.pieces + ' pieces locked by gravity');
});

t('soft drop factor speeds gravity up', () => {
  const slow = new Engine({ seed: 43 }), fast = new Engine({ seed: 43 });
  for (let i = 0; i < 120; i++) { slow.tick(16.7, 1); fast.tick(16.7, 20); }
  assert(fast.piece.y > slow.piece.y, 'soft drop did not fall faster');
});

process.exit(finish() ? 0 : 1);
