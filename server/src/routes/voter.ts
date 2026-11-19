// Identity service: voter login, eligibility, anonymous token issuance (Phase 8).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { pools, tx } from '../db.ts';
import { config } from '../config.ts';
import { verifyPassword, signSession, readSession, newOtp, hashOtp } from '../security.ts';
import { RateLimiter } from '../admission.ts';
import { metrics } from '../metrics.ts';
import { HttpError, issuanceOpen } from '../elections.ts';
import { blindSigner, blindSign } from '../keys.ts';
import { sendSms } from '../sms.ts';

// Per-IP limit. Behind carrier-grade NAT many voters share one IP, so production
// tunes this with real traffic data (and enforces it in Valkey across instances).
const ipLimiter = new RateLimiter(Number(process.env.LOGIN_IP_BURST ?? 30), Number(process.env.LOGIN_IP_PER_SEC ?? 0.5));
const idLimiter = new RateLimiter(10, 0.05);     // per national ID

function voter(req: FastifyRequest, stage: 'otp' | 'full' = 'full') {
  const s = readSession(req.headers.authorization?.replace(/^Bearer /, ''));
  if (!s || s.kind !== 'voter' || (stage === 'full' && s.stage !== 'full')) throw new HttpError(401, 'please sign in again');
  return s;
}

