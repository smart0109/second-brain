// Standalone test for lib/msgraph.js (no framework).
// Mocks global.fetch, records the last request, returns canned responses,
// and asserts request URLs/headers/bodies + response parsing.
// Exits non-zero on failure; prints "N checks passed" on success.

'use strict';

const assert = require('assert');
const mg = require('../lib/msgraph');

let checks = 0;
function check(cond, msg) {
  assert.ok(cond, msg);
  checks += 1;
}

// ---- fetch stub ------------------------------------------------------------
const realFetch = global.fetch;
let lastReq = null; // { url, method, headers, body }
let nextResponse = null; // { ok, status, statusText, json, text }

function makeResp(spec) {
  const s = spec || {};
  return {
    ok: s.ok !== undefined ? s.ok : true,
    status: s.status || 200,
    statusText: s.statusText || 'OK',
    async json() {
      return s.json !== undefined ? s.json : {};
    },
    async text() {
      return s.text !== undefined ? s.text : '';
    },
  };
}

global.fetch = async function (url, opts = {}) {
  lastReq = {
    url: String(url),
    method: opts.method || 'GET',
    headers: opts.headers || {},
    body: opts.body,
  };
  return makeResp(nextResponse);
};

async function run() {
  // ---- 1. authUrl: tenant + scopes + state + fixed params ------------------
  const url = mg.authUrl({
    clientId: 'CLIENT123',
    tenant: 'myorg.onmicrosoft.com',
    redirectUri: 'https://app.example.com/cb',
    state: 'st-abc',
    // scopes omitted -> defaults to MS_DATA_SCOPES
  });
  check(url.includes('login.microsoftonline.com/myorg.onmicrosoft.com/oauth2/v2.0/authorize'),
    'authUrl includes tenant in path');
  check(url.includes('client_id=CLIENT123'), 'authUrl includes client_id');
  check(url.includes('state=st-abc'), 'authUrl includes state');
  check(url.includes('response_type=code'), 'authUrl response_type=code');
  check(url.includes('response_mode=query'), 'authUrl response_mode=query');
  check(decodeURIComponent(url).includes('Calendars.Read'), 'authUrl includes Calendars.Read scope');
  check(decodeURIComponent(url).includes('OnlineMeetingTranscript.Read.All'),
    'authUrl includes transcript scope');

  // authUrl tenant default
  const urlDefault = mg.authUrl({ clientId: 'C', redirectUri: 'https://x/cb' });
  check(urlDefault.includes('/common/oauth2/v2.0/authorize'), 'authUrl defaults tenant to common');

  // MS_DATA_SCOPES exact contents
  check(
    JSON.stringify(mg.MS_DATA_SCOPES) ===
      JSON.stringify([
        'openid', 'profile', 'email', 'offline_access',
        'User.Read', 'Calendars.Read', 'OnlineMeetings.Read',
        'OnlineMeetingTranscript.Read.All',
      ]),
    'MS_DATA_SCOPES has expected contents'
  );

  // ---- 2. refreshAccessToken: posts grant_type=refresh_token ---------------
  nextResponse = { json: { access_token: 'AT-new', refresh_token: 'RT-new', expires_in: 3600 } };
  const tok = await mg.refreshAccessToken({
    clientId: 'C',
    clientSecret: 'SECRET',
    tenant: 'common',
    refreshToken: 'RT-old',
  });
  check(lastReq.url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    'refresh hits token endpoint');
  check(lastReq.method === 'POST', 'refresh uses POST');
  check((lastReq.headers['Content-Type'] || '').includes('x-www-form-urlencoded'),
    'refresh sends form content-type');
  check(lastReq.body.includes('grant_type=refresh_token'), 'refresh grant_type=refresh_token');
  check(lastReq.body.includes('refresh_token=RT-old'), 'refresh sends refresh_token');
  check(lastReq.body.includes('client_secret=SECRET'), 'refresh sends client_secret');
  check(tok.access_token === 'AT-new' && tok.refresh_token === 'RT-new',
    'refresh returns raw token JSON');

  // exchangeCode: grant_type=authorization_code
  nextResponse = { json: { access_token: 'AT', refresh_token: 'RT' } };
  await mg.exchangeCode({
    clientId: 'C', clientSecret: 'S', code: 'CODE1', redirectUri: 'https://x/cb',
  });
  check(lastReq.body.includes('grant_type=authorization_code'), 'exchangeCode grant_type');
  check(lastReq.body.includes('code=CODE1'), 'exchangeCode sends code');

  // token endpoint error path
  nextResponse = { ok: false, status: 400, statusText: 'Bad Request', text: 'invalid_grant' };
  let threw = false;
  try {
    await mg.refreshAccessToken({ clientId: 'C', refreshToken: 'RT' });
  } catch (e) {
    threw = /HTTP 400/.test(e.message) && /invalid_grant/.test(e.message);
  }
  check(threw, 'refresh throws with status + body on non-OK');

  // ---- 3. listCalendarEvents: endpoint, Prefer header, normalization -------
  const sampleEvent = {
    id: 'EVT-1',
    subject: 'Q3 Sync',
    start: { dateTime: '2026-06-18T15:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-06-18T15:30:00.0000000', timeZone: 'UTC' },
    organizer: { emailAddress: { name: 'Alice', address: 'alice@org.com' } },
    attendees: [
      { emailAddress: { name: 'Bob', address: 'bob@org.com' } },
      { emailAddress: { name: 'Carol Only' } },
    ],
    location: { displayName: 'Microsoft Teams Meeting' },
    isOnlineMeeting: true,
    onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/XYZ' },
  };
  nextResponse = { json: { value: [sampleEvent] } };
  const events = await mg.listCalendarEvents('TOKEN-cal', {
    start: '2026-06-18T00:00:00Z',
    end: '2026-06-19T00:00:00Z',
    top: 10,
  });
  check(lastReq.url.includes('https://graph.microsoft.com/v1.0/me/calendarView'),
    'listCalendarEvents hits /me/calendarView');
  check(lastReq.url.includes('startDateTime=2026-06-18T00%3A00%3A00Z'),
    'listCalendarEvents passes startDateTime');
  check(lastReq.url.includes('endDateTime='), 'listCalendarEvents passes endDateTime');
  check(lastReq.url.includes('%24top=10'), 'listCalendarEvents passes $top');
  check(decodeURIComponent(lastReq.url).includes('$orderby=start/dateTime'),
    'listCalendarEvents passes $orderby');
  check(lastReq.headers.Prefer === 'outlook.timezone="UTC"',
    'listCalendarEvents sends Prefer header');
  check(lastReq.headers.Authorization === 'Bearer TOKEN-cal',
    'listCalendarEvents sends bearer token');

  const ev = events[0];
  check(ev.id === 'EVT-1' && ev.subject === 'Q3 Sync', 'event id + subject normalized');
  check(ev.start === '2026-06-18T15:00:00.0000000', 'event start ISO normalized');
  check(ev.organizer === 'alice@org.com', 'organizer normalized to email');
  check(ev.attendees.length === 2 && ev.attendees[0] === 'bob@org.com' && ev.attendees[1] === 'Carol Only',
    'attendees normalized (email or name fallback)');
  check(ev.location === 'Microsoft Teams Meeting', 'location normalized');
  check(ev.isOnlineMeeting === true, 'isOnlineMeeting normalized');
  check(ev.joinUrl === 'https://teams.microsoft.com/l/meetup-join/XYZ', 'joinUrl normalized');
  check(ev.onlineMeetingId === null, 'onlineMeetingId left null on event');
  check(ev.raw === sampleEvent, 'raw event preserved');

  // default window when start/end omitted
  nextResponse = { json: { value: [] } };
  await mg.listCalendarEvents('T');
  check(lastReq.url.includes('startDateTime=') && lastReq.url.includes('endDateTime='),
    'listCalendarEvents defaults window');

  // ---- 4. getOnlineMeetingByJoinUrl ----------------------------------------
  nextResponse = { json: { value: [{ id: 'OM-1', joinWebUrl: 'https://teams/...' }] } };
  const om = await mg.getOnlineMeetingByJoinUrl('T2', 'https://teams.microsoft.com/l/meetup-join/XYZ');
  check(lastReq.url.includes('/me/onlineMeetings'), 'getOnlineMeeting hits /me/onlineMeetings');
  check(decodeURIComponent(lastReq.url).replace(/\+/g, ' ').includes("JoinWebUrl eq 'https://teams.microsoft.com/l/meetup-join/XYZ'"),
    'getOnlineMeeting filters on JoinWebUrl');
  check(om && om.id === 'OM-1', 'getOnlineMeeting returns first match');

  nextResponse = { json: { value: [] } };
  const omNone = await mg.getOnlineMeetingByJoinUrl('T2', 'https://none');
  check(omNone === null, 'getOnlineMeeting returns null on no match');

  // ---- 5. listMeetingTranscripts -------------------------------------------
  nextResponse = {
    json: {
      value: [
        {
          id: 'TR-1',
          createdDateTime: '2026-06-18T16:00:00Z',
          transcriptContentUrl: 'https://graph.microsoft.com/v1.0/.../transcripts/TR-1/content',
        },
      ],
    },
  };
  const trs = await mg.listMeetingTranscripts('T3', 'OM-1');
  check(lastReq.url.includes('/me/onlineMeetings/OM-1/transcripts'),
    'listMeetingTranscripts hits transcripts endpoint');
  check(lastReq.headers.Authorization === 'Bearer T3', 'transcripts list sends bearer');
  check(trs.length === 1 && trs[0].id === 'TR-1', 'transcript list parsed');
  check(trs[0].createdDateTime === '2026-06-18T16:00:00Z', 'transcript createdDateTime parsed');
  check(trs[0].transcriptContentUrl.includes('/content'), 'transcriptContentUrl parsed');

  // ---- 6. getTranscriptContent: returns text -------------------------------
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nAlice: Hello everyone.\n';
  nextResponse = { text: vtt };
  const content = await mg.getTranscriptContent('T4', 'OM-1', 'TR-1');
  check(lastReq.url.includes('/me/onlineMeetings/OM-1/transcripts/TR-1/content'),
    'getTranscriptContent hits content endpoint');
  check(decodeURIComponent(lastReq.url).includes('$format=text/vtt'),
    'getTranscriptContent defaults $format=text/vtt');
  check(content === vtt, 'getTranscriptContent returns raw text body');

  // custom format
  nextResponse = { text: 'plain' };
  await mg.getTranscriptContent('T4', 'OM-1', 'TR-1', 'text/plain');
  check(decodeURIComponent(lastReq.url).includes('$format=text/plain'),
    'getTranscriptContent honors custom format');

  // graph error path
  nextResponse = { ok: false, status: 403, statusText: 'Forbidden', text: 'admin consent required' };
  let gThrew = false;
  try {
    await mg.listMeetingTranscripts('T', 'OM');
  } catch (e) {
    gThrew = /HTTP 403/.test(e.message) && /admin consent/.test(e.message);
  }
  check(gThrew, 'graph GET throws with status + body on non-OK');
}

run()
  .then(() => {
    global.fetch = realFetch;
    console.log(`${checks} checks passed`);
  })
  .catch((err) => {
    global.fetch = realFetch;
    console.error('TEST FAILED:', err && err.message ? err.message : err);
    process.exit(1);
  });
