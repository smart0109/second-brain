// Standalone test harness (no framework) using pg-mem for a real SQL engine.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

process.env.TOKEN_ENC_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.ALLOWED_EMAIL = 'manish696@gmail.com';
process.env.ADMIN_EMAILS = 'manish@basisvps.com';

const db = require('../lib/db');
const tokens = require('../lib/tokens');
const auth = require('../lib/auth');

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok  -', name); }
  catch (e) { console.error('  FAIL-', name, '\n      ', e.message); process.exitCode = 1; }
}

(async () => {
  // pg-mem -> node-postgres compatible pool
  const mem = newDb();
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();
  db.__setPoolForTests(pool);

  console.log('migration:');
  await t('runs without error', async () => { await db.migrate(); });
  await t('seeds bootstrap allowlist + admin', async () => {
    assert.strictEqual(await auth.isAllowed('manish696@gmail.com'), true);
    assert.strictEqual(await auth.isAllowed('manish@basisvps.com'), true);
    assert.strictEqual(await auth.isAllowed('stranger@example.com'), false);
  });

  console.log('token vault (encryption):');
  await t('encrypt/decrypt round-trips', () => {
    const enc = tokens.encrypt({ refresh_token: 'abc123', foo: 1 });
    assert.ok(enc.ciphertext && enc.iv && enc.authTag);
    assert.notStrictEqual(enc.ciphertext, 'abc123');
    const dec = tokens.decrypt(enc);
    assert.strictEqual(dec.refresh_token, 'abc123');
    assert.strictEqual(dec.foo, 1);
  });
  await t('tampered ciphertext fails auth tag', () => {
    const enc = tokens.encrypt({ refresh_token: 'abc123' });
    const bad = Buffer.from(enc.ciphertext, 'base64'); bad[0] ^= 0xff;
    assert.throws(() => tokens.decrypt({ ...enc, ciphertext: bad.toString('base64') }));
  });
  await t('rejects wrong key length', () => {
    const save = process.env.TOKEN_ENC_KEY;
    process.env.TOKEN_ENC_KEY = 'tooshort';
    assert.throws(() => tokens.encrypt({ a: 1 }), /32 bytes/);
    process.env.TOKEN_ENC_KEY = save;
  });

  console.log('user store + login upsert:');
  let user;
  await t('upsert creates a user (microsoft login)', async () => {
    user = await auth.upsertUserOnLogin({ email: 'Manish696@gmail.com', name: 'Manish', provider: 'microsoft', providerId: 'oid-123' });
    assert.ok(user.id);
    assert.strictEqual(user.email, 'manish696@gmail.com');
    assert.strictEqual(user.microsoft_oid, 'oid-123');
  });
  await t('second login (google) updates same user, sets google_sub', async () => {
    const u2 = await auth.upsertUserOnLogin({ email: 'manish696@gmail.com', name: 'Manish', provider: 'google', providerId: 'gsub-9' });
    assert.strictEqual(u2.id, user.id);
    assert.strictEqual(u2.google_sub, 'gsub-9');
    assert.strictEqual(u2.microsoft_oid, 'oid-123'); // preserved
  });

  console.log('per-user token isolation:');
  let userB;
  await t('create second user', async () => {
    await auth.addToAllowlist('teammate@cadienttalent.com', 'manish');
    userB = await auth.upsertUserOnLogin({ email: 'teammate@cadienttalent.com', name: 'Mate', provider: 'google', providerId: 'gsub-B' });
  });
  await t('tokens stored per user, not shared', async () => {
    await tokens.setToken(user.id, 'google', { refresh_token: 'USER-A-google' }, { accountLabel: 'manish696@gmail.com' });
    await tokens.setToken(userB.id, 'google', { refresh_token: 'USER-B-google' }, { accountLabel: 'teammate@cadienttalent.com' });
    const a = await tokens.getToken(user.id, 'google');
    const b = await tokens.getToken(userB.id, 'google');
    assert.strictEqual(a.payload.refresh_token, 'USER-A-google');
    assert.strictEqual(b.payload.refresh_token, 'USER-B-google');
    assert.notStrictEqual(a.payload.refresh_token, b.payload.refresh_token);
  });
  await t('getToken returns null for unconnected provider', async () => {
    assert.strictEqual(await tokens.getToken(user.id, 'zoho'), null);
  });
  await t('upsert overwrites existing provider token', async () => {
    await tokens.setToken(user.id, 'google', { refresh_token: 'USER-A-google-v2' }, {});
    const a = await tokens.getToken(user.id, 'google');
    assert.strictEqual(a.payload.refresh_token, 'USER-A-google-v2');
  });
  await t('listConnections shows providers without leaking secrets', async () => {
    await tokens.setToken(user.id, 'zoho', { refresh_token: 'z' }, { accountLabel: 'cadient' });
    const conns = await tokens.listConnections(user.id);
    const provs = conns.map((c) => c.provider).sort();
    assert.deepStrictEqual(provs, ['google', 'zoho']);
    assert.ok(!JSON.stringify(conns).includes('refresh_token'));
  });
  await t('deleteToken disconnects a provider', async () => {
    await tokens.deleteToken(user.id, 'zoho');
    assert.strictEqual(await tokens.getToken(user.id, 'zoho'), null);
  });

  console.log('allowlist management:');
  await t('add + remove allowlist entries', async () => {
    await auth.addToAllowlist('new@x.com', 'manish');
    assert.strictEqual(await auth.isAllowed('new@x.com'), true);
    await auth.removeFromAllowlist('new@x.com');
    assert.strictEqual(await auth.isAllowed('new@x.com'), false);
  });

  console.log('oauth url builders:');
  await t('google auth url has scopes + state', () => {
    process.env.GOOGLE_CLIENT_ID = 'gid'; process.env.GOOGLE_CLIENT_SECRET = 'gsec';
    const url = auth.googleAuthUrl({ redirectUri: 'https://app/cb', scopes: auth.GOOGLE_DATA_SCOPES, state: 'st1' });
    assert.ok(url.includes('accounts.google.com'));
    assert.ok(url.includes('state=st1'));
    assert.ok(url.includes('gmail'));
  });
  await t('microsoft auth url targets configured tenant', () => {
    process.env.MS_CLIENT_ID = 'mid'; process.env.MS_TENANT = 'common';
    const url = auth.msAuthUrl({ redirectUri: 'https://app/mscb', state: 'st2' });
    assert.ok(url.includes('login.microsoftonline.com/common/oauth2/v2.0/authorize'));
    assert.ok(url.includes('client_id=mid'));
    assert.ok(url.includes('state=st2'));
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ' (with FAILURES)' : ''}`);
  await db.close().catch(() => {});
})();
