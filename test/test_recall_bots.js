// Tests per-user Recall bot ownership against pg-mem.
const assert = require('assert');
const { newDb } = require('pg-mem');
process.env.DATABASE_URL = 'postgres://test/test';
process.env.TOKEN_ENC_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.ALLOWED_EMAIL = 'admin@x.com';
const db = require('../lib/db');
const auth = require('../lib/auth');
const rb = require('../lib/recall_bots');

let passed=0;
async function t(n,fn){try{await fn();passed++;console.log('  ok  -',n);}catch(e){console.error('  FAIL-',n,'\n      ',e.message);process.exitCode=1;}}

(async()=>{
  const mem=newDb(); const pg=mem.adapters.createPg(); db.__setPoolForTests(new pg.Pool());
  await db.migrate();
  const a = await auth.upsertUserOnLogin({email:'a@x.com',name:'A',provider:'google',providerId:'ga'});
  const b = await auth.upsertUserOnLogin({email:'b@x.com',name:'B',provider:'google',providerId:'gb'});

  await t('record + ownerOf', async()=>{
    await rb.record(a.id,'bot_A','https://teams/x');
    assert.strictEqual(String(await rb.ownerOf('bot_A')), String(a.id));
  });
  await t('owner passes assertOwner', async()=>{ await rb.assertOwner(a.id,'bot_A'); });
  await t('non-owner is denied (403)', async()=>{
    await assert.rejects(()=>rb.assertOwner(b.id,'bot_A'), (e)=>e.status===403);
  });
  await t('unknown bot is denied (404) - makes shared key safe', async()=>{
    await assert.rejects(()=>rb.assertOwner(a.id,'ghost_bot'), (e)=>e.status===404);
  });
  await t('listForUser returns only that user bots', async()=>{
    await rb.record(b.id,'bot_B','https://teams/y');
    const la=await rb.listForUser(a.id), lb=await rb.listForUser(b.id);
    assert.deepStrictEqual(la.map(x=>x.bot_id),['bot_A']);
    assert.deepStrictEqual(lb.map(x=>x.bot_id),['bot_B']);
  });
  await t('record is idempotent on bot_id', async()=>{
    await rb.record(b.id,'bot_A','dup'); // must NOT steal ownership from A
    assert.strictEqual(String(await rb.ownerOf('bot_A')), String(a.id));
  });

  console.log(`\n${passed} checks passed${process.exitCode?' (WITH FAILURES)':''}`);
  await db.close().catch(()=>{});
})();
