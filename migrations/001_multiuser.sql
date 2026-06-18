-- Second Brain multi-tenant schema (001)
-- Safe to run repeatedly (IF NOT EXISTS guards).

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT,
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  google_sub    TEXT,
  microsoft_oid TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS allowlist (
  email      TEXT PRIMARY KEY,
  added_by   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Encrypted per-user data-source credentials (token vault).
-- ciphertext = AES-256-GCM( JSON payload ), with iv + auth_tag stored alongside.
CREATE TABLE IF NOT EXISTS user_tokens (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,         -- 'google' | 'zoho' | 'zoho_vorro' | 'granola'
  account_label TEXT,                  -- display only (email / org)
  ciphertext    TEXT NOT NULL,
  iv            TEXT NOT NULL,
  auth_tag      TEXT NOT NULL,
  scopes        TEXT,
  expiry        TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

-- Per-owner memory blobs (owner = user id as text, or '__company__' /
-- '__company_pending__'). data holds the JSON array of memory items.
CREATE TABLE IF NOT EXISTS memory_blobs (
  owner_key  TEXT PRIMARY KEY,
  data       JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- Recall.ai bot ownership: which user launched each bot, so transcript reads can
-- be scoped per-user even when admins share a single env API key.
CREATE TABLE IF NOT EXISTS recall_bots (
  bot_id      TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meeting_url TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recall_bots_user ON recall_bots(user_id);

-- connect-pg-simple session table (also auto-created at runtime; declared here for completeness).
CREATE TABLE IF NOT EXISTS "session" (
  sid    VARCHAR NOT NULL PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" (expire);
