// Password hashing, session tokens, OTP and TOTP, key encryption at rest.
import { scrypt, randomBytes, timingSafeEqual, createHmac, createHash, createCipheriv, createDecipheriv, randomInt } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.ts';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await scryptAsync(pw.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

// A fixed dummy hash keeps timing similar when the user does not exist.
const DUMMY = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
export async function verifyPassword(pw: string, stored: string | null | undefined): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = (stored ?? DUMMY).split('$');
  if (alg !== 'scrypt') return false;
  const dk = await scryptAsync(pw.normalize('NFKC'), Buffer.from(salt, 'base64'), 32, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  const ok = timingSafeEqual(dk, Buffer.from(hash, 'base64'));
  return ok && !!stored;
}

// ---------- stateless signed session tokens (Authorization: Bearer) ----------
export interface Session { sub: string; kind: 'voter' | 'official'; stage: 'otp' | 'full'; roles?: string[]; exp: number }

export function signSession(s: Omit<Session, 'exp'>, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ ...s, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const mac = createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function readSession(token: string | undefined): Session | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = createHmac('sha256', config.sessionSecret).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const s = JSON.parse(Buffer.from(body, 'base64url').toString()) as Session;
  if (s.exp < Date.now() / 1000) return null;
  return s;
}

// ---------- SMS one-time codes ----------
export const newOtp = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
export const hashOtp = (id: string, code: string) => createHash('sha256').update(`${config.otpPepper}|${id}|${code}`).digest();

// ---------- TOTP (RFC 6238) for officials ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function totp(secret: Buffer, t = Date.now(), step = 30): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / step)));
  const h = createHmac('sha1', secret).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}
export function verifyTotp(secret: Buffer, code: string): boolean {
  const now = Date.now();
  return [-30000, 0, 30000].some((d) => {
    const want = Buffer.from(totp(secret, now + d));
    const got = Buffer.from(code.padStart(6, '0').slice(0, 6));
    return timingSafeEqual(want, got);
  });
}

// ---------- AES-256-GCM key wrapping (dev stand-in for HSM / OpenBao transit) ----------
export function wrapKey(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', config.kek, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
export function unwrapKey(blob: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', config.kek, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}
