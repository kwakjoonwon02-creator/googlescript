/** Tiny test reporter shared by every suite. */
let pass = 0;
let fail = 0;

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message ? message + ': ' : '') +
      'expected ' + JSON.stringify(expected) + ' but got ' + JSON.stringify(actual));
  }
}

function close(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error((message ? message + ': ' : '') +
      'expected ~' + expected + ' but got ' + actual);
  }
}

function section(title) {
  console.log('\n== ' + title + ' ==');
}

function note(text) {
  console.log('        ' + text);
}

function test(name, fn) {
  try {
    fn();
    console.log('  PASS  ' + name);
    pass++;
  } catch (err) {
    console.log('  FAIL  ' + name);
    console.log('        ' + String(err.message).split('\n').join('\n        '));
    fail++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log('  PASS  ' + name);
    pass++;
  } catch (err) {
    console.log('  FAIL  ' + name);
    console.log('        ' + String(err.message).split('\n')[0]);
    fail++;
  }
}

function finish() {
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  return fail === 0;
}

module.exports = { assert, eq, close, section, note, test, testAsync, finish };
