// HubSpot CRM adapter for reading/updating a user's deal pipeline.
//
// Pure functions only: no DB, no session, no module-level state. Every function
// takes tokens/credentials as explicit arguments, so the caller (server.js) owns
// per-user token storage and refresh. Uses the built-in global `fetch` (Node 20+);
// no external npm packages.
//
// CANONICAL SHAPE (a sibling Zoho adapter emits the same shape):
//   Canonical deal:
//     { id (string), name, amount (number|null), stageId, stageName,
//       pipelineId, closeDate (ISO string|null), probability (number|null),
//       accountName, ownerId, raw }
//   Canonical pipeline:
//     { id, name, stages: [ { id, name, order (number),
//       probability (number|null), isClosed (bool), isWon (bool) } ] }
//
// CALLER CAVEATS:
//   - stageName and isWon are NOT populated on deals from listDeals/getDeal
//     (the deals API returns only the stage *id*). Use resolveStageNames(deals,
//     pipelines) to enrich them by cross-referencing listPipelines().
//   - ownerId is the HubSpot internal owner id (a number-as-string), NOT a name
//     or email. Resolve to a person via the owners API if a display name is
//     needed (scope crm.objects.owners.read is requested for this).
//   - createNote uses associationTypeId 214 = Note-to-Deal (HUBSPOT_DEFINED).
//     Other object types use different type ids.

'use strict';

const HUBSPOT_API = 'https://api.hubapi.com';
const HUBSPOT_AUTH = 'https://app.hubspot.com/oauth/authorize';
const TOKEN_URL = `${HUBSPOT_API}/oauth/v1/token`;

// Default deal properties pulled on every read so normalization is consistent.
const DEAL_PROPERTIES = [
  'dealname',
  'amount',
  'dealstage',
  'pipeline',
  'closedate',
  'hs_deal_stage_probability',
  'hubspot_owner_id',
];

const HUBSPOT_SCOPES = [
  'oauth',
  'crm.objects.deals.read',
  'crm.objects.deals.write',
  'crm.schemas.deals.read',
  'crm.objects.contacts.read',
  'crm.objects.owners.read',
];

// ---- helpers ---------------------------------------------------------------

function scopesToString(scopes) {
  if (Array.isArray(scopes) && scopes.length) return scopes.join(' ');
  if (typeof scopes === 'string' && scopes.length) return scopes;
  return HUBSPOT_SCOPES.join(' ');
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

// Coerce a string/number to Number, returning null for empty/invalid values.
function toNumberOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function strOrNull(v) {
  return v == null || v === '' ? null : String(v);
}

async function crmFetch(accessToken, method, url, body) {
  if (!accessToken) throw new Error(`crmFetch: accessToken is required (${method} ${url})`);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  };
  const opts = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const snippet = await bodySnippet(resp);
    throw new Error(`HubSpot ${method} ${url} failed: HTTP ${resp.status} ${resp.statusText} - ${snippet}`);
  }
  return resp.json();
}

// ---- OAuth: authorize URL --------------------------------------------------

function authUrl({ clientId, redirectUri, scopes, state } = {}) {
  if (!clientId) throw new Error('authUrl: clientId is required');
  if (!redirectUri) throw new Error('authUrl: redirectUri is required');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopesToString(scopes),
  });
  if (state != null) params.set('state', String(state));
  return `${HUBSPOT_AUTH}?${params.toString()}`;
}

// ---- OAuth: token endpoints ------------------------------------------------

async function postToken(form) {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!resp.ok) {
    const snippet = await bodySnippet(resp);
    throw new Error(`HubSpot token endpoint failed: HTTP ${resp.status} ${resp.statusText} - ${snippet}`);
  }
  return resp.json();
}

// Exchange an authorization code for tokens. Returns raw token JSON
// ({ access_token, refresh_token, expires_in, ... }).
async function exchangeCode({ clientId, clientSecret, code, redirectUri } = {}) {
  if (!clientId) throw new Error('exchangeCode: clientId is required');
  if (!clientSecret) throw new Error('exchangeCode: clientSecret is required');
  if (!code) throw new Error('exchangeCode: code is required');
  if (!redirectUri) throw new Error('exchangeCode: redirectUri is required');
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  });
  return postToken(form);
}

// Refresh an access token. Returns raw token JSON.
async function refreshAccessToken({ clientId, clientSecret, refreshToken } = {}) {
  if (!clientId) throw new Error('refreshAccessToken: clientId is required');
  if (!clientSecret) throw new Error('refreshAccessToken: clientSecret is required');
  if (!refreshToken) throw new Error('refreshAccessToken: refreshToken is required');
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  return postToken(form);
}

// ---- normalization ---------------------------------------------------------

function normalizeStage(stage) {
  const meta = stage && stage.metadata ? stage.metadata : {};
  const probability = toNumberOrNull(meta.probability);
  // metadata.isClosed arrives as the string "true"/"false" or a boolean.
  const isClosed = meta.isClosed === true || meta.isClosed === 'true';
  const label = stage.label || '';
  const isWon = probability === 1 || (isClosed && /won/i.test(label));
  return {
    id: strOrNull(stage.id),
    name: label,
    order: toNumberOrNull(stage.displayOrder) || 0,
    probability,
    isClosed,
    isWon,
  };
}

