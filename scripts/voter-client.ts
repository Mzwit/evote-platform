// A scripted voter that walks the full journey exactly like the PWA does:
// login -> OTP -> ballot -> blind token -> encrypt -> anonymous cast -> receipt.
// Used by the integration tests and by the load tester.
import {
  b64, unb64, importBlindPublicKey, createBlindedToken, finalizeToken, encryptBallot, type Selections,
} from '../shared/protocol.ts';

export class ApiError extends Error {
  status: number; body: any;
  constructor(status: number, body: any) { super(`${status} ${body?.error ?? ''}`); this.status = status; this.body = body; }
}

export async function call(base: string, path: string, opts: { method?: string; body?: unknown; session?: string; retries?: number } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(base + path, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', ...(opts.session ? { authorization: `Bearer ${opts.session}` } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    // Waiting room / transient errors: retry with jitter. Safe because every write is idempotent.
    if ((res.status === 503 || (res.status >= 500 && body?.retryable)) && attempt < (opts.retries ?? 20)) {
      const wait = Math.min(10_000, (body.retryAfterSeconds ?? 1) * 1000) * (0.5 + Math.random());
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new ApiError(res.status, body);
    return body;
  }
}

export type Timings = Record<string, number>;

export async function voteJourney(base: string, electionId: string, nationalId: string, password: string,
  choose: (contests: any[]) => Selections = firstChoice) {
  const t: Timings = {};
  let t0 = performance.now();
  const mark = (k: string) => { const n = performance.now(); t[k] = n - t0; t0 = n; };

  const login = await call(base, '/api/voter/login', { body: { nationalId, password } }); mark('login');
  const otp = await call(base, '/api/voter/otp', { body: { challengeId: login.challengeId, code: login.devOtp }, session: login.session }); mark('otp');
  const session = otp.session;
  const ballot = await call(base, `/api/voter/elections/${electionId}/ballot`, { session }); mark('ballot');
  const selections = choose(ballot.contests);

  const pub = await importBlindPublicKey(unb64(ballot.signingKey));
  const pending = await createBlindedToken(pub); mark('clientBlind');
  const { blindSig } = await call(base, `/api/voter/elections/${electionId}/token`, { body: { blinded: b64(pending.blinded) }, session }); mark('token');
  const sig = await finalizeToken(pub, pending, unb64(blindSig)); mark('clientFinalize');
  const { enc, ct } = await encryptBallot(unb64(ballot.electionKey), { v: 1, e: electionId, c: ballot.constituencyId, s: selections }); mark('clientEncrypt');
  const cast = { electionId, constituencyId: ballot.constituencyId, token: b64(pending.prepared), sig: b64(sig), enc: b64(enc), ct: b64(ct) };
  const receipt = await call(base, '/api/cast', { body: cast }); mark('cast');
  return { receipt, cast, ballot, selections, session, timings: t };
}

export const firstChoice = (contests: any[]): Selections =>
  Object.fromEntries(contests.map((c) => [c.id, [c.candidates[0].id]]));
export const randomChoice = (contests: any[]): Selections =>
  Object.fromEntries(contests.map((c) => [c.id, [c.candidates[Math.floor(Math.random() * c.candidates.length)].id]]));
