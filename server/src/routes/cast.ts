// Anonymous casting service (Phase 9).
// - No session, no cookie, no IP address is logged or stored on this path.
// - A ballot is acknowledged only AFTER PostgreSQL has committed it
//   (synchronous_commit=on; production adds synchronous_standby_names so the
//   commit is on two servers before the voter sees "accepted").
// - Retrying the same submission returns the original receipt (idempotent).
import type { FastifyInstance } from 'fastify';
import { createHash, createPublicKey, verify as rsaVerify, constants, type KeyObject } from 'node:crypto';
import { pools } from '../db.ts';
import { metrics } from '../metrics.ts';
import { HttpError, castWindowOpen, getElection } from '../elections.ts';
import { unb64, BALLOT_PAD_BYTES } from '../../../shared/protocol.ts';
import { signReceipt } from '../keys.ts';

// Server-side checks use OpenSSL synchronously instead of WebCrypto: WebCrypto jobs
// share libuv's small thread pool with password hashing, so under a login rush
// ballots would queue behind logins. These calls take microseconds.
const keyCache = new Map<string, KeyObject>();
async function constituencyKey(electionId: string, constituencyId: string): Promise<KeyObject | null> {
  const k = `${electionId}:${constituencyId}`;
  let key = keyCache.get(k);
  if (!key) {
    const r = (await pools.ballot.query('SELECT public_spki FROM cfg.signing_keys WHERE election_id=$1 AND constituency_id=$2', [electionId, constituencyId])).rows[0];
    if (!r) return null;
    key = createPublicKey({ key: r.public_spki, format: 'der', type: 'spki' });
    keyCache.set(k, key);
  }
  return key;
}

const b64 = { type: 'string', pattern: '^[A-Za-z0-9+/]+={0,2}$' };

export async function castRoutes(app: FastifyInstance) {
  app.post('/api/cast', {
    bodyLimit: 8192,
    schema: { body: { type: 'object', additionalProperties: false, required: ['electionId', 'constituencyId', 'token', 'sig', 'enc', 'ct'],
      properties: { electionId: { type: 'string', format: 'uuid' }, constituencyId: { type: 'string', format: 'uuid' },
        token: { ...b64, maxLength: 128 }, sig: { ...b64, maxLength: 400 }, enc: { ...b64, maxLength: 64 }, ct: { ...b64, maxLength: 3000 } } } },
  }, async (req) => {
    const b = req.body as Record<string, string>;
    const e = await getElection(b.electionId);
    if (!e) throw new HttpError(404, 'election not found');
    if (!castWindowOpen(e)) { metrics.ballotsRejected.inc({ reason: 'closed' }); throw new HttpError(409, 'voting is closed for this election', { code: 'CLOSED' }); }

    const token = Buffer.from(unb64(b.token)), sig = Buffer.from(unb64(b.sig)), enc = Buffer.from(unb64(b.enc)), ct = Buffer.from(unb64(b.ct));
    if (token.length !== 64 || sig.length !== 256 || enc.length !== 32 || ct.length !== BALLOT_PAD_BYTES + 16) {
      metrics.ballotsRejected.inc({ reason: 'malformed' }); throw new HttpError(400, 'malformed ballot');
    }
    const pub = await constituencyKey(b.electionId, b.constituencyId);
    // RFC 9474 Verify = RSASSA-PSS verification (SHA-384, 48-byte salt) of the prepared message.
    if (!pub || !rsaVerify('sha384', token, { key: pub, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 }, sig)) { metrics.ballotsRejected.inc({ reason: 'bad_token' }); throw new HttpError(403, 'ballot token is not valid'); }

    const tokenHash = createHash('sha256').update(token).digest();
    const tracker = trackerFor(token, enc, ct);
    const ins = await pools.ballot.query(
      `INSERT INTO ballot.ballots(election_id, constituency_id, token, token_sig, token_hash, enc, ct, tracker)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (election_id, token_hash) DO NOTHING RETURNING seq, received_minute`,
      [b.electionId, b.constituencyId, token, sig, tokenHash, enc, ct, tracker]);

    let row = ins.rows[0];
    if (!row) {
      const prev = (await pools.ballot.query('SELECT tracker, received_minute FROM ballot.ballots WHERE election_id=$1 AND token_hash=$2', [b.electionId, tokenHash])).rows[0];
      if (!prev || prev.tracker !== tracker) {
        metrics.ballotsRejected.inc({ reason: 'token_used' });
        throw new HttpError(409, 'this ballot token has already been used', { code: 'TOKEN_USED' });
      }
      metrics.ballotsReplayed.inc();
      row = prev;
    } else {
      metrics.ballotsAccepted.inc();
    }
    const acceptedAt = new Date(row.received_minute).toISOString();
    const statement = `accepted|${b.electionId}|${tracker}|${acceptedAt}`;
    return { status: 'ACCEPTED', tracker, acceptedAt, statement, receiptSignature: signReceipt(b.electionId, e.receipt_private_enc, statement) };
  });
}

// Same derivation as shared/protocol.ts trackerFor(), computed synchronously.
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function trackerFor(token: Buffer, enc: Buffer, ct: Buffer): string {
  const h = createHash('sha256').update(token).update(enc).update(ct).digest();
  let out = '';
  for (let i = 0; i < 20; i++) out += B32[h[i] % 32];
  return out.match(/.{4}/g)!.join('-');
}
