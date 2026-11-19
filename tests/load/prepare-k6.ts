// Pre-computes data for the k6 test: blinded token requests for the identity
// scenario, and fully valid (token-signed, encrypted) ballots for the cast storm.
//   node tests/load/prepare-k6.ts --base http://staging:8080 --voters 20000 --casts 20000
import { writeFileSync, readFileSync } from 'node:fs';
import * as P from '../../shared/protocol.ts';
import { call, randomChoice } from '../../scripts/voter-client.ts';
const a = (k: string, d: string) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const base = a('base', 'http://localhost:8080'), nV = +a('voters', '1000'), nC = +a('casts', '1000');
const demo = JSON.parse(readFileSync('seed-output/demo.json', 'utf8'));
const info = await call(base, `/api/public/elections/${demo.electionId}`);
const TK = ['HH-MBE', 'HH-LOB', 'MN-MZN', 'LU-SIT', 'SH-NHL'];
const byCode = new Map(info.constituencies.map((k: any) => [k.code, k]));
const voters: any[] = [], casts: any[] = [];
for (let j = 0; j < nV; j++) {
  const k: any = byCode.get(TK[j % 5]);
  const pending = await P.createBlindedToken(await P.importBlindPublicKey(P.unb64(k.signing_key)));
  voters.push({ nationalId: String(BigInt(demo.voters.firstNationalId) + BigInt(j)), password: demo.voters.password, blinded: P.b64(pending.blinded) });
}
// Casts need real tokens, so a separate voter range goes through issuance now;
// the signed, encrypted ballots are saved but NOT cast. The k6 storm casts them.
for (let j = nV; j < nV + nC; j++) {
  const nid = String(BigInt(demo.voters.firstNationalId) + BigInt(j));
  const l = await call(base, '/api/voter/login', { body: { nationalId: nid, password: demo.voters.password } });
  const { session } = await call(base, '/api/voter/otp', { body: { challengeId: l.challengeId, code: l.devOtp }, session: l.session });
  const b = await call(base, `/api/voter/elections/${demo.electionId}/ballot`, { session });
  const pub = await P.importBlindPublicKey(P.unb64(b.signingKey));
  const pending = await P.createBlindedToken(pub);
  const { blindSig } = await call(base, `/api/voter/elections/${demo.electionId}/token`, { body: { blinded: P.b64(pending.blinded) }, session });
  const sig = await P.finalizeToken(pub, pending, P.unb64(blindSig));
  const { enc, ct } = await P.encryptBallot(P.unb64(b.electionKey), { v: 1, e: demo.electionId, c: b.constituencyId, s: randomChoice(b.contests) });
  casts.push({ electionId: demo.electionId, constituencyId: b.constituencyId, token: P.b64(pending.prepared), sig: P.b64(sig), enc: P.b64(enc), ct: P.b64(ct) });
}
writeFileSync('tests/load/k6-data.json', JSON.stringify({ electionId: demo.electionId, voters, casts }));
console.log(`wrote ${voters.length} identity journeys and ${casts.length} casts to tests/load/k6-data.json`);
