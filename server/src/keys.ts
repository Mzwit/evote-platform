// Election key material.
//   - Blind-signing keys (RSA-2048, RFC 9474), one per constituency, wrapped under the KEK.
//   - The election encryption key (X25519 HPKE). Its private half is split with Shamir
//     into trustee shares immediately and then discarded; the server never stores it.
//   - Receipt signing key (Ed25519).
import nodeCrypto from 'node:crypto';
import { split } from 'shamir-secret-sharing';
import { blindSuite, hpkeSuite, sha256 } from '../../shared/protocol.ts';
import { unwrapKey, wrapKey } from './security.ts';

export async function newBlindSigningKey() {
  const kp = await blindSuite().generateKey({ publicExponent: Uint8Array.from([1, 0, 1]), modulusLength: 2048 });
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', kp.publicKey));
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  return { spki, privateEnc: wrapKey(pkcs8) };
}

export async function newElectionKey(trustees: number, threshold: number) {
  const suite = hpkeSuite();
  const kp = await suite.kem.generateKeyPair();
  const pk = new Uint8Array(await suite.kem.serializePublicKey(kp.publicKey));
  const sk = new Uint8Array(await suite.kem.serializePrivateKey(kp.privateKey));
  const shares = await split(sk, trustees, threshold);
  const commit = await sha256(sk);
  sk.fill(0); // best effort: JS cannot guarantee memory wiping
  return { publicKey: Buffer.from(pk), commit: Buffer.from(commit), shares: shares.map((s) => Buffer.from(s).toString('base64')) };
}

export function newReceiptKey() {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ed25519');
  return {
    spki: publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
    privateEnc: wrapKey(privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer),
  };
}

// ---------- caches used on the hot path ----------
const signerCache = new Map<string, { key: nodeCrypto.KeyObject; pub: nodeCrypto.KeyObject; spki: Buffer }>();

export function blindSigner(cacheKey: string, spki: Buffer, privateEnc: Buffer) {
  let s = signerCache.get(cacheKey);
  if (!s) {
    s = {
      key: nodeCrypto.createPrivateKey({ key: unwrapKey(privateEnc), format: 'der', type: 'pkcs8' }),
      pub: nodeCrypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }),
      spki,
    };
    signerCache.set(cacheKey, s);
  }
  return s;
}

// RFC 9474 Section 4.3 BlindSign: s = RSASP1(sk, m), then check RSAVP1(pk, s) == m.
// Uses OpenSSL's native RSA private operation (with OpenSSL's own blinding),
// about 1000x faster than a pure-JS big-integer implementation.
export function blindSign(signer: { key: nodeCrypto.KeyObject; pub: nodeCrypto.KeyObject }, blinded: Buffer): Buffer {
  const s = nodeCrypto.privateDecrypt({ key: signer.key, padding: nodeCrypto.constants.RSA_NO_PADDING }, blinded);
  const check = nodeCrypto.publicEncrypt({ key: signer.pub, padding: nodeCrypto.constants.RSA_NO_PADDING }, s);
  if (!check.equals(blinded)) throw new Error('signing failure');
  return s;
}

const receiptCache = new Map<string, nodeCrypto.KeyObject>();
export function signReceipt(electionId: string, privateEnc: Buffer, message: string): string {
  let k = receiptCache.get(electionId);
  if (!k) { k = nodeCrypto.createPrivateKey({ key: unwrapKey(privateEnc), format: 'der', type: 'pkcs8' }); receiptCache.set(electionId, k); }
  return nodeCrypto.sign(null, Buffer.from(message), k).toString('base64');
}
