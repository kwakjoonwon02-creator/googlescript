/**
 * Loads the room logic into a sandbox with the relay's own storage and the
 * two override hooks wired up.
 */
const vm = require('vm');
const { RELAY_FILES, read } = require('./sources');
const { createStore } = require('./store');

/**
 * @param {{clock?: {now: function}, authenticate: function, settle: function}} options
 */
function createRuntime(options) {
  const clock = options.clock || { now: () => Date.now() };
  const store = createStore(clock);

  const sandbox = {
    console,
    Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp,
    isFinite, isNaN, parseInt, parseFloat,
    Date: { now: clock.now }
  };
  Object.assign(sandbox, store);
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  RELAY_FILES.forEach(file => {
    vm.runInContext(read(file), sandbox, { filename: file });
  });

  sandbox.ROOMS_OVERRIDES.authenticate = options.authenticate;
  sandbox.ROOMS_OVERRIDES.settle = options.settle;

  return { sandbox, store, clock };
}

/** Methods the relay answers. Everything else belongs to Apps Script. */
const RELAY_METHODS = {
  queueJoin: 'Api_queueJoin',
  queuePoll: 'Api_queuePoll',
  queueLeave: 'Api_queueLeave',
  roomCreate: 'Api_roomCreate',
  roomJoin: 'Api_roomJoin',
  roomLeave: 'Api_roomLeave',
  roomConfig: 'Api_roomConfig',
  roomList: 'Api_roomList',
  chatSend: 'Api_chatSend',
  sync: 'Api_sync'
};

module.exports = { createRuntime, RELAY_METHODS };
