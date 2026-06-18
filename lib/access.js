// Per-request allowlist re-check with a short TTL cache, so removing someone from
// the allowlist revokes access within seconds (instead of waiting for their
// session cookie to expire). Hard, immediate kill is done by purging their
// sessions in the admin remove route; this recheck is the always-on guarantee.
const authLib = require('./auth');

const TTL_MS = 15000;
const cache = new Map(); // email -> { ok, exp }

async function isStillAllowed(email) {
  const e = (email || '').toLowerCase();
  const c = cache.get(e);
  if (c && Date.now() < c.exp) return c.ok;
  const ok = await authLib.isAllowed(e);
  cache.set(e, { ok, exp: Date.now() + TTL_MS });
  return ok;
}
function invalidate(email) {
  if (email) cache.delete((email || '').toLowerCase());
  else cache.clear();
}
module.exports = { isStillAllowed, invalidate, _cache: cache, TTL_MS };
