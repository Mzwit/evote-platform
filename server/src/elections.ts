// Election state machine and multi-person approvals (Phase 10).
//
//   DRAFT --publish--> PUBLISHED --open--> OPEN <--suspend/resume--> SUSPENDED
//   OPEN|SUSPENDED --close--> CLOSED --(trustee ceremony)--> TALLIED (preliminary)
//   TALLIED --verify--> VERIFIED --declare--> DECLARED
//
// Every transition except the trustee ceremony needs approval from distinct
// officials holding the listed roles. The requester's own approval counts once.
import type { Client } from './db.ts';
import { pools, tx } from './db.ts';
import { audit } from './audit.ts';
import { newBlindSigningKey, newElectionKey, newReceiptKey } from './keys.ts';

export type Status = 'DRAFT' | 'PUBLISHED' | 'OPEN' | 'SUSPENDED' | 'CLOSED' | 'TALLIED' | 'VERIFIED' | 'DECLARED';

export const TRANSITIONS: Record<string, { from: Status[]; to: Status; roles: string[][] }> = {
  // roles: one entry per required approver; each entry lists the roles that may fill that slot.
  publish: { from: ['DRAFT'], to: 'PUBLISHED', roles: [['NATIONAL_ADMIN'], ['NATIONAL_ADMIN']] },
  open: { from: ['PUBLISHED'], to: 'OPEN', roles: [['NATIONAL_ADMIN'], ['NATIONAL_ADMIN']] },
  suspend: { from: ['OPEN'], to: 'SUSPENDED', roles: [['NATIONAL_ADMIN', 'SECURITY_OFFICER'], ['NATIONAL_ADMIN', 'SECURITY_OFFICER']] },
  resume: { from: ['SUSPENDED'], to: 'OPEN', roles: [['NATIONAL_ADMIN'], ['NATIONAL_ADMIN', 'SECURITY_OFFICER']] },
  close: { from: ['OPEN', 'SUSPENDED'], to: 'CLOSED', roles: [['NATIONAL_ADMIN'], ['NATIONAL_ADMIN']] },
  verify: { from: ['TALLIED'], to: 'VERIFIED', roles: [['AUDITOR'], ['NATIONAL_ADMIN']] },
  declare: { from: ['VERIFIED'], to: 'DECLARED', roles: [['NATIONAL_ADMIN'], ['NATIONAL_ADMIN']] },
};

export class HttpError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) { super(message); this.status = status; this.extra = extra; }
}

// Assign each approver to a distinct slot (small bipartite matching).
export function slotsSatisfied(slots: string[][], approvers: { roles: string[] }[]): boolean {
  const used = new Array(approvers.length).fill(false);
  const fill = (i: number): boolean => {
    if (i === slots.length) return true;
    for (let a = 0; a < approvers.length; a++) {
      if (!used[a] && approvers[a].roles.some((r) => slots[i].includes(r))) {
        used[a] = true; if (fill(i + 1)) return true; used[a] = false;
      }
    }
    return false;
  };
  return fill(0);
}

export async function requestOrApprove(electionId: string, action: string, official: { id: string; username: string; roles: string[] }, reason: string) {
  const t = TRANSITIONS[action];
  if (!t) throw new HttpError(400, 'unknown action');
  if (!official.roles.some((r) => t.roles.flat().includes(r))) throw new HttpError(403, 'your role cannot approve this action');

  return tx(pools.admin, async (c) => {
    const e = (await c.query('SELECT id, status FROM cfg.elections WHERE id=$1 FOR UPDATE', [electionId])).rows[0];
    if (!e) throw new HttpError(404, 'election not found');
    if (!t.from.includes(e.status)) throw new HttpError(409, `cannot ${action} an election that is ${e.status}`);

    let ap = (await c.query("SELECT * FROM adm.approvals WHERE election_id=$1 AND action=$2 AND status='PENDING'", [electionId, action])).rows[0];
    if (!ap) {
      ap = (await c.query('INSERT INTO adm.approvals(election_id, action, reason, requested_by) VALUES ($1,$2,$3,$4) RETURNING *',
        [electionId, action, reason, official.id])).rows[0];
      await audit(c, official.username, `approval.requested`, { electionId, action, reason });
    }
    const already = await c.query('SELECT 1 FROM adm.approval_votes WHERE approval_id=$1 AND official_id=$2', [ap.id, official.id]);
    if (already.rowCount) throw new HttpError(409, 'you have already approved this request; a different official must approve');
    const role = official.roles.find((r) => t.roles.flat().includes(r))!;
    await c.query('INSERT INTO adm.approval_votes(approval_id, official_id, role_used) VALUES ($1,$2,$3)', [ap.id, official.id, role]);
    await audit(c, official.username, 'approval.vote', { electionId, action, approvalId: ap.id });

    const approvers = (await c.query(
      'SELECT o.roles FROM adm.approval_votes v JOIN adm.officials o ON o.id=v.official_id WHERE v.approval_id=$1', [ap.id])).rows;
    if (!slotsSatisfied(t.roles, approvers)) {
      return { status: 'PENDING', approvalId: ap.id, approvals: approvers.length, required: t.roles.length };
    }
    const result = await execute(c, electionId, action);
    await c.query("UPDATE adm.approvals SET status='EXECUTED', executed_at=now(), result=$2 WHERE id=$1", [ap.id, { ...result, trusteeShares: undefined }]);
    await c.query('UPDATE cfg.elections SET status=$2, updated_at=now() WHERE id=$1', [electionId, t.to]);
    await audit(c, official.username, `election.${action}`, { electionId, newStatus: t.to });
    return { status: 'EXECUTED', newStatus: t.to, ...result };
  });
}

