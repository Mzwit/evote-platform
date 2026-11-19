import type { AddressInfo } from 'node:net';
import { buildApp } from '../server/src/app.ts';
import { createDemoElection, DEMO_OFFICIAL_PASSWORD } from '../server/src/demo.ts';
import { totp } from '../server/src/security.ts';
import { call } from '../scripts/voter-client.ts';

export async function startServer() {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { app, base };
}

function b32decode(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, v = 0; const out: number[] = [];
  for (const ch of s) { v = (v << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}

export async function officialSession(base: string, demo: Awaited<ReturnType<typeof createDemoElection>>, username: string) {
  const code = totp(b32decode(demo.officials.totpSecrets[username]));
  const r = await call(base, '/api/admin/login', { body: { username, password: DEMO_OFFICIAL_PASSWORD, totp: code } });
  return r.session as string;
}

export const nid = (demo: { voters: { firstNationalId: string } }, i: number) => String(BigInt(demo.voters.firstNationalId) + BigInt(i));
export { createDemoElection };
