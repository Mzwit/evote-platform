// Demo/evaluation: closes the seeded election with two officials, runs the
// trustee ceremony with 3 of 5 shares, and prints reconciliation and timings.
//   node scripts/close-and-tally.ts --base http://localhost:8080
import { readFileSync } from 'node:fs';
import { call } from './voter-client.ts';
import { totp } from '../server/src/security.ts';
const i = process.argv.indexOf('--base'); const base = i > 0 ? process.argv[i + 1] : 'http://localhost:8080';
const demo = JSON.parse(readFileSync('seed-output/demo.json', 'utf8'));
const b32 = (s: string) => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, v = 0; const o: number[] = []; for (const c of s) { v = (v << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(o); };
const login = async (u: string) => (await call(base, '/api/admin/login', { body: { username: u, password: demo.officials.password, totp: totp(b32(demo.officials.totpSecrets[u])) } })).session;
const e = demo.electionId;
for (const u of ['admin1', 'admin2']) console.log(u, (await call(base, `/api/admin/elections/${e}/actions/close`, { body: { reason: 'polls closed (evaluation)' }, session: await login(u) })).status);
const grace = 125; console.log(`waiting ${grace}s closing grace period...`); await new Promise((r) => setTimeout(r, grace * 1000));
const t0 = performance.now();
for (const [i, u] of ['trustee1', 'trustee2', 'trustee4'].entries()) {
  const r = await call(base, `/api/admin/elections/${e}/trustee-share`, { body: { share: demo.trusteeShares[[0, 1, 3][i]] }, session: await login(u) });
  console.log(u, JSON.stringify(r));
}
console.log(`tally took ${((performance.now() - t0) / 1000).toFixed(1)} s`);
console.log(JSON.stringify(await call(base, `/api/public/elections/${e}/reconciliation`)));
const res = await call(base, `/api/public/elections/${e}/results`);
console.log(res.label, JSON.stringify(res.summary));
