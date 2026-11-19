// End-to-end election lifecycle against a real PostgreSQL database and a real HTTP server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { startServer, createDemoElection, officialSession, nid } from './helpers.ts';
import { voteJourney, call, ApiError, randomChoice } from '../scripts/voter-client.ts';
import { b64, unb64, importBlindPublicKey, createBlindedToken, finalizeToken, encryptBallot } from '../shared/protocol.ts';
import { sealOnce } from '../server/src/sealer.ts';
import { closePools } from '../server/src/db.ts';
import { config } from '../server/src/config.ts';

let base: string, app: any, demo: any;
const expectStatus = async (p: Promise<unknown>, status: number) => {
  await assert.rejects(p, (e: any) => { assert.ok(e instanceof ApiError, String(e)); assert.equal(e.status, status, JSON.stringify(e.body)); return true; });
};

before(async () => {
  demo = await createDemoElection({ voters: 400, open: true, graceSeconds: 1 });
  ({ app, base } = await startServer());
});
after(async () => { await app.close(); await closePools(); });

const tally: Record<string, number> = {};

test('a voter can complete the full journey and gets a non-revealing receipt', async () => {
  const r = await voteJourney(base, demo.electionId, nid(demo, 0), demo.voters.password);
  assert.equal(r.receipt.status, 'ACCEPTED');
  assert.match(r.receipt.tracker, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
  assert.ok(!JSON.stringify(r.receipt).includes(Object.values(r.selections)[0][0]), 'receipt must not reveal the choice');
  for (const [k, v] of Object.entries(r.selections)) tally[`${k}|${v[0]}`] = (tally[`${k}|${v[0]}`] ?? 0) + 1;

  await sealOnce();
  const look = await call(base, `/api/public/elections/${demo.electionId}/board/${r.receipt.tracker}`);
  assert.equal(look.onBoard, true);
});

test('retrying the same ballot is idempotent; reusing a token for a different ballot is refused', async () => {
  const r = await voteJourney(base, demo.electionId, nid(demo, 1), demo.voters.password);
  const again = await call(base, '/api/cast', { body: r.cast });
  assert.equal(again.tracker, r.receipt.tracker);
  const other = await encryptBallot(unb64(r.ballot.electionKey), { v: 1, e: demo.electionId, c: r.ballot.constituencyId, s: r.selections });
  await expectStatus(call(base, '/api/cast', { body: { ...r.cast, enc: b64(other.enc), ct: b64(other.ct) } }), 409);
  for (const [k, v] of Object.entries(r.selections)) tally[`${k}|${v[0]}`] = (tally[`${k}|${v[0]}`] ?? 0) + 1;
});

test('a voter cannot obtain a second token', async () => {
  // voter 1 already voted above
  const login = await call(base, '/api/voter/login', { body: { nationalId: nid(demo, 1), password: demo.voters.password } });
  const { session } = await call(base, '/api/voter/otp', { body: { challengeId: login.challengeId, code: login.devOtp }, session: login.session });
  const ballot = await call(base, `/api/voter/elections/${demo.electionId}/ballot`, { session });
  const pending = await createBlindedToken(await importBlindPublicKey(unb64(ballot.signingKey)));
  await expectStatus(call(base, `/api/voter/elections/${demo.electionId}/token`, { body: { blinded: b64(pending.blinded) }, session }), 409);
});

test('CONCURRENCY: 50 simultaneous token requests from one voter yield exactly one token', async () => {
  const login = await call(base, '/api/voter/login', { body: { nationalId: nid(demo, 2), password: demo.voters.password } });
  const { session } = await call(base, '/api/voter/otp', { body: { challengeId: login.challengeId, code: login.devOtp }, session: login.session });
  const ballot = await call(base, `/api/voter/elections/${demo.electionId}/ballot`, { session });
  const pub = await importBlindPublicKey(unb64(ballot.signingKey));
  const reqs = await Promise.all(Array.from({ length: 50 }, () => createBlindedToken(pub)));
  const results = await Promise.allSettled(reqs.map((p) => call(base, `/api/voter/elections/${demo.electionId}/token`, { body: { blinded: b64(p.blinded) }, session })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r: any) => r.reason.status === 409));
});

