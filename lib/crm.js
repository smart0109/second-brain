// CRM-agnostic layer. A "connection" is { provider, accessToken, apiDomain?, region? }.
//   provider: 'hubspot' | 'zoho' | 'zoho_vorro'
// Exposes one interface (pipelines / board / move / update / note) over either CRM,
// emitting the canonical deal + pipeline shapes (same as lib/crm_hubspot.js).
const hubspot = require('./crm_hubspot');

// Allowlist of deal fields the chat-to-change / updateDeal path may set.
// Keys are accepted in either CRM's naming; unknown keys are dropped.
const ALLOWED_DEAL_FIELDS = new Set([
  // Zoho
  'Deal_Name','Amount','Stage','Closing_Date','Probability','Pipeline','Description','Next_Step',
  // HubSpot
  'dealname','amount','dealstage','closedate','pipeline','hs_deal_stage_probability','description',
]);
function sanitizeDealFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) if (ALLOWED_DEAL_FIELDS.has(k)) out[k] = v;
  return out;
}

// --------------------------------------------------------------------------
// Zoho adapter (inline). Zoho uses the STAGE NAME as the stage identifier, so
// canonical stageId === stageName for Zoho.
// --------------------------------------------------------------------------
const zoho = {
  _headers(conn) {
    return { Authorization: `Zoho-oauthtoken ${conn.accessToken}`, 'Content-Type': 'application/json' };
  },
  async _get(conn, path) {
    const resp = await fetch(`${conn.apiDomain}${path}`, { headers: this._headers(conn) });
    if (!resp.ok) throw new Error(`Zoho GET ${path} failed: HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`);
    return resp.status === 204 ? {} : resp.json();
  },
  async _coql(conn, query) {
    const resp = await fetch(`${conn.apiDomain}/crm/v5/coql`, {
      method: 'POST', headers: this._headers(conn), body: JSON.stringify({ select_query: query }),
    });
    if (resp.status === 204) return { data: [] };
    if (!resp.ok) throw new Error(`Zoho COQL failed: HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`);
    return resp.json();
  },
  normalizeDeal(d) {
    return {
      id: String(d.id),
      name: d.Deal_Name || d.Deal_Name_value || '',
      amount: d.Amount != null ? Number(d.Amount) : null,
      stageId: d.Stage || '',
      stageName: d.Stage || '',
      pipelineId: d.Pipeline || null,
      closeDate: d.Closing_Date || null,
      probability: d.Probability != null ? Number(d.Probability) : null,
      accountName: (d.Account_Name && (d.Account_Name.name || d.Account_Name)) || '',
      ownerId: (d.Owner && (d.Owner.id || d.Owner)) || null,
      raw: d,
    };
  },
  async listPipelines(conn) {
    // Stage picklist from Deals field metadata; one synthetic pipeline.
    const data = await this._get(conn, '/crm/v2/settings/fields?module=Deals');
    const fields = data.fields || [];
    const stageField = fields.find((f) => f.api_name === 'Stage') || {};
    const pls = stageField.pick_list_values || [];
    const stages = pls
      .map((p, i) => ({
        id: p.actual_value || p.display_value,
        name: p.display_value || p.actual_value,
        order: p.sequence_number != null ? Number(p.sequence_number) : i,
        probability: p.probability != null ? Number(p.probability) : null,
        isClosed: /closed/i.test(p.display_value || ''),
        isWon: /won/i.test(p.display_value || ''),
      }))
      .sort((a, b) => a.order - b.order);
    return [{ id: 'default', name: 'Deals', stages }];
  },
  async listDeals(conn, { limit } = {}) {
    const q = `select id,Deal_Name,Amount,Stage,Pipeline,Closing_Date,Probability,Account_Name,Owner from Deals where id is not null order by Amount desc limit ${limit || 200}`;
    const data = await this._coql(conn, q);
    return { deals: (data.data || []).map((d) => this.normalizeDeal(d)), after: null };
  },
  async updateDealStage(conn, dealId, stageId) {
    return this.updateDeal(conn, dealId, { Stage: stageId });
  },
  async updateDeal(conn, dealId, properties) {
    const resp = await fetch(`${conn.apiDomain}/crm/v2/Deals/${dealId}`, {
      method: 'PUT', headers: this._headers(conn), body: JSON.stringify({ data: [{ id: String(dealId), ...properties }] }),
    });
    if (!resp.ok) throw new Error(`Zoho update deal failed: HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`);
    return resp.json();
  },
  async createNote(conn, dealId, body) {
    const resp = await fetch(`${conn.apiDomain}/crm/v2/Notes`, {
      method: 'POST', headers: this._headers(conn),
      body: JSON.stringify({ data: [{ Note_Content: body, Parent_Id: String(dealId), se_module: 'Deals' }] }),
    });
    if (!resp.ok) throw new Error(`Zoho create note failed: HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`);
    return resp.json();
  },
};

