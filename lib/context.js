// Request-scoped context so token helpers can resolve "the current user"
// without threading userId through every handler signature.
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();

function run(ctx, fn) {
  return als.run(ctx, fn);
}
function get() {
  return als.getStore() || null;
}
function currentUserId() {
  const s = als.getStore();
  return s ? s.userId : null;
}
module.exports = { als, run, get, currentUserId };