async function execute(c: Client, electionId: string, action: string): Promise<Record<string, unknown>> {
  if (action !== 'publish') return {};
  const e = (await c.query('SELECT * FROM cfg.elections WHERE id=$1', [electionId])).rows[0];
  const consts = (await c.query('SELECT id, code FROM cfg.constituencies WHERE election_id=$1', [electionId])).rows;
  if (!consts.length) throw new HttpError(409, 'add at least one constituency before publishing');
  const empty = (await c.query(
    `SELECT k.id FROM cfg.constituencies k WHERE k.election_id=$1 AND NOT EXISTS
       (SELECT 1 FROM cfg.candidates x JOIN cfg.contests t ON t.id=x.contest_id WHERE x.constituency_id=k.id AND t.election_id=$1)`, [electionId])).rows;
  if (empty.length) throw new HttpError(409, `${empty.length} constituency(ies) have no candidates`);

  for (const k of consts) {
    const sk = await newBlindSigningKey();
    await c.query('INSERT INTO cfg.signing_keys(election_id, constituency_id, public_spki, private_enc) VALUES ($1,$2,$3,$4)', [electionId, k.id, sk.spki, sk.privateEnc]);
  }
  const ek = await newElectionKey(e.trustee_count, e.trustee_threshold);
  const rk = newReceiptKey();
  // Freeze the voter roll: every ACTIVE voter registered in one of this election's constituencies.
  const roll = await c.query(
    `INSERT INTO identity.roll(election_id, voter_id, constituency_id)
       SELECT $1, v.id, k.id FROM identity.voters v JOIN cfg.constituencies k ON k.code = v.constituency_code AND k.election_id=$1
       WHERE v.status='ACTIVE'`, [electionId]);
  await c.query(`UPDATE cfg.elections SET hpke_public_key=$2, hpke_sk_commit=$3, receipt_public_key=$4, receipt_private_enc=$5, roll_frozen_at=now() WHERE id=$1`,
    [electionId, ek.publicKey, ek.commit, rk.spki, rk.privateEnc]);
  // The shares are returned ONCE, to be handed to the trustees, and are never stored.
  return { rollSize: roll.rowCount, trusteeShares: ek.shares, threshold: e.trustee_threshold };
}

// ---------- cached public election view (hot path) ----------
const cache = new Map<string, { at: number; v: any }>();
export async function getElection(id: string, maxAgeMs = 1000) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.v;
  const e = (await pools.ballot.query('SELECT * FROM cfg.elections WHERE id=$1', [id])).rows[0];
  if (!e) return null;
  cache.set(id, { at: Date.now(), v: e });
  return e;
}

export function castWindowOpen(e: any, now = Date.now()) {
  // Tokens are only issued while OPEN; casting is allowed for a short grace period
  // after close so voters already mid-ballot are not cut off.
  if (e.status === 'OPEN') return now >= +new Date(e.opens_at) && now <= +new Date(e.closes_at) + e.close_grace_s * 1000;
  if (e.status === 'CLOSED') return now <= +new Date(e.updated_at) + e.close_grace_s * 1000;
  return false;
}
export function issuanceOpen(e: any, now = Date.now()) {
  return e.status === 'OPEN' && now >= +new Date(e.opens_at) && now <= +new Date(e.closes_at);
}
