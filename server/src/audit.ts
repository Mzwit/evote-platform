// Tamper-evident, hash-chained audit log. Each record commits to the previous one,
// so any edit or deletion breaks the chain and is detected by verifyAuditChain().
import { createHash } from 'node:crypto';
import type { Client, Pool } from './db.ts';

const canon = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);

function recordHash(prev: Buffer, at: string, actor: string, action: string, details: unknown) {
  return createHash('sha256').update(prev).update(`|${at}|${actor}|${action}|${canon(details)}`).digest();
}

export async function audit(c: Client | Pool, actor: string, action: string, details: Record<string, unknown> = {}) {
  // Serialise writers so the chain is linear (audit volume is low).
  await c.query('SELECT pg_advisory_xact_lock(777001)');
  const last = await c.query('SELECT hash FROM adm.audit_log ORDER BY seq DESC LIMIT 1');
  const prev: Buffer = last.rows[0]?.hash ?? Buffer.alloc(32);
  const at = new Date().toISOString();
  const hash = recordHash(prev, at, actor, action, details);
  await c.query('INSERT INTO adm.audit_log(at, actor, action, details, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6)',
    [at, actor, action, details, prev, hash]);
}

export async function verifyAuditChain(pool: Pool) {
  const { rows } = await pool.query('SELECT seq, at, actor, action, details, prev_hash, hash FROM adm.audit_log ORDER BY seq');
  let prev = Buffer.alloc(32);
  for (const r of rows) {
    const at = new Date(r.at).toISOString();
    if (!r.prev_hash.equals(prev) || !recordHash(prev, at, r.actor, r.action, r.details).equals(r.hash)) {
      return { ok: false, brokenAt: r.seq, records: rows.length };
    }
    prev = r.hash;
  }
  return { ok: true, records: rows.length, head: prev.toString('hex') };
}