// --------------------------------------------------------------------------
// HubSpot adapter (delegates to the tested lib/crm_hubspot.js)
// --------------------------------------------------------------------------
const hub = {
  listPipelines: (conn) => hubspot.listPipelines(conn.accessToken),
  listDeals: (conn, opts) => hubspot.listDeals(conn.accessToken, opts || {}),
  updateDealStage: (conn, dealId, stageId) => hubspot.updateDealStage(conn.accessToken, dealId, stageId),
  updateDeal: (conn, dealId, props) => hubspot.updateDeal(conn.accessToken, dealId, props),
  createNote: (conn, dealId, body) => hubspot.createNote(conn.accessToken, dealId, body),
  resolveStageNames: hubspot.resolveStageNames,
};

function adapterFor(conn) {
  if (!conn || !conn.provider) throw new Error('No CRM connection.');
  if (conn.provider === 'hubspot') return hub;
  if (conn.provider === 'zoho' || conn.provider === 'zoho_vorro') return zoho;
  throw new Error(`Unsupported CRM provider: ${conn.provider}`);
}

// --------------------------------------------------------------------------
// Unified API
// --------------------------------------------------------------------------
async function getPipelines(conn) {
  return adapterFor(conn).listPipelines(conn);
}

// Returns a Kanban board: columns ordered by stage, each with its deals + totals.
async function getBoard(conn, { pipelineId } = {}) {
  const a = adapterFor(conn);
  const pipelines = await a.listPipelines(conn);
  const pipeline = pipelines.find((p) => p.id === pipelineId) || pipelines[0] || { id: 'default', name: 'Deals', stages: [] };
  let { deals } = await a.listDeals(conn, {});
  if (conn.provider === 'hubspot' && a.resolveStageNames) deals = a.resolveStageNames(deals, pipelines);
  // Bucket deals into stage columns. Match by normalized stage id OR name so casing/
  // whitespace never causes a false "unassigned". Real stages not in the configured
  // pipeline get their own column; only genuinely stage-less deals land in "No stage".
  const norm = (x) => String(x == null ? '' : x).trim().toLowerCase();
  const columns = [];
  const byKey = new Map();
  for (const st of pipeline.stages) {
    const col = { stageId: st.id, stageName: st.name, isWon: !!st.isWon, isClosed: !!st.isClosed, deals: [] };
    columns.push(col);
    byKey.set(norm(st.id), col);
    byKey.set(norm(st.name), col);
  }
  let noStage = null;
  for (const d of deals) {
    const key = norm(d.stageId) || norm(d.stageName);
    let col = key ? byKey.get(key) : null;
    if (!col && key) {
      col = { stageId: d.stageId || d.stageName, stageName: d.stageName || d.stageId, isWon: false, isClosed: false, deals: [] };
      columns.push(col);
      byKey.set(key, col);
    }
    if (!col) {
      if (!noStage) noStage = { stageId: '__no_stage__', stageName: 'No stage', isWon: false, isClosed: false, deals: [] };
      col = noStage;
    }
    col.deals.push(d);
  }
  if (noStage) columns.push(noStage);
  const finalCols = columns.map((c) => ({
    stageId: c.stageId, stageName: c.stageName, isWon: c.isWon, isClosed: c.isClosed,
    count: c.deals.length, total: c.deals.reduce((sum, d) => sum + (d.amount || 0), 0), deals: c.deals,
  }));
  return { provider: conn.provider, pipeline: { id: pipeline.id, name: pipeline.name }, columns: finalCols };
}


async function moveDeal(conn, dealId, toStageId) {
  return adapterFor(conn).updateDealStage(conn, dealId, toStageId);
}
async function updateDeal(conn, dealId, fields) {
  const safe = sanitizeDealFields(fields);
  if (!Object.keys(safe).length) throw new Error('No updatable fields provided (allowlist).');
  return adapterFor(conn).updateDeal(conn, dealId, safe);
}
async function addNote(conn, dealId, body) {
  return adapterFor(conn).createNote(conn, dealId, body);
}

module.exports = { getPipelines, getBoard, moveDeal, updateDeal, addNote, _zoho: zoho, adapterFor, sanitizeDealFields };
