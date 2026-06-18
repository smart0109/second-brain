// CRO Second Brain - Express Backend Server
// Proxies Gmail, Calendar, Drive (Google), Zoho CRM, Granola, and Claude APIs

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const db = require('./lib/db');
const tokens = require('./lib/tokens');
const authLib = require('./lib/auth');
const ctx = require('./lib/context');
const memstore = require('./lib/memstore');
const msgraph = require('./lib/msgraph');
const hubspotLib = require('./lib/crm_hubspot');
const crm = require('./lib/crm');
const recall = require('./lib/recall');
const recallBots = require('./lib/recall_bots');

const app = express();

// === Error Telemetry Storage ===
const ERROR_LOG_PATH = path.join(__dirname, 'data', 'errors.json');
let errorLog = [];
let errorCounts = {};
const CIRCUIT_BREAK_THRESHOLD = 2;

try {
  if (fs.existsSync(ERROR_LOG_PATH)) {
    const data = JSON.parse(fs.readFileSync(ERROR_LOG_PATH, 'utf8'));
    errorLog = data.log || [];
    errorCounts = data.counts || {};
  }
} catch(e) { console.warn('Could not load error log:', e.message); }

function saveErrorLog() {
  try {
    const dir = path.dirname(ERROR_LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ERROR_LOG_PATH, JSON.stringify({ log: errorLog, counts: errorCounts }, null, 2));
  } catch(e) { console.warn('Could not save error log:', e.message); }
}


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const ALLOWED_EMAILS = [
  (process.env.ALLOWED_EMAIL || 'manish696@gmail.com').toLowerCase(),
  'manish@basisvps.com',
];
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

// Fail closed in production: refuse to boot with insecure/missing secrets.
if (process.env.NODE_ENV === 'production') {
  if (!process.env.SESSION_SECRET) { console.error('FATAL: SESSION_SECRET is required in production.'); process.exit(1); }
  if (db.isConfigured() && !process.env.TOKEN_ENC_KEY) { console.error('FATAL: TOKEN_ENC_KEY is required when DATABASE_URL is set.'); process.exit(1); }
}

const ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';

// Google OAuth scopes
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Trust Render's reverse proxy for secure cookies / correct protocol
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Session store: Postgres-backed (durable across restarts/deploys) when DATABASE_URL
// is set, else in-memory (dev only).
let _sessionStore;
if (db.isConfigured()) {
  const pgSession = require('connect-pg-simple')(session);
  _sessionStore = new pgSession({ pool: db.getPool(), tableName: 'session', createTableIfMissing: true });
} else {
  console.warn('[startup] DATABASE_URL not set - using in-memory sessions (multi-user disabled).');
}

app.use(
  session({
    store: _sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    },
  })
);

// Bind the logged-in user to request-scoped context so token helpers can resolve
// "the current user" without threading userId through every handler.
app.use((req, _res, next) => {
  ctx.run({ userId: (req.session && req.session.userId) || null,
            isAdmin: !!(req.session && req.session.isAdmin),
            email: (req.session && req.session.email) || null }, () => next());
});

// ---------------------------------------------------------------------------
// Google OAuth2 helpers
// ---------------------------------------------------------------------------
function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`
  );
}

// Per-user Google client: loads THIS user's refresh token from the encrypted
// vault. No global GOOGLE_REFRESH_TOKEN is used anymore.
async function getAuthedClient() {
  const userId = ctx.currentUserId();
  if (!userId) return null;
  const t = await tokens.getToken(userId, 'google');
  if (!t || !t.payload || !t.payload.refresh_token) return null;
  const oauth2 = createOAuth2Client();
  oauth2.setCredentials({ refresh_token: t.payload.refresh_token });
  return oauth2;
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'Not authenticated. Visit /auth/google to sign in.' });
}

// ---------------------------------------------------------------------------
// Zoho token cache — Cadient (US DC) + Vorro (India DC)
// ---------------------------------------------------------------------------
const VORRO_ZOHO_API_DOMAIN = process.env.VORRO_ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
const VORRO_ZOHO_TOKEN_URL = process.env.VORRO_ZOHO_TOKEN_URL || 'https://accounts.zoho.in/oauth/v2/token';

// Per-user Zoho access-token cache, keyed `${userId}:${provider}`.
const zohoUserCache = new Map();

// Refresh a Zoho access token for the CURRENT user using their vault-stored
// refresh token. The OAuth app (client id/secret) is shared; the grant is per user.
async function _zohoAccessToken(provider) {
  const userId = ctx.currentUserId();
  if (!userId) throw new Error('Not authenticated.');
  const ck = `${userId}:${provider}`;
  const cached = zohoUserCache.get(ck);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.accessToken;

  const t = await tokens.getToken(userId, provider);
  if (!t || !t.payload || !t.payload.refresh_token) {
    throw new Error(`${provider === 'zoho_vorro' ? 'Vorro Zoho' : 'Zoho'} not connected. Connect it from the dashboard.`);
  }
  const isVorro = provider === 'zoho_vorro';
  const tokenUrl = isVorro ? VORRO_ZOHO_TOKEN_URL : (process.env.ZOHO_TOKEN_URL || 'https://accounts.zoho.com/oauth/v2/token');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: isVorro ? process.env.VORRO_ZOHO_CLIENT_ID : process.env.ZOHO_CLIENT_ID,
    client_secret: isVorro ? process.env.VORRO_ZOHO_CLIENT_SECRET : process.env.ZOHO_CLIENT_SECRET,
    refresh_token: t.payload.refresh_token,
  });
  const resp = await fetch(tokenUrl, { method: 'POST', body: params });
  if (!resp.ok) throw new Error(`Zoho token refresh failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  if (data.error) throw new Error(`Zoho token error: ${data.error}`);
  const entry = { accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  zohoUserCache.set(ck, entry);
  return entry.accessToken;
}

async function getZohoAccessToken() {
  return _zohoAccessToken('zoho');
}

async function getVorroZohoAccessToken() {
  return _zohoAccessToken('zoho_vorro');
}

// ---------------------------------------------------------------------------
// Gmail helpers
// ---------------------------------------------------------------------------
function decodeBase64Url(str) {
  if (!str) return '';
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function getHeader(headers, name) {
  if (!headers) return '';
  const h = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function extractPlainBody(payload) {
  if (!payload) return '';
  // Direct body
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return decodeBase64Url(payload.body.data);
  }
  // Recurse into parts
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return decodeBase64Url(part.body.data);
      }
      if (part.parts) {
        const nested = extractPlainBody(part);
        if (nested) return nested;
      }
    }
    // Fallback: try text/html if no plain text
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        return decodeBase64Url(part.body.data);
      }
    }
  }
  // Fallback: body.data on root
  if (payload.body && payload.body.data) {
    return decodeBase64Url(payload.body.data);
  }
  return '';
}

function formatGmailMessage(msg) {
  const headers = msg.payload ? msg.payload.headers : [];
  return {
    id: msg.id,
    threadId: msg.threadId,
    subject: getHeader(headers, 'Subject'),
    sender: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    date: getHeader(headers, 'Date'),
    snippet: msg.snippet || '',
    plaintextBody: extractPlainBody(msg.payload),
    labelIds: msg.labelIds || [],
  };
}

