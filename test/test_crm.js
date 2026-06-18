const assert = require('assert');
const crm = require('../lib/crm');

let passed=0,last=null,queue=[];
async function ta(n,fn){try{await fn();passed++;console.log('  ok  -',n);}catch(e){console.error('  FAIL-',n,'\n      ',e.message);process.exitCode=1;}}
function t(n,fn){try{fn();passed++;console.log('  ok  -',n);}catch(e){console.error('  FAIL-',n,'\n      ',e.message);process.exitCode=1;}}
// queue of responses; each fetch shifts one
function enqueue(...rs){ queue=rs.slice(); }
global.fetch = async (url,opts={})=>{
  last={url:String(url),method:opts.method||'GET',body:opts.body?JSON.parse(opts.body):null,headers:opts.headers||{}};
  const r = queue.length>1 ? queue.shift() : queue[0];
  return { ok:(r.status||200)>=200&&(r.status||200)<300, status:r.status||200, statusText:'',
           json:async()=>r.payload, text:async()=>JSON.stringify(r.payload) };
};

(async()=>{
  const zconn={provider:'zoho',accessToken:'zt',apiDomain:'https://www.zohoapis.com'};

  console.log('dispatch:');
  t('adapterFor maps providers', ()=>{
    assert.strictEqual(crm.adapterFor({provider:'zoho'}), crm.adapterFor({provider:'zoho_vorro'}));
    assert.throws(()=>crm.adapterFor({provider:'salesforce'}), /Unsupported/);
    assert.throws(()=>crm.adapterFor({}), /No CRM connection/);
  });

  console.log('zoho normalize:');
  t('normalizeDeal maps fields', ()=>{
    const d=crm._zoho.normalizeDeal({id:7,Deal_Name:'Acme',Amount:'5000',Stage:'Negotiation',Pipeline:'Standard',Closing_Date:'2026-07-01',Probability:60,Account_Name:{name:'Acme Co'},Owner:{id:'u1'}});
    assert.strictEqual(d.id,'7'); assert.strictEqual(d.name,'Acme'); assert.strictEqual(d.amount,5000);
    assert.strictEqual(d.stageId,'Negotiation'); assert.strictEqual(d.stageName,'Negotiation');
    assert.strictEqual(d.accountName,'Acme Co'); assert.strictEqual(d.ownerId,'u1'); assert.strictEqual(d.probability,60);
  });

  console.log('zoho pipelines:');
  await ta('listPipelines parses stage picklist + order', async()=>{
    enqueue({payload:{fields:[{api_name:'Stage',pick_list_values:[
      {display_value:'Qualification',sequence_number:1},
      {display_value:'Closed Won',sequence_number:3,probability:100},
      {display_value:'Negotiation',sequence_number:2}]}]}});
    const pls=await crm.getPipelines(zconn);
    assert.strictEqual(pls.length,1);
    const names=pls[0].stages.map(s=>s.name);
    assert.deepStrictEqual(names,['Qualification','Negotiation','Closed Won']); // sorted by order
    assert.ok(pls[0].stages.find(s=>s.name==='Closed Won').isWon);
    assert.ok(last.url.includes('/crm/v2/settings/fields?module=Deals'));
  });

  console.log('board bucketing:');
  await ta('getBoard buckets by stage; unknown stage gets its own column; no false unassigned', async()=>{
    enqueue(
      {payload:{fields:[{api_name:'Stage',pick_list_values:[{display_value:'Qualification',sequence_number:1},{display_value:'Negotiation',sequence_number:2}]}]}}, // listPipelines
      {payload:{data:[
        {id:1,Deal_Name:'A',Amount:100,Stage:'Qualification'},
        {id:2,Deal_Name:'B',Amount:200,Stage:'negotiation'},   // different casing -> still matches Negotiation
        {id:3,Deal_Name:'C',Amount:50,Stage:'Negotiation'},
        {id:4,Deal_Name:'D',Amount:10,Stage:'GhostStage'},     // real but unconfigured -> own column
        {id:5,Deal_Name:'E',Amount:5,Stage:''}]}}              // truly no stage -> "No stage"
    );
    const board=await crm.getBoard(zconn,{});
    assert.strictEqual(board.provider,'zoho');
    const qual=board.columns.find(c=>c.stageId==='Qualification');
    const neg=board.columns.find(c=>c.stageId==='Negotiation');
    const ghost=board.columns.find(c=>c.stageName==='GhostStage');
    const none=board.columns.find(c=>c.stageId==='__no_stage__');
    const unassigned=board.columns.find(c=>c.stageId==='__unassigned__');
    assert.strictEqual(qual.count,1); assert.strictEqual(qual.total,100);
    assert.strictEqual(neg.count,2); assert.strictEqual(neg.total,250); // casing-insensitive match
    assert.ok(ghost && ghost.count===1);     // unknown stage -> its own column, NOT unassigned
    assert.ok(!unassigned);                  // no false "unassigned" column
    assert.ok(none && none.count===1);       // empty-stage deal -> "No stage"
  });

  console.log('writes:');
  await ta('moveDeal PUTs Stage to Zoho', async()=>{
    enqueue({payload:{data:[{code:'SUCCESS'}]}});
    await crm.moveDeal(zconn,'99','Closed Won');
    assert.strictEqual(last.method,'PUT');
    assert.ok(last.url.endsWith('/crm/v2/Deals/99'));
    assert.strictEqual(last.body.data[0].id,'99');
    assert.strictEqual(last.body.data[0].Stage,'Closed Won');
  });
  await ta('addNote POSTs to Zoho Notes with parent', async()=>{
    enqueue({payload:{data:[{code:'SUCCESS'}]}});
    await crm.addNote(zconn,'99','Called the buyer');
    assert.ok(last.url.endsWith('/crm/v2/Notes'));
    assert.strictEqual(last.body.data[0].Parent_Id,'99');
    assert.strictEqual(last.body.data[0].se_module,'Deals');
    assert.strictEqual(last.body.data[0].Note_Content,'Called the buyer');
  });
  await ta('updateDeal PUTs arbitrary fields', async()=>{
    enqueue({payload:{data:[{code:'SUCCESS'}]}});
    await crm.updateDeal(zconn,'5',{Amount:9999,Closing_Date:'2026-08-01'});
    assert.strictEqual(last.body.data[0].Amount,9999);
    assert.strictEqual(last.body.data[0].Closing_Date,'2026-08-01');
  });

  console.log('hubspot dispatch (via mocked fetch):');
  await ta('getBoard works for hubspot conn', async()=>{
    enqueue(
      {payload:{results:[{id:'p1',label:'Sales',stages:[{id:'s1',label:'New',displayOrder:0},{id:'s2',label:'Won',displayOrder:1,metadata:{isClosed:'true',probability:'1.0'}}]}]}}, // pipelines
      {payload:{results:[{id:'d1',properties:{dealname:'HS Deal',amount:'300',dealstage:'s1',pipeline:'p1'}}],paging:null}} // deals
    );
    const board=await crm.getBoard({provider:'hubspot',accessToken:'ht'},{});
    assert.strictEqual(board.provider,'hubspot');
    const newCol=board.columns.find(c=>c.stageId==='s1');
    assert.strictEqual(newCol.count,1); assert.strictEqual(newCol.total,300);
    assert.strictEqual(newCol.deals[0].stageName,'New'); // resolveStageNames filled it
  });

  console.log(`\n${passed} checks passed${process.exitCode?' (WITH FAILURES)':''}`);
})();
