// Standalone test for lib/recall.js — mocks global.fetch, asserts auth/url/body
// and transcript normalization. No framework.
const assert = require('assert');
const recall = require('../lib/recall');

let passed = 0, last = null;
function t(name, fn){ try{ fn(); passed++; console.log('  ok  -',name); } catch(e){ console.error('  FAIL-',name,'\n      ',e.message); process.exitCode=1; } }
async function ta(name, fn){ try{ await fn(); passed++; console.log('  ok  -',name); } catch(e){ console.error('  FAIL-',name,'\n      ',e.message); process.exitCode=1; } }

function mock(status, payload, isText){
  global.fetch = async (url, opts={}) => {
    last = { url:String(url), method:(opts.method||'GET'), headers:opts.headers||{}, body: opts.body?JSON.parse(opts.body):null };
    return {
      ok: status>=200&&status<300, status, statusText:'',
      json: async()=>payload, text: async()=> (isText?payload:JSON.stringify(payload)),
    };
  };
}

(async () => {
  const cfg = { apiKey:'sk_test_123', region:'us-east-1' };
  const cfgEu = { apiKey:'sk_eu', region:'eu-central-1' };

  console.log('base url + auth:');
  t('region base url', ()=>{ assert.strictEqual(recall.baseUrl('us-west-2'),'https://us-west-2.recall.ai/api/v1'); assert.strictEqual(recall.baseUrl(),'https://us-east-1.recall.ai/api/v1'); });

  console.log('createBot:');
  await ta('posts to /bot/ with Token auth + default caption transcript config', async()=>{
    mock(201, { id:'bot_1', status:'joining' });
    const r = await recall.createBot(cfg, { meetingUrl:'https://teams.microsoft.com/l/meetup-join/xyz', botName:'SB' });
    assert.strictEqual(last.url,'https://us-east-1.recall.ai/api/v1/bot/');
    assert.strictEqual(last.method,'POST');
    assert.strictEqual(last.headers.Authorization,'Token sk_test_123');
    assert.strictEqual(last.body.meeting_url,'https://teams.microsoft.com/l/meetup-join/xyz');
    assert.strictEqual(last.body.bot_name,'SB');
    assert.ok(last.body.recording_config.transcript.provider.meeting_captions);
    assert.strictEqual(r.id,'bot_1');
  });
  await ta('region is honored in URL', async()=>{
    mock(201,{id:'b'}); await recall.createBot(cfgEu,{meetingUrl:'https://x'});
    assert.strictEqual(last.url,'https://eu-central-1.recall.ai/api/v1/bot/');
  });
  await ta('webhookUrl adds webhooks block', async()=>{
    mock(201,{id:'b'}); await recall.createBot(cfg,{meetingUrl:'https://x', webhookUrl:'https://cb/hook'});
    assert.strictEqual(last.body.webhooks[0].url,'https://cb/hook');
    assert.ok(last.body.webhooks[0].events.includes('transcript.data'));
  });
  await ta('throws without meetingUrl or body', async()=>{
    mock(201,{}); await assert.rejects(()=>recall.createBot(cfg,{}), /meetingUrl is required/);
  });
  await ta('throws without apiKey', async()=>{
    await assert.rejects(()=>recall.createBot({},{meetingUrl:'https://x'}), /not configured/);
  });

  console.log('getBot / errors:');
  await ta('getBot hits /bot/{id}/', async()=>{
    mock(200,{id:'bot_9',status_changes:[]}); const r=await recall.getBot(cfg,'bot_9');
    assert.strictEqual(last.url,'https://us-east-1.recall.ai/api/v1/bot/bot_9/'); assert.strictEqual(r.id,'bot_9');
  });
  await ta('non-OK throws with status + body snippet', async()=>{
    mock(401,'unauthorized', true); await assert.rejects(()=>recall.getBot(cfg,'b'), /HTTP 401/);
  });

  console.log('transcript normalization:');
  t('normalizes words[] segments to text + speaker', ()=>{
    const raw=[
      { speaker:'Alice', words:[{text:'Hello',start_timestamp:0,end_timestamp:1},{text:'team',start_timestamp:1,end_timestamp:2}] },
      { participant:{name:'Bob'}, words:[{text:'Hi',start_time:3,end_time:4}] },
    ];
    const n=recall.normalizeTranscript(raw);
    assert.strictEqual(n.segments.length,2);
    assert.strictEqual(n.segments[0].speaker,'Alice');
    assert.strictEqual(n.segments[0].text,'Hello team');
    assert.strictEqual(n.segments[0].start,0);
    assert.strictEqual(n.segments[0].end,2);
    assert.strictEqual(n.segments[1].speaker,'Bob');
    assert.strictEqual(n.segments[1].text,'Hi');
    assert.ok(n.text.includes('Alice: Hello team'));
    assert.ok(n.text.includes('Bob: Hi'));
  });
  t('handles {transcript:[...]} envelope + string words', ()=>{
    const n=recall.normalizeTranscript({ transcript:[ { speaker_id:0, words:'plain text here' } ] });
    assert.strictEqual(n.segments[0].speaker,'Speaker 0');
    assert.strictEqual(n.segments[0].text,'plain text here');
  });
  t('empty/garbage -> empty', ()=>{ assert.strictEqual(recall.normalizeTranscript(null).segments.length,0); assert.strictEqual(recall.normalizeTranscript({}).text,''); });
  await ta('getTranscript fetches and normalizes', async()=>{
    mock(200,[{speaker:'A',words:[{text:'one'},{text:'two'}]}]);
    const n=await recall.getTranscript(cfg,'bot_1');
    assert.strictEqual(last.url,'https://us-east-1.recall.ai/api/v1/bot/bot_1/transcript/');
    assert.strictEqual(n.segments[0].text,'one two');
  });

  console.log(`\n${passed} checks passed${process.exitCode?' (WITH FAILURES)':''}`);
})();