// Batch-fetch threads in groups of 5 to avoid rate limits
async function batchGetThreads(gmail, threadIds) {
  const results = [];
  const BATCH_SIZE = 5;
  for (let i = 0; i < threadIds.length; i += BATCH_SIZE) {
    const batch = threadIds.slice(i, i + BATCH_SIZE);
    const promises = batch.map((id) =>
      gmail.users.threads.get({ userId: 'me', id, format: 'full' }).catch((err) => {
        console.error(`Failed to fetch thread ${id}:`, err.message);
        return null;
      })
    );
    const batchResults = await Promise.all(promises);
    results.push(...batchResults.filter(Boolean));
    // Small delay between batches to be safe
    if (i + BATCH_SIZE < threadIds.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// API Handlers
// ---------------------------------------------------------------------------

// ---- Gmail ----
async function handleGmail(toolName, args) {
  const auth = await getAuthedClient();
  if (!auth) throw new Error('Google not connected for this user. Connect Google from the dashboard.');
  const gmail = google.gmail({ version: 'v1', auth });

  if (toolName === 'search_threads') {
    const { query, pageSize } = args || {};
    const listResp = await gmail.users.threads.list({
      userId: 'me',
      q: query || '',
      maxResults: pageSize || 20,
    });
    const threadStubs = listResp.data.threads || [];
    if (threadStubs.length === 0) return { threads: [] };

    const fullThreads = await batchGetThreads(
      gmail,
      threadStubs.map((t) => t.id)
    );
    const threads = fullThreads.map((t) => ({
      id: t.data.id,
      messages: (t.data.messages || []).map(formatGmailMessage),
    }));
    return { threads };
  }

  if (toolName === 'list_drafts') {
    const { pageSize } = args || {};
    const listResp = await gmail.users.drafts.list({
      userId: 'me',
      maxResults: pageSize || 20,
    });
    const draftStubs = listResp.data.drafts || [];
    if (draftStubs.length === 0) return { drafts: [] };

    // Fetch details in batches of 5
    const drafts = [];
    const BATCH_SIZE = 5;
    for (let i = 0; i < draftStubs.length; i += BATCH_SIZE) {
      const batch = draftStubs.slice(i, i + BATCH_SIZE);
      const promises = batch.map((d) =>
        gmail.users.drafts.get({ userId: 'me', id: d.id, format: 'full' }).catch((err) => {
          console.error(`Failed to fetch draft ${d.id}:`, err.message);
          return null;
        })
      );
      const results = await Promise.all(promises);
      for (const r of results) {
        if (!r) continue;
        const msg = r.data.message;
        const headers = msg.payload ? msg.payload.headers : [];
        drafts.push({
          id: r.data.id,
          message: {
            id: msg.id,
            subject: getHeader(headers, 'Subject'),
            to: getHeader(headers, 'To'),
            date: getHeader(headers, 'Date'),
            snippet: msg.snippet || '',
            plaintextBody: extractPlainBody(msg.payload),
          },
        });
      }
      if (i + BATCH_SIZE < draftStubs.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return { drafts };
  }

  if (toolName === 'get_thread') {
    const { threadId } = args || {};
    if (!threadId) throw new Error('threadId is required');
    const resp = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
    return {
      id: resp.data.id,
      messages: (resp.data.messages || []).map(formatGmailMessage),
    };
  }

  if (toolName === 'create_draft') {
    const { subject, body, to, threadId } = args || {};
    const lines = [
      `To: ${to || ''}`,
      `Subject: ${subject || ''}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body || '',
    ];
    const raw = Buffer.from(lines.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const draftBody = { message: { raw } };
    if (threadId) draftBody.message.threadId = threadId;

    const resp = await gmail.users.drafts.create({ userId: 'me', requestBody: draftBody });
    return { id: resp.data.message.id, draftId: resp.data.id };
  }

  throw new Error(`Unknown Gmail tool: ${toolName}`);
}

// ---- Calendar ----
async function handleCalendar(toolName, args) {
  const auth = await getAuthedClient();
  if (!auth) throw new Error('Google not authenticated');
  const calendar = google.calendar({ version: 'v3', auth });

  if (toolName === 'list_events') {
    const { startTime, endTime, timeZone, orderBy } = args || {};
    const params = {
      calendarId: 'primary',
      singleEvents: true,
      orderBy: orderBy || 'startTime',
      maxResults: 50,
    };
    if (startTime) params.timeMin = startTime;
    if (endTime) params.timeMax = endTime;
    if (timeZone) params.timeZone = timeZone;

    const resp = await calendar.events.list(params);
    const events = (resp.data.items || []).map((e) => {
      let conferenceUrl = e.hangoutLink || null;
      if (!conferenceUrl && e.conferenceData && e.conferenceData.entryPoints) {
        const video = e.conferenceData.entryPoints.find((ep) => ep.entryPointType === 'video');
        if (video) conferenceUrl = video.uri;
      }
      return {
        id: e.id,
        summary: e.summary || '',
        start: e.start,
        end: e.end,
        attendees: (e.attendees || []).map((a) => ({
          email: a.email,
          displayName: a.displayName || '',
          self: a.self || false,
          responseStatus: a.responseStatus || '',
        })),
        conferenceUrl,
        location: e.location || '',
        htmlLink: e.htmlLink || '',
        description: e.description || '',
      };
    });
    return { events };
  }

  throw new Error(`Unknown Calendar tool: ${toolName}`);
}

// ---- Zoho CRM ----
async function handleZoho(toolName, args) {
  // Per-user: getZohoAccessToken() throws a clear 'not connected' error if this
  // user has not linked Zoho. No global ZOHO_REFRESH_TOKEN is used.
  const token = await getZohoAccessToken();
  const headers = {
    Authorization: `Zoho-oauthtoken ${token}`,
    'Content-Type': 'application/json',
  };

  if (toolName === 'executeCOQLQuery') {
    const body = args?.body || args;
    const resp = await fetch(`${ZOHO_API_DOMAIN}/crm/v5/coql`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Zoho COQL failed: ${resp.status} ${text}`);
    }
    return await resp.json();
  }

  if (toolName === 'searchRecords') {
    const module = args?.path_variables?.module;
    if (!module) throw new Error('module is required for searchRecords');
    const qp = args?.query_params || {};
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(qp)) {
      if (v !== undefined && v !== null) params.append(k, String(v));
    }
    const url = `${ZOHO_API_DOMAIN}/crm/v2/${module}/search?${params.toString()}`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Zoho search failed: ${resp.status} ${text}`);
    }
    return await resp.json();
  }

  if (toolName === 'updateRecord') {
    const module = args?.path_variables?.module;
    const recordID = args?.path_variables?.recordID;
    if (!module || !recordID) throw new Error('module and recordID are required for updateRecord');
    const resp = await fetch(`${ZOHO_API_DOMAIN}/crm/v2/${module}/${recordID}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(args?.body || {}),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Zoho update failed: ${resp.status} ${text}`);
    }
    return await resp.json();
  }

  if (toolName === 'getRecords') {
    const module = args?.path_variables?.module;
    if (!module) throw new Error('module is required for getRecords');
    const qp = args?.query_params || {};
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(qp)) {
      if (v !== undefined && v !== null) params.append(k, String(v));
    }
    const url = `${ZOHO_API_DOMAIN}/crm/v2/${module}?${params.toString()}`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Zoho getRecords failed: ${resp.status} ${text}`);
    }
    return await resp.json();
  }

  if (toolName === 'getRecord') {
    const module = args?.path_variables?.module;
    const recordID = args?.path_variables?.recordID;
    if (!module || !recordID) throw new Error('module and recordID required');
    const resp = await fetch(`${ZOHO_API_DOMAIN}/crm/v2/${module}/${recordID}`, { headers });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Zoho getRecord failed: ${resp.status} ${text}`);
    }
    return await resp.json();
  }

  // Generic fallback for other Zoho tools
  throw new Error(`Unhandled Zoho tool: ${toolName}. Supported: executeCOQLQuery, searchRecords, updateRecord, getRecords, getRecord`);
}

// ---- Granola ----
// Load cached meetings data (refreshed periodically via Cowork scheduled task)
let meetingsCache = null;
function loadMeetingsCache() {
  try {
    const cachePath = path.join(__dirname, 'public', 'meetings-cache.json');
    if (fs.existsSync(cachePath)) {
      meetingsCache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      console.log(`Meetings cache loaded: ${meetingsCache.meetings?.length || 0} meetings`);
    }
  } catch (e) { console.error('Failed to load meetings cache:', e.message); }
}
loadMeetingsCache();

async function getGranolaKey() {
  const userId = ctx.currentUserId();
  if (userId) {
    const t = await tokens.getToken(userId, 'granola');
    if (t && t.payload && t.payload.api_key) return t.payload.api_key;
  }
  // Legacy shared key is only honored for an admin's own session (no cross-user leak).
  const c = ctx.get();
  if (c && c.isAdmin && process.env.GRANOLA_API_KEY) return process.env.GRANOLA_API_KEY;
  return null;
}

async function handleGranola(toolName, args) {
  const apiKey = await getGranolaKey();

  // If we have an API key, use live Granola API
  if (apiKey) {
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    const BASE = 'https://api.granola.ai/v1';
    try {
      if (toolName === 'query_granola_meetings') {
        const resp = await fetch(`${BASE}/meetings/search`, { method: 'POST', headers, body: JSON.stringify({ query: args?.query || '' }) });
        if (!resp.ok) throw new Error(`Granola search: ${resp.status}`);
        return await resp.json();
      }
      if (toolName === 'list_meetings') {
        const resp = await fetch(`${BASE}/meetings`, { headers });
        if (!resp.ok) throw new Error(`Granola list: ${resp.status}`);
        return await resp.json();
      }
      if (toolName === 'get_meeting_transcript') {
        const meetingId = args?.meetingId;
        if (!meetingId) throw new Error('meetingId is required');
        const resp = await fetch(`${BASE}/meetings/${meetingId}/transcript`, { headers });
        if (!resp.ok) throw new Error(`Granola transcript: ${resp.status}`);
        return await resp.json();
      }
      if (toolName === 'get_meetings') {
        const resp = await fetch(`${BASE}/meetings`, { headers });
        if (!resp.ok) throw new Error(`Granola get_meetings: ${resp.status}`);
        return await resp.json();
      }
      throw new Error(`Unknown Granola tool: ${toolName}`);
    } catch (err) {
      console.error('Granola API error:', err.message);
      // Fall through to cache on API error
    }
  }

  // Serve from cache when no API key or API fails
  if (!meetingsCache) loadMeetingsCache();
  if (!meetingsCache) return { error: 'No Granola data available. Cache not loaded.' };

  if (toolName === 'list_meetings') {
    const range = args?.time_range || 'last_30_days';
    const now = new Date();
    let cutoff = new Date(now);
    if (range === 'this_week') { cutoff.setDate(now.getDate() - now.getDay()); cutoff.setHours(0,0,0,0); }
    else if (range === 'last_week') { cutoff.setDate(now.getDate() - 7); }
    else { cutoff.setDate(now.getDate() - 30); }
    const filtered = (meetingsCache.meetings || []).filter(m => new Date(m.date) >= cutoff);
    return { meetings: filtered };
  }

  if (toolName === 'get_meetings') {
    const ids = args?.meeting_ids || [];
    if (ids.length) {
      const found = (meetingsCache.meetings || []).filter(m => ids.includes(m.id));
      return { meetings: found };
    }
    return { meetings: meetingsCache.meetings || [] };
  }

  if (toolName === 'get_meeting_transcript') {
    const mid = args?.meetingId;
    const mtg = (meetingsCache.meetings || []).find(m => m.id === mid);
    if (mtg && mtg.summary) return { transcript: mtg.summary, text: mtg.summary };
    return { error: 'No transcript in cache for this meeting' };
  }

  if (toolName === 'query_granola_meetings') {
    const q = (args?.query || '').toLowerCase();
    if (q.includes('action item') || q.includes('follow-up')) {
      return { answer: meetingsCache.intelligence?.actionItems || 'No cached action items.' };
    }
    if (q.includes('decision')) {
      return { answer: meetingsCache.intelligence?.decisions || 'No cached decisions.' };
    }
    // Default: return weekly summary
    return { answer: meetingsCache.intelligence?.weeklySummary || 'No cached summary.' };
  }

  return { error: `Unknown Granola tool: ${toolName}` };
}

// ---- Drive ----
async function handleDrive(toolName, args) {
  const auth = await getAuthedClient();
  if (!auth) throw new Error('Google not authenticated');
  const drive = google.drive({ version: 'v3', auth });

  if (toolName === 'search_files') {
    const { query, pageSize } = args || {};
    const params = {
      q: query || '',
      pageSize: pageSize || 20,
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
      orderBy: 'modifiedTime desc',
    };
    const resp = await drive.files.list(params);
    const files = (resp.data.files || []).map((f) => ({
      id: f.id,
      title: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      viewUrl: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
    }));
    return { files };
  }

  if (toolName === 'list_recent_files') {
    const { pageSize } = args || {};
    const params = {
      pageSize: pageSize || 10,
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
      orderBy: 'modifiedTime desc',
    };
    const resp = await drive.files.list(params);
    const files = (resp.data.files || []).map((f) => ({
      id: f.id,
      title: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      viewUrl: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
    }));
    return { files };
  }

  throw new Error(`Unknown Drive tool: ${toolName}`);
}

// ---------------------------------------------------------------------------
// Tool name resolution: extract service + operation from full MCP tool name
// ---------------------------------------------------------------------------
function resolveToolName(fullName) {
  // Full MCP format: mcp__<uuid>__<operation>
  // Extract the UUID segment and operation
  const parts = fullName.split('__');
  if (parts.length >= 3) {
    const uuid = parts[1];
    const operation = parts.slice(2).join('__');
    return { uuid, operation };
  }
  // Fallback: treat as operation name directly
  return { uuid: '', operation: fullName };
}

function routeTool(fullToolName) {
  const { uuid, operation } = resolveToolName(fullToolName);

  if (fullToolName.includes('9561144e') || uuid === '9561144e-87f0-4ebc-b6ce-79cb22df9c27') {
    return { service: 'gmail', operation };
  }
  if (fullToolName.includes('3df8d99f') || uuid === '3df8d99f-29e6-4b72-aff5-d20c243cd8cc') {
    return { service: 'calendar', operation };
  }
  if (fullToolName.includes('ebef5225') || uuid === 'ebef5225-9c03-4cba-9a7a-d6093b72e70d') {
    return { service: 'zoho', operation };
  }
  if (fullToolName.includes('71e0cfca') || uuid === '71e0cfca-ad84-47ab-9d34-6b8b20c1f749') {
    return { service: 'granola', operation };
  }
  if (fullToolName.includes('30527659') || uuid === '30527659-94cd-40e2-94f3-2d183a4d50bb') {
    return { service: 'drive', operation };
  }

  // Try matching by operation name alone (for simplified tool names)
  const gmailOps = ['search_threads', 'list_drafts', 'get_thread', 'create_draft', 'label_message', 'label_thread', 'list_labels', 'create_label'];
  const calendarOps = ['list_events', 'create_event', 'get_event', 'update_event', 'delete_event', 'list_calendars', 'suggest_time'];
  const granolaOps = ['query_granola_meetings', 'list_meetings', 'get_meeting_transcript', 'list_meeting_folders', 'get_meetings', 'get_account_info'];
  const driveOps = ['search_files', 'list_recent_files', 'get_file_metadata', 'read_file_content', 'download_file_content'];

  if (gmailOps.includes(operation)) return { service: 'gmail', operation };
  if (calendarOps.includes(operation)) return { service: 'calendar', operation };
  if (granolaOps.includes(operation)) return { service: 'granola', operation };
  if (driveOps.includes(operation)) return { service: 'drive', operation };

  // Zoho operations typically have camelCase names
  const zohoOps = ['executeCOQLQuery', 'searchRecords', 'updateRecord', 'getRecords', 'getRecord', 'getModules', 'getFields', 'createRecords', 'updateRecords', 'deleteRecord'];
  if (zohoOps.includes(operation)) return { service: 'zoho', operation };

  return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    multiUser: db.isConfigured(),
    services: {
      googleOAuth: !!process.env.GOOGLE_CLIENT_ID,
      microsoftOAuth: !!process.env.MS_CLIENT_ID,
      zohoOAuth: !!process.env.ZOHO_CLIENT_ID,
      vorroZohoOAuth: !!process.env.VORRO_ZOHO_CLIENT_ID,
      granola: !!(process.env.GRANOLA_API_KEY || meetingsCache),
      claude: !!process.env.ANTHROPIC_API_KEY, gemini: !!process.env.GEMINI_API_KEY, groq: !!process.env.GROQ_API_KEY,
    },
  });
});

// ---------------------------------------------------------------------------
// Auth helpers (multi-provider: Google + Microsoft) + per-user data connections
// ---------------------------------------------------------------------------
const crypto = require('crypto');

function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  return `${proto}://${req.get('host')}`;
}
function googleRedirectUri(req) {
  return process.env.REDIRECT_URI || `${baseUrl(req)}/auth/google/callback`;
}
function msRedirectUri(req) {
  return process.env.MS_REDIRECT_URI || `${baseUrl(req)}/auth/microsoft/callback`;
}
function zohoRedirectUri(req) {
  return process.env.ZOHO_REDIRECT_URI || `${baseUrl(req)}/connect/zoho/callback`;
}
function newState(req, extra) {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauth = { state, extra: extra || {}, ts: Date.now() };
  return state;
}
function checkState(req, given) {
  const o = req.session.oauth;
  if (!o || !given || o.state !== given) return null;
  if (Date.now() - o.ts > 10 * 60 * 1000) return null; // 10-min window
  delete req.session.oauth;
  return o.extra || {};
}
function _escHtml(x){return String(x||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function denied(res, email) {
  return res
    .status(403)
    .send(`<html><body style="font-family:system-ui;max-width:640px;margin:60px auto;text-align:center"><h2>Access denied</h2><p><b>${_escHtml(email) || 'This account'}</b> is not on the allowlist. Ask an admin to add you.</p><p><a href="/">Back</a></p></body></html>`);
}
function requireDb(res) {
  if (!db.isConfigured()) {
    res.status(503).json({ error: 'Multi-user store not configured (DATABASE_URL missing).' });
    return false;
  }
  return true;
}
async function finishLogin(req, res, { email, name, provider, providerId }) {
  if (!(await authLib.isAllowed(email))) return denied(res, email);
  const user = await authLib.upsertUserOnLogin({ email, name, provider, providerId });
  // Prevent session fixation: issue a fresh session id on every successful login.
  await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.userId = user.id;
  req.session.email = user.email;
  req.session.isAdmin = !!user.is_admin;
  return user;
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.userId && req.session.isAdmin) return next();
  return res.status(403).json({ error: 'Admin only.' });
}

// Auth status (per-user)
app.get('/auth/status', async (req, res) => {
  const userId = req.session?.userId || null;
  let connections = [];
  if (userId && db.isConfigured()) {
    try { connections = await tokens.listConnections(userId); } catch (e) { /* ignore */ }
  }
  const has = (p) => connections.some((c) => c.provider === p);
  res.json({
    authenticated: !!userId,
    email: req.session?.email || null,
    isAdmin: !!req.session?.isAdmin,
    providers: { google: true, microsoft: !!process.env.MS_CLIENT_ID },
    services: {
      google: has('google'),
      zoho: has('zoho'),
      vorroZoho: has('zoho_vorro'),
      granola: has('granola') || !!(process.env.GRANOLA_API_KEY || meetingsCache),
      claude: !!process.env.ANTHROPIC_API_KEY, gemini: !!process.env.GEMINI_API_KEY, groq: !!process.env.GROQ_API_KEY,
    },
    connections,
  });
});

// --- Google: login + connect data (Gmail/Calendar/Drive) in one consent ---
app.get('/auth/google', (req, res) => {
  const state = newState(req, { flow: 'google' });
  res.redirect(authLib.googleAuthUrl({ redirectUri: googleRedirectUri(req), scopes: authLib.GOOGLE_DATA_SCOPES, state }));
});
// Connect alias (for an already-logged-in user re-linking Google)
app.get('/connect/google', requireAuth, (req, res) => {
  const state = newState(req, { flow: 'google' });
  res.redirect(authLib.googleAuthUrl({ redirectUri: googleRedirectUri(req), scopes: authLib.GOOGLE_DATA_SCOPES, state }));
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');
  if (!requireDb(res)) return;
  if (!checkState(req, state)) return res.status(400).send('Invalid or expired state. Please retry sign-in.');
  try {
    const { tokens: gtok, profile } = await authLib.exchangeGoogle({ code, redirectUri: googleRedirectUri(req) });
    if (!profile.email) return res.status(400).send('Could not read Google email.');

    // Establish/refresh the session user (login if not already).
    let userId = req.session.userId;
    if (!userId) {
      const user = await finishLogin(req, res, { email: profile.email, name: profile.name, provider: 'google', providerId: profile.sub });
      if (!user) return; // denied() already sent
      userId = user.id;
    }

    // Store this user's Google data tokens in the vault.
    if (gtok.refresh_token) {
      await tokens.setToken(userId, 'google',
        { refresh_token: gtok.refresh_token, access_token: gtok.access_token, scope: gtok.scope },
        { accountLabel: profile.email, scopes: gtok.scope, expiry: gtok.expiry_date ? new Date(gtok.expiry_date) : null });
    }
    return res.redirect('/');
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    return res.status(500).send(`Authentication failed: ${err.message}`);
  }
});

// --- Microsoft / Entra: login (identity only) ---
app.get('/auth/microsoft', (req, res) => {
  if (!process.env.MS_CLIENT_ID) return res.status(503).send('Microsoft login is not configured.');
  const state = newState(req, { flow: 'microsoft' });
  res.redirect(authLib.msAuthUrl({ redirectUri: msRedirectUri(req), state }));
});
app.get('/auth/microsoft/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');
  if (!requireDb(res)) return;
  if (!checkState(req, state)) return res.status(400).send('Invalid or expired state. Please retry sign-in.');
  try {
    const { profile } = await authLib.exchangeMicrosoft({ code, redirectUri: msRedirectUri(req) });
    if (!profile.email) return res.status(400).send('Could not read Microsoft account email.');
    const user = await finishLogin(req, res, { email: profile.email, name: profile.name, provider: 'microsoft', providerId: profile.oid });
    if (!user) return;
    return res.redirect('/');
  } catch (err) {
    console.error('Microsoft OAuth callback error:', err);
    return res.status(500).send(`Authentication failed: ${err.message}`);
  }
});

// --- Zoho: connect a data source (which = zoho | zoho_vorro) ---
app.get('/connect/zoho', requireAuth, (req, res) => {
  const which = req.query.which === 'zoho_vorro' ? 'zoho_vorro' : 'zoho';
  const state = newState(req, { flow: 'zoho', which });
  res.redirect(authLib.zohoAuthUrl({ which, redirectUri: zohoRedirectUri(req), state }));
});
app.get('/connect/zoho/callback', requireAuth, async (req, res) => {
  const { code, state } = req.query;
  const extra = checkState(req, state);
  if (!code || !extra) return res.status(400).send('Invalid or expired Zoho authorization.');
  const which = extra.which === 'zoho_vorro' ? 'zoho_vorro' : 'zoho';
  try {
    const { tokens: ztok } = await authLib.exchangeZoho({ which, code, redirectUri: zohoRedirectUri(req) });
    if (!ztok.refresh_token) return res.status(400).send('Zoho did not return a refresh token (re-consent required).');
    await tokens.setToken(req.session.userId, which,
      { refresh_token: ztok.refresh_token, access_token: ztok.access_token },
      { accountLabel: which === 'zoho_vorro' ? 'Vorro CRM' : 'Cadient CRM' });
    return res.redirect('/');
  } catch (err) {
    console.error('Zoho connect error:', err);
    return res.status(500).send(`Zoho connection failed: ${err.message}`);
  }
});

// --- Granola: connect via API key (no OAuth) ---
app.post('/connect/granola', requireAuth, async (req, res) => {
  const apiKey = (req.body && req.body.apiKey || '').trim();
  if (!apiKey) return res.status(400).json({ error: 'apiKey required' });
  await tokens.setToken(req.session.userId, 'granola', { api_key: apiKey }, { accountLabel: 'Granola' });
  res.json({ success: true });
});

// --- Connections list + disconnect ---
app.get('/api/connections', requireAuth, async (req, res) => {
  res.json({ connections: await tokens.listConnections(req.session.userId) });
});
app.delete('/api/connections/:provider', requireAuth, async (req, res) => {
  const allowed = ['google', 'zoho', 'zoho_vorro', 'granola'];
  if (!allowed.includes(req.params.provider)) return res.status(400).json({ error: 'unknown provider' });
  await tokens.deleteToken(req.session.userId, req.params.provider);
  res.json({ success: true });
});

// --- Admin: allowlist + users ---
app.get('/api/admin/allowlist', requireAuth, requireAdmin, async (_req, res) => {
  res.json({ allowlist: await authLib.listAllowlist() });
});
app.post('/api/admin/allowlist', requireAuth, requireAdmin, async (req, res) => {
  const email = (req.body && req.body.email || '').trim();
  if (!email) return res.status(400).json({ error: 'email required' });
  await authLib.addToAllowlist(email, req.session.email);
  res.json({ success: true });
});
app.delete('/api/admin/allowlist/:email', requireAuth, requireAdmin, async (req, res) => {
  await authLib.removeFromAllowlist(req.params.email);
  res.json({ success: true });
});
app.get('/api/admin/users', requireAuth, requireAdmin, async (_req, res) => {
  res.json({ users: await authLib.listUsers() });
});


// ===========================================================================
// Microsoft Graph (calendar + Teams transcripts), Recall.ai transcription,
// HubSpot CRM, and the CRM-agnostic board/chat -- all per-user, vault-backed.
// ===========================================================================
const _msTokCache = new Map();  // userId -> {accessToken, expiresAt}
const _hsTokCache = new Map();

async function getMsAccessToken() {
  const userId = ctx.currentUserId();
  if (!userId) throw new Error('Not authenticated.');
  const c = _msTokCache.get(userId);
  if (c && Date.now() < c.expiresAt - 60000) return c.accessToken;
  const t = await tokens.getToken(userId, 'microsoft');
  if (!t || !t.payload || !t.payload.refresh_token) throw new Error('Microsoft not connected. Connect it from the dashboard.');
  const tok = await msgraph.refreshAccessToken({ clientId: process.env.MS_CLIENT_ID, clientSecret: process.env.MS_CLIENT_SECRET, tenant: process.env.MS_TENANT, refreshToken: t.payload.refresh_token });
  if (tok.refresh_token && tok.refresh_token !== t.payload.refresh_token) {
    await tokens.setToken(userId, 'microsoft', { refresh_token: tok.refresh_token }, { accountLabel: t.accountLabel });
  }
  _msTokCache.set(userId, { accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in || 3600) * 1000 });
  return tok.access_token;
}

