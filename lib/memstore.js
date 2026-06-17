// Durable per-owner memory store: in-memory cache with write-through to Postgres
// (memory_blobs). Keeps the synchronous Map-like API the routes already use, but
// survives restarts. No-ops to cache-only when DATABASE_URL is unset (dev).
const db = require('./db');

const cache = new Map();
let loaded = false;

async function load() {
  if (loaded) return;
  if (db.isConfigured()) {
    try {
      const { rows } = await db.query('SELECT owner_key, data FROM memory_blobs');
      for (const r of rows) cache.set(r.owner_key, Array.isArray(r.data) ? r.data : []);
    } catch (e) {
      console.error('[memstore] load failed:', e.message);
    }
  }
  loaded = true;
}

function get(key) {
  return cache.get(key);
}

function set(key, arr) {
  cache.set(key, arr);
  if (db.isConfigured()) {
    db.query(
      `INSERT INTO memory_blobs (owner_key, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (owner_key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [key, JSON.stringify(arr)]
    ).catch((e) => console.error('[memstore] persist failed:', e.message));
  }
  return cache;
}

function del(key) {
  const had = cache.delete(key);
  if (db.isConfigured()) {
    db.query('DELETE FROM memory_blobs WHERE owner_key = $1', [key]).catch((e) =>
      console.error('[memstore] delete failed:', e.message)
    );
  }
  return had;
}

module.exports = { load, get, set, delete: del, _cache: cache };
