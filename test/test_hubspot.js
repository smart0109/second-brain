// Standalone test for lib/crm_hubspot.js. No test framework.
//
//   node test/test_hubspot.js
//
// Mocks global.fetch, asserts request URL/method/body/headers and that
// responses are parsed/normalized to the canonical shape. Exits non-zero on
// the first failure and prints "N checks passed" on success.

'use strict';

const hs = require('../lib/crm_hubspot');

let checks = 0;
function check(cond, msg) {
  if (!cond) {
    console.error('FAIL: ' + msg);
    // restore before bailing so we don't leave global.fetch clobbered.
    if (originalFetch !== undefined) global.fetch = originalFetch;
    process.exit(1);
  }
  checks += 1;
}

const originalFetch = global.fetch;

// Build a Response-like stub. `captures` records each call.
const captures = [];
function makeFetch(handler) {
  return async function mockFetch(url, opts) {
    const call = { url, opts: opts || {} };
    captures.push(call);
    const result = handler(url, call.opts);
    const status = result.status || 200;
    const ok = status >= 200 && status < 300;
    const bodyObj = result.json !== undefined ? result.json : {};
    return {
      ok,
      status,
      statusText: result.statusText || (ok ? 'OK' : 'Error'),
      async json() {
        return bodyObj;
      },
      async text() {
        return typeof result.text === 'string' ? result.text : JSON.stringify(bodyObj);
      },
    };
  };
}

function lastCall() {
  return captures[captures.length - 1];
}