async function getHubspotAccessToken() {
  const userId = ctx.currentUserId();
  if (!userId) throw new Error('Not authenticated.');
  const c = _hsTokCache.get(userId);
  if (c && Date.now() < c.expiresAt - 60000) return c.accessToken;
  const t = await tokens.getToken(userId, 'hubspot');
  if (!t || !t.payload || !t.payload.refresh_token) throw new Error('HubSpot not connected. Connect it from the dashboard.');
  const tok = await hubspotLib.refreshAccessToken({ clientId: process.env.HUBSPOT_CLIENT_ID, clientSecret: process.env.HUBSPOT_CLIENT_SECRET, refreshToken: t.payload.refresh_token });
  if (tok.refresh_token && tok.refresh_token !== t.payload.refresh_token) {
    await tokens.setToken(userId, 'hubspot', { refresh_token: tok.refresh_token }, { accountLabel: t.accountLabel });
  }
  _hsTokCache.set(userId, { accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in || 1800) * 1000 });
  return tok.access_token;
}

async function getRecallConfig() {
  const userId = ctx.currentUserId();
  if (userId) {
    const t = await tokens.getToken(userId, 'recall');
    if (t && t.payload && t.payload.api_key) return { apiKey: t.payload.api_key, region: t.payload.region || process.env.RECALL_REGION || 'us-east-1' };
  }
  const c = ctx.get();
  if (c && c.isAdmin && process.env.RECALL_API_KEY) return { apiKey: process.env.RECALL_API_KEY, region: process.env.RECALL_REGION || 'us-east-1' };
  return null;
}

// CRM connection: HubSpot first, then Zoho (Cadient), then Vorro -- or a preferred provider.
async function resolveCrmConnection(preferred) {
  const userId = ctx.currentUserId();
  if (!userId) throw new Error('Not authenticated.');
  const conns = await tokens.listConnections(userId);
  const have = new Set(conns.map((c) => c.provider));
  const order = preferred ? [preferred] : ['hubspot', 'zoho', 'zoho_vorro'];
  for (const prov of order) {
    if (!have.has(prov)) continue;
    if (prov === 'hubspot') return { provider: 'hubspot', accessToken: await getHubspotAccessToken() };
    if (prov === 'zoho') return { provider: 'zoho', accessToken: await getZohoAccessToken(), apiDomain: ZOHO_API_DOMAIN };
    if (prov === 'zoho_vorro') return { provider: 'zoho_vorro', accessToken: await getVorroZohoAccessToken(), apiDomain: VORRO_ZOHO_API_DOMAIN };
  }
  throw new Error('No CRM connected. Connect HubSpot or Zoho from the dashboard.');
}

// ---- Microsoft connect (calendar/transcripts data scopes) ----
app.get('/connect/microsoft', requireAuth, (req, res) => {
  if (!process.env.MS_CLIENT_ID) return res.status(503).send('Microsoft is not configured.');
  const state = newState(req, { flow: 'ms_data' });
  const redirectUri = process.env.MS_DATA_REDIRECT_URI || `${baseUrl(req)}/connect/microsoft/callback`;
  res.redirect(msgraph.authUrl({ clientId: process.env.MS_CLIENT_ID, tenant: process.env.MS_TENANT, redirectUri, state }));
});
app.get('/connect/microsoft/callback', requireAuth, async (req, res) => {
  const { code, state } = req.query;
  if (!code || !checkState(req, state)) return res.status(400).send('Invalid or expired Microsoft authorization.');
  const redirectUri = process.env.MS_DATA_REDIRECT_URI || `${baseUrl(req)}/connect/microsoft/callback`;
  try {
    const tok = await msgraph.exchangeCode({ clientId: process.env.MS_CLIENT_ID, clientSecret: process.env.MS_CLIENT_SECRET, tenant: process.env.MS_TENANT, code, redirectUri });
    if (!tok.refresh_token) return res.status(400).send('Microsoft did not return a refresh token (need offline_access + re-consent).');
    await tokens.setToken(req.session.userId, 'microsoft', { refresh_token: tok.refresh_token }, { accountLabel: 'Microsoft 365', scopes: msgraph.MS_DATA_SCOPES.join(' ') });
    res.redirect('/');
  } catch (e) { console.error('MS connect error:', e); res.status(500).send(`Microsoft connection failed: ${e.message}`); }
});

// ---- HubSpot connect ----
app.get('/connect/hubspot', requireAuth, (req, res) => {
  if (!process.env.HUBSPOT_CLIENT_ID) return res.status(503).send('HubSpot is not configured.');
  const state = newState(req, { flow: 'hubspot' });
  const redirectUri = process.env.HUBSPOT_REDIRECT_URI || `${baseUrl(req)}/connect/hubspot/callback`;
  res.redirect(hubspotLib.authUrl({ clientId: process.env.HUBSPOT_CLIENT_ID, redirectUri, state }));
});
app.get('/connect/hubspot/callback', requireAuth, async (req, res) => {
  const { code, state } = req.query;
  if (!code || !checkState(req, state)) return res.status(400).send('Invalid or expired HubSpot authorization.');
  const redirectUri = process.env.HUBSPOT_REDIRECT_URI || `${baseUrl(req)}/connect/hubspot/callback`;
  try {
    const tok = await hubspotLib.exchangeCode({ clientId: process.env.HUBSPOT_CLIENT_ID, clientSecret: process.env.HUBSPOT_CLIENT_SECRET, code, redirectUri });
    if (!tok.refresh_token) return res.status(400).send('HubSpot did not return a refresh token.');
    await tokens.setToken(req.session.userId, 'hubspot', { refresh_token: tok.refresh_token }, { accountLabel: 'HubSpot CRM' });
    res.redirect('/');
  } catch (e) { console.error('HubSpot connect error:', e); res.status(500).send(`HubSpot connection failed: ${e.message}`); }
});

// ---- Recall.ai connect (single API key) ----
app.post('/connect/recall', requireAuth, async (req, res) => {
  const apiKey = ((req.body && req.body.apiKey) || '').trim();
  if (!apiKey) return res.status(400).json({ error: 'apiKey required' });
  const region = ((req.body && req.body.region) || 'us-east-1').trim();
  await tokens.setToken(req.session.userId, 'recall', { api_key: apiKey, region }, { accountLabel: `Recall.ai (${region})` });
  res.json({ success: true });
});

