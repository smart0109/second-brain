const assert=require('assert');
const { newDb }=require('pg-mem');
process.env.DATABASE_URL='postgres://test/test';
process.env.TOKEN_ENC_KEY=require('crypto').randomBytes(32).toString('hex');
process.env.ALLOWED_EMAIL='admin@x.com';
const db=require('../lib/db'); const auth=require('../lib/auth'); const access=require('../lib/access');
let passed=0;
async function t(n,fn){try{await fn();passed++;console.log('  ok  -',n);}catch(e){console.error('  FAIL-',n,'\n      ',e.message);process.exitCode=1;}}
(async()=>{
  const mem=newDb(); const pg=mem.adapters.createPg(); db.__setPoolForTests(new pg.Pool()); await db.migrate();
  await auth.addToAllowlist('user@x.com','admin');
  await t('allowed user passes', async()=>{ assert.strictEqual(await access.isStillAllowed('user@x.com'), true); });
  await t('removal + invalidate -> denied immediately', async()=>{
    await auth.removeFromAllowlist('user@x.com');
    access.invalidate('user@x.com');           // mirrors the admin route
    assert.strictEqual(await access.isStillAllowed('user@x.com'), false);
  });
  await t('cache serves within TTL until invalidated', async()=>{
    await auth.addToAllowlist('c@x.com','admin');
    assert.strictEqual(await access.isStillAllowed('c@x.com'), true);  // caches true
    await auth.removeFromAllowlist('c@x.com');                          // removed in DB
    assert.strictEqual(await access.isStillAllowed('c@x.com'), true);  // still cached (no invalidate)
    access.invalidate('c@x.com');
    assert.strictEqual(await access.isStillAllowed('c@x.com'), false); // now denied
  });
  await t('purgeUserSessions runs (session table)', async()=>{
    // insert a fake session row then purge by email
    await db.query(`INSERT INTO "session"(sid,sess,expire) VALUES('s1','{"email":"user@x.com"}','2099-01-01')`);
    await auth.purgeUserSessions('user@x.com');
    const { rows }=await db.query(`SELECT * FROM "session" WHERE sid='s1'`);
    assert.strictEqual(rows.length, 0);
  });
  console.log(`\n${passed} checks passed${process.exitCode?' (WITH FAILURES)':''}`);
  await db.close().catch(()=>{});
})();