function normalizePipeline(p) {
  const stages = Array.isArray(p.stages) ? p.stages.map(normalizeStage) : [];
  // HubSpot returns stages already ordered, but sort by `order` to be safe.
  stages.sort((a, b) => a.order - b.order);
  return {
    id: strOrNull(p.id),
    name: p.label || '',
    stages,
  };
}

function normalizeDeal(d) {
  const props = (d && d.properties) || {};
  return {
    id: strOrNull(d.id),
    name: props.dealname || '',
    amount: toNumberOrNull(props.amount),
    stageId: strOrNull(props.dealstage),
    stageName: '',
    pipelineId: strOrNull(props.pipeline),
    closeDate: strOrNull(props.closedate),
    probability: toNumberOrNull(props.hs_deal_stage_probability),
    accountName: '',
    ownerId: strOrNull(props.hubspot_owner_id),
    raw: d,
  };
}

// ---- pipelines -------------------------------------------------------------

async function listPipelines(accessToken) {
  const url = `${HUBSPOT_API}/crm/v3/pipelines/deals`;
  const json = await crmFetch(accessToken, 'GET', url);
  const results = Array.isArray(json.results) ? json.results : [];
  return results.map(normalizePipeline);
}

// ---- deals -----------------------------------------------------------------

function dealPropertiesParam() {
  return DEAL_PROPERTIES.join(',');
}

async function listDeals(accessToken, { limit, after, pipelineId } = {}) {
  const params = new URLSearchParams({
    limit: String(limit || 100),
    properties: dealPropertiesParam(),
    archived: 'false',
  });
  if (after != null) params.set('after', String(after));
  const url = `${HUBSPOT_API}/crm/v3/objects/deals?${params.toString()}`;
  const json = await crmFetch(accessToken, 'GET', url);
  const results = Array.isArray(json.results) ? json.results : [];
  let deals = results.map(normalizeDeal);
  // HubSpot's list endpoint has no server-side pipeline filter without the
  // search API, so filter client-side when a pipelineId is supplied.
  if (pipelineId != null) {
    deals = deals.filter((d) => d.pipelineId === String(pipelineId));
  }
  const nextAfter =
    json.paging && json.paging.next && json.paging.next.after != null
      ? String(json.paging.next.after)
      : null;
  return { deals, after: nextAfter };
}

async function getDeal(accessToken, dealId) {
  if (!dealId) throw new Error('getDeal: dealId is required');
  const params = new URLSearchParams({ properties: dealPropertiesParam(), archived: 'false' });
  const url = `${HUBSPOT_API}/crm/v3/objects/deals/${encodeURIComponent(dealId)}?${params.toString()}`;
  const json = await crmFetch(accessToken, 'GET', url);
  return normalizeDeal(json);
}

async function updateDeal(accessToken, dealId, properties) {
  if (!dealId) throw new Error('updateDeal: dealId is required');
  if (!properties || typeof properties !== 'object') {
    throw new Error('updateDeal: properties object is required');
  }
  const url = `${HUBSPOT_API}/crm/v3/objects/deals/${encodeURIComponent(dealId)}`;
  const json = await crmFetch(accessToken, 'PATCH', url, { properties });
  return normalizeDeal(json);
}

async function updateDealStage(accessToken, dealId, stageId) {
  if (!stageId) throw new Error('updateDealStage: stageId is required');
  return updateDeal(accessToken, dealId, { dealstage: stageId });
}

// ---- notes -----------------------------------------------------------------

async function createNote(accessToken, dealId, body) {
  if (!dealId) throw new Error('createNote: dealId is required');
  if (body == null) throw new Error('createNote: body is required');
  const url = `${HUBSPOT_API}/crm/v3/objects/notes`;
  const payload = {
    properties: {
      hs_note_body: body,
      hs_timestamp: Date.now(),
    },
    associations: [
      {
        to: { id: String(dealId) },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: 214, // Note -> Deal
          },
        ],
      },
    ],
  };
  return crmFetch(accessToken, 'POST', url, payload);
}

// ---- enrichment (pure) -----------------------------------------------------

// Cross-reference deals against pipelines to fill in stageName/isWon (and
// re-derive probability from the pipeline when the deal didn't carry one).
// Returns a NEW array of deals; does not mutate the inputs.
function resolveStageNames(deals, pipelines) {
  const dealsArr = Array.isArray(deals) ? deals : [];
  const pipesArr = Array.isArray(pipelines) ? pipelines : [];

  // Build stageId -> stage lookup across all pipelines.
  const stageById = new Map();
  for (const p of pipesArr) {
    for (const s of p.stages || []) {
      if (s.id != null) stageById.set(String(s.id), s);
    }
  }

  return dealsArr.map((d) => {
    const stage = d.stageId != null ? stageById.get(String(d.stageId)) : null;
    if (!stage) return Object.assign({}, d);
    return Object.assign({}, d, {
      stageName: stage.name || d.stageName || '',
      isWon: !!stage.isWon,
      probability: d.probability != null ? d.probability : stage.probability,
    });
  });
}

module.exports = {
  HUBSPOT_SCOPES,
  authUrl,
  exchangeCode,
  refreshAccessToken,
  listPipelines,
  listDeals,
  getDeal,
  updateDeal,
  updateDealStage,
  createNote,
  resolveStageNames,
  // exported for tests / advanced callers
  normalizeDeal,
  normalizePipeline,
};