// ---- Microsoft calendar ----
app.get('/api/ms/calendar', requireAuth, async (req, res) => {
  try {
    const at = await getMsAccessToken();
    const events = await msgraph.listCalendarEvents(at, { start: req.query.start, end: req.query.end, top: req.query.top ? Number(req.query.top) : undefined });
    res.json({ events });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- Teams transcripts via Graph (stored; org tenant + admin consent) ----
app.get('/api/ms/transcripts', requireAuth, async (req, res) => {
  try {
    const at = await getMsAccessToken();
    const joinUrl = req.query.joinUrl;
    if (!joinUrl) return res.status(400).json({ error: 'joinUrl required' });
    const meeting = await msgraph.getOnlineMeetingByJoinUrl(at, joinUrl);
    if (!meeting) return res.json({ meeting: null, transcripts: [] });
    const transcripts = await msgraph.listMeetingTranscripts(at, meeting.id);
    res.json({ meeting: { id: meeting.id }, transcripts });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/ms/transcripts/:meetingId/:transcriptId', requireAuth, async (req, res) => {
  try {
    const at = await getMsAccessToken();
    const text = await msgraph.getTranscriptContent(at, req.params.meetingId, req.params.transcriptId, 'text/vtt');
    res.type('text/plain').send(text);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- Recall.ai transcription (Teams/Zoom/Meet via meeting bot) ----
app.get('/api/transcription/status', requireAuth, async (_req, res) => {
  const cfg = await getRecallConfig();
  res.json({ recall: !!cfg, deepgram: !!process.env.DEEPGRAM_API_KEY, graph: true });
});
app.post('/api/transcription/bot', requireAuth, async (req, res) => {
  const cfg = await getRecallConfig();
  if (!cfg) return res.status(503).json({ error: 'Recall.ai not connected. Add your API key in Connections.' });
  const { meetingUrl, botName } = req.body || {};
  if (!meetingUrl) return res.status(400).json({ error: 'meetingUrl required' });
  try {
    const bot = await recall.createBot(cfg, { meetingUrl, botName });
    if (bot && bot.id) { try { await recallBots.record(req.session.userId, bot.id, meetingUrl); } catch (e) { console.error('recall ownership record failed:', e.message); } }
    res.json(bot);
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/transcription/bot/:id', requireAuth, async (req, res) => {
  const cfg = await getRecallConfig(); if (!cfg) return res.status(503).json({ error: 'Recall.ai not connected.' });
  try {
    await recallBots.assertOwner(req.session.userId, req.params.id);
    res.json(await recall.getBot(cfg, req.params.id));
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
app.get('/api/transcription/bot/:id/transcript', requireAuth, async (req, res) => {
  const cfg = await getRecallConfig(); if (!cfg) return res.status(503).json({ error: 'Recall.ai not connected.' });
  try {
    await recallBots.assertOwner(req.session.userId, req.params.id);
    res.json(await recall.getTranscript(cfg, req.params.id));
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
app.get('/api/transcription/bots', requireAuth, async (req, res) => {
  try { res.json({ bots: await recallBots.listForUser(req.session.userId) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- CRM-agnostic board + write-back ----
app.get('/api/crm/pipelines', requireAuth, async (req, res) => {
  try { const conn = await resolveCrmConnection(req.query.provider); res.json({ provider: conn.provider, pipelines: await crm.getPipelines(conn) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/crm/board', requireAuth, async (req, res) => {
  try { const conn = await resolveCrmConnection(req.query.provider); res.json(await crm.getBoard(conn, { pipelineId: req.query.pipelineId })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/crm/deals/:id/move', requireAuth, async (req, res) => {
  const stageId = req.body && req.body.stageId;
  if (!stageId) return res.status(400).json({ error: 'stageId required' });
  try { const conn = await resolveCrmConnection(req.body.provider); res.json(await crm.moveDeal(conn, req.params.id, stageId)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- CRM chat-to-change: preview (no write) then confirm/apply ----
app.post('/api/crm/chat', requireAuth, async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const conn = await resolveCrmConnection(req.body.provider);
    const board = await crm.getBoard(conn, {});
    const deals = board.columns.flatMap((c) => c.deals.map((d) => ({ id: d.id, name: d.name, stage: d.stageName, amount: d.amount })));
    const stages = board.columns.map((c) => c.stageName);
    const sys = 'You convert a sales rep request into a STRICT JSON array of CRM changes. Output ONLY JSON, no prose. ' +
      'Each item: {"dealId":"<id>","dealName":"<name>","action":"move"|"update"|"note","stageId":"<exact stage name>","fields":{<field:value>},"note":"<text>"}. ' +
      'Include only keys relevant to the action. Use dealId values and stage names exactly as provided.';
    const user = `Deals: ${JSON.stringify(deals)}\nStages: ${JSON.stringify(stages)}\nRequest: ${message}`;
    const raw = (await askAnthropic(sys, user, 1200)) || '';
    let changes = [];
    try { const m = raw.match(/\[[\s\S]*\]/); changes = JSON.parse(m ? m[0] : raw); } catch (_) { changes = []; }
    res.json({ provider: conn.provider, changes, rawModelText: raw });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/crm/apply', requireAuth, async (req, res) => {
  const { changes } = req.body || {};
  if (!Array.isArray(changes) || !changes.length) return res.status(400).json({ error: 'changes[] required' });
  try {
    const conn = await resolveCrmConnection(req.body.provider);
    const results = [];
    for (const ch of changes) {
      try {
        if (ch.action === 'move') { await crm.moveDeal(conn, ch.dealId, ch.stageId); results.push({ dealId: ch.dealId, ok: true, action: 'move' }); }
        else if (ch.action === 'update') { await crm.updateDeal(conn, ch.dealId, ch.fields || {}); results.push({ dealId: ch.dealId, ok: true, action: 'update' }); }
        else if (ch.action === 'note') { await crm.addNote(conn, ch.dealId, ch.note || ''); results.push({ dealId: ch.dealId, ok: true, action: 'note' }); }
        else results.push({ dealId: ch.dealId, ok: false, error: 'unknown action' });
      } catch (e) { results.push({ dealId: ch.dealId, ok: false, error: e.message }); }
    }
    res.json({ results });
  } catch (e) { res.status(502).json({ error: e.message }); }
});


// Logout
app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ---------------------------------------------------------------------------
// MCP proxy endpoint
// ---------------------------------------------------------------------------
app.post('/api/proxy', requireAuth, async (req, res) => {
  const { tool, args } = req.body;
  if (!tool) return res.status(400).json({ error: 'Missing tool parameter' });

  const route = routeTool(tool);
  if (!route) {
    return res.status(400).json({ error: `Unknown tool: ${tool}. Cannot determine target service.` });
  }

  try {
    let result;
    switch (route.service) {
      case 'gmail':
        result = await handleGmail(route.operation, args || {});
        break;
      case 'calendar':
        result = await handleCalendar(route.operation, args || {});
        break;
      case 'zoho':
        result = await handleZoho(route.operation, args || {});
        break;
      case 'granola':
        result = await handleGranola(route.operation, args || {});
        break;
      case 'drive':
        result = await handleDrive(route.operation, args || {});
        break;
      default:
        return res.status(400).json({ error: `No handler for service: ${route.service}` });
    }
    return res.json(result);
  } catch (err) {
    console.error(`Proxy error [${route.service}/${route.operation}]:`, err.message);
    return res.status(502).json({
      error: err.message,
      service: route.service,
      operation: route.operation,
    });
  }
});

// ---------------------------------------------------------------------------
// Weather proxy (wttr.in has no CORS headers)
// ---------------------------------------------------------------------------
app.get('/api/weather', requireAuth, async (req, res) => {
  const loc = req.query.location || '07086';
  try {
    const url = `https://wttr.in/${encodeURIComponent(loc)}?format=j1`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'ManishHQ/1.0' } });
    if (!resp.ok) throw new Error('wttr.in returned ' + resp.status);
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// News RSS proxy — fetches Google News RSS and returns parsed articles
// ---------------------------------------------------------------------------
app.get('/api/news', requireAuth, async (req, res) => {
  const topic = req.query.topic || 'HR technology';
  const limit = Math.min(parseInt(req.query.limit) || 8, 15);
  try {
    const q = encodeURIComponent(topic);
    const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'ManishHQ/1.0' } });
    if (!resp.ok) throw new Error('Google News RSS returned ' + resp.status);
    const xml = await resp.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
      const block = match[1];
      const get = (tag) => { const m = block.match(new RegExp('<' + tag + '>(.*?)</' + tag + '>', 's')); return m ? m[1].replace(/<!\[CDATA\[(.*?)\]\]>/s, '$1').trim() : ''; };
      const title = get('title');
      const link = get('link');
      const pubDate = get('pubDate');
      const source = get('source');
      if (title && link) items.push({ title, link, pubDate, source });
    }
    res.json({ topic, items });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// ICP Checker API
// ---------------------------------------------------------------------------
const ICP_CONFIGS = {
  cadient: {
    brand: 'Cadient',
    product: 'SmartSuite™',
    focus: 'AI-powered talent & HR optimization',
    min_employees: 500,
    min_title_score: 1,
    geo: 'US only',
    target_personas: [
      { title: 'CHRO / Chief People Officer', score: 10, tier: 'A' },
      { title: 'VP Talent Acquisition', score: 9, tier: 'A' },
      { title: 'VP Human Resources / VP People', score: 8, tier: 'A' },
      { title: 'Head of Talent Acquisition', score: 8, tier: 'A' },
      { title: 'Director of HR / Director of TA', score: 7, tier: 'A' },
      { title: 'Talent Acquisition Manager', score: 6, tier: 'B' },
      { title: 'HR Manager', score: 5, tier: 'B' },
      { title: 'Senior Recruiter', score: 4, tier: 'B' },
      { title: 'HR Business Partner', score: 4, tier: 'B' },
      { title: 'Recruiter (volume hiring)', score: 3, tier: 'C' },
      { title: 'HR Generalist', score: 2, tier: 'C' },
    ],
    industries: ['Retail', 'Healthcare', 'Logistics', 'Hospitality', 'Manufacturing', 'Contact Centers', 'Staffing/RPO'],
    competitors: ['iCIMS', 'Greenhouse', 'Lever', 'Workday/Taleo', 'SmartRecruiters', 'Jobvite', 'Paradox', 'Phenom', 'Paylocity', 'UKG', 'Rippling'],
    disqualify_titles: ['Student', 'PhD', 'Freelancer', 'Job Seeker', 'BDR/SDR', 'Account Executive', 'Bench Sales', 'Agency Recruiter'],
    disqualify_companies: ['iCIMS', 'Greenhouse', 'Lever', 'Workday', 'SmartRecruiters', 'Paradox'],
    keyword_boosts: { 'high-volume hiring': 2, 'staffing': 2, 'workforce': 1, 'frontline': 2, 'hourly': 2, 'contact center': 2 },
    tier_thresholds: { A: 6, B: 3, C: 1 },
  },
  vorro: {
    brand: 'Vorro',
    product: 'BridgeGate™ EiPaaS',
    focus: 'Healthcare data integration & automation',
    min_employees: 500,
    min_title_score: 1,
    geo: 'US only',
    target_personas: [
      { title: 'CIO / Chief Information Officer', score: 10, tier: 'A' },
      { title: 'CTO / Chief Technology Officer', score: 9, tier: 'A' },
      { title: 'CMIO', score: 9, tier: 'A' },
      { title: 'VP of Health IT / VP Technology', score: 9, tier: 'A' },
      { title: 'Director of Interoperability', score: 9, tier: 'A' },
      { title: 'VP/Director of Integration', score: 8, tier: 'A' },
      { title: 'Director of IT / Technology', score: 7, tier: 'A' },
      { title: 'Chief Data Officer', score: 8, tier: 'A' },
      { title: 'Integration Manager', score: 6, tier: 'B' },
      { title: 'Health IT Manager', score: 6, tier: 'B' },
      { title: 'Enterprise/Integration Architect', score: 5, tier: 'B' },
      { title: 'Health Informatics', score: 5, tier: 'B' },
      { title: 'Interface Analyst', score: 3, tier: 'C' },
      { title: 'FHIR/HL7 Specialist', score: 3, tier: 'C' },
    ],
    industries: ['Health Systems/Hospitals', 'Payers/MCOs', 'TPL/Payment Integrity', 'PBMs', 'HIEs', 'Digital Health', 'Healthcare ISVs', 'Rural/Critical Access'],
    competitors: ['Rhapsody', 'MuleSoft', 'Corepoint', 'Redox', 'InterSystems', 'Jitterbit', 'Boomi', 'Health Gorilla', 'Particle Health'],
    disqualify_titles: ['Student', 'PhD', 'Freelancer', 'Job Seeker', 'BDR/SDR', 'Sales Rep', 'Marketing Manager', 'Therapist', 'Clinician (non-IT)'],
    disqualify_companies: ['Rhapsody', 'MuleSoft', 'Corepoint', 'Redox', 'InterSystems'],
    keyword_boosts: { 'FHIR': 2, 'HL7': 2, 'interoperability': 2, 'EHR integration': 2, 'claims': 1, 'payer': 1, 'Medicaid': 2 },
    tier_thresholds: { A: 6, B: 3, C: 1 },
  },
};

app.get('/api/icp', requireAuth, async (_req, res) => {
  res.json(ICP_CONFIGS);
});

app.get('/api/icp/crm-analysis', requireAuth, async (_req, res) => {
  try {
    const token = await getZohoAccessToken();
    const domain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';
    // Fetch closed-won deals for pattern analysis
    const wonResp = await fetch(
      `${domain}/crm/v2/Deals/search?criteria=(Stage:equals:Closed Won)&per_page=100`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
    );
    const wonData = wonResp.ok ? await wonResp.json() : { data: [] };
    const wonDeals = wonData.data || [];

    // Fetch closed-lost deals
    const lostResp = await fetch(
      `${domain}/crm/v2/Deals/search?criteria=(Stage:equals:Closed Lost)&per_page=100`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
    );
    const lostData = lostResp.ok ? await lostResp.json() : { data: [] };
    const lostDeals = lostData.data || [];

    // Fetch open deals
    const openResp = await fetch(
      `${domain}/crm/v2/Deals?per_page=200&sort_by=Closing_Date&sort_order=asc`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
    );
    const openData = openResp.ok ? await openResp.json() : { data: [] };
    const allDeals = openData.data || [];
    const openDeals = allDeals.filter(d => d.Stage && !d.Stage.startsWith('Closed'));

    // Analyze patterns
    const analysis = {
      won: { count: wonDeals.length, deals: wonDeals.map(d => ({ name: d.Deal_Name, amount: d.Amount, stage: d.Stage, account: d.Account_Name?.name, contact_title: d.Contact_Name?.title || '', industry: d.Industry || '' })) },
      lost: { count: lostDeals.length, deals: lostDeals.map(d => ({ name: d.Deal_Name, amount: d.Amount, stage: d.Stage, account: d.Account_Name?.name, reason: d.Reason_For_Loss__s || '', contact_title: d.Contact_Name?.title || '' })) },
      open: { count: openDeals.length, deals: openDeals.map(d => ({ name: d.Deal_Name, amount: d.Amount, stage: d.Stage, account: d.Account_Name?.name, closing: d.Closing_Date, probability: d.Probability, contact_title: d.Contact_Name?.title || '' })) },
      recommendations: [],
    };

    // Generate ICP recommendations from CRM data
    const wonTitles = wonDeals.map(d => (d.Contact_Name?.title || '').toLowerCase()).filter(Boolean);
    const lostTitles = lostDeals.map(d => (d.Contact_Name?.title || '').toLowerCase()).filter(Boolean);
    const wonIndustries = wonDeals.map(d => (d.Industry || '')).filter(Boolean);

    // Title pattern analysis
    const titleCounts = {};
    wonTitles.forEach(t => { titleCounts[t] = (titleCounts[t] || 0) + 1; });
    const topWonTitles = Object.entries(titleCounts).sort((a,b) => b[1]-a[1]).slice(0, 5);
    if (topWonTitles.length) {
      analysis.recommendations.push({
        type: 'title_pattern',
        priority: 'high',
        message: `Top converting titles: ${topWonTitles.map(([t,c]) => `"${t}" (${c} wins)`).join(', ')}. Consider boosting these in ICP scoring.`,
        data: topWonTitles,
      });
    }

    // Industry pattern analysis
    const industryCounts = {};
    wonIndustries.forEach(i => { industryCounts[i] = (industryCounts[i] || 0) + 1; });
    const topIndustries = Object.entries(industryCounts).sort((a,b) => b[1]-a[1]).slice(0, 5);
    if (topIndustries.length) {
      analysis.recommendations.push({
        type: 'industry_pattern',
        priority: 'medium',
        message: `Top converting industries: ${topIndustries.map(([i,c]) => `${i} (${c} wins)`).join(', ')}. Prioritize prospecting in these verticals.`,
        data: topIndustries,
      });
    }

    // Loss pattern analysis
    const lossCounts = {};
    lostDeals.forEach(d => { const r = d.Reason_For_Loss__s || 'Unknown'; lossCounts[r] = (lossCounts[r] || 0) + 1; });
    const topLossReasons = Object.entries(lossCounts).sort((a,b) => b[1]-a[1]).slice(0, 5);
    if (topLossReasons.length) {
      analysis.recommendations.push({
        type: 'loss_pattern',
        priority: 'high',
        message: `Top loss reasons: ${topLossReasons.map(([r,c]) => `"${r}" (${c}x)`).join(', ')}. Address these in outreach and qualification.`,
        data: topLossReasons,
      });
    }

    // Deal size analysis
    const wonAmounts = wonDeals.map(d => d.Amount).filter(a => a > 0);
    if (wonAmounts.length) {
      const avg = wonAmounts.reduce((s,a) => s+a, 0) / wonAmounts.length;
      const median = wonAmounts.sort((a,b) => a-b)[Math.floor(wonAmounts.length/2)];
      analysis.recommendations.push({
        type: 'deal_size',
        priority: 'medium',
        message: `Average won deal: $${Math.round(avg).toLocaleString()}, median: $${Math.round(median).toLocaleString()}. Filter out prospects unlikely to reach this threshold.`,
        data: { avg: Math.round(avg), median: Math.round(median), min: Math.min(...wonAmounts), max: Math.max(...wonAmounts) },
      });
    }

    // Stale deal detection
    const now = new Date();
    const staleDeals = openDeals.filter(d => {
      if (!d.Closing_Date) return false;
      const close = new Date(d.Closing_Date);
      return close < now;
    });
    if (staleDeals.length) {
      analysis.recommendations.push({
        type: 'stale_deals',
        priority: 'urgent',
        message: `${staleDeals.length} deals have closing dates in the past. Review and update or close these.`,
        data: staleDeals.map(d => ({ name: d.Deal_Name, closing: d.Closing_Date, amount: d.Amount })),
      });
    }

    res.json(analysis);
  } catch (err) {
    console.error('ICP CRM analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/icp/score', requireAuth, (req, res) => {
  const { name, title, company, location, brand } = req.body;

  if ((!title || !title.trim()) && (!company || !company.trim())) {
    return res.json({ tier: 'N/A', score: 0, details: { error: 'Title and company are required for ICP scoring' } });
  }
  if (!title || !brand) return res.status(400).json({ error: 'title and brand required' });

  const config = ICP_CONFIGS[brand.toLowerCase()];
  if (!config) return res.status(400).json({ error: `Unknown brand: ${brand}` });

  const t = title.toLowerCase();
  let score = 0;
  let matches = [];
  let rejects = [];

  // Check disqualifiers
  const dqTitles = (config.disqualify_titles || []).map(d => d.toLowerCase());
  for (const dq of dqTitles) {
    if (t.includes(dq.toLowerCase())) {
      rejects.push(`Disqualified title: "${dq}"`);
      return res.json({ name, title, company, location, brand, score: 0, tier: 'DISQUALIFIED', matches: [], rejects, recommendation: 'Remove from pipeline. Title is not a buyer persona.' });
    }
  }

  // Title scoring
  const personas = config.target_personas || [];
  for (const p of personas) {
    const pTitle = p.title.toLowerCase().split('/').map(s => s.trim());
    for (const pt of pTitle) {
      if (t.includes(pt)) {
        score = Math.max(score, p.score);
        matches.push(`Title match: "${p.title}" (score ${p.score})`);
        break;
      }
    }
  }

  // Keyword boosts
  const combined = `${title} ${company || ''} ${location || ''}`.toLowerCase();
  for (const [kw, boost] of Object.entries(config.keyword_boosts || {})) {
    if (combined.includes(kw.toLowerCase())) {
      score += boost;
      matches.push(`Keyword boost: "${kw}" (+${boost})`);
    }
  }

  // Determine tier
  let tier = 'DISQUALIFIED';
  if (score >= config.tier_thresholds.A) tier = 'A';
  else if (score >= config.tier_thresholds.B) tier = 'B';
  else if (score >= config.tier_thresholds.C) tier = 'C';

  // Generate recommendation
  let recommendation = '';
  if (tier === 'A') recommendation = 'High-priority prospect. Assign to senior AE for personalized outreach.';
  else if (tier === 'B') recommendation = 'Good prospect. Include in targeted campaign sequence.';
  else if (tier === 'C') recommendation = 'Low-priority. Include in nurture campaigns only.';
  else recommendation = 'Does not match ICP. Consider removing from pipeline.';

  res.json({ name, title, company, location, brand, score, tier, matches, rejects, recommendation });
});

// ---------------------------------------------------------------------------
// CRM Kanban: Bulk update deals
// ---------------------------------------------------------------------------
app.put('/api/crm/deals/bulk', requireAuth, async (req, res) => {
  const { dealIds, updates } = req.body;
  if (!dealIds || !Array.isArray(dealIds) || dealIds.length === 0) {
    return res.status(400).json({ error: 'dealIds array required' });
  }
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'updates object required' });
  }
  try {
    const token = await getZohoAccessToken();
    const domain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';
    const data = dealIds.map(id => ({ id, ...updates }));
    // Zoho allows max 100 records per call
    const results = [];
    for (let i = 0; i < data.length; i += 100) {
      const batch = data.slice(i, i + 100);
      const resp = await fetch(`${domain}/crm/v2/Deals`, {
        method: 'PUT',
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data: batch }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Zoho bulk update failed: ${resp.status} ${text}`);
      }
      const result = await resp.json();
      results.push(...(result.data || []));
    }
    res.json({ success: true, updated: results.length, results });
  } catch (err) {
    console.error('Bulk deal update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// CRM: Deal Notes (read + create)
// ---------------------------------------------------------------------------
app.get('/api/crm/deals/:id/notes', requireAuth, async (req, res) => {
  try {
    const token = await getZohoAccessToken();
    const domain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';
    const resp = await fetch(`${domain}/crm/v2/Deals/${req.params.id}/Notes?per_page=50`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Zoho notes fetch failed: ${resp.status} ${text}`);
    }
    const data = await resp.json();
    res.json({ notes: data.data || [] });
  } catch (err) {
    console.error('Deal notes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/crm/deals/:id/notes', requireAuth, async (req, res) => {
  const { content, title } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  try {
    const token = await getZohoAccessToken();
    const domain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';
    const noteData = { Note_Content: content };
    if (title) noteData.Note_Title = title;
    const resp = await fetch(`${domain}/crm/v2/Deals/${req.params.id}/Notes`, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: [noteData] }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Zoho note create failed: ${resp.status} ${text}`);
    }
    const data = await resp.json();
    res.json({ success: true, note: data.data?.[0] });
  } catch (err) {
    console.error('Deal note create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// CRM: Deal Products (read + add)
// ---------------------------------------------------------------------------
app.get('/api/crm/deals/:id/products', requireAuth, async (req, res) => {
  try {
    const token = await getZohoAccessToken();
    const domain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';
    const resp = await fetch(`${domain}/crm/v2/Deals/${req.params.id}/Products?per_page=50`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (!resp.ok) {
      // 204 = no products, not an error
      if (resp.status === 204) return res.json({ products: [] });
      const text = await resp.text();
      throw new Error(`Zoho products fetch failed: ${resp.status} ${text}`);
    }
    const data = await resp.json();
    res.json({ products: data.data || [] });
  } catch (err) {
    console.error('Deal products error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/crm/products', requireAuth, async (req, res) => {
  try {
    const token = await getZohoAccessToken();
    const domain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';
    const resp = await fetch(`${domain}/crm/v2/Products?per_page=200&fields=Product_Name,Unit_Price,Product_Code,Product_Active`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (!resp.ok) {
      if (resp.status === 204) return res.json({ products: [] });
      const text = await resp.text();
      throw new Error(`Zoho products list failed: ${resp.status} ${text}`);
    }
    const data = await resp.json();
    res.json({ products: data.data || [] });
  } catch (err) {
    console.error('Products list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/crm/deals/:id/products', requireAuth, async (req, res) => {
  const { productId, quantity, listPrice } = req.body;
  if (!productId) return res.status(400).json({ error: 'productId required' });
  try {
    const token = await getZohoAccessToken();
    const domain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';
    const prodData = {
      id: productId,
      quantity: quantity || 1,
      list_price: listPrice || 0,
    };
    const resp = await fetch(`${domain}/crm/v2/Deals/${req.params.id}/Products/${productId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: [prodData] }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Zoho product add failed: ${resp.status} ${text}`);
    }
    const data = await resp.json();
    res.json({ success: true, result: data.data?.[0] });
  } catch (err) {
    console.error('Deal product add error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// CRM: Zoho Users (for owner assignment)
// ---------------------------------------------------------------------------
app.get('/api/crm/users', requireAuth, async (req, res) => {
  try {
    const token = await getZohoAccessToken();
    const domain = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';
    const resp = await fetch(`${domain}/crm/v2/users?type=ActiveUsers`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Zoho users fetch failed: ${resp.status} ${text}`);
    }
    const data = await resp.json();
    const users = (data.users || []).map(u => ({ id: u.id, name: u.full_name || u.name, email: u.email, role: u.role?.name }));
    res.json({ users });
  } catch (err) {
    console.error('Users fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Vorro Zoho CRM (India DC) — direct query for Vorro deals
// ---------------------------------------------------------------------------
app.get('/api/crm/vorro/deals', requireAuth, async (req, res) => {
  try {
    const token = await getVorroZohoAccessToken();
    const query = req.query.query || "select Deal_Name,Stage,Amount,Closing_Date,Contact_Name,Account_Name,Owner,Probability,Pipeline from Deals where Stage != 'Closed Won' and Stage != 'Closed Lost' order by Amount desc limit 200";
    const resp = await fetch(`${VORRO_ZOHO_API_DOMAIN}/crm/v5/coql`, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ select_query: query }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Vorro Zoho COQL failed: ${resp.status} ${text}`);
    }
    const data = await resp.json();
    res.json({ data: data.data || [], info: data.info });
  } catch (err) {
    console.error('Vorro deals error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/crm/vorro/deals/bulk', requireAuth, async (req, res) => {
  try {
    const token = await getVorroZohoAccessToken();
    const { dealIds, updates } = req.body;
    if (!dealIds?.length || !updates) return res.status(400).json({ error: 'dealIds and updates required' });
    const results = [];
    const batches = [];
    for (let i = 0; i < dealIds.length; i += 100) {
      batches.push(dealIds.slice(i, i + 100));
    }
    for (const batch of batches) {
      const records = batch.map(id => ({ id, ...updates }));
      const resp = await fetch(`${VORRO_ZOHO_API_DOMAIN}/crm/v2/Deals`, {
        method: 'PUT',
        headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: records }),
      });
      const data = await resp.json();
      results.push(...(data.data || []));
    }
    res.json({ success: true, updated: results.length, results });
  } catch (err) {
    console.error('Vorro bulk update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/crm/vorro/deals/:id/notes', requireAuth, async (req, res) => {
  try {
    const token = await getVorroZohoAccessToken();
    const resp = await fetch(`${VORRO_ZOHO_API_DOMAIN}/crm/v2/Deals/${req.params.id}/Notes?per_page=50`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (!resp.ok && resp.status !== 204) throw new Error(`Vorro notes fetch: ${resp.status}`);
    if (resp.status === 204) return res.json({ notes: [] });
    const data = await resp.json();
    res.json({ notes: data.data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/crm/vorro/deals/:id/notes', requireAuth, async (req, res) => {
  try {
    const token = await getVorroZohoAccessToken();
    const { content, title } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });
    const noteData = { Note_Content: content };
    if (title) noteData.Note_Title = title;
    const resp = await fetch(`${VORRO_ZOHO_API_DOMAIN}/crm/v2/Deals/${req.params.id}/Notes`, {
      method: 'POST',
      headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [noteData] }),
    });
    const data = await resp.json();
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Vorro products catalog
app.get('/api/crm/vorro/products', requireAuth, async (req, res) => {
  try {
    const token = await getVorroZohoAccessToken();
    const resp = await fetch(`${VORRO_ZOHO_API_DOMAIN}/crm/v2/Products?per_page=200&fields=Product_Name,Unit_Price,Product_Code,Product_Active`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (!resp.ok) {
      if (resp.status === 204) return res.json({ products: [] });
      const text = await resp.text();
      throw new Error(`Vorro products list failed: ${resp.status} ${text}`);
    }
    const data = await resp.json();
    res.json({ products: data.data || [] });
  } catch (err) {
    console.error('Vorro products list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Vorro users (for owner assignment)
app.get('/api/crm/vorro/users', requireAuth, async (req, res) => {
  try {
    const token = await getVorroZohoAccessToken();
    const resp = await fetch(`${VORRO_ZOHO_API_DOMAIN}/crm/v2/users?type=ActiveUsers`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Vorro users fetch failed: ${resp.status} ${text}`);
    }
    const data = await resp.json();
    const users = (data.users || []).map(u => ({ id: u.id, name: u.full_name || u.name, email: u.email, role: u.role?.name }));
    res.json({ users });
  } catch (err) {
    console.error('Vorro users fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Vorro deal products
app.get('/api/crm/vorro/deals/:id/products', requireAuth, async (req, res) => {
  try {
    const token = await getVorroZohoAccessToken();
    const resp = await fetch(`${VORRO_ZOHO_API_DOMAIN}/crm/v2/Deals/${req.params.id}/Products?per_page=50`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (!resp.ok && resp.status !== 204) throw new Error(`Vorro products fetch: ${resp.status}`);
    if (resp.status === 204) return res.json({ products: [] });
    const data = await resp.json();
    res.json({ products: data.data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/crm/vorro/deals/:id/products', requireAuth, async (req, res) => {
  try {
    const token = await getVorroZohoAccessToken();
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ error: 'productId required' });
    const resp = await fetch(`${VORRO_ZOHO_API_DOMAIN}/crm/v2/Deals/${req.params.id}/Products`, {
      method: 'POST',
      headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [{ id: productId }] }),
    });
    const data = await resp.json();
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// AI API proxy — Gemini (primary, free) → Groq (fallback, free) → Anthropic (last resort)
// ---------------------------------------------------------------------------
async function askGemini(systemPrompt, userContent, maxTokens) {
  // Rotate through available Gemini keys
  const keys = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3, process.env.GEMINI_API_KEY_4, process.env.GEMINI_API_KEY_5].filter(Boolean);
  if (!keys.length) return null;
  const key = keys[Math.floor(Math.random() * keys.length)];
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 }
    }),
  });
  if (!resp.ok) { const t = await resp.text(); throw new Error(`Gemini ${resp.status}: ${t.slice(0,200)}`); }
  const r = await resp.json();
  return r.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function askGroq(systemPrompt, userContent, maxTokens) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
      max_tokens: maxTokens, temperature: 0.3
    }),
  });
  if (!resp.ok) { const t = await resp.text(); throw new Error(`Groq ${resp.status}: ${t.slice(0,200)}`); }
  const r = await resp.json();
  return r.choices?.[0]?.message?.content || '';
}

async function askAnthropic(systemPrompt, userContent, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!resp.ok) { const t = await resp.text(); throw new Error(`Anthropic ${resp.status}: ${t.slice(0,200)}`); }
  const r = await resp.json();
  return r.content?.[0]?.text || '';
}

app.post('/api/ask', requireAuth, async (req, res) => {
  const { prompt, data, fast } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  let userContent = prompt;
  if (data && Array.isArray(data) && data.length > 0) {
    const contextParts = data.map((d) => {
      if (typeof d === 'string') return d;
      if (d && d.label && d.value) return `[${d.label}]: ${typeof d.value === 'string' ? d.value : JSON.stringify(d.value)}`;
      return JSON.stringify(d);
    });
    userContent += '\n\n--- DATA CONTEXT ---\n' + contextParts.join('\n\n');
  }

  const maxTokens = 512;
  const systemPrompt = 'You are a real-time sales meeting intelligence assistant for a CRO named Manish. He manages two companies: Cadient (AI-powered talent/HR platform with SmartSuite) and Vorro (healthcare integration platform with BridgeGate EiPaaS). Be direct, data-driven, and actionable. Never generic. Always reference specifics from the conversation. Keep responses concise and immediately usable in a live meeting context.';

  // Try providers in order: Gemini (free) → Groq (free) → Anthropic (paid)
  const providers = [
    { name: 'Gemini', fn: () => askGemini(systemPrompt, userContent, maxTokens) },
    { name: 'Groq', fn: () => askGroq(systemPrompt, userContent, maxTokens) },
    { name: 'Anthropic', fn: () => askAnthropic(systemPrompt, userContent, maxTokens) },
  ];

  for (const p of providers) {
    try {
      const result = await p.fn();
      if (result !== null && result !== '') {
        console.log(`AI ask served by ${p.name}`);
        return res.json(result);
      }
    } catch (err) {
      console.warn(`${p.name} failed: ${err.message}`);
    }
  }

  return res.status(503).json({ error: 'All AI providers failed. Check GEMINI_API_KEY, GROQ_API_KEY, or ANTHROPIC_API_KEY in environment.' });
});


// ===========================================================================
// MANISH HQ v6 — NEW CAPABILITIES
// Added: Memory Layer, Meeting Brief, Deep Ask (Sonnet), Daily Briefing
// ===========================================================================

// ── In-Process Memory Store (lightweight Mem0 alternative) ──────────────────
const _memoryStore = memstore; // Postgres-backed write-through cache (Map-like API)

// ─── Two-Tier Memory System ────────────────────────────────────────────────
// namespace=company  → admin-protected shared knowledge (read freely, write needs approval)
// namespace=personal → per-user private notes (write freely, admin-readable)
// ?user=firstname    → whose personal store to read/write (defaults to current user)
// ADMINS: manish, prateek, scott  (only they may approve company writes)
// ─────────────────────────────────────────────────────────────────────────────

const COMPANY_MEMORY_KEY = '__company__';
const ADMINS = ['manish', 'manish696@gmail.com'];

function _getUserId(req) {
  // Stable per-user namespace key (DB user id), so memory is isolated per account.
  return 'u:' + ((req.session && req.session.userId) || 'anon');
}

function _isAdmin(_userId) {
  // Admin status comes from the authenticated session (users.is_admin), via request context.
  const c = ctx.get();
  return !!(c && c.isAdmin);
}

// GET /api/memory?q=query&namespace=personal|company&user=firstname
app.get('/api/memory', requireAuth, async (req, res) => {
  const currentUser = _getUserId(req);
  const ns = req.query.namespace || 'personal';
  const targetUser = ns === 'company' ? COMPANY_MEMORY_KEY : currentUser; // per-user isolation: no cross-user override
  const query = (req.query.q || '').toLowerCase();
  const mem0Key = process.env.MEM0_API_KEY;

  // Personal notes: enforce privacy (only self or admin can read)
  if (ns === 'personal' && targetUser !== currentUser && !_isAdmin(currentUser)) {
    return res.status(403).json({ error: "Cannot read another user's personal notes" });
  }

  if (mem0Key) {
    try {
      const resp = await fetch('https://api.mem0.ai/v1/memories/search/', {
        method: 'POST',
        headers: { 'Authorization': `Token ${mem0Key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query || 'recent context', user_id: targetUser, limit: 20 })
      });
      if (resp.ok) {
        const data = await resp.json();
        return res.json({ ...data, namespace: ns, user: targetUser });
      }
    } catch (e) { console.error('Mem0 search error:', e.message); }
  }

  const memories = _memoryStore.get(targetUser) || [];
  const filtered = query
    ? memories.filter(m => m.memory?.toLowerCase().includes(query))
    : memories;
  res.json({ results: filtered.slice(-50), namespace: ns, user: targetUser });
});

// POST /api/memory  — write a memory
// namespace=personal: writes immediately
// namespace=company:  queues for admin approval (returns pending status)
app.post('/api/memory', requireAuth, async (req, res) => {
  const currentUser = _getUserId(req);
  const ns = req.body.namespace || 'personal';
  const targetUser = ns === 'company' ? COMPANY_MEMORY_KEY : currentUser; // per-user isolation: no cross-user override
  const { messages, metadata } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages required' });

  // Personal notes: only self or admin may write
  if (ns === 'personal' && targetUser !== currentUser && !_isAdmin(currentUser)) {
    return res.status(403).json({ error: "Cannot write to another user's personal notes" });
  }

  // Company memory: non-admins get a pending queue entry, not a direct write
  if (ns === 'company' && !_isAdmin(currentUser)) {
    const pending = _memoryStore.get('__company_pending__') || [];
    const entry = {
      proposed_by: currentUser,
      proposed_at: new Date().toISOString(),
      messages,
      metadata,
      status: 'PENDING'
    };
    _memoryStore.set('__company_pending__', [...pending, entry]);
    return res.json({
      status: 'pending_approval',
      message: 'Company memory change queued for admin approval.',
      entry
    });
  }

  const mem0Key = process.env.MEM0_API_KEY;
  if (mem0Key) {
    try {
      const resp = await fetch('https://api.mem0.ai/v1/memories/', {
        method: 'POST',
        headers: { 'Authorization': `Token ${mem0Key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, user_id: targetUser, metadata })
      });
      if (resp.ok) return res.json({ ...(await resp.json()), namespace: ns });
    } catch (e) { console.error('Mem0 add error:', e.message); }
  }

  const existing = _memoryStore.get(targetUser) || [];
  const newMems = messages.map(m => ({
    memory: m.content,
    namespace: ns,
    metadata: { ...metadata, written_by: currentUser },
    created_at: new Date().toISOString()
  }));
  _memoryStore.set(targetUser, [...existing, ...newMems].slice(-300));
  res.json({ results: newMems, namespace: ns, source: 'in-process' });
});

// DELETE /api/memory  — clear memories
// namespace=company: admin only; namespace=personal: self or admin
app.delete('/api/memory', requireAuth, (req, res) => {
  const currentUser = _getUserId(req);
  const ns = req.query.namespace || 'personal';
  const targetUser = ns === 'company' ? COMPANY_MEMORY_KEY : currentUser; // per-user isolation: no cross-user override

  if (ns === 'company' && !_isAdmin(currentUser)) {
    return res.status(403).json({ error: 'Only admins can clear company memory' });
  }
  if (ns === 'personal' && targetUser !== currentUser && !_isAdmin(currentUser)) {
    return res.status(403).json({ error: "Cannot clear another user's personal notes" });
  }

  _memoryStore.delete(targetUser);
  res.json({ success: true, namespace: ns, user: targetUser });
});

// GET /api/memory/pending  — admin: review pending company memory proposals
app.get('/api/memory/pending', requireAuth, (req, res) => {
  const currentUser = _getUserId(req);
  if (!_isAdmin(currentUser)) return res.status(403).json({ error: 'Admin only' });
  res.json({ pending: _memoryStore.get('__company_pending__') || [] });
});

// POST /api/memory/pending/:index/approve  — admin approves a pending change
app.post('/api/memory/pending/:index/approve', requireAuth, async (req, res) => {
  const currentUser = _getUserId(req);
  if (!_isAdmin(currentUser)) return res.status(403).json({ error: 'Admin only' });

  const pending = _memoryStore.get('__company_pending__') || [];
  const idx = parseInt(req.params.index, 10);
  if (!pending[idx]) return res.status(404).json({ error: 'Pending entry not found' });

  const entry = pending[idx];
  entry.status = 'APPROVED';
  entry.approved_by = currentUser;
  entry.approved_at = new Date().toISOString();

  // Commit it to company memory
  const existing = _memoryStore.get(COMPANY_MEMORY_KEY) || [];
  const newMems = entry.messages.map(m => ({
    memory: m.content,
    namespace: 'company',
    metadata: { ...entry.metadata, proposed_by: entry.proposed_by, approved_by: currentUser },
    created_at: new Date().toISOString()
  }));
  _memoryStore.set(COMPANY_MEMORY_KEY, [...existing, ...newMems].slice(-500));
  pending[idx] = entry;
  _memoryStore.set('__company_pending__', pending);

  res.json({ success: true, approved: entry, stored: newMems });
});

// ── Meeting Brief Generator ──────────────────────────────────────────────────
app.post('/api/brief', requireAuth, async (req, res) => {
  const { eventId, attendees = [], title, startTime } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const emailQuery = attendees.length
      ? '(' + attendees.slice(0, 3).map(a => `from:${a} OR to:${a}`).join(' OR ') + ') newer_than:30d'
      : `"${title.slice(0, 40)}" newer_than:30d`;

    const [emailR, granolaR] = await Promise.allSettled([
      handleGmail('search_threads', { query: emailQuery, pageSize: 8 }),
      handleGranola('query_granola_meetings', { query: (attendees.slice(0, 2).join(' ') || title).slice(0, 80) })
    ]);

    const emailCtx = emailR.status === 'fulfilled'
      ? (emailR.value?.threads || []).slice(0, 5).map(t => {
          const last = t.messages?.slice(-1)[0] || {};
          return `"${last.subject}" from ${last.sender}: ${(last.snippet || '').slice(0, 120)}`;
        }).join('\n')
      : '';

    const granolaCtx = granolaR.status === 'fulfilled'
      ? (typeof granolaR.value === 'string'
          ? granolaR.value
          : JSON.stringify(granolaR.value)).slice(0, 2000)
      : '';

    const prompt = [
      `Pre-meeting brief for: "${title}"`,
      `Start: ${startTime || 'soon'}`,
      `Attendees: ${attendees.join(', ') || 'unknown'}`,
      emailCtx ? `\nRecent email threads:\n${emailCtx}` : '',
      granolaCtx ? `\nPast meeting notes:\n${granolaCtx}` : '',
      `\nCreate a tight brief with these sections:
**Context** (2 sentences on what this meeting is about)
**Objectives** (2-3 bullets: specific outcomes to achieve)
**Agenda Intel** (1-2 bullets: what they'll likely raise based on email/notes)
**Opening Move** (1 specific thing Manish can say/propose in first 3 minutes)
**Watch Out** (1 risk or sensitive topic to navigate)

Under 200 words total. Manish reads this in under 60 seconds.`
    ].filter(Boolean).join('\n');

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: "You are Manish's executive assistant. Manish is CRO at Basis Vectors Capital managing Cadient (AI hiring platform) and Vorro (healthcare integration). Be direct, specific, no fluff.",
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!resp.ok) throw new Error(`Claude API error: ${resp.status}`);
    const result = await resp.json();
    const brief = result.content?.[0]?.text || '';

    // Auto-store brief in memory
    const userId = req.session.email;
    const existing = _memoryStore.get(userId) || [];
    _memoryStore.set(userId, [...existing, {
      memory: `Brief for "${title}" (${new Date().toLocaleDateString()}): ${brief.slice(0, 200)}`,
      metadata: { type: 'meeting_brief', title, attendees },
      created_at: new Date().toISOString()
    }].slice(-300));

    res.json({ brief, title, attendees, generated_at: new Date().toISOString() });
  } catch (err) {
    console.error('Brief generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Deep Ask — Sonnet 4.6 with auto-injected live context ───────────────────
app.post('/api/ask/deep', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { prompt, inject_context = true, max_tokens = 2048 } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const contextBlocks = [];

  if (inject_context) {
    try {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();

      const [calR, dealsR] = await Promise.allSettled([
        handleCalendar('list_events', { startTime: todayStart, endTime: todayEnd, timeZone: 'America/New_York' }),
        handleZoho('executeCOQLQuery', { body: { select_query: "select Deal_Name,Stage,Amount,Closing_Date,Account_Name from Deals where Stage != 'Closed Won' and Stage != 'Closed Lost' order by Amount desc limit 10" }})
      ]);

      if (calR.status === 'fulfilled' && calR.value?.events?.length) {
        contextBlocks.push('TODAY\'S SCHEDULE:\n' + calR.value.events.map(e => {
          const t = new Date(e.start?.dateTime || e.start?.date);
          return `  ${t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })} - ${e.summary}`;
        }).join('\n'));
      }

      if (dealsR.status === 'fulfilled' && dealsR.value?.data?.length) {
        contextBlocks.push('TOP OPEN DEALS:\n' + dealsR.value.data.slice(0, 8).map(d =>
          `  ${d.Deal_Name} | ${d.Stage} | $${(d.Amount || 0).toLocaleString()} | Close: ${d.Closing_Date || 'TBD'}`
        ).join('\n'));
      }

      // Recent memory
      const userId = req.session.email;
      const memories = (_memoryStore.get(userId) || []).slice(-5);
      if (memories.length) {
        contextBlocks.push('RECENT CONTEXT:\n' + memories.map(m => `  - ${m.memory}`).join('\n'));
      }
    } catch (e) {
      console.error('Deep ask context fetch error:', e.message);
    }
  }

  const systemPrompt = `You are Manish's strategic AI advisor. Manish is CRO at Basis Vectors Capital managing:
- Cadient: AI hiring platform (SmartSuite™). 60% faster hiring, 45% lower cost-per-hire, 80% recruiter productivity lift.
- Vorro: Healthcare integration (BridgeGate™ EiPaaS). FHIR/HL7, $20K-$90K+/yr, 100+ enterprises.
- CV3/RevEngineer: E-commerce platform.
Be direct, specific, and data-driven. Reference exact numbers when relevant. Give actionable next steps.`;

  const userContent = contextBlocks.length > 0
    ? prompt + '\n\n--- LIVE CONTEXT ---\n' + contextBlocks.join('\n\n')
    : prompt;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: Math.min(max_tokens, 4096),
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    if (!resp.ok) throw new Error(`Claude API error: ${resp.status}`);
    const result = await resp.json();
    const text = result.content?.[0]?.text || '';

    // Auto-store to memory
    const userId = req.session.email;
    const existing = _memoryStore.get(userId) || [];
    _memoryStore.set(userId, [...existing, {
      memory: `Q: ${prompt.slice(0, 100)} → ${text.slice(0, 150)}`,
      metadata: { type: 'deep_query' },
      created_at: new Date().toISOString()
    }].slice(-300));

    return res.json(text);
  } catch (err) {
    console.error('Deep ask error:', err.message);
    return res.status(502).json({ error: err.message });
  }
});

// ── Daily Intelligence Briefing ──────────────────────────────────────────────
app.get('/api/intelligence/daily', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();
    const weekEnd = new Date(now.getTime() + 7 * 86400000).toISOString();

    const [calR, dealsR, mailR] = await Promise.allSettled([
      handleCalendar('list_events', { startTime: todayStart, endTime: weekEnd, timeZone: 'America/New_York' }),
      handleZoho('executeCOQLQuery', { body: { select_query: "select Deal_Name,Stage,Amount,Closing_Date,Probability,Account_Name from Deals where Stage != 'Closed Won' and Stage != 'Closed Lost' order by Closing_Date asc limit 30" }}),
      handleGmail('search_threads', { query: 'is:unread newer_than:1d', pageSize: 15 })
    ]);

    const allEvents = calR.status === 'fulfilled' ? (calR.value?.events || []) : [];
    const todayEvents = allEvents.filter(e => {
      const d = new Date(e.start?.dateTime || e.start?.date);
      return d >= new Date(todayStart) && d < new Date(todayEnd);
    });
    const weekEvents = allEvents.filter(e => {
      const d = new Date(e.start?.dateTime || e.start?.date);
      return d >= new Date(todayEnd) && d < new Date(weekEnd);
    });

    const deals = dealsR.status === 'fulfilled' ? (dealsR.value?.data || []) : [];
    const overdueDeals = deals.filter(d => d.Closing_Date && new Date(d.Closing_Date) < now);
    const closingThisWeek = deals.filter(d => {
      if (!d.Closing_Date) return false;
      const cd = new Date(d.Closing_Date);
      return cd >= now && cd <= new Date(weekEnd);
    });
    const pipelineValue = deals.reduce((s, d) => s + (d.Amount || 0), 0);
    const weightedValue = deals.reduce((s, d) => s + (d.Amount || 0) * ((d.Probability || 0) / 100), 0);

    const unreadThreads = mailR.status === 'fulfilled' ? (mailR.value?.threads || []) : [];
    const unreadEmails = unreadThreads.slice(0, 6).map(t => {
      const last = t.messages?.slice(-1)[0] || {};
      return { subject: last.subject || '(no subject)', from: last.sender || '', snippet: (last.snippet || '').slice(0, 100) };
    });

    const dataContext = [
      `DATE: ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`,
      todayEvents.length
        ? `MEETINGS TODAY (${todayEvents.length}):\n${todayEvents.map(e => `• ${new Date(e.start?.dateTime || e.start?.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })} — ${e.summary}`).join('\n')}`
        : '• No meetings scheduled today',
      closingThisWeek.length
        ? `DEALS CLOSING THIS WEEK (${closingThisWeek.length}, total $${closingThisWeek.reduce((s,d)=>s+(d.Amount||0),0).toLocaleString()}):\n${closingThisWeek.map(d => `• ${d.Deal_Name} | ${d.Stage} | $${(d.Amount||0).toLocaleString()} | ${d.Closing_Date}`).join('\n')}`
        : '',
      overdueDeals.length ? `OVERDUE DEALS (${overdueDeals.length}): ${overdueDeals.slice(0,3).map(d=>`${d.Deal_Name} (${d.Closing_Date})`).join(', ')}` : '',
      unreadEmails.length ? `UNREAD EMAILS (${unreadEmails.length}):\n${unreadEmails.slice(0,4).map(e=>`• "${e.subject}" from ${e.from}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');

    const briefResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: "You are Manish's morning briefing AI. CRO at Basis Vectors (Cadient + Vorro). Sharp, direct, scannable. Under 150 words total.",
        messages: [{ role: 'user', content: `Generate today's briefing from this data:\n\n${dataContext}\n\nFormat exactly:\n🎯 TOP PRIORITY — (1 sentence: the single most important thing today)\n\n⚡ ACT NOW\n• (item 1)\n• (item 2)\n• (item 3 if warranted)\n\n🔥 WATCH\n• (risk or opportunity 1)\n• (item 2 if warranted)` }]
      })
    });

    const briefResult = await briefResp.json();
    const briefingText = briefResult.content?.[0]?.text || '';

    res.json({
      briefing: briefingText,
      stats: {
        meetings_today: todayEvents.length,
        meetings_this_week: weekEvents.length,
        deals_closing_this_week: closingThisWeek.length,
        deals_overdue: overdueDeals.length,
        unread_emails: unreadEmails.length,
        total_open_deals: deals.length,
        pipeline_value: pipelineValue,
        weighted_pipeline: Math.round(weightedValue),
      },
      today_events: todayEvents.slice(0, 8).map(e => ({
        id: e.id,
        summary: e.summary,
        start: e.start,
        attendees: (e.attendees || []).filter(a => !a.self).map(a => a.email || a.displayName),
        conferenceUrl: e.conferenceUrl,
      })),
      closing_this_week: closingThisWeek,
      overdue_deals: overdueDeals.slice(0, 5),
      unread_emails: unreadEmails,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Daily briefing error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Deal Intelligence — AI risk/opportunity scoring ──────────────────────────
app.post('/api/intelligence/deals/score', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { deals } = req.body;
  if (!deals?.length) return res.status(400).json({ error: 'deals array required' });

  const dealSummaries = deals.slice(0, 20).map(d => ({
    id: d.id,
    name: d.Deal_Name || d.name,
    stage: d.Stage || d.stage,
    amount: d.Amount || d.amount || 0,
    closing: d.Closing_Date || d.closing,
    probability: d.Probability || d.probability || 0,
    account: d.Account_Name?.name || d.account || '',
    contact: d.Contact_Name?.name || d.contact || '',
  }));

  const now = new Date();

  const prompt = `Score these ${dealSummaries.length} deals for risk (1-10, 10=high risk) and opportunity (1-10, 10=high opportunity). Consider: stage, amount, closing date, probability.

Deals:
${dealSummaries.map((d, i) => `${i+1}. ${d.name} | ${d.stage} | $${d.amount.toLocaleString()} | Close: ${d.closing || 'TBD'} | Prob: ${d.probability}% | Account: ${d.account}`).join('\n')}

Today: ${now.toISOString().slice(0,10)}

Return ONLY valid JSON array, no markdown:
[{"id":"deal_id","name":"deal_name","risk_score":5,"opp_score":7,"risk_reason":"overdue by 2 weeks","action":"Schedule executive check-in"}]`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!resp.ok) throw new Error(`Claude API error: ${resp.status}`);
    const result = await resp.json();
    const text = result.content?.[0]?.text || '[]';

    // Parse JSON from response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const scores = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    res.json({ scores, deals_scored: scores.length });
  } catch (err) {
    console.error('Deal scoring error:', err.message);
    res.status(500).json({ error: err.message });
  }
});




// ---------------------------------------------------------------------------
// Multi-Tenant Memory System
// ---------------------------------------------------------------------------
// Two namespaces per org:
//   company  — shared org knowledge, admin-protected, writes need approval
//   personal — per-user private notes, self-writable, admin-readable
//
// Backups: 3 rolling snapshots per org. Auto-taken before every approved write.
// Audit log: every action logged exhaustively (who, IP, UA, session, content, outcome).
// Orgs: bootstrapped from ORGS_CONFIG env var (JSON). Default org: basis-vectors.
// ---------------------------------------------------------------------------

const _memStore    = new Map();   // `${org}:company` or `${org}:user:${u}`
const _pendQueue   = new Map();   // org -> pending[]
const _backups     = new Map();   // org -> [snap1, snap2, snap3] newest-first
const _auditLog    = new Map();   // org -> entry[]

let _orgs = {};
try { _orgs = JSON.parse(process.env.ORGS_CONFIG || '{}'); } catch(e) {}
if (!_orgs['basis-vectors']) {
  _orgs['basis-vectors'] = {
    name: 'Basis Vectors Capital',
    admins: ['manish', 'manish696@gmail.com', 'prateek', 'scott'],
    created_at: new Date().toISOString(),
    created_by: 'manish'
  };
}

function _uid(req)  { return (req.session?.email || '').toLowerCase(); }
function _org(req)  { return ((req.query?.org || req.body?.org || 'basis-vectors') + '').toLowerCase().replace(/[^a-z0-9-]/g, '-'); }
function _isOrgAdmin(uid, orgId) {
  const o = _orgs[orgId];
  return o && o.admins.some(a => uid === a || uid === a.split('@')[0]);
}
function _mkey(orgId, ns, user) { return ns === 'company' ? `${orgId}:company` : `${orgId}:user:${user}`; }

function _audit(req, orgId, action, extra) {
  const log = _auditLog.get(orgId) || [];
  log.push({
    id: Math.random().toString(36).slice(2) + Date.now().toString(36),
    org: orgId,
    action,
    requested_by: _uid(req),
    requested_by_email: req.session?.email || 'unknown',
    requested_at: new Date().toISOString(),
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
    user_agent: req.headers['user-agent'] || 'unknown',
    session_id: req.sessionID || 'none',
    ...extra
  });
  if (log.length > 10000) log.splice(0, log.length - 10000);
  _auditLog.set(orgId, log);
}

function _takeBackup(orgId, triggeredBy) {
  const key = _mkey(orgId, 'company');
  const current = _memStore.get(key) || [];
  if (!current.length) return null;
  const snap = { snapshot: JSON.parse(JSON.stringify(current)), created_at: new Date().toISOString(), size: current.length, triggered_by: triggeredBy };
  const list = _backups.get(orgId) || [];
  list.unshift(snap);
  if (list.length > 3) list.length = 3;
  _backups.set(orgId, list);
  return snap;
}

// NOTE: the duplicate /api/memory GET/POST/DELETE routes (org-based subsystem) were
// removed here -- they were shadowed (dead) by the canonical /api/memory block above.
// The org-admin routes below (pending/backups/orgs) remain the live org feature.

// GET /api/memory/pending — admin: view queue
app.get('/api/memory/pending', requireAuth, (req, res) => {
  const uid = _uid(req), orgId = _org(req);
  if (!_isOrgAdmin(uid, orgId)) return res.status(403).json({ error: 'Admin only' });
  res.json({ org: orgId, pending: _pendQueue.get(orgId) || [] });
});

// POST /api/memory/pending/:entryId/approve
app.post('/api/memory/pending/:entryId/approve', requireAuth, async (req, res) => {
  const uid = _uid(req), orgId = _org(req);
  if (!_isOrgAdmin(uid, orgId)) { _audit(req, orgId, 'approve_blocked', { reason: 'not_admin', id: req.params.entryId }); return res.status(403).json({ error: 'Admin only' }); }
  const queue = _pendQueue.get(orgId) || [];
  const idx = queue.findIndex(e => e.id === req.params.entryId);
  if (idx === -1) return res.status(404).json({ error: 'Entry not found' });
  const entry = queue[idx];
  if (entry.status !== 'PENDING') return res.status(400).json({ error: `Already ${entry.status}` });

  const bk = _takeBackup(orgId, uid + '_approve');
  const key = _mkey(orgId, 'company');
  const existing = _memStore.get(key) || [];
  const newMems = entry.messages.map(m => ({ memory: m.content, namespace: 'company', org: orgId, metadata: { ...entry.metadata, proposed_by: entry.proposed_by, approved_by: uid }, created_at: new Date().toISOString() }));
  _memStore.set(key, [...existing, ...newMems].slice(-500));

  entry.status = 'APPROVED';
  entry.decision = { action: 'approved', by: uid, by_email: req.session?.email || 'unknown', at: new Date().toISOString(), ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown', note: req.body.note || null };
  queue[idx] = entry;
  _pendQueue.set(orgId, queue);
  _audit(req, orgId, 'approved', { entry_id: entry.id, proposed_by: entry.proposed_by, proposed_at: entry.proposed_at, backup_size: bk?.size || 0, committed: newMems.length, messages: entry.messages, note: req.body.note || null });
  res.json({ success: true, org: orgId, approved: entry, stored: newMems });
});

// POST /api/memory/pending/:entryId/reject
app.post('/api/memory/pending/:entryId/reject', requireAuth, (req, res) => {
  const uid = _uid(req), orgId = _org(req);
  if (!_isOrgAdmin(uid, orgId)) return res.status(403).json({ error: 'Admin only' });
  const queue = _pendQueue.get(orgId) || [];
  const idx = queue.findIndex(e => e.id === req.params.entryId);
  if (idx === -1) return res.status(404).json({ error: 'Entry not found' });
  const entry = queue[idx];
  entry.status = 'REJECTED';
  entry.decision = { action: 'rejected', by: uid, by_email: req.session?.email || 'unknown', at: new Date().toISOString(), reason: req.body.reason || null };
  queue[idx] = entry;
  _pendQueue.set(orgId, queue);
  _audit(req, orgId, 'rejected', { entry_id: entry.id, proposed_by: entry.proposed_by, reason: req.body.reason || null, messages: entry.messages });
  res.json({ success: true, org: orgId, rejected: entry });
});

// GET /api/memory/backups — admin: list backups
app.get('/api/memory/backups', requireAuth, (req, res) => {
  const uid = _uid(req), orgId = _org(req);
  if (!_isOrgAdmin(uid, orgId)) return res.status(403).json({ error: 'Admin only' });
  const snaps = (_backups.get(orgId) || []).map((b, i) => ({ index: i, created_at: b.created_at, size: b.size, triggered_by: b.triggered_by }));
  res.json({ org: orgId, backups: snaps, count: snaps.length });
});

// POST /api/memory/backups/:index/restore
app.post('/api/memory/backups/:index/restore', requireAuth, (req, res) => {
  const uid = _uid(req), orgId = _org(req);
  if (!_isOrgAdmin(uid, orgId)) return res.status(403).json({ error: 'Admin only' });
  const snaps = _backups.get(orgId) || [];
  const idx = parseInt(req.params.index, 10);
  if (!snaps[idx]) return res.status(404).json({ error: 'Backup not found' });
  _takeBackup(orgId, uid + '_pre_restore');
  _memStore.set(_mkey(orgId, 'company'), JSON.parse(JSON.stringify(snaps[idx].snapshot)));
  _audit(req, orgId, 'backup_restored', { backup_index: idx, backup_created_at: snaps[idx].created_at, size: snaps[idx].snapshot.length });
  res.json({ success: true, org: orgId, restored_from: snaps[idx].created_at, size: snaps[idx].snapshot.length });
});

// GET /api/audit-log — admin: full exhaustive log
app.get('/api/audit-log', requireAuth, (req, res) => {
  const uid = _uid(req), orgId = _org(req);
  if (!_isOrgAdmin(uid, orgId)) return res.status(403).json({ error: 'Admin only' });
  let log = _auditLog.get(orgId) || [];
  if (req.query.action) log = log.filter(e => e.action === req.query.action);
  if (req.query.user)   log = log.filter(e => e.requested_by === req.query.user);
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 2000);
  res.json({ org: orgId, total: log.length, entries: log.slice(-limit) });
});

// GET /api/orgs — list orgs
app.get('/api/orgs', requireAuth, (req, res) => {
  const uid = _uid(req);
  const orgs = Object.entries(_orgs).map(([id, cfg]) => ({ id, name: cfg.name, is_admin: _isOrgAdmin(uid, id), admin_count: cfg.admins.length, created_at: cfg.created_at }));
  res.json({ orgs, current_user: uid });
});

// POST /api/orgs — create a new org (global admin only)
app.post('/api/orgs', requireAuth, (req, res) => {
  const uid = _uid(req);
  if (!_isOrgAdmin(uid, 'basis-vectors')) return res.status(403).json({ error: 'Global admin only' });
  const { id, name, admins } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  const orgId = id.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (_orgs[orgId]) return res.status(409).json({ error: `Org '${orgId}' already exists` });
  _orgs[orgId] = { name, admins: admins || [uid], created_at: new Date().toISOString(), created_by: uid };
  _audit(req, orgId, 'org_created', { org_name: name, admins: admins || [uid] });
  res.status(201).json({ success: true, org: orgId, config: _orgs[orgId] });
});

// POST /api/orgs/:orgId/admins — add an admin to an org
app.post('/api/orgs/:orgId/admins', requireAuth, (req, res) => {
  const uid = _uid(req), orgId = req.params.orgId;
  if (!_orgs[orgId]) return res.status(404).json({ error: 'Org not found' });
  if (!_isOrgAdmin(uid, orgId)) return res.status(403).json({ error: 'Admin only' });
  const { user } = req.body;
  if (!user) return res.status(400).json({ error: 'user required' });
  if (!_orgs[orgId].admins.includes(user)) { _orgs[orgId].admins.push(user); _audit(req, orgId, 'admin_added', { new_admin: user }); }
  res.json({ success: true, org: orgId, admins: _orgs[orgId].admins });
});


// ---------------------------------------------------------------------------
// SPA catch-all
// ---------------------------------------------------------------------------

// === Error Telemetry Endpoints ===
app.post('/api/errors', (req, res) => {
  const { errors } = req.body || {};
  if (!Array.isArray(errors)) return res.status(400).json({ error: 'errors array required' });
  let circuitBreaks = [];
  for (const err of errors.slice(0, 50)) {
    const hash = err.hash || 'unknown';
    const entry = { hash, msg: (err.msg||'').slice(0,500), stack: (err.stack||'').slice(0,1000),
      context: (err.context||'').slice(0,100), count: err.count||1,
      ts: err.ts||new Date().toISOString(), url: (err.url||'').slice(0,200) };
    errorLog.push(entry);
    if (!errorCounts[hash]) {
      errorCounts[hash] = { count:0, msg:entry.msg, context:entry.context, firstSeen:entry.ts, lastSeen:entry.ts, notified:false };
    }
    errorCounts[hash].count++;
    errorCounts[hash].lastSeen = entry.ts;
    if (errorCounts[hash].count >= CIRCUIT_BREAK_THRESHOLD && !errorCounts[hash].notified) {
      errorCounts[hash].notified = true;
      circuitBreaks.push(errorCounts[hash]);
    }
  }
  if (errorLog.length > 500) errorLog = errorLog.slice(-500);
  saveErrorLog();
  if (circuitBreaks.length > 0) {
    console.warn('[ErrorBus] CIRCUIT BREAK: ' + circuitBreaks.length + ' errors hit threshold');
    (async () => {
      try {
        const auth = await getAuthedClient();
        if (!auth) return;
        const gmail = google.gmail({ version: 'v1', auth });
        const subject = '[Second Brain] Circuit Breaker: ' + circuitBreaks.length + ' error(s) fired';
        const body = circuitBreaks.map(cb =>
          'Error: ' + cb.msg + '\nContext: ' + cb.context + '\nCount: ' + cb.count + '\nFirst: ' + cb.firstSeen + '\nLast: ' + cb.lastSeen
        ).join('\n\n---\n\n');
        const raw = Buffer.from(
          'To: manish696@gmail.com\r\nSubject: ' + subject + '\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + body
        ).toString('base64url');
        await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
        console.log('[ErrorBus] Circuit break notification draft created');
      } catch(e) { console.warn('[ErrorBus] Failed to create notification draft:', e.message); }
    })();
  }
  res.json({ received: errors.length, circuitBreaks: circuitBreaks.length, totalUnique: Object.keys(errorCounts).length });
});

app.get('/api/errors', requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const recent = errorLog.slice(-limit).reverse();
  const stats = { total: errorLog.length, unique: Object.keys(errorCounts).length,
    circuitBreaks: Object.values(errorCounts).filter(c => c.count >= CIRCUIT_BREAK_THRESHOLD).length,
    topErrors: Object.entries(errorCounts).sort((a,b) => b[1].count - a[1].count).slice(0,10).map(([h,d]) => ({hash:h,...d}))
  };
  res.json({ stats, recent });
});

app.get('/api/errors/circuit-breaks', requireAuth, (req, res) => {
  const breaks = Object.entries(errorCounts)
    .filter(([_,d]) => d.count >= CIRCUIT_BREAK_THRESHOLD)
    .map(([h,d]) => ({hash:h,...d}));
  res.json({ count: breaks.length, threshold: CIRCUIT_BREAK_THRESHOLD, breaks });
});

// ---------------------------------------------------------------------------
// Deepgram live transcription - short-lived WS tokens
// ---------------------------------------------------------------------------
const dgCrypto = require('crypto');
const dgTokens = new Map();
function dgSweepTokens() { const now = Date.now(); for (const [t, exp] of dgTokens) { if (exp < now) dgTokens.delete(t); } }
app.post('/api/transcribe/token', requireAuth, (_req, res) => {
  if (!process.env.DEEPGRAM_API_KEY) return res.status(503).json({ error: 'DEEPGRAM_API_KEY not configured' });
  dgSweepTokens();
  const token = dgCrypto.randomBytes(24).toString('hex');
  dgTokens.set(token, Date.now() + 5 * 60 * 1000);
  res.json({ token });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
// Initialize the multi-user store (migrate schema, load memory cache) before serving.
(async () => {
  if (db.isConfigured()) {
    try {
      await db.migrate();
      console.log('[startup] Postgres schema ready.');
    } catch (e) {
      console.error('[startup] DB migration FAILED:', e.message);
    }
  }
  try { await memstore.load(); } catch (e) { console.error('[startup] memory load failed:', e.message); }
})();

const httpServer = app.listen(PORT, () => {
  console.log(`Second Brain server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    console.log(`Auth: http://localhost:${PORT}/auth/google`);
  } else {
    console.log('Google auth: configured via GOOGLE_REFRESH_TOKEN');
  }
  if (process.env.ZOHO_REFRESH_TOKEN) console.log('Zoho (Cadient): configured');
  if (process.env.VORRO_ZOHO_REFRESH_TOKEN) console.log('Zoho (Vorro India DC): configured');
  if (process.env.GRANOLA_API_KEY) console.log('Granola: configured');
  if (process.env.ANTHROPIC_API_KEY) console.log('Claude: configured');
});

// ---------------------------------------------------------------------------
// Deepgram live transcription - WS proxy (browser <-> Deepgram)
// ---------------------------------------------------------------------------
const DG_KEYTERMS = ['Cadient','SmartSuite','SmartSource','SmartMatch','SmartScreen','SmartTenure','SmartHire','Vorro','BridgeGate','EiPaaS','FHIR','HL7','iCIMS','Workday','Greenhouse','Paradox','Cerner','athenahealth','interoperability','Medicaid','ATS','cost per hire','time to fill','Basis Vectors'];

let DGWss = null;
try {
  const { WebSocketServer } = require('ws');
  DGWss = new WebSocketServer({ noServer: true });
} catch (e) { console.warn('ws module not installed; live transcription disabled:', e.message); }

if (DGWss) {
  httpServer.on('upgrade', (req, socket, head) => {
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch (e) { socket.destroy(); return; }
    if (u.pathname !== '/ws/transcribe') { socket.destroy(); return; }
    const token = u.searchParams.get('token') || '';
    const exp = dgTokens.get(token);
    if (!exp || exp < Date.now()) { socket.destroy(); return; }
    dgTokens.delete(token);
    DGWss.handleUpgrade(req, socket, head, (client) => dgHandleClient(client));
  });
  console.log('Live transcription: WS proxy mounted at /ws/transcribe');
}

function dgHandleClient(client) {
  const WS = require('ws');
  const params = new URLSearchParams({ model: 'nova-3', smart_format: 'true', diarize: 'true', interim_results: 'true', punctuate: 'true' });
  const qs = params.toString() + DG_KEYTERMS.map(k => '&keyterm=' + encodeURIComponent(k)).join('');
  const dg = new WS('wss://api.deepgram.com/v1/listen?' + qs, { headers: { Authorization: 'Token ' + process.env.DEEPGRAM_API_KEY } });
  const queue = [];
  let dgOpen = false;
  let keepAlive = null;
  function cleanup() { if (keepAlive) { clearInterval(keepAlive); keepAlive = null; } }
  dg.on('open', () => {
    dgOpen = true;
    for (const buf of queue.splice(0)) { try { dg.send(buf); } catch (e) {} }
    keepAlive = setInterval(() => { try { dg.send(JSON.stringify({ type: 'KeepAlive' })); } catch (e) {} }, 6000);
  });
  dg.on('message', (data) => { try { client.send(data.toString()); } catch (e) {} });
  dg.on('close', () => { cleanup(); try { client.close(); } catch (e) {} });
  dg.on('error', (e) => { cleanup(); try { client.send(JSON.stringify({ dgError: String((e && e.message) || e) })); client.close(); } catch (e2) {} });
  client.on('message', (msg, isBinary) => {
    if (!isBinary) { if (dgOpen) { try { dg.send(msg.toString()); } catch (e) {} } return; }
    if (dgOpen) { try { dg.send(msg); } catch (e) {} }
    else if (queue.length < 400) queue.push(msg);
  });
  client.on('close', () => { cleanup(); try { dg.close(); } catch (e) {} });
  client.on('error', () => { cleanup(); try { dg.close(); } catch (e) {} });
}
