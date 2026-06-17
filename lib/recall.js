// Recall.ai meeting-bot transcription provider (single API key).
// A bot joins a Teams/Zoom/Meet meeting URL and produces a transcript.
// Auth: header `Authorization: Token <RECALL_API_KEY>`. Region-scoped base URL.
// This module is pure (no DB/session); callers pass { apiKey, region }.
//
// Works for Microsoft Teams, Zoom, and Google Meet via the same API — unlike the
// Microsoft Graph path (org-tenant + admin consent), Recall.ai needs only one API
// key, so it's the "add credentials later" lane. Region examples: us-east-1
// (default), us-west-2, eu-central-1, ap-northeast-1.

function baseUrl(region) {
  return `https://${region || 'us-east-1'}.recall.ai/api/v1`;
}
function headers(apiKey) {
  return { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' };
}
function requireKey(cfg) {
  if (!cfg || !cfg.apiKey) throw new Error('Recall.ai not configured: missing API key.');
}
async function _json(resp, what) {
  if (!resp.ok) {
    let body = '';
    try { body = (await resp.text()).slice(0, 500); } catch (_) {}
    throw new Error(`Recall.ai ${what} failed: HTTP ${resp.status} ${resp.statusText} - ${body}`);
  }
  return resp.status === 204 ? null : resp.json();
}

// Schedule/launch a bot to join a meeting and transcribe it.
// opts: { meetingUrl, botName, webhookUrl, joinAt (ISO), body (full override) }
async function createBot(cfg, opts = {}) {
  requireKey(cfg);
  if (!opts.body && !opts.meetingUrl) throw new Error('meetingUrl is required to create a bot.');
  const body = opts.body || {
    meeting_url: opts.meetingUrl,
    bot_name: opts.botName || 'Second Brain Notetaker',
    // Default: transcribe from the platform's own live captions (no extra cost,
    // works for Teams/Zoom/Meet). Override via opts.body for other providers.
    recording_config: { transcript: { provider: { meeting_captions: {} } } },
    ...(opts.joinAt ? { join_at: opts.joinAt } : {}),
    ...(opts.webhookUrl ? { webhooks: [{ url: opts.webhookUrl, events: ['transcript.data', 'bot.status_change'] }] } : {}),
  };
  const resp = await fetch(`${baseUrl(cfg.region)}/bot/`, { method: 'POST', headers: headers(cfg.apiKey), body: JSON.stringify(body) });
  return _json(resp, 'createBot');
}

async function getBot(cfg, botId) {
  requireKey(cfg);
  if (!botId) throw new Error('botId required');
  const resp = await fetch(`${baseUrl(cfg.region)}/bot/${botId}/`, { headers: headers(cfg.apiKey) });
  return _json(resp, 'getBot');
}

async function listBots(cfg, { limit } = {}) {
  requireKey(cfg);
  const u = new URL(`${baseUrl(cfg.region)}/bot/`);
  if (limit) u.searchParams.set('limit', String(limit));
  const resp = await fetch(u.toString(), { headers: headers(cfg.apiKey) });
  return _json(resp, 'listBots');
}

// Fetch + normalize a bot's transcript to { text, segments:[{speaker,start,end,text}], raw }.
async function getTranscript(cfg, botId) {
  requireKey(cfg);
  if (!botId) throw new Error('botId required');
  const resp = await fetch(`${baseUrl(cfg.region)}/bot/${botId}/transcript/`, { headers: headers(cfg.apiKey) });
  const raw = await _json(resp, 'getTranscript');
  return normalizeTranscript(raw);
}

// Recall transcript shapes vary by version; normalize defensively. Common shape is
// an array of segments: { speaker | participant.name, words:[{text,start_timestamp|start_time,end_timestamp|end_time}] }.
function normalizeTranscript(raw) {
  const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.transcript) ? raw.transcript : []);
  const segments = arr.map((seg) => {
    const words = seg.words || seg.text || [];
    const speaker = seg.speaker || (seg.participant && (seg.participant.name || seg.participant.id)) || (seg.speaker_id != null ? `Speaker ${seg.speaker_id}` : 'Unknown');
    let text, start, end;
    if (Array.isArray(words)) {
      text = words.map((w) => (typeof w === 'string' ? w : w.text)).join(' ').trim();
      const first = words[0] || {}, last = words[words.length - 1] || {};
      start = first.start_timestamp ?? first.start_time ?? first.start ?? null;
      end = last.end_timestamp ?? last.end_time ?? last.end ?? null;
    } else {
      text = String(words || '').trim();
      start = seg.start_timestamp ?? seg.start_time ?? null;
      end = seg.end_timestamp ?? seg.end_time ?? null;
    }
    return { speaker, start, end, text };
  }).filter((s) => s.text);
  const text = segments.map((s) => `${s.speaker}: ${s.text}`).join('\n');
  return { text, segments, raw };
}

module.exports = { baseUrl, createBot, getBot, listBots, getTranscript, normalizeTranscript };