async function main() {
  // ---- HUBSPOT_SCOPES --------------------------------------------------------
  check(Array.isArray(hs.HUBSPOT_SCOPES), 'HUBSPOT_SCOPES is an array');
  check(
    hs.HUBSPOT_SCOPES.join(' ') ===
      'oauth crm.objects.deals.read crm.objects.deals.write crm.schemas.deals.read crm.objects.contacts.read crm.objects.owners.read',
    'HUBSPOT_SCOPES has the expected ordered values'
  );

  // ---- authUrl ---------------------------------------------------------------
  const url = hs.authUrl({
    clientId: 'CID',
    redirectUri: 'https://app.example.com/cb',
    state: 'xyz',
  });
  check(url.startsWith('https://app.hubspot.com/oauth/authorize?'), 'authUrl points at HubSpot authorize endpoint');
  check(url.includes('client_id=CID'), 'authUrl includes client_id');
  check(url.includes('state=xyz'), 'authUrl includes state');
  // redirect_uri url-encoded
  check(url.includes('redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb'), 'authUrl url-encodes redirect_uri');
  // default scopes, space-joined -> url-encoded as +
  check(url.includes('scope=oauth+crm.objects.deals.read'), 'authUrl defaults to HUBSPOT_SCOPES, space-joined');
  // custom scopes honored
  const url2 = hs.authUrl({ clientId: 'C', redirectUri: 'https://x/y', scopes: ['a', 'b'] });
  check(url2.includes('scope=a+b'), 'authUrl honors custom scopes array');

  // ---- exchangeCode ----------------------------------------------------------
  global.fetch = makeFetch(() => ({
    json: { access_token: 'AT', refresh_token: 'RT', expires_in: 1800 },
  }));
  const tok = await hs.exchangeCode({
    clientId: 'CID',
    clientSecret: 'SEC',
    code: 'CODE',
    redirectUri: 'https://app.example.com/cb',
  });
  let c = lastCall();
  check(c.url === 'https://api.hubapi.com/oauth/v1/token', 'exchangeCode posts to the token endpoint');
  check(c.opts.method === 'POST', 'exchangeCode uses POST');
  check(
    c.opts.headers['Content-Type'] === 'application/x-www-form-urlencoded',
    'exchangeCode sends form-urlencoded content type'
  );
  check(c.opts.body.includes('grant_type=authorization_code'), 'exchangeCode sends grant_type=authorization_code');
  check(c.opts.body.includes('code=CODE'), 'exchangeCode sends the code');
  check(c.opts.body.includes('client_secret=SEC'), 'exchangeCode sends client_secret');
  check(tok.access_token === 'AT' && tok.refresh_token === 'RT', 'exchangeCode returns raw token JSON');

  // ---- refreshAccessToken ----------------------------------------------------
  global.fetch = makeFetch(() => ({ json: { access_token: 'AT2', expires_in: 1800 } }));
  const tok2 = await hs.refreshAccessToken({ clientId: 'CID', clientSecret: 'SEC', refreshToken: 'RT' });
  c = lastCall();
  check(c.url === 'https://api.hubapi.com/oauth/v1/token', 'refreshAccessToken posts to the token endpoint');
  check(c.opts.body.includes('grant_type=refresh_token'), 'refreshAccessToken sends grant_type=refresh_token');
  check(c.opts.body.includes('refresh_token=RT'), 'refreshAccessToken sends refresh_token');
  check(tok2.access_token === 'AT2', 'refreshAccessToken returns token JSON');

  // ---- error path ------------------------------------------------------------
  global.fetch = makeFetch(() => ({ status: 401, statusText: 'Unauthorized', text: 'bad token' }));
  let threw = false;
  try {
    await hs.listPipelines('BAD');
  } catch (e) {
    threw = true;
    check(/HTTP 401/.test(e.message), 'non-OK error message includes the status');
    check(/bad token/.test(e.message), 'non-OK error message includes a body snippet');
  }
  check(threw, 'listPipelines throws on non-OK response');

  // ---- listPipelines ---------------------------------------------------------
  global.fetch = makeFetch(() => ({
    json: {
      results: [
        {
          id: 'default',
          label: 'Sales Pipeline',
          stages: [
            { id: 'appointmentscheduled', label: 'Appointment', displayOrder: 0, metadata: { probability: '0.2', isClosed: 'false' } },
            { id: 'closedwon', label: 'Closed Won', displayOrder: 2, metadata: { probability: '1.0', isClosed: 'true' } },
            { id: 'closedlost', label: 'Closed Lost', displayOrder: 1, metadata: { probability: '0.0', isClosed: 'true' } },
          ],
        },
      ],
    },
  }));
  const pipelines = await hs.listPipelines('AT');
  c = lastCall();
  check(c.url === 'https://api.hubapi.com/crm/v3/pipelines/deals', 'listPipelines GETs the deals pipelines endpoint');
  check(c.opts.method === 'GET', 'listPipelines uses GET');
  check(c.opts.headers.Authorization === 'Bearer AT', 'listPipelines sends Bearer auth header');
  check(pipelines.length === 1, 'listPipelines returns one pipeline');
  const pl = pipelines[0];
  check(pl.id === 'default' && pl.name === 'Sales Pipeline', 'pipeline id/name normalized from id/label');
  check(pl.stages.length === 3, 'pipeline has 3 stages');
  // sorted by order: 0,1,2
  check(
    pl.stages[0].id === 'appointmentscheduled' &&
      pl.stages[1].id === 'closedlost' &&
      pl.stages[2].id === 'closedwon',
    'stages sorted by order ascending'
  );
  const won = pl.stages.find((s) => s.id === 'closedwon');
  const lost = pl.stages.find((s) => s.id === 'closedlost');
  const open = pl.stages.find((s) => s.id === 'appointmentscheduled');
  check(won.name === 'Closed Won' && won.order === 2, 'stage name/order normalized');
  check(won.probability === 1 && won.isClosed === true, 'stage probability/isClosed normalized to number/bool');
  check(won.isWon === true, 'closedwon stage isWon=true (probability===1)');
  check(lost.isWon === false, 'closedlost stage isWon=false (closed but not won)');
  check(open.isWon === false && open.isClosed === false, 'open stage isWon/isClosed=false');

  // ---- listDeals -------------------------------------------------------------
  global.fetch = makeFetch(() => ({
    json: {
      results: [
        {
          id: '101',
          properties: {
            dealname: 'Acme Renewal',
            amount: '12500.50',
            dealstage: 'closedwon',
            pipeline: 'default',
            closedate: '2026-07-01T00:00:00.000Z',
            hs_deal_stage_probability: '1.0',
            hubspot_owner_id: '555',
          },
        },
      ],
      paging: { next: { after: '101', link: 'https://...' } },
    },
  }));
  const { deals, after } = await hs.listDeals('AT', { limit: 50 });
  c = lastCall();
  check(c.url.startsWith('https://api.hubapi.com/crm/v3/objects/deals?'), 'listDeals hits the deals object endpoint');
  check(c.url.includes('limit=50'), 'listDeals sends limit');
  check(c.url.includes('archived=false'), 'listDeals sends archived=false');
  check(
    c.url.includes('properties=dealname%2Camount%2Cdealstage%2Cpipeline%2Cclosedate%2Chs_deal_stage_probability%2Chubspot_owner_id'),
    'listDeals requests the canonical property set'
  );
  check(deals.length === 1, 'listDeals returns one deal');
  const d = deals[0];
  check(d.id === '101' && typeof d.id === 'string', 'deal id normalized to string');
  check(d.name === 'Acme Renewal', 'deal name from properties.dealname');
  check(d.amount === 12500.5 && typeof d.amount === 'number', 'deal amount coerced to Number');
  check(d.stageId === 'closedwon', 'deal stageId from properties.dealstage');
  check(d.pipelineId === 'default', 'deal pipelineId from properties.pipeline');
  check(d.closeDate === '2026-07-01T00:00:00.000Z', 'deal closeDate from properties.closedate');
  check(d.probability === 1, 'deal probability coerced to Number');
  check(d.ownerId === '555', 'deal ownerId from properties.hubspot_owner_id');
  check(d.stageName === '' && d.accountName === '', 'deal stageName/accountName left blank by listDeals');
  check(d.raw && d.raw.id === '101', 'deal carries raw payload');
  check(after === '101', 'listDeals returns paging.next.after');

  // listDeals default limit + after param
  global.fetch = makeFetch(() => ({ json: { results: [], paging: {} } }));
  const r2 = await hs.listDeals('AT', { after: 'CURSOR' });
  c = lastCall();
  check(c.url.includes('limit=100'), 'listDeals defaults limit to 100');
  check(c.url.includes('after=CURSOR'), 'listDeals forwards after cursor');
  check(r2.after === null, 'listDeals after is null when no further page');

  // ---- getDeal ---------------------------------------------------------------
  global.fetch = makeFetch(() => ({
    json: { id: '202', properties: { dealname: 'Beta', amount: '0', dealstage: 's1', pipeline: 'p1' } },
  }));
  const one = await hs.getDeal('AT', '202');
  c = lastCall();
  check(c.url.startsWith('https://api.hubapi.com/crm/v3/objects/deals/202?'), 'getDeal hits the single deal endpoint');
  check(one.id === '202' && one.amount === 0, 'getDeal normalizes a single deal (amount 0 stays 0)');

  // ---- updateDealStage -------------------------------------------------------
  global.fetch = makeFetch(() => ({
    json: { id: '101', properties: { dealname: 'Acme Renewal', dealstage: 'qualifiedtobuy', pipeline: 'default' } },
  }));
  const upd = await hs.updateDealStage('AT', '101', 'qualifiedtobuy');
  c = lastCall();
  check(c.url === 'https://api.hubapi.com/crm/v3/objects/deals/101', 'updateDealStage PATCHes the single deal endpoint');
  check(c.opts.method === 'PATCH', 'updateDealStage uses PATCH');
  check(c.opts.headers['Content-Type'] === 'application/json', 'updateDealStage sends JSON content type');
  check(c.opts.headers.Authorization === 'Bearer AT', 'updateDealStage sends Bearer auth');
  const sentBody = JSON.parse(c.opts.body);
  check(
    sentBody && sentBody.properties && sentBody.properties.dealstage === 'qualifiedtobuy',
    'updateDealStage body is {properties:{dealstage}}'
  );
  check(Object.keys(sentBody.properties).length === 1, 'updateDealStage only sets dealstage');
  check(upd.stageId === 'qualifiedtobuy', 'updateDealStage returns canonical deal with new stageId');

  // ---- updateDeal (generic) --------------------------------------------------
  global.fetch = makeFetch(() => ({ json: { id: '101', properties: { dealname: 'Renamed', amount: '999' } } }));
  const upd2 = await hs.updateDeal('AT', '101', { dealname: 'Renamed', amount: '999' });
  c = lastCall();
  const body2 = JSON.parse(c.opts.body);
  check(body2.properties.dealname === 'Renamed' && body2.properties.amount === '999', 'updateDeal forwards arbitrary properties');
  check(upd2.name === 'Renamed' && upd2.amount === 999, 'updateDeal returns canonical normalized deal');

  // ---- createNote ------------------------------------------------------------
  global.fetch = makeFetch(() => ({ json: { id: 'note-1', properties: { hs_note_body: 'hi' } } }));
  const note = await hs.createNote('AT', '101', 'Call recap: pricing approved.');
  c = lastCall();
  check(c.url === 'https://api.hubapi.com/crm/v3/objects/notes', 'createNote POSTs to the notes endpoint');
  check(c.opts.method === 'POST', 'createNote uses POST');
  const nb = JSON.parse(c.opts.body);
  check(nb.properties.hs_note_body === 'Call recap: pricing approved.', 'createNote sets hs_note_body');
  check(typeof nb.properties.hs_timestamp === 'number', 'createNote sets a numeric hs_timestamp');
  check(Array.isArray(nb.associations) && nb.associations.length === 1, 'createNote includes one association');
  const assoc = nb.associations[0];
  check(assoc.to.id === '101', 'createNote associates to the deal id');
  check(
    assoc.types[0].associationCategory === 'HUBSPOT_DEFINED' && assoc.types[0].associationTypeId === 214,
    'createNote uses HUBSPOT_DEFINED associationTypeId 214 (note->deal)'
  );
  check(note.id === 'note-1', 'createNote returns the created note JSON');

  // ---- resolveStageNames (pure) ----------------------------------------------
  const enriched = hs.resolveStageNames(
    [
      { id: '101', stageId: 'closedwon', stageName: '', probability: null, isWon: undefined },
      { id: '102', stageId: 'unknownstage', stageName: '', probability: null },
    ],
    pipelines
  );
  check(enriched[0].stageName === 'Closed Won', 'resolveStageNames fills stageName from pipelines');
  check(enriched[0].isWon === true, 'resolveStageNames fills isWon from the matched stage');
  check(enriched[0].probability === 1, 'resolveStageNames backfills probability from the stage');
  check(enriched[1].stageName === '', 'resolveStageNames leaves unmatched stages blank');

  // ---- restore ---------------------------------------------------------------
  global.fetch = originalFetch;
  check(global.fetch === originalFetch, 'global.fetch restored after tests');

  console.log(checks + ' checks passed');
}

main().catch((e) => {
  if (originalFetch !== undefined) global.fetch = originalFetch;
  console.error('UNEXPECTED ERROR:', e && e.stack ? e.stack : e);
  process.exit(1);
});
