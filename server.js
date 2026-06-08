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
let errorCounts = {}; // hash -> { count, msg, context, firstSeen, lastSeen }
const CIRCUIT_BREAK_THRESHOLD = 2;

// Load existing errors on startup
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
    fs.writeFileSync(ERROR_LOG_PATH, JSON.stringify({ 
      log: errorLog.slice(-500),  // Keep last 500 entries
      counts: errorCounts,
      lastUpdated: new Date().toISOString()
    }, null, 2));
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
  if (req.session && req.session.authenticated) return next();
  if (process.env.GOOGLE_REFRESH_TOKEN) return next(); // env-based persistent auth
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
    services: {
      google: !!process.env.GOOGLE_REFRESH_TOKEN,
      zoho: !!process.env.ZOHO_REFRESH_TOKEN,
      vorroZoho: !!process.env.VORRO_ZOHO_REFRESH_TOKEN,
      granola: !!(process.env.GRANOLA_API_KEY || meetingsCache),
      claude: !!process.env.ANTHROPIC_API_KEY,
    },
  });
});

// Auth status
app.get('/auth/status', (req, res) => {
  res.json({
    authenticated: !!(req.session?.authenticated || process.env.GOOGLE_REFRESH_TOKEN),
    email: req.session?.email || process.env.ALLOWED_EMAIL || null,
    services: {
      google: !!process.env.GOOGLE_REFRESH_TOKEN,
      zoho: !!process.env.ZOHO_REFRESH_TOKEN,
      vorroZoho: !!process.env.VORRO_ZOHO_REFRESH_TOKEN,
      granola: !!(process.env.GRANOLA_API_KEY || meetingsCache),
      claude: !!process.env.ANTHROPIC_API_KEY,
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

    // If we got a refresh token, show it for the user to save
    if (tokens.refresh_token) {
      res.send(`
        <html>
        <head><title>Auth Success</title>
        <style>
          body { font-family: system-ui, sans-serif; max-width: 700px; margin: 40px auto; padding: 20px; background: #0f172a; color: #e2e8f0; }
          .token-box { background: #1e293b; padding: 16px; border-radius: 8px; word-break: break-all; font-family: monospace; font-size: 13px; margin: 16px 0; border: 1px solid #334155; }
          h1 { color: #38bdf8; }
          p { line-height: 1.6; }
          a { color: #38bdf8; }
          code { background: #1e293b; padding: 2px 6px; border-radius: 4px; }
        </style>
        </head>
        <body>
          <h1>Authenticated as ${email}</h1>
          <p>Save this refresh token as <code>GOOGLE_REFRESH_TOKEN</code> in your environment variables for persistent auth:</p>
          <div class="token-box">${tokens.refresh_token}</div>
          <p>Once saved, the server will auto-authenticate on startup without needing to sign in again.</p>
          <p><a href="/">Go to Dashboard</a></p>
        </body>
        </html>
      `);
    } else {
      res.redirect('/');
    }
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
  const { name, title, company, location, brand } = req.body || {};
  
  // BUG 4 fix: validate empty/garbage input
  if (!title || !company) {
    return res.json({ 
      name: name || '', title: title || '', company: company || '', location: location || '', brand: brand || '',
      tier: 'N/A', score: 0, 
      error: 'Title and company are required for ICP scoring',
      matches: [], rejects: [],
      recommendations: ['Please provide at least a job title and company name']
    });
  }
  if (!brand) return res.status(400).json({ error: 'brand is required' });

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
// Claude API proxy
// ---------------------------------------------------------------------------
app.post('/api/ask', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const { prompt, data, fast } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  // Build the user message: prompt + serialized data context
  let userContent = prompt;
  if (data && Array.isArray(data) && data.length > 0) {
    const contextParts = data.map((d) => {
      if (typeof d === 'string') return d;
      if (d && d.label && d.value) return `[${d.label}]: ${typeof d.value === 'string' ? d.value : JSON.stringify(d.value)}`;
      return JSON.stringify(d);
    });
    userContent += '\n\n--- DATA CONTEXT ---\n' + contextParts.join('\n\n');
  }

  // Always use Haiku for fastest response time
  const model = 'claude-haiku-4-5-20251001';
  const maxTokens = 512;

  const systemPrompt = 'You are a real-time sales meeting intelligence assistant for a CRO named Manish. He manages two companies: Cadient (AI-powered talent/HR platform with SmartSuite) and Vorro (healthcare integration platform with BridgeGate EiPaaS). Be direct, data-driven, and actionable. Never generic. Always reference specifics from the conversation. Keep responses concise and immediately usable in a live meeting context.';

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic API error: ${resp.status} ${text}`);
    }

    const result = await resp.json();
    const text = result.content?.[0]?.text || '';
    return res.json(text);
  } catch (err) {
    console.error('Claude API error:', err.message);
    return res.status(502).json({ error: err.message });
  }
});


// ---------------------------------------------------------------------------
// Error Telemetry Endpoints
// ---------------------------------------------------------------------------
app.post('/api/errors', (req, res) => {
  const { errors } = req.body || {};
  if (!Array.isArray(errors)) return res.status(400).json({ error: 'errors array required' });
  
  let circuitBreaks = [];
  
  for (const err of errors.slice(0, 50)) { // Max 50 per batch
    const hash = err.hash || 'unknown';
    const entry = {
      hash,
      msg: (err.msg || '').slice(0, 500),
      stack: (err.stack || '').slice(0, 1000),
      context: (err.context || '').slice(0, 100),
      count: err.count || 1,
      ts: err.ts || new Date().toISOString(),
      url: (err.url || '').slice(0, 200),
      circuitBreak: !!err.circuitBreak
    };
    
    errorLog.push(entry);
    
    // Update counts
    if (!errorCounts[hash]) {
      errorCounts[hash] = { 
        count: 0, 
        msg: entry.msg, 
        context: entry.context, 
        firstSeen: entry.ts,
        lastSeen: entry.ts,
        notified: false
      };
    }
    errorCounts[hash].count++;
    errorCounts[hash].lastSeen = entry.ts;
    
    // Circuit breaker check
    if (errorCounts[hash].count >= CIRCUIT_BREAK_THRESHOLD && !errorCounts[hash].notified) {
      errorCounts[hash].notified = true;
      circuitBreaks.push(errorCounts[hash]);
    }
  }
  
  // Trim log to 500 entries
  if (errorLog.length > 500) errorLog = errorLog.slice(-500);
  
  // Save to disk
  saveErrorLog();
  
  // If circuit breaks detected, create Gmail draft notification
  if (circuitBreaks.length > 0) {
    console.warn(`[ErrorBus] CIRCUIT BREAK: ${circuitBreaks.length} errors hit threshold`);
    // Attempt to create a Gmail draft notification
    (async () => {
      try {
        const auth = getAuthedClient();
        if (!auth) return;
        const gmail = google.gmail({ version: 'v1', auth });
        const subject = `[Second Brain] Circuit Breaker: ${circuitBreaks.length} error(s) fired`;
        const body = circuitBreaks.map(cb => 
          `Error: ${cb.msg}\nContext: ${cb.context}\nCount: ${cb.count}\nFirst: ${cb.firstSeen}\nLast: ${cb.lastSeen}`
        ).join('\n\n---\n\n');
        const raw = Buffer.from(
          `To: manish696@gmail.com\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
        ).toString('base64url');
        await gmail.users.drafts.create({
          userId: 'me',
          requestBody: { message: { raw } }
        });
        console.log('[ErrorBus] Circuit break notification draft created');
      } catch(e) {
        console.warn('[ErrorBus] Failed to create notification draft:', e.message);
      }
    })();
  }
  
  res.json({ 
    received: errors.length, 
    circuitBreaks: circuitBreaks.length,
    totalUnique: Object.keys(errorCounts).length 
  });
});

app.get('/api/errors', requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const recent = errorLog.slice(-limit).reverse();
  const stats = {
    total: errorLog.length,
    unique: Object.keys(errorCounts).length,
    circuitBreaks: Object.values(errorCounts).filter(c => c.count >= CIRCUIT_BREAK_THRESHOLD).length,
    topErrors: Object.entries(errorCounts)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([hash, data]) => ({ hash, ...data }))
  };
  res.json({ stats, recent });
});

app.get('/api/errors/circuit-breaks', requireAuth, (req, res) => {
  const breaks = Object.entries(errorCounts)
    .filter(([_, data]) => data.count >= CIRCUIT_BREAK_THRESHOLD)
    .map(([hash, data]) => ({ hash, ...data }));
  res.json({ 
    count: breaks.length, 
    threshold: CIRCUIT_BREAK_THRESHOLD,
    breaks 
  });
});

// ---------------------------------------------------------------------------
// SPA catch-all
// ---------------------------------------------------------------------------
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
app.listen(PORT, () => {
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
