// Postgres connection pool + migration runner for Second Brain multi-tenant store.
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const connectionString = process.env.DATABASE_URL;

// Render-managed Postgres requires SSL; allow opt-out for local dev.
const ssl =
  process.env.PGSSL === 'disable'
    ? false
    : connectionString && /localhost|127\.0\.0\.1/.test(connectionString)
    ? false
    : { rejectUnauthorized: false };

let pool = null;

function __setPoolForTests(p) { pool = p; }

function getPool() {
  if (pool) return pool;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Multi-user features require Postgres.');
  }
  if (!pool) {
    pool = new Pool({ connectionString, ssl, max: 5, idleTimeoutMillis: 30_000 });
    pool.on('error', (e) => console.error('[db] idle client error:', e.message));
  }
  return pool;
}

function isConfigured() {
  return !!connectionString;
}

async function query(text, params) {
  return getPool().query(text, params);
}

// Run the SQL migration(s). Idempotent (IF NOT EXISTS throughout).
async function migrate() {
  const file = path.join(__dirname, '..', 'migrations', '001_multiuser.sql');
  const sql = fs.readFileSync(file, 'utf8');
  await getPool().query(sql);

  // Bootstrap: seed the initial admin + allowlist from env so the owner is never locked out.
  const bootstrap = (process.env.ALLOWED_EMAIL || '').toLowerCase().trim();
  if (bootstrap) {
    await getPool().query(
      `INSERT INTO allowlist (email, added_by) VALUES ($1, 'bootstrap')
       ON CONFLICT (email) DO NOTHING`,
      [bootstrap]
    );
    await getPool().query(
      `INSERT INTO users (email, name, is_admin) VALUES ($1, $2, TRUE)
       ON CONFLICT (email) DO UPDATE SET is_admin = TRUE`,
      [bootstrap, bootstrap.split('@')[0]]
    );
  }
  // Extra bootstrap admins (comma-separated), e.g. manish@basisvps.com
  const extra = (process.env.ADMIN_EMAILS || 'manish@basisvps.com')
    .split(',')
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean);
  for (const em of extra) {
    await getPool().query(
      `INSERT INTO allowlist (email, added_by) VALUES ($1, 'bootstrap') ON CONFLICT (email) DO NOTHING`,
      [em]
    );
    await getPool().query(
      `INSERT INTO users (email, name, is_admin) VALUES ($1, $2, TRUE)
       ON CONFLICT (email) DO UPDATE SET is_admin = TRUE`,
      [em, em.split('@')[0]]
    );
  }
}

async function close() {
  if (pool) await pool.end();
  pool = null;
}

module.exports = { getPool, isConfigured, query, migrate, close, __setPoolForTests };
