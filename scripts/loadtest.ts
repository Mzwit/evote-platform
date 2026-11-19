// Load test with REALISTIC voter journeys (login, OTP, ballot, blind token,
// on-device encryption, anonymous cast), not homepage hits.
//
//   node scripts/loadtest.ts --base http://localhost:8080 --voters 5000 --concurrency 500 --offset 0
//
// Spreads virtual voters over worker threads (the client-side crypto is CPU work too),
// then prints latency percentiles per step, error counts and a reconciliation check.
// For 50k+ concurrent users run it from several machines (or use the k6 script in
// tests/load/k6-voter-journey.js) so the generator is not the bottleneck.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { readFileSync } from 'node:fs';

const arg = (k: string, d: string) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

if (isMainThread) {
  const demo = JSON.parse(readFileSync(arg('demo', 'seed-output/demo.json'), 'utf8'));
  const base = arg('base', 'http://localhost:8080');
  const voters = Number(arg('voters', '1000')), concurrency = Number(arg('concurrency', '200')), offset = Number(arg('offset', '0'));
  const threads = Math.min(Number(arg('threads', String(Math.max(1, Math.floor(availableParallelism() / 2))))), concurrency);
  const before = await (await fetch(`${base}/api/public/elections/${demo.electionId}/reconciliation`)).json();
  console.log(`load test: ${voters} voters, ${concurrency} concurrent journeys, ${threads} generator threads -> ${base}`);
  const precompute = process.argv.includes('--precompute');
  const workers: Worker[] = []; let ready = 0; let t0 = 0;
  let goAll: () => void; const allReady = new Promise<void>((r) => (goAll = r));
  const done = Array.from({ length: threads }, (_, w) => new Promise<any>((resolve, reject) => {
    const per = Math.ceil(voters / threads);
    const wk = new Worker(new URL(import.meta.url), { workerData: { base, electionId: demo.electionId, first: demo.voters.firstNationalId, password: demo.voters.password,
      start: offset + w * per, count: Math.min(per, voters - w * per), concurrency: Math.ceil(concurrency / threads), precompute } });
    workers.push(wk);
    wk.on('message', (m) => { if (m === 'ready') { if (++ready === threads) goAll(); } else resolve(m); }); wk.on('error', reject);
  }));
  await allReady;
  if (precompute) console.log('device-side crypto pre-computed for every voter; timed phase measures the SERVER only');
  t0 = performance.now();
  for (const w of workers) w.postMessage('go');
  const results = await Promise.all(done);
  const wall = (performance.now() - t0) / 1000;
  const steps: Record<string, number[]> = {}; let ok = 0; const errors: Record<string, number> = {}; let busy = 0;
  for (const r of results) {
    ok += r.ok; busy += r.busy;
    for (const [k, v] of Object.entries(r.errors as Record<string, number>)) errors[k] = (errors[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.steps as Record<string, number[]>)) (steps[k] ??= []).push(...v);
  }
  const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
  console.log(`\ncompleted ${ok}/${voters} journeys in ${wall.toFixed(1)} s  ->  ${(ok / wall).toFixed(1)} ballots/s, waiting-room retries ${busy}`);
  console.log('step'.padEnd(16), 'p50 ms'.padStart(8), 'p95 ms'.padStart(8), 'p99 ms'.padStart(8), 'max ms'.padStart(8));
  for (const [k, v] of Object.entries(steps)) console.log(k.padEnd(16), ...[0.5, 0.95, 0.99, 1].map((p) => pct(v, p).toFixed(0).padStart(8)));
  console.log('errors:', JSON.stringify(errors));
  await new Promise((r) => setTimeout(r, 3000)); // let the sealer catch up
  const after = await (await fetch(`${base}/api/public/elections/${demo.electionId}/reconciliation`)).json();
  const accepted = after.ballotsAccepted - before.ballotsAccepted;
  console.log(`reconciliation: journeys reported accepted ${ok}, new ballots in database ${accepted}, board ${after.boardEntries}/${after.ballotsAccepted}, checks ${JSON.stringify(after.checks)}`);
  console.log(JSON.stringify({ voters, concurrency, wallSeconds: +wall.toFixed(1), ok, ballotsPerSec: +(ok / wall).toFixed(1), errors, accepted,
    p: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { p50: +pct(v, 0.5).toFixed(0), p95: +pct(v, 0.95).toFixed(0), p99: +pct(v, 0.99).toFixed(0) }])), checks: after.checks }));
  process.exit(accepted === ok && Object.values(after.checks).every(Boolean) ? 0 : 1);
} else {
  const { voteJourney, randomChoice, ApiError, call } = await import('./voter-client.ts');
  const P = await import('../shared/protocol.ts');
  const d = workerData;
  const steps: Record<string, number[]> = { total: [] }; const errors: Record<string, number> = {}; let ok = 0, next = 0; const busy = 0;
  const TK = ['HH-MBE', 'HH-LOB', 'MN-MZN', 'LU-SIT', 'SH-NHL']; // seed assigns voter j to TK[j % 5]
  const pre = new Map<number, any>();
  if (d.precompute) {
    const info = await call(d.base, `/api/public/elections/${d.electionId}`);
    const byCode = new Map(info.constituencies.map((k: any) => [k.code, k]));
    const keys = new Map<string, CryptoKey>();
    for (const k of info.constituencies) keys.set(k.id, await P.importBlindPublicKey(P.unb64(k.signing_key)));
    for (let i = 0; i < d.count; i++) {
      const j = d.start + i, k: any = byCode.get(TK[j % 5]);
      const contests = info.contests.map((c: any) => ({ id: c.id, candidates: info.candidates.filter((x: any) => x.contest_id === c.id && x.constituency_id === k.id) }));
      const pub = keys.get(k.id)!;
      const pending = await P.createBlindedToken(pub);
      const { enc, ct } = await P.encryptBallot(P.unb64(info.election_key), { v: 1, e: d.electionId, c: k.id, s: randomChoice(contests) });
      pre.set(i, { pub, pending, enc, ct, constituencyId: k.id });
    }
  }
  parentPort!.postMessage('ready');
  await new Promise<void>((r) => parentPort!.once('message', () => r()));

  async function fastJourney(i: number, nid: string) {
    const p = pre.get(i); const t: Record<string, number> = {}; let t0 = performance.now();
    const mark = (k: string) => { const n = performance.now(); t[k] = n - t0; t0 = n; };
    const login = await call(d.base, '/api/voter/login', { body: { nationalId: nid, password: d.password } }); mark('login');
    const otp = await call(d.base, '/api/voter/otp', { body: { challengeId: login.challengeId, code: login.devOtp }, session: login.session }); mark('otp');
    await call(d.base, `/api/voter/elections/${d.electionId}/ballot`, { session: otp.session }); mark('ballot');
    const { blindSig } = await call(d.base, `/api/voter/elections/${d.electionId}/token`, { body: { blinded: P.b64(p.pending.blinded) }, session: otp.session }); mark('token');
    // finalize = unblind + verify; it is cheap but done after timing so the generator stays light
    const sig = await P.finalizeToken(p.pub, p.pending, P.unb64(blindSig)); t0 = performance.now();
    await call(d.base, '/api/cast', { body: { electionId: d.electionId, constituencyId: p.constituencyId, token: P.b64(p.pending.prepared), sig: P.b64(sig), enc: P.b64(p.enc), ct: P.b64(p.ct) } }); mark('cast');
    return t;
  }

  async function lane() {
    for (;;) {
      const i = next++; if (i >= d.count) return;
      const nid = String(BigInt(d.first) + BigInt(d.start + i));
      const t = performance.now();
      try {
        const timings = d.precompute ? await fastJourney(i, nid) : (await voteJourney(d.base, d.electionId, nid, d.password, randomChoice)).timings;
        ok++; steps.total.push(performance.now() - t);
        for (const [k, v] of Object.entries(timings)) (steps[k] ??= []).push(v as number);
      } catch (e) {
        const k = e instanceof ApiError ? `${e.status} ${e.body?.error ?? ''}` : (e as Error).message.slice(0, 60);
        errors[k] = (errors[k] ?? 0) + 1;
      }
    }
  }
  await Promise.all(Array.from({ length: d.concurrency }, lane));
  parentPort!.postMessage({ ok, steps, errors, busy });
}