test('CONCURRENCY: 50 simultaneous different ballots with one token -> exactly one accepted', async () => {
  const r = await voteJourney(base, demo.electionId, nid(demo, 3), demo.voters.password, () => ({}));
  // r already cast an empty (blank) ballot; now race 50 different ballots with a fresh voter's token
  const login = await call(base, '/api/voter/login', { body: { nationalId: nid(demo, 4), password: demo.voters.password } });
  const { session } = await call(base, '/api/voter/otp', { body: { challengeId: login.challengeId, code: login.devOtp }, session: login.session });
  const ballot = await call(base, `/api/voter/elections/${demo.electionId}/ballot`, { session });
  const pub = await importBlindPublicKey(unb64(ballot.signingKey));
  const p = await createBlindedToken(pub);
  const { blindSig } = await call(base, `/api/voter/elections/${demo.electionId}/token`, { body: { blinded: b64(p.blinded) }, session });
  const sig = await finalizeToken(pub, p, unb64(blindSig));
  const variants = await Promise.all(Array.from({ length: 50 }, () => encryptBallot(unb64(ballot.electionKey), { v: 1, e: demo.electionId, c: ballot.constituencyId, s: randomChoice(ballot.contests) })));
  const res = await Promise.allSettled(variants.map((v) => call(base, '/api/cast', { body: { electionId: demo.electionId, constituencyId: ballot.constituencyId, token: b64(p.prepared), sig: b64(sig), enc: b64(v.enc), ct: b64(v.ct) } })));
  assert.equal(res.filter((x) => x.status === 'fulfilled').length, 1, 'exactly one ballot accepted');
  assert.ok(res.filter((x) => x.status === 'rejected').every((x: any) => x.reason.status === 409));
  assert.ok(r.receipt.tracker);
});

test('forged tokens and malformed ballots are rejected', async () => {
  const r = await voteJourney(base, demo.electionId, nid(demo, 5), demo.voters.password);
  for (const [k, v] of Object.entries(r.selections)) tally[`${k}|${v[0]}`] = (tally[`${k}|${v[0]}`] ?? 0) + 1;
  const forged = crypto.getRandomValues(new Uint8Array(64));
  await expectStatus(call(base, '/api/cast', { body: { ...r.cast, token: b64(forged) } }), 403);
  await expectStatus(call(base, '/api/cast', { body: { ...r.cast, ct: b64(new Uint8Array(10)) } }), 400);
  await expectStatus(call(base, '/api/cast', { body: { ...r.cast, extra: 1 } }), 400);
});

test('wrong password and wrong OTP are refused; ineligible requests need a session', async () => {
  await expectStatus(call(base, '/api/voter/login', { body: { nationalId: nid(demo, 6), password: 'wrong-password' } }), 401);
  const login = await call(base, '/api/voter/login', { body: { nationalId: nid(demo, 6), password: demo.voters.password } });
  const bad = login.devOtp === '000000' ? '111111' : '000000';
  await expectStatus(call(base, '/api/voter/otp', { body: { challengeId: login.challengeId, code: bad }, session: login.session }), 401);
  await expectStatus(call(base, `/api/voter/elections/${demo.electionId}/ballot`, { session: login.session }), 401); // otp-stage session is not enough
  await expectStatus(call(base, `/api/voter/elections/${demo.electionId}/ballot`), 401);
});

test('PRIVACY: database roles cannot cross between identity and ballots', async () => {
  const ballotRole = new pg.Client({ connectionString: config.db.ballot }); await ballotRole.connect();
  await assert.rejects(ballotRole.query('SELECT * FROM identity.voters LIMIT 1'), /permission denied/);
  await assert.rejects(ballotRole.query('SELECT * FROM identity.token_issuance LIMIT 1'), /permission denied/);
  await ballotRole.end();
  const idRole = new pg.Client({ connectionString: config.db.identity }); await idRole.connect();
  await assert.rejects(idRole.query('SELECT * FROM ballot.ballots LIMIT 1'), /permission denied/);
  await idRole.end();
  const adminRole = new pg.Client({ connectionString: config.db.admin }); await adminRole.connect();
  await assert.rejects(adminRole.query('SELECT * FROM identity.token_issuance LIMIT 1'), /permission denied/);
  await adminRole.end();
});

