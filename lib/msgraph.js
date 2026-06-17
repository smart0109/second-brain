// Microsoft Graph client for Outlook/Teams calendar + Teams meeting transcripts.
//
// Pure functions only: no DB, no session, no module-level state. Every function
// takes credentials/tokens as explicit arguments, so the caller (server.js) owns
// per-user token storage and refresh. Uses the built-in global `fetch` (Node 20+);
// no external npm packages.
//
// PERMISSION / TENANT LIMITATION (caller MUST know):
//   OnlineMeetingTranscript.Read.All typically requires ADMIN CONSENT and works
//   only on ORGANIZATIONAL (work/school) tenants. PERSONAL Microsoft accounts
//   (outlook.com/hotmail/live) CANNOT read Teams meeting transcripts at all, and
//   the /me/onlineMeetings + /transcripts endpoints are unavailable for them.
//   Calendar reading (Calendars.Read via /me/calendarView) works for ANY account,
//   personal or org. So degrade gracefully: calendar always; transcripts only on
//   org tenants with admin-consented transcript scope.

'use strict';

const LOGIN_BASE = 'https://login.microsoftonline.com';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Delegated scopes for reading calendar + Teams transcripts.
const MS_DATA_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'User.Read',
  'Calendars.Read',
  'OnlineMeetings.Read',
  'OnlineMeetingTranscript.Read.All',
];

// ---- helpers ---------------------------------------------------------------

function scopesToString(scopes) {
  if (Array.isArray(scopes)) return scopes.join(' ');
  if (typeof scopes === 'string' && scopes.length) return scopes;
  return MS_DATA_SCOPES.join(' ');
}

// Read a short body snippet for error messages without blowing up on huge bodies.
async function bodySnippet(resp) {
  let text = '';
  try {
    text = await resp.text();
  } catch (_e) {
    text = '<unreadable body>';
  }
  if (text.length > 500) text = text.slice(0, 500) + '...';
  return text;
}

async function graphGet(accessToken, url, extraHeaders = {}) {
  const resp = await fetch(url, {
    method: 'GET',
    headers: Object.assign(
      {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      extraHeaders
    ),
  });
  if (!resp.ok) {
    const snippet = await bodySnippet(resp);
    throw new Error(`Graph GET ${url} failed: HTTP ${resp.status} ${resp.statusText} - ${snippet}`);
  }
  return resp;
}

// ---- OAuth: authorize URL --------------------------------------------------

// Build the Entra (Azure AD) v2 authorize URL. tenant defaults to 'common'.
function authUrl({ clientId, tenant = 'common', redirectUri, state, scopes } = {}) {
  if (!clientId) throw new Error('authUrl: clientId is required');
  if (!redirectUri) throw new Error('authUrl: redirectUri is required');
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: scopesToString(scopes),
  });
  if (state != null) params.set('state', String(state));
  return `${LOGIN_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?${params.toString()}`;
}

// ---- OAuth: token endpoints ------------------------------------------------

