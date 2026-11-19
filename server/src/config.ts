import { createHash } from 'node:crypto';

const env = process.env;
const isProd = env.NODE_ENV === 'production';
// DEMO_MODE=1: a public demonstration with fictional data. It shows the SMS code on
// screen instead of sending it and creates a demo election on first start.
const demoMode = env.DEMO_MODE === '1';

// Hosted databases (e.g. Neon) give one owner URL. The least-privilege role URLs are
// derived from it, with each role's password taken from its own environment variable.
function roleUrl(name: string, user: string, pwVar: string, devDefault: string): string {
  if (env[name]) return env[name]!;
  const owner = env.DATABASE_URL;
  if (owner && env[pwVar]) {
    const u = new URL(owner);
    u.username = user; u.password = encodeURIComponent(env[pwVar]!);
    return u.toString();
  }
  return required(name, devDefault);
}
// Accept any secret string for the KEK; anything that is not exactly 32 bytes of base64 is hashed to 32 bytes.
function kek(v: string): Buffer {
  const b = Buffer.from(v, 'base64');
  return b.length === 32 ? b : createHash('sha256').update(v).digest();
}

function required(name: string, devDefault: string): string {
  const v = env[name];
  if (v) return v;
  if (isProd) throw new Error(`Missing required environment variable ${name}`);
  return devDefault;
}

export const config = {
  isProd,
  demoMode,
  port: Number(env.PORT ?? 8080),
  host: env.HOST ?? '0.0.0.0',
  // Which services this process runs: identity, cast, admin, public, or all.
  services: new Set((env.SERVICES ?? 'all').split(',')),
  db: {
    identity: roleUrl('DATABASE_URL_IDENTITY', 'evote_identity', 'IDENTITY_DB_PASSWORD', 'postgres://evote_identity:dev-identity@localhost:5432/evote'),
    ballot: roleUrl('DATABASE_URL_BALLOT', 'evote_ballot', 'BALLOT_DB_PASSWORD', 'postgres://evote_ballot:dev-ballot@localhost:5432/evote'),
    admin: roleUrl('DATABASE_URL_ADMIN', 'evote_admin', 'ADMIN_DB_PASSWORD', 'postgres://evote_admin:dev-admin@localhost:5432/evote'),
    owner: env.DATABASE_URL_OWNER ?? env.DATABASE_URL ?? 'postgres://evote:evote@localhost:5432/evote',
    rolePasswords: { evote_identity: env.IDENTITY_DB_PASSWORD, evote_ballot: env.BALLOT_DB_PASSWORD, evote_admin: env.ADMIN_DB_PASSWORD },
    poolSize: Number(env.DB_POOL_SIZE ?? 20),
  },
  // Key-encryption key for signing keys at rest. Production: fetched from OpenBao / HSM.
  kek: kek(required('KEK_BASE64', Buffer.alloc(32, 7).toString('base64'))),
  sessionSecret: Buffer.from(required('SESSION_SECRET', 'dev-only-session-secret-change-me'), 'utf8'),
  otpPepper: required('OTP_PEPPER', 'dev-pepper'),
  // Development only: return the OTP in the API response instead of sending an SMS.
  devShowOtp: (!isProd || demoMode) && env.DEV_SHOW_OTP !== '0',
  admission: {
    maxInflight: Number(env.MAX_INFLIGHT ?? 512),
    maxQueue: Number(env.MAX_QUEUE ?? 5000),
    queueTimeoutMs: Number(env.QUEUE_TIMEOUT_MS ?? 10000),
  },
  sealIntervalMs: Number(env.SEAL_INTERVAL_MS ?? 1000),
  webDist: env.WEB_DIST ?? new URL('../../web/dist', import.meta.url).pathname,
  logLevel: env.LOG_LEVEL ?? (isProd ? 'info' : 'warn'),
};