test('INTEGRITY: accepted ballots cannot be altered or deleted, even by the database owner', async () => {
  const owner = new pg.Client({ connectionString: config.db.owner }); await owner.connect();
  await assert.rejects(owner.query('UPDATE ballot.ballots SET tracker=tracker WHERE election_id=$1', [demo.electionId]), /immutable/);
  await assert.rejects(owner.query('DELETE FROM ballot.ballots WHERE election_id=$1', [demo.electionId]), /immutable/);
  await assert.rejects(owner.query('UPDATE cfg.candidates SET name=$1', ['Substitute']), /locked/);
  await assert.rejects(owner.query("UPDATE cfg.elections SET status='DECLARED' WHERE id=$1", [demo.electionId]), /illegal election status/);
  await owner.end();
});

test('closing needs two different officials; casting stops after the grace period; tally, verify, declare', async () => {
  // a voter gets a token before close and casts during the grace period
  const a1 = await officialSession(base, demo, 'admin1'), a2 = await officialSession(base, demo, 'admin2');
  const audSession = await officialSession(base, demo, 'auditor');

  const first = await call(base, `/api/admin/elections/${demo.electionId}/actions/close`, { body: { reason: 'polls closed' }, session: a1 });
  assert.equal(first.status, 'PENDING');
  await expectStatus(call(base, `/api/admin/elections/${demo.electionId}/actions/close`, { body: { reason: 'again' }, session: a1 }), 409); // same person twice
  await expectStatus(call(base, `/api/admin/elections/${demo.electionId}/actions/close`, { body: { reason: 'auditor tries to close' }, session: audSession }), 403);
  const done = await call(base, `/api/admin/elections/${demo.electionId}/actions/close`, { body: { reason: 'polls closed' }, session: a2 });
  assert.equal(done.newStatus, 'CLOSED');

  await new Promise((r) => setTimeout(r, 2100)); // grace = 1 s, election cache = 1 s
  await expectStatus(voteJourney(base, demo.electionId, nid(demo, 10), demo.voters.password), 409);

  // Results are not public before the tally.
  const pre = await call(base, `/api/public/elections/${demo.electionId}/results`);
  assert.equal(pre.available, false);

  // Trustee ceremony: 2 shares are not enough, the 3rd triggers the tally.
  for (const [i, u] of ['trustee1', 'trustee3'].entries()) {
    const s = await officialSession(base, demo, u);
    const r = await call(base, `/api/admin/elections/${demo.electionId}/trustee-share`, { body: { share: demo.trusteeShares[i * 2] }, session: s });
    assert.equal(r.status, 'WAITING');
  }
  const t5 = await officialSession(base, demo, 'trustee5');
  const tallied = await call(base, `/api/admin/elections/${demo.electionId}/trustee-share`, { body: { share: demo.trusteeShares[4] }, session: t5 });
  assert.equal(tallied.status, 'TALLIED');

  const rec = await call(base, `/api/public/elections/${demo.electionId}/reconciliation`);
  assert.deepEqual(rec.checks, { noBallotWithoutToken: true, boardMatchesAccepted: true, tallyMatchesAccepted: true });
  assert.equal(rec.ballotsAccepted, 5);  // voters 0,1,3,4,5
  assert.equal(rec.tokensIssued, 6);     // voter 2 took a token but never cast

  const res = await call(base, `/api/public/elections/${demo.electionId}/results`);
  assert.equal(res.label, 'PRELIMINARY');
  for (const [k, n] of Object.entries(tally)) {
    const [contest, cand] = k.split('|');
    const row = res.results.find((x: any) => x.contest_id === contest && x.candidate_id === cand);
    assert.ok(row.votes >= n, `candidate ${cand} should have at least ${n} votes`);
  }

  // verify needs AUDITOR + NATIONAL_ADMIN; declare needs two NATIONAL_ADMINs
  await call(base, `/api/admin/elections/${demo.electionId}/actions/verify`, { body: { reason: 'recount matches' }, session: audSession });
  const v = await call(base, `/api/admin/elections/${demo.electionId}/actions/verify`, { body: { reason: 'recount matches' }, session: a1 });
  assert.equal(v.newStatus, 'VERIFIED');
  await call(base, `/api/admin/elections/${demo.electionId}/actions/declare`, { body: { reason: 'official declaration' }, session: a1 });
  const d = await call(base, `/api/admin/elections/${demo.electionId}/actions/declare`, { body: { reason: 'official declaration' }, session: a2 });
  assert.equal(d.newStatus, 'DECLARED');
  assert.equal((await call(base, `/api/public/elections/${demo.electionId}/results`)).label, 'OFFICIALLY DECLARED');

  const chain = await call(base, '/api/admin/audit/verify', { session: audSession });
  assert.equal(chain.ok, true);
});
