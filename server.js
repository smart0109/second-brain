// CRO Second Brain - Express Backend Server
// Proxies Gmail, Calendar, Drive (Google), Zoho CRM, Granola, and Claude APIs

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');

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
const SESSION_SECRET = process.env.SESSION_SECRET
  || (process.env.NODE_ENV === 'production'
      ? require('crypto').randomBytes(32).toString('hex')   // random per-boot: not forgeable; sessions reset on redeploy
      : 'dev-secret-change-me');
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET not set — using a random per-boot secret. Set SESSION_SECRET in env to keep sessions across deploys.');
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

// Trust Render's reverse proxy for secure cookies / correct protocol
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(
  session({
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

// Data files that live under /public must NOT be served to anonymous visitors.
// (meetings-cache.json contains meeting summaries, participants, deal/pricing data.)
// requireAuth is hoisted; session middleware above has already run at this point.
const PROTECTED_STATIC = [/^\/meetings-cache\.json$/i, /\.json$/i];
app.use((req, res, next) => {
  if (req.method === 'GET' && PROTECTED_STATIC.some((re) => re.test(req.path))) {
    return requireAuth(req, res, next);
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

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

function getAuthedClient() {
  const oauth2 = createOAuth2Client();
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!refreshToken) return null;
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  // Browser users: must have a signed-in session (Google OAuth + allowlisted email).
  if (req.session && req.session.authenticated) return next();
  // Server-to-server automation (schedulers, local bridge, sync): explicit shared token.
  // NOTE: we intentionally do NOT fall back to the presence of GOOGLE_REFRESH_TOKEN —
  // that env var is a data-access credential, not proof the *caller* is authorized,
  // and using it as an auth bypass left the whole site open to anyone with the link.
  const svc = process.env.SERVICE_API_TOKEN;
  if (svc && req.get('x-api-token') === svc) return next();
  return res.status(401).json({ error: 'Not authenticated. Visit /auth/google to sign in.' });
}

// ---------------------------------------------------------------------------
// Zoho token cache — Cadient (US DC) + Vorro (India DC)
// ---------------------------------------------------------------------------
let zohoTokenCache = { accessToken: null, expiresAt: 0 };
let vorroTokenCache = { accessToken: null, expiresAt: 0 };

const VORRO_ZOHO_API_DOMAIN = process.env.VORRO_ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
const VORRO_ZOHO_TOKEN_URL = process.env.VORRO_ZOHO_TOKEN_URL || 'https://accounts.zoho.in/oauth/v2/token';

async function getZohoAccessToken() {
  if (zohoTokenCache.accessToken && Date.now() < zohoTokenCache.expiresAt - 60_000) {
    return zohoTokenCache.accessToken;
  }
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
  });
  const resp = await fetch('https://accounts.zoho.com/oauth/v2/token', {
    method: 'POST',
    body: params,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Zoho token refresh failed: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  if (data.error) throw new Error(`Zoho token error: ${data.error}`);
  zohoTokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return zohoTokenCache.accessToken;
}

async function getVorroZohoAccessToken() {
  if (vorroTokenCache.accessToken && Date.now() < vorroTokenCache.expiresAt - 60_000) {
    return vorroTokenCache.accessToken;
  }
  if (!process.env.VORRO_ZOHO_REFRESH_TOKEN) {
    throw new Error('Vorro Zoho not configured. Set VORRO_ZOHO_CLIENT_ID, VORRO_ZOHO_CLIENT_SECRET, and VORRO_ZOHO_REFRESH_TOKEN.');
  }
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.VORRO_ZOHO_CLIENT_ID,
    client_secret: process.env.VORRO_ZOHO_CLIENT_SECRET,
    refresh_token: process.env.VORRO_ZOHO_REFRESH_TOKEN,
  });
  const resp = await fetch(VORRO_ZOHO_TOKEN_URL, {
    method: 'POST',
    body: params,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Vorro Zoho token refresh failed: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  if (data.error) throw new Error(`Vorro Zoho token error: ${data.error}`);
  vorroTokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return vorroTokenCache.accessToken;
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
  const auth = getAuthedClient();
  if (!auth) throw new Error('Google not authenticated. Set GOOGLE_REFRESH_TOKEN or visit /auth/google');
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
  const auth = getAuthedClient();
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
  if (!process.env.ZOHO_REFRESH_TOKEN) {
    throw new Error('Zoho not configured. Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, and ZOHO_REFRESH_TOKEN.');
  }
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

async function handleGranola(toolName, args) {
  const apiKey = process.env.GRANOLA_API_KEY;

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
  const auth = getAuthedClient();
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

  if (toolName === 'get_file_metadata') {
    const fid = (args && (args.fileId || args.id));
    if (!fid) throw new Error('fileId required');
    const meta = await drive.files.get({ fileId: fid, fields: 'id,name,mimeType,modifiedTime,webViewLink,size' });
    return meta.data;
  }

  if (toolName === 'read_file_content' || toolName === 'download_file_content') {
    const fid = (args && (args.fileId || args.id));
    if (!fid) throw new Error('fileId required');
    const meta = await drive.files.get({ fileId: fid, fields: 'id,name,mimeType' });
    const mt = meta.data.mimeType || '';
    let content = '';
    if (mt.startsWith('application/vnd.google-apps')) {
      const exportMime = mt.includes('spreadsheet') ? 'text/csv' : 'text/plain';
      const resp = await drive.files.export({ fileId: fid, mimeType: exportMime }, { responseType: 'text' });
      content = typeof resp.data === 'string' ? resp.data : String(resp.data || '');
    } else {
      const resp = await drive.files.get({ fileId: fid, alt: 'media' }, { responseType: 'text' });
      content = typeof resp.data === 'string' ? resp.data : String(resp.data || '');
    }
    return { id: fid, name: meta.data.name, mimeType: mt, content };
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
  });
});

// Auth status
app.get('/auth/status', (req, res) => {
  // Anonymous visitors get ZERO identifying info or config detail.
  if (!(req.session && req.session.authenticated)) {
    return res.json({ authenticated: false });
  }
  res.json({
    authenticated: true,
    email: req.session.email || null,
    services: {
      google: !!process.env.GOOGLE_REFRESH_TOKEN,
      zoho: !!process.env.ZOHO_REFRESH_TOKEN,
      vorroZoho: !!process.env.VORRO_ZOHO_REFRESH_TOKEN,
      granola: !!(process.env.GRANOLA_API_KEY || meetingsCache),
      claude: !!process.env.ANTHROPIC_API_KEY, gemini: !!process.env.GEMINI_API_KEY, groq: !!process.env.GROQ_API_KEY,
    },
  });
});

// Google OAuth: start
app.get('/auth/google', (_req, res) => {
  const oauth2 = createOAuth2Client();
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES,
  });
  res.redirect(url);
});

// Google OAuth: callback
app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');

  try {
    const oauth2 = createOAuth2Client();
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);

    // Verify email
    const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
    const userInfo = await oauth2Api.userinfo.get();
    const email = (userInfo.data.email || '').toLowerCase();

    if (!ALLOWED_EMAILS.includes(email)) {
      return res.status(403).send(`Access denied. Email ${email} is not authorized.`);
    }

    req.session.authenticated = true;
    req.session.email = email;

    // SECURITY: never display the Google refresh token in the browser. Login is
    // session-based and the server's GOOGLE_REFRESH_TOKEN is configured once in
    // env for data access. Just establish the session and go to the dashboard.
    return res.redirect('/');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send(`Authentication failed: ${err.message}`);
  }
});

