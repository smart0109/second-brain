// CRO Second Brain - Express Backend Server
// Proxies Gmail, Calendar, Drive (Google), Zoho CRM, Granola, and Claude APIs

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { google } = require('googleapis');

const app = express();

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
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
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
// Zoho token cache
// ---------------------------------------------------------------------------
let zohoTokenCache = { accessToken: null, expiresAt: 0 };

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
async function handleGranola(toolName, args) {
  const apiKey = process.env.GRANOLA_API_KEY;
  if (!apiKey) {
    return { answer: 'Granola not configured. Set GRANOLA_API_KEY to enable meeting features.' };
  }
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const BASE = 'https://api.granola.ai/v1';

  try {
    if (toolName === 'query_granola_meetings') {
      const resp = await fetch(`${BASE}/meetings/search`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: args?.query || '' }),
      });
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

    if (toolName === 'list_meeting_folders') {
      const resp = await fetch(`${BASE}/meetings/folders`, { headers });
      if (!resp.ok) throw new Error(`Granola folders: ${resp.status}`);
      return await resp.json();
    }

    if (toolName === 'get_meetings') {
      const resp = await fetch(`${BASE}/meetings`, { headers });
      if (!resp.ok) throw new Error(`Granola get_meetings: ${resp.status}`);
      return await resp.json();
    }

    throw new Error(`Unknown Granola tool: ${toolName}`);
  } catch (err) {
    console.error('Granola error:', err.message);
    return { error: err.message, answer: `Granola API error: ${err.message}` };
  }
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
      granola: !!process.env.GRANOLA_API_KEY,
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
      granola: !!process.env.GRANOLA_API_KEY,
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
// Claude API proxy
// ---------------------------------------------------------------------------
app.post('/api/ask', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const { prompt, data } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  // Build the user message: prompt + serialized data context
  let userContent = prompt;
  if (data && Array.isArray(data) && data.length > 0) {
    const contextParts = data.map((d) => (typeof d === 'string' ? d : JSON.stringify(d)));
    userContent += '\n\n--- DATA CONTEXT ---\n' + contextParts.join('\n\n');
  }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
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
  if (process.env.ZOHO_REFRESH_TOKEN) console.log('Zoho: configured');
  if (process.env.GRANOLA_API_KEY) console.log('Granola: configured');
  if (process.env.ANTHROPIC_API_KEY) console.log('Claude: configured');
});
