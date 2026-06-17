// Encrypted per-user token vault (AES-256-GCM).
// Stores each user's data-source credentials so no provider token is ever
// global/shared. Key comes from TOKEN_ENC_KEY (32 bytes, hex or base64).
const crypto = require('crypto');
const db = require('./db');

const ALGO = 'aes-256-gcm';

function getKey() {
  const raw = process.env.TOKEN_ENC_KEY;
  if (!raw) throw new Error('TOKEN_ENC_KEY is not set (need 32-byte hex or base64 key).');
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, 'hex');
  else key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`TOKEN_ENC_KEY must decode to 32 bytes, got ${key.length}.`);
  }
  return key;
}

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

function decrypt({ ciphertext, iv, authTag }) {
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const out = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(out.toString('utf8'));
}

// Generate a fresh key (used by the CLI helper / docs).
function generateKey() {
  return crypto.randomBytes(32).toString('hex');
}

// Upsert a provider credential for a user.
// payload: { refresh_token, access_token?, ... } (object, will be encrypted)
async function setToken(userId, provider, payload, meta = {}) {
  const { ciphertext, iv, authTag } = encrypt(payload);
  await db.query(
    `INSERT INTO user_tokens (user_id, provider, account_label, ciphertext, iv, auth_tag, scopes, expiry, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (user_id, provider) DO UPDATE SET
       account_label = EXCLUDED.account_label,
       ciphertext = EXCLUDED.ciphertext,
       iv = EXCLUDED.iv,
       auth_tag = EXCLUDED.auth_tag,
       scopes = EXCLUDED.scopes,
       expiry = EXCLUDED.expiry,
       updated_at = now()`,
    [
      userId,
      provider,
      meta.accountLabel || null,
      ciphertext,
      iv,
      authTag,
      meta.scopes || null,
      meta.expiry || null,
    ]
  );
}

// Return the decrypted payload object, or null if not connected.
async function getToken(userId, provider) {
  const { rows } = await db.query(
    `SELECT ciphertext, iv, auth_tag, account_label, scopes, expiry
       FROM user_tokens WHERE user_id = $1 AND provider = $2`,
    [userId, provider]
  );
  if (!rows.length) return null;
  const r = rows[0];
  const payload = decrypt({ ciphertext: r.ciphertext, iv: r.iv, authTag: r.auth_tag });
  return { payload, accountLabel: r.account_label, scopes: r.scopes, expiry: r.expiry };
}

async function deleteToken(userId, provider) {
  await db.query(`DELETE FROM user_tokens WHERE user_id = $1 AND provider = $2`, [userId, provider]);
}

// Connection status (no secrets) for the UI.
async function listConnections(userId) {
  const { rows } = await db.query(
    `SELECT provider, account_label, scopes, expiry, updated_at
       FROM user_tokens WHERE user_id = $1 ORDER BY provider`,
    [userId]
  );
  return rows.map((r) => ({
    provider: r.provider,
    accountLabel: r.account_label,
    scopes: r.scopes,
    expiry: r.expiry,
    updatedAt: r.updated_at,
  }));
}

module.exports = { encrypt, decrypt, generateKey, setToken, getToken, deleteToken, listConnections };