// Logout
app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
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
const _memoryStore = new Map(); // userId → [{memory, metadata, created_at}]

// ─── Two-Tier Memory System ────────────────────────────────────────────────
// namespace=company  → admin-protected shared knowledge (read freely, write needs approval)
// namespace=personal → per-user private notes (write freely, admin-readable)
// ?user=firstname    → whose personal store to read/write (defaults to current user)
// ADMINS: manish, prateek, scott  (only they may approve company writes)
// ─────────────────────────────────────────────────────────────────────────────

const COMPANY_MEMORY_KEY = '__company__';
const ADMINS = ['manish', 'manish696@gmail.com'];

function _getUserId(req) {
  return (req.session?.email || process.env.ALLOWED_EMAIL || 'manish').toLowerCase().split('@')[0];
}

function _isAdmin(userId) {
  return ADMINS.some(a => userId.includes(a.split('@')[0]));
}

// GET /api/memory?q=query&namespace=personal|company&user=firstname
app.get('/api/memory', requireAuth, async (req, res) => {
  const currentUser = _getUserId(req);
  const ns = req.query.namespace || 'personal';
  const targetUser = ns === 'company' ? COMPANY_MEMORY_KEY : (req.query.user || currentUser);
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
  const targetUser = ns === 'company' ? COMPANY_MEMORY_KEY : (req.body.user || currentUser);
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
  const targetUser = ns === 'company' ? COMPANY_MEMORY_KEY : (req.query.user || currentUser);

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
    const userId = req.session?.email || process.env.ALLOWED_EMAIL || 'manish';
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
      const userId = req.session?.email || process.env.ALLOWED_EMAIL || 'manish';
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
    const userId = req.session?.email || process.env.ALLOWED_EMAIL || 'manish';
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

function _uid(req)  { return (req.session?.email || process.env.ALLOWED_EMAIL || 'manish').toLowerCase().split('@')[0]; }
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
    requested_by_email: req.session?.email || process.env.ALLOWED_EMAIL || 'unknown',
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

// GET /api/memory
app.get('/api/memory', requireAuth, async (req, res) => {
  const uid = _uid(req), orgId = _org(req), ns = req.query.namespace || 'personal';
  const targetUser = ns === 'company' ? null : (req.query.user || uid);
  const q = (req.query.q || '').toLowerCase();
  if (!_orgs[orgId]) return res.status(404).json({ error: `Org '${orgId}' not found` });
  if (ns === 'personal' && targetUser !== uid && !_isOrgAdmin(uid, orgId)) {
    _audit(req, orgId, 'read_blocked', { ns, target: targetUser, reason: 'privacy' });
    return res.status(403).json({ error: "Cannot read another user's personal notes" });
  }
  _audit(req, orgId, 'read', { ns, target: targetUser || 'company', query: q || null });

  const mem0Key = process.env.MEM0_API_KEY;
  const m0uid = ns === 'company' ? `${orgId}__company` : `${orgId}__${targetUser}`;
  if (mem0Key) {
    try {
      const r = await fetch('https://api.mem0.ai/v1/memories/search/', {
        method: 'POST', headers: { Authorization: `Token ${mem0Key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q || 'recent context', user_id: m0uid, limit: 20 })
      });
      if (r.ok) return res.json({ ...(await r.json()), namespace: ns, org: orgId });
    } catch(e) {}
  }
  const mems = _memStore.get(_mkey(orgId, ns, targetUser)) || [];
  const filtered = q ? mems.filter(m => (m.memory || '').toLowerCase().includes(q)) : mems;
  res.json({ results: filtered.slice(-50), namespace: ns, org: orgId, user: targetUser, total: filtered.length });
});

// POST /api/memory
app.post('/api/memory', requireAuth, async (req, res) => {
  const uid = _uid(req), orgId = _org(req), ns = req.body.namespace || 'personal';
  const targetUser = ns === 'company' ? null : (req.body.user || uid);
  const { messages, metadata } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages required' });
  if (!_orgs[orgId]) return res.status(404).json({ error: `Org '${orgId}' not found` });
  const isAdmin = _isOrgAdmin(uid, orgId);

  if (ns === 'personal' && targetUser !== uid && !isAdmin) {
    _audit(req, orgId, 'write_blocked', { ns, target: targetUser, reason: 'not_self_or_admin', messages });
    return res.status(403).json({ error: "Cannot write to another user's personal notes" });
  }

  // Company write by non-admin → queue
  if (ns === 'company' && !isAdmin) {
    const q = _pendQueue.get(orgId) || [];
    const entry = {
      id: Math.random().toString(36).slice(2) + Date.now().toString(36),
      proposed_by: uid, proposed_by_email: req.session?.email || process.env.ALLOWED_EMAIL || 'unknown',
      proposed_at: new Date().toISOString(),
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
      user_agent: req.headers['user-agent'] || 'unknown',
      session_id: req.sessionID || 'none',
      org: orgId, messages, metadata: metadata || {}, status: 'PENDING', decision: null
    };
    q.push(entry);
    _pendQueue.set(orgId, q);
    _audit(req, orgId, 'company_write_queued', { entry_id: entry.id, messages, metadata, pending_count: q.length });
    return res.json({ status: 'pending_approval', message: 'Queued for org admin approval.', entry_id: entry.id, entry, org_admins: _orgs[orgId].admins });
  }

  // Admin direct write → backup first
  if (ns === 'company') {
    const bk = _takeBackup(orgId, uid);
    _audit(req, orgId, 'backup_rotated', { size: bk?.size || 0, trigger: 'pre_admin_write' });
  }

  const mem0Key = process.env.MEM0_API_KEY;
  const m0uid = ns === 'company' ? `${orgId}__company` : `${orgId}__${targetUser}`;
  if (mem0Key) {
    try {
      const r = await fetch('https://api.mem0.ai/v1/memories/', {
        method: 'POST', headers: { Authorization: `Token ${mem0Key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, user_id: m0uid, metadata })
      });
      if (r.ok) {
        _audit(req, orgId, 'write_committed', { ns, user: targetUser, via: 'mem0', messages });
        return res.json({ ...(await r.json()), namespace: ns, org: orgId });
      }
    } catch(e) {}
  }

  const key = _mkey(orgId, ns, targetUser);
  const existing = _memStore.get(key) || [];
  const newMems = messages.map(m => ({ memory: m.content, namespace: ns, org: orgId, metadata: { ...metadata, written_by: uid }, created_at: new Date().toISOString() }));
  _memStore.set(key, [...existing, ...newMems].slice(-300));
  _audit(req, orgId, 'write_committed', { ns, user: targetUser, via: 'in-process', count: newMems.length, messages });
  res.json({ results: newMems, namespace: ns, org: orgId, source: 'in-process' });
});

// DELETE /api/memory
app.delete('/api/memory', requireAuth, (req, res) => {
  const uid = _uid(req), orgId = _org(req), ns = req.query.namespace || 'personal';
  const targetUser = ns === 'company' ? null : (req.query.user || uid);
  if (!_orgs[orgId]) return res.status(404).json({ error: `Org '${orgId}' not found` });
  const isAdmin = _isOrgAdmin(uid, orgId);
  if (ns === 'company' && !isAdmin) { _audit(req, orgId, 'delete_blocked', { ns, reason: 'not_admin' }); return res.status(403).json({ error: 'Admin only' }); }
  if (ns === 'personal' && targetUser !== uid && !isAdmin) { _audit(req, orgId, 'delete_blocked', { ns, target: targetUser, reason: 'not_self_or_admin' }); return res.status(403).json({ error: "Cannot clear another user's notes" }); }
  if (ns === 'company') _takeBackup(orgId, uid + '_delete');
  _memStore.delete(_mkey(orgId, ns, targetUser));
  _audit(req, orgId, 'deleted', { ns, user: targetUser || 'company' });
  res.json({ success: true, namespace: ns, org: orgId, user: targetUser });
});

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
  entry.decision = { action: 'approved', by: uid, by_email: req.session?.email || process.env.ALLOWED_EMAIL || 'unknown', at: new Date().toISOString(), ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown', note: req.body.note || null };
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
  entry.decision = { action: 'rejected', by: uid, by_email: req.session?.email || process.env.ALLOWED_EMAIL || 'unknown', at: new Date().toISOString(), reason: req.body.reason || null };
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
        const auth = getAuthedClient();
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

// ===========================================================================
// Live Meet captions bridge (no bot): a Chrome extension scrapes Google Meet's
// own live captions (with the speaker name) and POSTs them here keyed by a
// short pairing code; the dashboard polls them into the live transcript.
// ===========================================================================
const _capBuffers = new Map();
const _capCodes = new Map();
function _capCleanup(){ const now=Date.now(); for(const [c,m] of _capCodes) if(m.exp<now){_capCodes.delete(c);_capBuffers.delete(c);} }
setInterval(_capCleanup, 10*60*1000).unref && setInterval(_capCleanup,10*60*1000).unref();
function _stableCapCode(req){ const id=(req.session&&(req.session.userId||req.session.email))||'anon'; const secret=process.env.SESSION_SECRET||'sb-captions'; return dgCrypto.createHmac('sha256',secret).update('cap:'+id).digest('hex').slice(0,8).toUpperCase(); }
app.post('/api/live-captions/code', requireAuth, (req, res) => {
  const code = _stableCapCode(req);
  _capCodes.set(code, { userId: (req.session && (req.session.userId||req.session.email)) || 'user', exp: Date.now()+24*60*60*1000 });
  if(!_capBuffers.has(code)) _capBuffers.set(code, { lines: [], updated: Date.now() });
  res.json({ code });
});
app.options('/api/live-captions', (_req, res) => { res.set('Access-Control-Allow-Origin','*'); res.set('Access-Control-Allow-Methods','POST, GET, OPTIONS'); res.set('Access-Control-Allow-Headers','Content-Type'); res.sendStatus(204); });
app.post('/api/live-captions', (req, res) => {
  res.set('Access-Control-Allow-Origin','*');
  const code = String((req.query.code || (req.body && req.body.code) || '')).trim().toUpperCase();
  if (!code || !_capCodes.has(code)) return res.status(401).json({ error: 'invalid or expired pairing code' });
  const buf = _capBuffers.get(code) || { lines: [], updated: 0 };
  const incoming = (req.body && req.body.lines) || [];
  for (const l of incoming) { if (l && l.text) buf.lines.push({ speaker: String(l.speaker||'').slice(0,80), text: String(l.text).slice(0,2000), ts: Number(l.ts)||Date.now() }); }
  if (buf.lines.length > 4000) buf.lines = buf.lines.slice(-4000);
  buf.updated = Date.now(); _capBuffers.set(code, buf);
  const meta = _capCodes.get(code); if (meta) meta.exp = Date.now()+12*60*60*1000;
  res.json({ ok: true, count: buf.lines.length });
});
app.get('/api/live-captions', requireAuth, (req, res) => {
  const code = String(req.query.code||'').trim().toUpperCase();
  const since = Number(req.query.since)||0;
  const meta=_capCodes.get(code); if(meta)meta.exp=Date.now()+24*60*60*1000;
  const buf = _capBuffers.get(code);
  if (!buf) return res.json({ lines: [], now: Date.now() });
  res.json({ lines: buf.lines.filter((l)=>l.ts>since), now: Date.now() });
});
const MEET_CAPTION_CONFIG = { version:3, updated:'2026-06-24',
  platforms:{
    meet:{ regionSelectors:['div[role="region"][aria-label*="aption" i]','div[aria-live="polite"]','.a4cQT'],
      rowSelectors:['.nMcdL','.TBMuR','div[class*="caption"]'],
      speakerSelectors:['.NWpY1d','.zs7s8d','span[class*="name" i]'],
      textSelectors:['.ygicle','.bh44bd','.iTTPOb','div[class*="text" i]'],
      captionsButtonSelectors:['button[aria-label*="aption" i]','button[jsname][data-tooltip*="aption" i]'], toggleKey:'c' },
    teams:{ regionSelectors:['[data-tid="closed-captions-renderer"]','[aria-label*="aptions" i]','[class*="closed-caption" i]'],
      rowSelectors:['[data-tid="closed-caption-message"]','.ui-chat__item','[class*="caption" i][class*="message" i]','div[class*="caption" i]'],
      speakerSelectors:['[data-tid="author"]','[class*="author" i]','[class*="name" i]'],
      textSelectors:['[data-tid="caption-text"]','[class*="caption-text" i]','[class*="text" i]'],
      captionsButtonSelectors:['button[aria-label*="aption" i]'], toggleKey:null },
    zoom:{ regionSelectors:['[aria-label*="aptions" i]','.live-transcription-subtitle','[class*="transcription" i]','[class*="caption" i]'],
      rowSelectors:['.live-transcription-subtitle__item','[class*="subtitle__item" i]','[class*="caption-item" i]','div[class*="caption" i]'],
      speakerSelectors:['.live-transcription-subtitle__item-name','[class*="item-name" i]','[class*="name" i]'],
      textSelectors:['.live-transcription-subtitle__item-text','[class*="item-text" i]','[class*="text" i]'],
      captionsButtonSelectors:['button[aria-label*="aption" i]','button[aria-label*="ranscript" i]'], toggleKey:null } },
  regionSelectors:['div[role="region"][aria-label*="aption" i]','div[aria-live="polite"]','.a4cQT'],
  rowSelectors:['.nMcdL','.TBMuR','div[class*="caption"]'],
  speakerSelectors:['.NWpY1d','.zs7s8d','span[class*="name" i]'],
  textSelectors:['.ygicle','.bh44bd','.iTTPOb','div[class*="text" i]'],
  captionsButtonSelectors:['button[aria-label*="aption" i]','button[jsname][data-tooltip*="aption" i]'],
  toggleKey:'c' };
app.get('/api/meet-caption-config', (_req, res) => { res.set('Access-Control-Allow-Origin','*'); res.json(MEET_CAPTION_CONFIG); });
app.options('/api/meet-caption-config', (_req, res) => { res.set('Access-Control-Allow-Origin','*'); res.set('Access-Control-Allow-Methods','GET, OPTIONS'); res.set('Access-Control-Allow-Headers','Content-Type'); res.sendStatus(204); });

// ===========================================================================
// SOCIAL MEDIA POSTING  (viral-post engagement + AI drafts + local-poster bridge)
// ---------------------------------------------------------------------------
// Flow: local machine pushes today's viral LinkedIn targets -> this page shows
// the post to engage with -> generates 2 AI drafts (challenging/punchy +
// expert opinion) -> "Post" creates a pending job -> the local Windows poller
// (reusing the Selenium stack) claims the job, posts to LinkedIn, reports back.
// ===========================================================================
const SOCIAL_TARGETS_PATH = path.join(__dirname, 'data', 'social-targets.json');
const SOCIAL_POSTS_PATH = path.join(__dirname, 'data', 'social-posts.json');

// ---- Durable KV: Postgres-backed when DATABASE_URL is set; file fallback otherwise ----
// Render's filesystem is EPHEMERAL (wiped on every redeploy), which silently erased
// viral targets + meeting-prep entries. With DATABASE_URL we persist these small JSON
// stores in Postgres (hydrated into memory at boot) so they survive redeploys.
let _pgPool = null;
const _kv = {};
let _kvHydrated = false;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    _pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
    _pgPool.on('error', (e) => console.warn('pg pool error:', e.message));
  } catch (e) { console.warn('pg unavailable, using file storage:', e.message); _pgPool = null; }
}
async function _kvInit() {
  if (!_pgPool) { _kvHydrated = true; return; }
  try {
    await _pgPool.query('CREATE TABLE IF NOT EXISTS app_kv (k text primary key, v jsonb, updated_at timestamptz default now())');
    const r = await _pgPool.query('SELECT k, v FROM app_kv');
    for (const row of r.rows) _kv[row.k] = row.v;
    _kvHydrated = true;
    console.log('Durable KV hydrated from Postgres:', r.rows.length, 'keys');
  } catch (e) {
    console.warn('KV init failed, falling back to files:', e.message);
    _pgPool = null; _kvHydrated = true;
  }
}
const _kvKey = (p) => path.basename(p);

function _readJsonSafe(p, fallback) {
  if (_pgPool) { const k = _kvKey(p); return (k in _kv) ? _kv[k] : fallback; }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function _writeJsonSocial(p, obj) {
  if (_pgPool) {
    const k = _kvKey(p); _kv[k] = obj;
    _pgPool.query('INSERT INTO app_kv(k,v,updated_at) VALUES($1,$2,now()) ON CONFLICT(k) DO UPDATE SET v=$2, updated_at=now()', [k, JSON.stringify(obj)])
      .catch((e) => console.warn('kv write ' + k + ' failed:', e.message));
    return;
  }
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
function _socialId() { return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// Guard for endpoints the LOCAL poller calls. If SOCIAL_BRIDGE_TOKEN is set,
// require a matching x-bridge-token header; otherwise fall back to requireAuth
// (which passes server-side via the GOOGLE_REFRESH_TOKEN bypass).
function bridgeGuard(req, res, next) {
  const want = process.env.SOCIAL_BRIDGE_TOKEN;
  const svc = process.env.SERVICE_API_TOKEN;
  // Server-to-server callers (local poller / schedulers) present a token header.
  if (want && req.get('x-bridge-token') === want) return next();
  if (svc && req.get('x-api-token') === svc) return next();
  // Browser users on the dashboard are authorized by their signed-in session.
  if (req.session && req.session.authenticated) return next();
  return res.status(401).json({ error: 'Not authorized for bridge endpoint.' });
}

// Generate one LinkedIn draft in a given style, grounded in Manish's context.
async function _genSocialDraft(style, post) {
  const styleSpec = style === 'expert'
    ? 'Write a credible EXPERT-OPINION LinkedIn comment (3 to 5 sentences, 60 to 100 words). Add one sharp, specific insight or operator-level data point that reframes the discussion and positions the writer as a seasoned CRO. Professional but human.'
    : 'Write a CHALLENGING, PUNCHY LinkedIn comment (2 to 4 sentences, under 60 words). Take a bold, slightly contrarian stance that sparks debate and makes people stop scrolling. Conversational and confident.';
  const systemPrompt = 'You are drafting LinkedIn engagement comments for Manish, a CRO who runs Cadient (AI-powered high-volume hiring / talent platform) and Vorro (healthcare data integration, BridgeGate EiPaaS). Write in first person as Manish. Rules: sound like a real human, use contractions, no hashtags, no emojis, no asterisks or hyphens or arrows as formatting, do NOT pitch or name products, do not be salesy. Return ONLY the comment text, nothing else.';
  const userContent = `${styleSpec}\n\n--- POST TO ENGAGE WITH ---\nAuthor: ${post.author || 'Unknown'}${post.authorTitle ? ' (' + post.authorTitle + ')' : ''}\nPost:\n${post.text || '(no text captured)'}\n`;
  const providers = [
    () => askGemini(systemPrompt, userContent, 320),
    () => askGroq(systemPrompt, userContent, 320),
    () => askAnthropic(systemPrompt, userContent, 320),
  ];
  for (const fn of providers) {
    try { const out = await fn(); if (out && out.trim()) return out.trim(); } catch (e) { console.warn('social draft provider failed:', e.message); }
  }
  throw new Error('All AI providers failed (check GEMINI_API_KEY / GROQ_API_KEY / ANTHROPIC_API_KEY)');
}

// --- Page-facing endpoints (requireAuth) -----------------------------------
app.get('/api/social/targets', requireAuth, (_req, res) => {
  res.json(_readJsonSafe(SOCIAL_TARGETS_PATH, { updatedAt: null, targets: [] }));
});

app.post('/api/social/draft', requireAuth, async (req, res) => {
  try {
    let post = req.body && req.body.post;
    if (!post && req.body && req.body.targetId) {
      const store = _readJsonSafe(SOCIAL_TARGETS_PATH, { targets: [] });
      post = (store.targets || []).find(t => t.id === req.body.targetId);
    }
    if (!post) return res.status(400).json({ error: 'Provide a targetId or a post object' });
    const [challenging, expert] = await Promise.all([
      _genSocialDraft('challenging', post),
      _genSocialDraft('expert', post),
    ]);
    res.json({ challenging, expert });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/social/posts', requireAuth, (_req, res) => {
  const store = _readJsonSafe(SOCIAL_POSTS_PATH, { jobs: [] });
  res.json({ jobs: (store.jobs || []).slice(-50).reverse() });
});

app.post('/api/social/posts', requireAuth, (req, res) => {
  const b = req.body || {};
  if (!b.text || !b.text.trim()) return res.status(400).json({ error: 'Missing draft text' });
  const store = _readJsonSafe(SOCIAL_POSTS_PATH, { jobs: [] });
  const job = {
    id: _socialId(),
    createdAt: new Date().toISOString(),
    platform: b.platform || 'linkedin',
    mode: b.mode || 'comment',
    targetId: b.targetId || null,
    targetUrl: b.targetUrl || null,
    style: b.style || null,
    text: b.text.trim(),
    status: 'pending',
    claimedAt: null, postedAt: null, error: null, resultUrl: null,
  };
  store.jobs = store.jobs || []; store.jobs.push(job);
  _writeJsonSocial(SOCIAL_POSTS_PATH, store);
  res.json({ ok: true, job });
});

// --- Local-poster bridge endpoints (bridgeGuard) ---------------------------
app.post('/api/social/targets', bridgeGuard, (req, res) => {
  const targets = (req.body && req.body.targets) || [];
  const norm = targets.map(t => ({
    id: t.id || _socialId(),
    platform: t.platform || 'linkedin',
    url: t.url || t.postUrl || null,
    text: t.text || t.postText || '',
    author: t.author || t.authorName || '',
    authorTitle: t.authorTitle || t.headline || '',
    score: t.score != null ? t.score : (t.target_score != null ? t.target_score : null),
    topic: t.topic || t.matched_template || '',
    source: t.source || null,
    likes: t.likes != null ? t.likes : null,
    comments: t.comments != null ? t.comments : null,
    shares: t.shares != null ? t.shares : null,
  }));
  _writeJsonSocial(SOCIAL_TARGETS_PATH, { updatedAt: new Date().toISOString(), targets: norm });
  res.json({ ok: true, count: norm.length });
});

app.get('/api/social/posts/pending', bridgeGuard, (_req, res) => {
  const store = _readJsonSafe(SOCIAL_POSTS_PATH, { jobs: [] });
  res.json({ jobs: (store.jobs || []).filter(j => j.status === 'pending') });
});

app.post('/api/social/posts/:id/claim', bridgeGuard, (req, res) => {
  const store = _readJsonSafe(SOCIAL_POSTS_PATH, { jobs: [] });
  const job = (store.jobs || []).find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'pending') return res.status(409).json({ error: 'Already ' + job.status });
  job.status = 'claimed'; job.claimedAt = new Date().toISOString();
  _writeJsonSocial(SOCIAL_POSTS_PATH, store);
  res.json({ ok: true, job });
});

app.post('/api/social/posts/:id/result', bridgeGuard, (req, res) => {
  const store = _readJsonSafe(SOCIAL_POSTS_PATH, { jobs: [] });
  const job = (store.jobs || []).find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const b = req.body || {};
  job.status = b.status === 'posted' ? 'posted' : 'failed';
  job.resultUrl = b.resultUrl || null;
  job.error = b.error || null;
  job.postedAt = new Date().toISOString();
  _writeJsonSocial(SOCIAL_POSTS_PATH, store);
  res.json({ ok: true, job });
});

// --- Breaking-source "be first" monitor + refresh + super-viral email alert ----
const SOCIAL_SOURCES_PATH = path.join(__dirname, 'data', 'social-sources.json');
const SOCIAL_REFRESH_PATH = path.join(__dirname, 'data', 'social-refresh.json');
const SOCIAL_ALERTS_PATH = path.join(__dirname, 'data', 'social-alerts.json');

// Breaking news sources the page shows (pushed by the local news monitor)
app.get('/api/social/sources', requireAuth, (_req, res) => {
  res.json(_readJsonSafe(SOCIAL_SOURCES_PATH, { updatedAt: null, sources: [] }));
});
app.post('/api/social/sources', bridgeGuard, (req, res) => {
  const sources = (req.body && req.body.sources) || [];
  _writeJsonSocial(SOCIAL_SOURCES_PATH, { updatedAt: new Date().toISOString(), sources });
  res.json({ ok: true, count: sources.length });
});

// "Find viral posts" button -> request an on-demand refresh the local poller runs
app.post('/api/social/refresh', requireAuth, (req, res) => {
  const store = _readJsonSafe(SOCIAL_REFRESH_PATH, {});
  store.requestedAt = new Date().toISOString();
  store.kind = (req.body && req.body.kind) || 'viral';
  _writeJsonSocial(SOCIAL_REFRESH_PATH, store);
  res.json({ ok: true, requestedAt: store.requestedAt });
});
app.get('/api/social/refresh', bridgeGuard, (_req, res) => {
  const s = _readJsonSafe(SOCIAL_REFRESH_PATH, {});
  res.json({ pending: !!(s.requestedAt && s.requestedAt !== s.doneAt), requestedAt: s.requestedAt || null, kind: s.kind || 'viral' });
});
app.post('/api/social/refresh/done', bridgeGuard, (req, res) => {
  const s = _readJsonSafe(SOCIAL_REFRESH_PATH, {});
  s.doneAt = (req.body && req.body.requestedAt) || s.requestedAt || new Date().toISOString();
  _writeJsonSocial(SOCIAL_REFRESH_PATH, s);
  res.json({ ok: true });
});

// ===========================================================================
// ARTIFACTS — pin/remove preferences + most-emailed-client ranking
// Durable (Postgres-backed via _writeJsonSocial/_readJsonSafe; file fallback).
// Prefs survive redeploys and are shared across devices for the single owner.
// ===========================================================================
const ARTIFACT_PREFS_PATH = path.join(__dirname, 'data', 'artifact-prefs.json');
const ARTIFACT_CLIENTS_PATH = path.join(__dirname, 'data', 'artifact-clients.json');

// Pin/hide preferences. Shape: { pinned:[...ids], hidden:[...ids], updatedAt }
app.get('/api/artifacts/prefs', requireAuth, (_req, res) => {
  const p = _readJsonSafe(ARTIFACT_PREFS_PATH, { pinned: [], hidden: [], updatedAt: null });
  res.json({ pinned: Array.isArray(p.pinned) ? p.pinned : [], hidden: Array.isArray(p.hidden) ? p.hidden : [], updatedAt: p.updatedAt || null });
});
app.post('/api/artifacts/prefs', requireAuth, (req, res) => {
  const b = req.body || {};
  const clean = (a) => Array.from(new Set((Array.isArray(a) ? a : []).filter(x => typeof x === 'string' && x).map(String))).slice(0, 2000);
  const obj = { pinned: clean(b.pinned), hidden: clean(b.hidden), updatedAt: new Date().toISOString() };
  _writeJsonSocial(ARTIFACT_PREFS_PATH, obj);
  res.json({ ok: true, pinned: obj.pinned, hidden: obj.hidden });
});

// Most-emailed client ranking (computed from Gmail SENT mail, last ~90d, external
// domains only). Served to the SPA so "Sort: Most-emailed clients" can order
// artifacts by client relevance. A scheduler/agent may refresh it durably via POST
// (bridgeGuard: service token or signed-in session). Seeded so it works immediately.
const _ARTIFACT_CLIENTS_SEED = {
  updatedAt: null,
  source: 'gmail:in:sent newer_than:90d (external domains, seeded 2026-06-22)',
  clients: [
    { domain: 'chaiclassconsulting.com', company: 'chaiclassconsulting', weight: 6 },
    { domain: 'medreviq.com', company: 'medreviq', weight: 5 },
    { domain: 'airmeez.com', company: 'airmeez', weight: 3 },
    { domain: 'ipill.tech', company: 'ipill', weight: 3 },
    { domain: 'medozai.com', company: 'medozai', weight: 3 },
    { domain: 'ipex.health', company: 'ipex', weight: 2 },
    { domain: 'fadv.com', company: 'fadv', weight: 2 },
    { domain: 'unilogcorp.com', company: 'unilog', weight: 2 },
    { domain: 'stancehealthsolutions.com', company: 'stancehealth', weight: 2 },
    { domain: 'safespace.tools', company: 'safespace', weight: 2 },
    { domain: 'athenaequity.com', company: 'athenaequity', weight: 2 },
    { domain: 'etherfax.net', company: 'etherfax', weight: 1 },
    { domain: 'ehe.health', company: 'ehe', weight: 1 },
    { domain: 'safestartmedical.com', company: 'safestartmedical', weight: 1 },
    { domain: 'aarkai.com', company: 'aarkai', weight: 1 },
    { domain: 'latentbridge.com', company: 'latentbridge', weight: 1 },
    { domain: 'boydbeauty.com', company: 'boydbeauty', weight: 1 }
  ]
};
app.get('/api/artifacts/clients', requireAuth, (_req, res) => {
  const c = _readJsonSafe(ARTIFACT_CLIENTS_PATH, _ARTIFACT_CLIENTS_SEED);
  res.json({ updatedAt: c.updatedAt || null, source: c.source || _ARTIFACT_CLIENTS_SEED.source, clients: Array.isArray(c.clients) ? c.clients : [] });
});
app.post('/api/artifacts/clients', bridgeGuard, (req, res) => {
  const b = req.body || {};
  const clients = (Array.isArray(b.clients) ? b.clients : []).filter(x => x && (x.domain || x.company)).slice(0, 500)
    .map(x => ({ domain: String(x.domain || '').toLowerCase(), company: String(x.company || (x.domain || '').split('.')[0] || '').toLowerCase(), weight: Number(x.weight) || 1 }));
  const obj = { updatedAt: new Date().toISOString(), source: b.source || 'gmail:in:sent', clients };
  _writeJsonSocial(ARTIFACT_CLIENTS_PATH, obj);
  res.json({ ok: true, count: clients.length });
});

// Send a real super-viral alert email to the owner (recipient hardcoded; never outreach)
async function _sendAlertEmail(subject, htmlBody) {
  const auth = getAuthedClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const to = process.env.ALLOWED_EMAIL || 'manish696@gmail.com';
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${htmlBody}`
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

app.post('/api/social/alert', bridgeGuard, async (req, res) => {
  const posts = (req.body && req.body.posts) || [];
  const threshold = (req.body && req.body.threshold) || 0;
  if (!posts.length) return res.json({ ok: true, emailed: 0, note: 'no posts' });
  const seen = _readJsonSafe(SOCIAL_ALERTS_PATH, { urls: [] });
  const fresh = posts.filter(p => p.url && !seen.urls.includes(p.url));
  if (!fresh.length) return res.json({ ok: true, emailed: 0, note: 'all already alerted' });
  const rows = fresh.map(p =>
    `<tr><td style="padding:6px 10px;font-weight:700">${(p.score||p.engagement||'')}</td>`
    + `<td style="padding:6px 10px">${(p.author||'')}</td>`
    + `<td style="padding:6px 10px">${((p.text||'').slice(0,140)).replace(/</g,'&lt;')}`
    + (p.url ? ` <a href="${p.url}">open</a>` : '') + '</td></tr>').join('');
  const html = `<h2>Super-viral posts (score &ge; ${threshold})</h2>`
    + `<table style="border-collapse:collapse;font-family:Arial">${rows}</table>`
    + `<p>Detected by your Social Posting monitor.</p>`;
  try {
    await _sendAlertEmail(`Super-viral alert: ${fresh.length} post(s)`, html);
    seen.urls = (seen.urls || []).concat(fresh.map(p => p.url)).slice(-500);
    _writeJsonSocial(SOCIAL_ALERTS_PATH, seen);
    res.json({ ok: true, emailed: fresh.length });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ===========================================================================
// MEETING PREP INDEX
// The morning prep run (pre-meeting-prospect-prep) POSTs one entry per meeting
// with the Drive doc link + local file path (service token). The dashboard GETs
// them to link "Prep Doc" instead of opening a Gmail draft.
// ===========================================================================
const PREP_INDEX_FILE = path.join(__dirname, 'data', 'meeting-prep-index.json');
function _loadPrepIndex() { return _readJsonSafe(PREP_INDEX_FILE, { entries: [] }); }
function _savePrepIndex(idx) { _writeJsonSocial(PREP_INDEX_FILE, idx); }
// Service token OR a signed-in session may write prep entries.
function prepWriteGuard(req, res, next) {
  const svc = process.env.SERVICE_API_TOKEN;
  if (svc && req.get('x-api-token') === svc) return next();
  return requireAuth(req, res, next);
}
app.post('/api/prep', prepWriteGuard, (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body) ? body : (Array.isArray(body.entries) ? body.entries : [body]);
  const idx = _loadPrepIndex();
  const byKey = new Map((idx.entries || []).map((e) => [e.key || e.meetingId || e.title, e]));
  let n = 0;
  for (const it of items) {
    if (!it || !(it.title || it.meetingId)) continue;
    const key = it.key || it.meetingId || it.title;
    const entry = {
      key, meetingId: it.meetingId || '', title: it.title || '',
      date: it.date || '', startTime: it.startTime || it.start || '',
      driveUrl: it.driveUrl || '', driveId: it.driveId || '',
      localPath: it.localPath || '', attendees: it.attendees || [],
      company: it.company || '', angle: it.angle || '',
      updatedAt: new Date().toISOString(),
    };
    byKey.set(key, Object.assign(byKey.get(key) || {}, entry));
    n++;
  }
  let entries = Array.from(byKey.values());
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000; // prune >14 days old
  entries = entries.filter((e) => { const t = Date.parse(e.startTime || e.date); return isNaN(t) ? true : t > cutoff; });
  _savePrepIndex({ entries });
  res.json({ ok: true, upserted: n, total: entries.length });
});
app.get('/api/prep', requireAuth, (_req, res) => {
  res.json(_loadPrepIndex());
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
_kvInit();
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
    DGWss.handleUpgrade(req, socket, head, (client) => dgHandleClient(client, u));
  });
  console.log('Live transcription: WS proxy mounted at /ws/transcribe');
}

function dgHandleClient(client, u) {
  const WS = require('ws');
  const pcm = u && u.searchParams.get('pcm') === '1';
  const channels = Math.max(1, Math.min(2, parseInt((u && u.searchParams.get('channels')) || '1', 10) || 1));
  const sr = parseInt((u && u.searchParams.get('sr')) || '16000', 10) || 16000;
  const base = { model: 'nova-3', smart_format: 'true', diarize: 'true', interim_results: 'true', punctuate: 'true' };
  if (pcm) {
    base.encoding = 'linear16';
    base.sample_rate = String(sr);
    base.channels = String(channels);
    if (channels > 1) base.multichannel = 'true';
  }
  const params = new URLSearchParams(base);
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
