// store.js — Durable key/value storage adapter for the Second Brain server.
//
// Backend selection:
//   * If MEMORY_DATABASE_URL or DATABASE_URL is set → Postgres (pg Pool, max 3,
//     ssl rejectUnauthorized:false) using table:
//       sb_store (k TEXT PRIMARY KEY, v JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())
//   * Otherwise → JSON files in ./data/<key>.json (the legacy behavior).
//
// Write-through pattern: init() hydrates every key into an in-memory cache at
// boot so the existing synchronous route handlers keep working unchanged.
// get()/set() are synchronous against the cache; set() flushes to the backend
// asynchronously (fire-and-forget with error logging plus one retry).

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const TABLE = 'sb_store';

let _pool = null; // pg Pool when Postgres is active
const _cache = Object.create(null);

function _connString() {
  return process.env.MEMORY_DATABASE_URL || process.env.DATABASE_URL || '';
}

// Keys map 1:1 to the legacy data/<key>.json files.
function _filePath(key) {
  return path.join(DATA_DIR, String(key).replace(/[^a-zA-Z0-9._-]/g, '_') + '.json');
}

function _loadFilesIntoCache(skipExisting) {
  let names = [];
  try { names = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')); } catch { return; }
  for (const f of names) {
    const key = f.slice(0, -5);
    if (skipExisting && (key in _cache)) continue;
    try { _cache[key] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); }
    catch (e) { console.warn(`[store] could not read data/${f}:`, e.message); }
  }
}

function _flushPg(key, attempt) {
  if (!_pool) return;
  _pool.query(
    `INSERT INTO ${TABLE} (k, v, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now()`,
    [key, JSON.stringify(_cache[key])]
  ).catch((e) => {
    if (attempt < 1) {
      console.warn(`[store] pg write "${key}" failed (will retry once):`, e.message);
      setTimeout(() => _flushPg(key, attempt + 1), 1000);
    } else {
      console.error(`[store] pg write "${key}" failed permanently:`, e.message);
    }
  });
}

function _flushFile(key, attempt) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFile(_filePath(key), JSON.stringify(_cache[key], null, 2), (e) => {
      if (!e) return;
      if (attempt < 1) {
        console.warn(`[store] file write "${key}" failed (will retry once):`, e.message);
        setTimeout(() => _flushFile(key, attempt + 1), 1000);
      } else {
        console.error(`[store] file write "${key}" failed permanently:`, e.message);
      }
    });
  } catch (e) { console.error(`[store] file write "${key}" failed:`, e.message); }
}

let _initPromise = null;

module.exports = {
  get usingPostgres() { return !!_pool; },

  // Hydrate the cache at boot. Idempotent: repeat callers share one hydration.
  init() {
    if (!_initPromise) _initPromise = this._doInit();
    return _initPromise;
  },

  async _doInit() {
    const conn = _connString();
    if (conn) {
      try {
        const { Pool } = require('pg');
        _pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false }, max: 3 });
        _pool.on('error', (e) => console.warn('[store] pg pool error:', e.message));
        await _pool.query(
          `CREATE TABLE IF NOT EXISTS ${TABLE} (k TEXT PRIMARY KEY, v JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`
        );
        const r = await _pool.query(`SELECT k, v FROM ${TABLE}`);
        for (const row of r.rows) _cache[row.k] = row.v;
        // One-time migration: seed Postgres from any legacy data/*.json files
        // whose keys aren't in the table yet (first boot after enabling PG).
        const pgKeys = new Set(r.rows.map((row) => row.k));
        _loadFilesIntoCache(true);
        let migrated = 0;
        for (const key of Object.keys(_cache)) {
          if (!pgKeys.has(key)) { _flushPg(key, 0); migrated++; }
        }
        console.log(`[store] Postgres hydrated: ${r.rows.length} keys (+${migrated} migrated from data/*.json)`);
        return;
      } catch (e) {
        console.warn('[store] Postgres unavailable, falling back to files:', e.message);
        try { if (_pool) await _pool.end(); } catch (_) {}
        _pool = null;
      }
    }
    _loadFilesIntoCache(false);
    console.log(`[store] file-backed: ${Object.keys(_cache).length} keys loaded from data/`);
  },

  // Synchronous read from the in-memory cache.
  get(key, fallback) {
    return (key in _cache) ? _cache[key] : fallback;
  },

  // Synchronous cache update + asynchronous fire-and-forget flush (one retry).
  set(key, value) {
    _cache[key] = value;
    if (_pool) _flushPg(key, 0);
    else _flushFile(key, 0);
  },
};
