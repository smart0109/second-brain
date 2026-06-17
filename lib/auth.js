// Multi-provider auth: user store, email allowlist, and OAuth helpers for
// Google (login + data), Microsoft/Entra (login only), and Zoho (data).
const { google } = require('googleapis');
const db = require('./db');

// ---------------------------------------------------------------------------
// User store + allowlist
// ---------------------------------------------------------------------------
async function isAllowed(email) {
  const e = (email || '').toLowerCase().trim();
  if (!e) return false;
  const { rows } = await db.query(`SELECT 1 FROM allowlist WHERE email = $1`, [e]);
  return rows.length > 0;
}

async function findUserById(id) {
  const { rows } = await db.query(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function findUserByEmail(email) {
  const { rows } = await db.query(`SELECT * FROM users WHERE email = $1`, [
    (email || '').toLowerCase(),
  ]);
  return rows[0] || null;
}

// Create or update a user on login. provider in {google, microsoft}.
async function upsertUserOnLogin({ email, name, provider, providerId }) {
  const e = (email || '').toLowerCase().trim();
  const nm = name || e.split('@')[0];
  const providerCol = provider === 'google' ? 'google_sub' : provider === 'microsoft' ? 'microsoft_oid' : null;

  const existing = await findUserByEmail(e);
  if (!existing) {
    const { rows } = await db.query(
      `INSERT INTO users (email, name, last_login_at) VALUES ($1, $2, now()) RETURNING *`,
      [e, nm]
    );
    const user = rows[0];
    if (providerCol && providerId) {
      await db.query(`UPDATE users SET ${providerCol} = $1 WHERE id = $2`, [providerId, user.id]);
      user[providerCol] = providerId;
    }
    return user;
  }

  // Update name + provider id + last_login on the existing row.
  if (providerCol && providerId) {
    await db.query(
      `UPDATE users SET name = COALESCE($1, name), ${providerCol} = COALESCE($2, ${providerCol}), last_login_at = now() WHERE id = $3`,
      [nm, providerId, existing.id]
    );
  } else {
    await db.query(`UPDATE users SET name = COALESCE($1, name), last_login_at = now() WHERE id = $2`, [nm, existing.id]);
  }
  return await findUserById(existing.id);
}

async function listAllowlist() {
  const { rows } = await db.query(`SELECT email, added_by, created_at FROM allowlist ORDER BY email`);
  return rows;
}
async function addToAllowlist(email, addedBy) {
  await db.query(
    `INSERT INTO allowlist (email, added_by) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING`,
    [(email || '').toLowerCase().trim(), addedBy || null]
  );
}
async function removeFromAllowlist(email) {
  await db.query(`DELETE FROM allowlist WHERE email = $1`, [(email || '').toLowerCase().trim()]);
}
async function listUsers() {
  const { rows } = await db.query(
    `SELECT id, email, name, is_admin, created_at, last_login_at FROM users ORDER BY created_at`
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Google OAuth (login + data scopes)
// ---------------------------------------------------------------------------
const GOOGLE_LOGIN_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];
const GOOGLE_DATA_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

function googleClient(redirectUri) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

function googleAuthUrl({ redirectUri, scopes, state }) {
  const oauth2 = googleClient(redirectUri);
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: scopes,
    state,
  });
}

async function exchangeGoogle({ code, redirectUri }) {
  const oauth2 = googleClient(redirectUri);
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  const info = await google.oauth2({ version: 'v2', auth: oauth2 }).userinfo.get();
  return {
    tokens,
    profile: {
      email: (info.data.email || '').toLowerCase(),
      name: info.data.name,
      sub: info.data.id,
    },
  };
}

// ---------------------------------------------------------------------------
// Microsoft / Entra OAuth (login/identity only)
// ---------------------------------------------------------------------------
function msTenant() {
  return process.env.MS_TENANT || 'common';
}
function msAuthUrl({ redirectUri, state }) {
  const p = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID || '',
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: 'openid profile email offline_access User.Read',
    state,
  });
  return `https://login.microsoftonline.com/${msTenant()}/oauth2/v2.0/authorize?${p.toString()}`;
}

function decodeJwtPayload(jwt) {
  try {
    const part = jwt.split('.')[1];
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return {};
  }
}

async function exchangeMicrosoft({ code, redirectUri }) {
  const body = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID || '',
    client_secret: process.env.MS_CLIENT_SECRET || '',
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    scope: 'openid profile email offline_access User.Read',
  });
  const resp = await fetch(`https://login.microsoftonline.com/${msTenant()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    throw new Error(`Microsoft token exchange failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  const claims = decodeJwtPayload(data.id_token || '');
  let email = (claims.email || claims.preferred_username || '').toLowerCase();
  let name = claims.name;
  // Fallback to Graph if the id_token lacked an email claim.
  if (!email && data.access_token) {
    try {
      const me = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (me.ok) {
        const j = await me.json();
        email = (j.mail || j.userPrincipalName || '').toLowerCase();
        name = name || j.displayName;
      }
    } catch (e) {
      console.warn('Graph /me lookup failed:', e.message);
    }
  }
  return { tokens: data, profile: { email, name, oid: claims.oid || claims.sub } };
}

// ---------------------------------------------------------------------------
// Zoho OAuth (data connection). which = 'zoho' (US) | 'zoho_vorro' (IN)
// ---------------------------------------------------------------------------
function zohoAccountsHost(which) {
  return which === 'zoho_vorro'
    ? process.env.VORRO_ZOHO_ACCOUNTS_HOST || 'https://accounts.zoho.in'
    : process.env.ZOHO_ACCOUNTS_HOST || 'https://accounts.zoho.com';
}
function zohoClientId(which) {
  return which === 'zoho_vorro' ? process.env.VORRO_ZOHO_CLIENT_ID : process.env.ZOHO_CLIENT_ID;
}
function zohoClientSecret(which) {
  return which === 'zoho_vorro' ? process.env.VORRO_ZOHO_CLIENT_SECRET : process.env.ZOHO_CLIENT_SECRET;
}
function zohoAuthUrl({ which, redirectUri, state }) {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: zohoClientId(which) || '',
    scope: 'ZohoCRM.modules.ALL,ZohoCRM.settings.ALL,ZohoCRM.users.READ',
    redirect_uri: redirectUri,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${zohoAccountsHost(which)}/oauth/v2/auth?${p.toString()}`;
}
async function exchangeZoho({ which, code, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: zohoClientId(which) || '',
    client_secret: zohoClientSecret(which) || '',
    redirect_uri: redirectUri,
    code,
  });
  const resp = await fetch(`${zohoAccountsHost(which)}/oauth/v2/token`, { method: 'POST', body });
  if (!resp.ok) throw new Error(`Zoho token exchange failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  if (data.error) throw new Error(`Zoho token error: ${data.error}`);
  return { tokens: data };
}

module.exports = {
  isAllowed,
  findUserById,
  findUserByEmail,
  upsertUserOnLogin,
  listAllowlist,
  addToAllowlist,
  removeFromAllowlist,
  listUsers,
  GOOGLE_LOGIN_SCOPES,
  GOOGLE_DATA_SCOPES,
  googleAuthUrl,
  exchangeGoogle,
  msAuthUrl,
  exchangeMicrosoft,
  zohoAuthUrl,
  exchangeZoho,
};