export async function voterRoutes(app: FastifyInstance) {
  app.post('/api/voter/login', {
    schema: { body: { type: 'object', required: ['nationalId', 'password'], additionalProperties: false,
      properties: { nationalId: { type: 'string', pattern: '^[0-9]{6,20}$' }, password: { type: 'string', minLength: 1, maxLength: 200 } } } },
  }, async (req) => {
    const { nationalId, password } = req.body as { nationalId: string; password: string };
    if (!ipLimiter.take(req.ip) || !idLimiter.take(nationalId)) {
      metrics.logins.inc({ result: 'limited' });
      throw new HttpError(429, 'too many attempts, please wait a minute and try again');
    }
    const v = (await pools.identity.query(
      'SELECT id, password_hash, status, phone, locked_until FROM identity.voters WHERE national_id=$1', [nationalId])).rows[0];
    const ok = await verifyPassword(password, v?.password_hash);
    if (!v || !ok || v.status !== 'ACTIVE' || (v.locked_until && new Date(v.locked_until) > new Date())) {
      if (v) await pools.identity.query(
        `UPDATE identity.voters SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END WHERE id=$1`, [v.id]);
      metrics.logins.inc({ result: 'fail' });
      throw new HttpError(401, 'ID number or password is incorrect, or the account is not active');
    }
    await pools.identity.query('UPDATE identity.voters SET failed_logins=0, locked_until=NULL WHERE id=$1', [v.id]);
    const code = newOtp();
    const ch = (await pools.identity.query(
      "INSERT INTO identity.otp_challenges(voter_id, code_hash, expires_at) VALUES ($1, $2, now() + interval '5 minutes') RETURNING id",
      [v.id, Buffer.alloc(32)])).rows[0];
    await pools.identity.query('UPDATE identity.otp_challenges SET code_hash=$2 WHERE id=$1', [ch.id, hashOtp(ch.id, code)]);
    await sendSms(v.phone, `Your voting code is ${code}. It expires in 5 minutes. Never share it.`);
    metrics.logins.inc({ result: 'password_ok' });
    return {
      challengeId: ch.id,
      session: signSession({ sub: v.id, kind: 'voter', stage: 'otp' }, 300),
      phoneHint: v.phone ? `•••• ${String(v.phone).slice(-3)}` : null,
      ...(config.devShowOtp ? { devOtp: code } : {}),
    };
  });

  app.post('/api/voter/otp', {
    schema: { body: { type: 'object', required: ['challengeId', 'code'], additionalProperties: false,
      properties: { challengeId: { type: 'string', format: 'uuid' }, code: { type: 'string', pattern: '^[0-9]{6}$' } } } },
  }, async (req) => {
    const s = voter(req, 'otp');
    const { challengeId, code } = req.body as { challengeId: string; code: string };
    const r = await tx(pools.identity, async (c) => {
      const ch = (await c.query('SELECT * FROM identity.otp_challenges WHERE id=$1 AND voter_id=$2 FOR UPDATE', [challengeId, s.sub])).rows[0];
      if (!ch || ch.used || new Date(ch.expires_at) < new Date() || ch.attempts >= 5) throw new HttpError(401, 'this code has expired, please sign in again');
      if (!hashOtp(challengeId, code).equals(ch.code_hash)) {
        await c.query('UPDATE identity.otp_challenges SET attempts = attempts + 1 WHERE id=$1', [challengeId]);
        // commit the attempt counter even though we reject
        return { error: true as const, attemptsLeft: 4 - ch.attempts };
      }
      await c.query('UPDATE identity.otp_challenges SET used=true WHERE id=$1', [challengeId]);
      metrics.logins.inc({ result: 'ok' });
      return { session: signSession({ sub: s.sub, kind: 'voter', stage: 'full' }, 1800) };
    });
    if ('error' in r) throw new HttpError(401, `wrong code, ${r.attemptsLeft} attempt(s) left`);
    return r;
  });

  app.get('/api/voter/me', async (req) => {
    const s = voter(req);
    const v = (await pools.identity.query('SELECT full_name, constituency_code FROM identity.voters WHERE id=$1', [s.sub])).rows[0];
    const elections = (await pools.identity.query(
      `SELECT e.id, e.name, e.status, e.opens_at, e.closes_at, k.name AS constituency,
              (t.voter_id IS NOT NULL) AS token_issued
         FROM identity.roll r JOIN cfg.elections e ON e.id=r.election_id
         JOIN cfg.constituencies k ON k.id=r.constituency_id
         LEFT JOIN identity.token_issuance t ON t.election_id=r.election_id AND t.voter_id=r.voter_id
        WHERE r.voter_id=$1 ORDER BY e.opens_at DESC`, [s.sub])).rows;
    return { name: v.full_name, constituencyCode: v.constituency_code, elections };
  });

  app.get('/api/voter/elections/:id/ballot', async (req) => {
    const s = voter(req);
    const { id } = req.params as { id: string };
    const r = (await pools.identity.query(
      `SELECT r.constituency_id, k.name AS constituency, e.name, e.status, e.hpke_public_key, e.parties_enabled, e.closes_at, sk.public_spki
         FROM identity.roll r JOIN cfg.elections e ON e.id=r.election_id JOIN cfg.constituencies k ON k.id=r.constituency_id
         JOIN cfg.signing_keys sk ON sk.election_id=r.election_id AND sk.constituency_id=r.constituency_id
        WHERE r.election_id=$1 AND r.voter_id=$2`, [id, s.sub])).rows[0];
    if (!r) throw new HttpError(403, 'you are not on the voter roll for this election');
    const contests = (await pools.identity.query(
      `SELECT t.id, t.name, t.max_choices,
              coalesce(json_agg(json_build_object('id', c.id, 'name', c.name, 'party', CASE WHEN $3 THEN c.party END, 'bio', c.bio, 'photoUrl', c.photo_url) ORDER BY c.sort, c.name)
                FILTER (WHERE c.id IS NOT NULL), '[]') AS candidates
         FROM cfg.contests t LEFT JOIN cfg.candidates c ON c.contest_id=t.id AND c.constituency_id=$2
        WHERE t.election_id=$1 GROUP BY t.id ORDER BY t.sort, t.name`, [id, r.constituency_id, r.parties_enabled])).rows
      .filter((t) => t.candidates.length);
    return {
      electionId: id, name: r.name, status: r.status, closesAt: r.closes_at,
      constituencyId: r.constituency_id, constituency: r.constituency, contests,
      signingKey: r.public_spki.toString('base64'), electionKey: r.hpke_public_key.toString('base64'),
    };
  });

  // Exactly one token per voter per election. Retrying with the SAME blinded
  // message returns the same signature (safe retry); a different one is refused.
  app.post('/api/voter/elections/:id/token', {
    schema: { body: { type: 'object', required: ['blinded'], additionalProperties: false, properties: { blinded: { type: 'string', maxLength: 400 } } } },
  }, async (req) => {
    const s = voter(req);
    const { id } = req.params as { id: string };
    const blinded = Buffer.from((req.body as { blinded: string }).blinded, 'base64');
    if (blinded.length !== 256) throw new HttpError(400, 'malformed token request');
    const bh = createHash('sha256').update(blinded).digest();

    return tx(pools.identity, async (c) => {
      const row = (await c.query(
        `SELECT r.constituency_id, e.status, e.opens_at, e.closes_at, sk.public_spki, sk.private_enc
           FROM identity.roll r JOIN cfg.elections e ON e.id=r.election_id
           JOIN cfg.signing_keys sk ON sk.election_id=r.election_id AND sk.constituency_id=r.constituency_id
          WHERE r.election_id=$1 AND r.voter_id=$2`, [id, s.sub])).rows[0];
      if (!row) throw new HttpError(403, 'you are not on the voter roll for this election');
      if (!issuanceOpen(row)) throw new HttpError(409, 'voting is not open for this election');

      const existing = (await c.query('SELECT blinded_hash, blind_sig FROM identity.token_issuance WHERE election_id=$1 AND voter_id=$2', [id, s.sub])).rows[0];
      if (existing) {
        if (existing.blinded_hash.equals(bh)) { return { blindSig: existing.blind_sig.toString('base64'), replay: true }; }
        throw new HttpError(409, 'a ballot token has already been issued to you for this election', { code: 'ALREADY_ISSUED' });
      }
      const signer = blindSigner(`${id}:${row.constituency_id}`, row.public_spki, row.private_enc);
      let sig: Buffer;
      try { sig = blindSign(signer, blinded); } catch { throw new HttpError(400, 'malformed token request'); }
      // The primary key (election_id, voter_id) makes a second issuance impossible,
      // even if two requests race past the check above.
      try {
        await c.query(`INSERT INTO identity.token_issuance(election_id, voter_id, constituency_id, blinded_hash, blind_sig) VALUES ($1,$2,$3,$4,$5)`,
          [id, s.sub, row.constituency_id, bh, sig]);
      } catch (e: any) {
        if (e.code === '23505') throw new HttpError(409, 'a ballot token has already been issued to you for this election', { code: 'ALREADY_ISSUED' });
        throw e;
      }
      metrics.tokensIssued.inc();
      return { blindSig: sig.toString('base64') };
    });
  });
}