async function postToken(tenant, form) {
  const url = `${LOGIN_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!resp.ok) {
    const snippet = await bodySnippet(resp);
    throw new Error(`Token endpoint failed: HTTP ${resp.status} ${resp.statusText} - ${snippet}`);
  }
  return resp.json();
}

// Exchange an authorization code for tokens. Returns raw token JSON.
async function exchangeCode({ clientId, clientSecret, tenant = 'common', code, redirectUri, scopes } = {}) {
  if (!clientId) throw new Error('exchangeCode: clientId is required');
  if (!code) throw new Error('exchangeCode: code is required');
  if (!redirectUri) throw new Error('exchangeCode: redirectUri is required');
  const form = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    scope: scopesToString(scopes),
  });
  if (clientSecret) form.set('client_secret', clientSecret);
  return postToken(tenant, form);
}

// Refresh an access token. Returns raw token JSON.
async function refreshAccessToken({ clientId, clientSecret, tenant = 'common', refreshToken, scopes } = {}) {
  if (!clientId) throw new Error('refreshAccessToken: clientId is required');
  if (!refreshToken) throw new Error('refreshAccessToken: refreshToken is required');
  const form = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: scopesToString(scopes),
  });
  if (clientSecret) form.set('client_secret', clientSecret);
  return postToken(tenant, form);
}

// ---- Calendar --------------------------------------------------------------

function isoOrNull(v) {
  return v == null ? null : String(v);
}

// Normalize one Graph calendarView event into our flat shape.
function normalizeEvent(ev) {
  const org = ev.organizer && ev.organizer.emailAddress ? ev.organizer.emailAddress : null;
  const organizer = org ? org.address || org.name || null : null;

  const attendees = Array.isArray(ev.attendees)
    ? ev.attendees
        .map((a) => {
          const e = a && a.emailAddress ? a.emailAddress : null;
          return e ? e.address || e.name || null : null;
        })
        .filter(Boolean)
    : [];

  return {
    id: ev.id || null,
    subject: ev.subject || null,
    start: ev.start ? isoOrNull(ev.start.dateTime) : null,
    end: ev.end ? isoOrNull(ev.end.dateTime) : null,
    organizer,
    attendees,
    location: ev.location ? ev.location.displayName || null : null,
    isOnlineMeeting: !!ev.isOnlineMeeting,
    joinUrl: ev.onlineMeeting && ev.onlineMeeting.joinUrl ? ev.onlineMeeting.joinUrl : null,
    // onlineMeetingId is NOT present on the calendar event; resolve later via
    // getOnlineMeetingByJoinUrl(joinUrl) if a transcript lookup is needed.
    onlineMeetingId: null,
    raw: ev,
  };
}

// List calendar events in a time window. Defaults to now .. now+7 days.
async function listCalendarEvents(accessToken, { start, end, top } = {}) {
  if (!accessToken) throw new Error('listCalendarEvents: accessToken is required');
  const now = new Date();
  const startIso = start || now.toISOString();
  const endIso = end || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const params = new URLSearchParams({
    startDateTime: startIso,
    endDateTime: endIso,
    $top: String(top || 50),
    $orderby: 'start/dateTime',
  });
  const url = `${GRAPH_BASE}/me/calendarView?${params.toString()}`;

  const resp = await graphGet(accessToken, url, { Prefer: 'outlook.timezone="UTC"' });
  const json = await resp.json();
  const value = Array.isArray(json.value) ? json.value : [];
  return value.map(normalizeEvent);
}

// ---- Online meetings + transcripts -----------------------------------------

// Resolve an online meeting from its join URL. Returns the first match or null.
async function getOnlineMeetingByJoinUrl(accessToken, joinUrl) {
  if (!accessToken) throw new Error('getOnlineMeetingByJoinUrl: accessToken is required');
  if (!joinUrl) throw new Error('getOnlineMeetingByJoinUrl: joinUrl is required');
  // $filter on JoinWebUrl. The URL value must be single-quoted per OData.
  const filter = `JoinWebUrl eq '${joinUrl}'`;
  const params = new URLSearchParams({ $filter: filter });
  const url = `${GRAPH_BASE}/me/onlineMeetings?${params.toString()}`;
  const resp = await graphGet(accessToken, url);
  const json = await resp.json();
  const value = Array.isArray(json.value) ? json.value : [];
  return value.length ? value[0] : null;
}

// List transcripts for an online meeting.
async function listMeetingTranscripts(accessToken, onlineMeetingId) {
  if (!accessToken) throw new Error('listMeetingTranscripts: accessToken is required');
  if (!onlineMeetingId) throw new Error('listMeetingTranscripts: onlineMeetingId is required');
  const url = `${GRAPH_BASE}/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/transcripts`;
  const resp = await graphGet(accessToken, url);
  const json = await resp.json();
  const value = Array.isArray(json.value) ? json.value : [];
  return value.map((t) => ({
    id: t.id || null,
    createdDateTime: t.createdDateTime || null,
    transcriptContentUrl: t.transcriptContentUrl || null,
    raw: t,
  }));
}

// Fetch the raw transcript content (default text/vtt). Returns the text body.
async function getTranscriptContent(accessToken, onlineMeetingId, transcriptId, format) {
  if (!accessToken) throw new Error('getTranscriptContent: accessToken is required');
  if (!onlineMeetingId) throw new Error('getTranscriptContent: onlineMeetingId is required');
  if (!transcriptId) throw new Error('getTranscriptContent: transcriptId is required');
  const params = new URLSearchParams({ $format: format || 'text/vtt' });
  const url =
    `${GRAPH_BASE}/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}` +
    `/transcripts/${encodeURIComponent(transcriptId)}/content?${params.toString()}`;
  const resp = await graphGet(accessToken, url);
  return resp.text();
}

module.exports = {
  MS_DATA_SCOPES,
  authUrl,
  exchangeCode,
  refreshAccessToken,
  listCalendarEvents,
  getOnlineMeetingByJoinUrl,
  listMeetingTranscripts,
  getTranscriptContent,
};
