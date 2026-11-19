// Ballot protocol v0 (PROTOTYPE) - shared by the browser, the server and the load tester.
//
// Uses only standardised, independently reviewed primitives:
//   - RFC 9474 RSABSSA-SHA384-PSS-Randomized blind signatures (@cloudflare/blindrsa-ts)
//   - RFC 9180 HPKE: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM (@hpke/core)
// No cryptographic algorithm is invented here; this file only wires them together.
// Production gate (Phase 9): replace the tally step with Belenios or ElectionGuard
// and have the whole protocol reviewed by independent cryptographers.

import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes128Gcm } from '@hpke/core';

export const PROTOCOL_VERSION = 1;
export const BALLOT_PAD_BYTES = 2048; // every plaintext is padded to the same length

export const blindSuite = () => RSABSSA.SHA384.PSS.Randomized();
export const hpkeSuite = () =>
  new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });

export type Selections = Record<string, string[]>; // contestId -> candidateIds

export interface BallotPlaintext {
  v: number;
  e: string; // election id
  c: string; // constituency id
  s: Selections;
}

// ---------- encoding helpers (browser + node) ----------
export const b64 = (u: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
};
export const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', all));
}

// Human-friendly tracking code: 20 base32 chars in groups of 4.
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export async function trackerFor(token: Uint8Array, enc: Uint8Array, ct: Uint8Array): Promise<string> {
  const h = await sha256(token, enc, ct);
  let out = '';
  for (let i = 0; i < 20; i++) out += B32[h[i] % 32];
  return out.match(/.{4}/g)!.join('-');
}

export async function importBlindPublicKey(spki: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', spki as BufferSource, { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
}

// ---------- client side: token ----------
export interface PendingToken { prepared: Uint8Array; inv: Uint8Array; blinded: Uint8Array }

export async function createBlindedToken(pub: CryptoKey): Promise<PendingToken> {
  const s = blindSuite();
  const prepared = s.prepare(crypto.getRandomValues(new Uint8Array(32)));
  const { blindedMsg, inv } = await s.blind(pub, prepared);
  return { prepared, inv, blinded: blindedMsg };
}

export async function finalizeToken(pub: CryptoKey, t: PendingToken, blindSig: Uint8Array): Promise<Uint8Array> {
  // finalize() verifies the signature and throws if the server misbehaved.
  return blindSuite().finalize(pub, t.prepared, blindSig, t.inv);
}

export async function verifyToken(pub: CryptoKey, token: Uint8Array, sig: Uint8Array): Promise<boolean> {
  try { return await blindSuite().verify(pub, sig, token); } catch { return false; }
}

// ---------- client side: ballot encryption ----------
export function encodeBallot(p: BallotPlaintext): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(p));
  if (body.length + 4 > BALLOT_PAD_BYTES) throw new Error('ballot too large');
  const out = new Uint8Array(BALLOT_PAD_BYTES); // zero padded, fixed length
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

export function decodeBallot(buf: Uint8Array): BallotPlaintext {
  if (buf.length !== BALLOT_PAD_BYTES) throw new Error('bad length');
  const n = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
  if (n > BALLOT_PAD_BYTES - 4) throw new Error('bad body length');
  return JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + n)));
}

export async function encryptBallot(electionPublicKey: Uint8Array, p: BallotPlaintext) {
  const suite = hpkeSuite();
  const pk = await suite.kem.deserializePublicKey(electionPublicKey);
  const ctx = await suite.createSenderContext({ recipientPublicKey: pk, info: new TextEncoder().encode('evote-ballot-v1:' + p.e) });
  const ct = new Uint8Array(await ctx.seal(encodeBallot(p), new TextEncoder().encode(p.c)));
  return { enc: new Uint8Array(ctx.enc), ct };
}

export async function decryptBallot(electionSk: Uint8Array, electionId: string, constituencyId: string, enc: Uint8Array, ct: Uint8Array) {
  const suite = hpkeSuite();
  const sk = await suite.kem.deserializePrivateKey(electionSk);
  const ctx = await suite.createRecipientContext({ recipientKey: sk, enc, info: new TextEncoder().encode('evote-ballot-v1:' + electionId) });
  return decodeBallot(new Uint8Array(await ctx.open(ct, new TextEncoder().encode(constituencyId))));
}

// ---------- bulletin board hash chain ----------
export async function boardEntryHash(prev: Uint8Array, position: number, tracker: string): Promise<Uint8Array> {
  return sha256(prev, new TextEncoder().encode(`|${position}|${tracker}`));
}
export const GENESIS = new Uint8Array(32);
export { hex };
