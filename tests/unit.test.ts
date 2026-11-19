import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { totp, hashPassword, verifyPassword, signSession, readSession, wrapKey, unwrapKey } from '../server/src/security.ts';
import { slotsSatisfied, castWindowOpen, issuanceOpen } from '../server/src/elections.ts';
import { encodeBallot, decodeBallot, trackerFor, BALLOT_PAD_BYTES, boardEntryHash, GENESIS } from '../shared/protocol.ts';
import { RateLimiter } from '../server/src/admission.ts';
import { audit, verifyAuditChain } from '../server/src/audit.ts';
import { pools, closePools } from '../server/src/db.ts';
import { config } from '../server/src/config.ts';
import { migrate } from '../server/src/migrate.ts';

after(() => closePools());

test('TOTP matches the RFC 6238 SHA-1 test vector', () => {
  assert.equal(totp(Buffer.from('12345678901234567890'), 59_000), '287082');
  assert.equal(totp(Buffer.from('12345678901234567890'), 1111111109_000), '081804');
});

test('password hashing verifies and rejects', async () => {
  const h = await hashPassword('correct horse battery');
  assert.equal(await verifyPassword('correct horse battery', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
  assert.equal(await verifyPassword('anything', null), false);
});

test('session tokens reject tampering and expiry', () => {
  const t = signSession({ sub: 'a', kind: 'voter', stage: 'full' }, 60);
  assert.equal(readSession(t)?.sub, 'a');
  const [body, mac] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), sub: 'b' })).toString('base64url');
  assert.equal(readSession(`${forged}.${mac}`), null);
  assert.equal(readSession(signSession({ sub: 'a', kind: 'voter', stage: 'full' }, -1)), null);
});

test('key wrapping round-trips and detects tampering', () => {
  const k = Buffer.from('secret key material');
  const w = wrapKey(k);
  assert.deepEqual(unwrapKey(w), k);
  w[w.length - 1] ^= 1;
  assert.throws(() => unwrapKey(w));
});

test('approval slots need distinct officials with the right roles', () => {
  const two = [['NATIONAL_ADMIN'], ['NATIONAL_ADMIN']];
  assert.equal(slotsSatisfied(two, [{ roles: ['NATIONAL_ADMIN'] }]), false);
  assert.equal(slotsSatisfied(two, [{ roles: ['NATIONAL_ADMIN'] }, { roles: ['NATIONAL_ADMIN'] }]), true);
  const verify = [['AUDITOR'], ['NATIONAL_ADMIN']];
  assert.equal(slotsSatisfied(verify, [{ roles: ['NATIONAL_ADMIN'] }, { roles: ['NATIONAL_ADMIN'] }]), false);
  assert.equal(slotsSatisfied(verify, [{ roles: ['NATIONAL_ADMIN'] }, { roles: ['AUDITOR'] }]), true);
});

test('voting windows: issuance stops at close, casting has a grace period', () => {
  const now = Date.now();
  const e = { status: 'OPEN', opens_at: new Date(now - 1000), closes_at: new Date(now - 10_000), close_grace_s: 60, updated_at: new Date(now) };
  assert.equal(issuanceOpen(e, now), false);
  assert.equal(castWindowOpen(e, now), true);
  assert.equal(castWindowOpen({ ...e, close_grace_s: 0 }, now), false);
  assert.equal(castWindowOpen({ ...e, status: 'SUSPENDED' }, now), false);
});

test('ballot plaintexts are fixed length and round-trip', async () => {
  const a = encodeBallot({ v: 1, e: 'e', c: 'c', s: {} });
  const b = encodeBallot({ v: 1, e: 'e', c: 'c', s: { x: ['a', 'b', 'c'] } });
  assert.equal(a.length, BALLOT_PAD_BYTES); assert.equal(b.length, BALLOT_PAD_BYTES);
  assert.deepEqual(decodeBallot(b).s, { x: ['a', 'b', 'c'] });
  const tr = await trackerFor(new Uint8Array(64), new Uint8Array(32), new Uint8Array(10));
  assert.match(tr, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
  const h1 = await boardEntryHash(GENESIS, 1, tr), h2 = await boardEntryHash(GENESIS, 2, tr);
  assert.notDeepEqual(h1, h2);
});

test('rate limiter allows a burst then throttles', () => {
  const r = new RateLimiter(3, 0.001);
  assert.deepEqual([r.take('x'), r.take('x'), r.take('x'), r.take('x')], [true, true, true, false]);
  assert.equal(r.take('y'), true);
});

test('audit chain detects a record edited behind the application\'s back', async () => {
  await migrate(config.db.owner, false);
  await audit(pools.admin, 'unit-test', 'test.event', { n: 1 });
  await audit(pools.admin, 'unit-test', 'test.event', { n: 2 });
  assert.equal((await verifyAuditChain(pools.admin)).ok, true);
  // Simulate a malicious database owner who disables the immutability trigger.
  const owner = new pg.Client({ connectionString: config.db.owner }); await owner.connect();
  await owner.query('BEGIN');
  await owner.query('ALTER TABLE adm.audit_log DISABLE TRIGGER audit_immutable');
  await owner.query(`UPDATE adm.audit_log SET details='{"n":99}' WHERE seq=(SELECT max(seq)-1 FROM adm.audit_log)`);
  const c = await verifyAuditChainWith(owner);
  await owner.query('ROLLBACK'); await owner.end();
  assert.equal(c.ok, false);
});

async function verifyAuditChainWith(client: pg.Client) {
  return verifyAuditChain({ query: (q: string) => client.query(q) } as any);
}

test('server-side synchronous tracker matches the shared (browser) derivation', async () => {
  const { trackerFor: serverTracker } = await import('../server/src/routes/cast.ts');
  const tok = crypto.getRandomValues(new Uint8Array(64)), enc = crypto.getRandomValues(new Uint8Array(32)), ct = crypto.getRandomValues(new Uint8Array(100));
  assert.equal(serverTracker(Buffer.from(tok), Buffer.from(enc), Buffer.from(ct)), await trackerFor(tok, enc, ct));
});
