// Trustee ceremony and tally (Phase 9 / Phase 11).
// PROTOTYPE: decrypt-and-shuffle. Each decrypted ballot is published (shuffled,
// unlinked from trackers) so anyone can recount. What this prototype cannot yet
// PROVE is that decryption/shuffle were honest; production replaces this step
// with Belenios or ElectionGuard (verifiable mix-net or homomorphic tally).
import { createHash, randomInt } from 'node:crypto';
import { combine } from 'shamir-secret-sharing';
import { pools, tx } from './db.ts';
import { audit } from './audit.ts';
import { HttpError } from './elections.ts';
import { decryptBallot, importBlindPublicKey, verifyToken, sha256 } from '../../shared/protocol.ts';
import { sealOnce } from './sealer.ts';

// Shares are held in memory only, never written to disk, and wiped after use.
// Because they live in ONE process's memory, the web ceremony requires the admin
// service to run as a single instance during the ceremony. The recommended route
// for real elections is the offline CLI (server/src/ceremony.ts) on an air-gapped
// machine with a read-only database connection plus the result-writing role.
const pendingShares = new Map<string, Map<string, Uint8Array>>();

export async function submitShare(electionId: string, trustee: { id: string; username: string }, shareB64: string) {
  const e = (await pools.admin.query('SELECT * FROM cfg.elections WHERE id=$1', [electionId])).rows[0];
  if (!e) throw new HttpError(404, 'election not found');
  if (e.status !== 'CLOSED') throw new HttpError(409, 'the election must be CLOSED before the tally ceremony');
  if (Date.now() < +new Date(e.updated_at) + e.close_grace_s * 1000) throw new HttpError(409, 'wait until the closing grace period has ended');
  const share = new Uint8Array(Buffer.from(shareB64, 'base64'));
  if (share.length !== 33) throw new HttpError(400, 'that does not look like a key share');
  const m = pendingShares.get(electionId) ?? new Map();
  m.set(trustee.id, share);
  pendingShares.set(electionId, m);
  await audit(pools.admin, trustee.username, 'tally.share_submitted', { electionId, sharesHeld: m.size, threshold: e.trustee_threshold });
  if (m.size < e.trustee_threshold) return { status: 'WAITING', sharesHeld: m.size, threshold: e.trustee_threshold };

  const trustees = [...m.keys()];
  const shares = [...m.values()];
  pendingShares.delete(electionId);
  return tallyWithShares(e, shares, trustees);
}

// Used by the web ceremony (single admin instance) and by the offline CLI (server/src/ceremony.ts).
export async function tallyWithShares(e: any, shares: Uint8Array[], trustees: string[]) {
  const sk = await combine(shares);
  for (const s of shares) s.fill(0);
  if (!Buffer.from(await sha256(sk)).equals(e.hpke_sk_commit)) {
    sk.fill(0);
    await audit(pools.admin, 'system', 'tally.bad_shares', { electionId: e.id, trustees });
    throw new HttpError(400, 'the combined key does not match the election key; at least one share is wrong. Shares were discarded; resubmit.');
  }
  try { return await runTally(e, sk, trustees); } finally { sk.fill(0); }
}

async function runTally(e: any, sk: Uint8Array, trustees: string[]) {
  const id = e.id;
  while ((await sealOnce()) > 0) { /* make sure every accepted ballot is on the board */ }
  const consts = (await pools.admin.query('SELECT id FROM cfg.constituencies WHERE election_id=$1', [id])).rows.map((r) => r.id);
  const contests = (await pools.admin.query('SELECT id, max_choices FROM cfg.contests WHERE election_id=$1', [id])).rows;
  const cands = (await pools.admin.query('SELECT c.id, c.contest_id, c.constituency_id FROM cfg.candidates c JOIN cfg.contests t ON t.id=c.contest_id WHERE t.election_id=$1', [id])).rows;
  const keys = new Map<string, CryptoKey>();
  for (const r of (await pools.admin.query('SELECT constituency_id, public_spki FROM cfg.signing_keys WHERE election_id=$1', [id])).rows) {
    keys.set(r.constituency_id, await importBlindPublicKey(r.public_spki));
  }
  const candIndex = new Map(cands.map((c) => [c.id, c]));
  const contestIndex = new Map(contests.map((c) => [c.id, c]));

  const out: { constituency_id: string; selections: any; valid: boolean; reason: string | null }[] = [];
  const counts = new Map<string, number>(); // contest|constituency|candidate
  let lastSeq = 0, total = 0;
  for (;;) {
    const batch = (await pools.admin.query('SELECT seq, constituency_id, token, token_sig, enc, ct FROM ballot.ballots WHERE election_id=$1 AND seq>$2 ORDER BY seq LIMIT 2000', [id, lastSeq])).rows;
    if (!batch.length) break;
    for (const b of batch) {
      lastSeq = Number(b.seq); total++;
      let valid = false, reason: string | null = null, selections: any = null;
      try {
        if (!(await verifyToken(keys.get(b.constituency_id)!, b.token, b.token_sig))) throw new Error('token signature invalid');
        const p = await decryptBallot(sk, id, b.constituency_id, b.enc, b.ct);
        if (p.e !== id || p.c !== b.constituency_id) throw new Error('ballot belongs to another election or constituency');
        selections = p.s;
        for (const [contestId, chosen] of Object.entries(p.s ?? {})) {
          const ct = contestIndex.get(contestId);
          if (!ct) throw new Error('unknown contest');
          if (!Array.isArray(chosen) || chosen.length > ct.max_choices || new Set(chosen).size !== chosen.length) throw new Error('too many or duplicate choices');
          for (const cid of chosen) { const c = candIndex.get(cid); if (!c || c.contest_id !== contestId || c.constituency_id !== b.constituency_id) throw new Error('candidate not on this ballot'); }
        }
        valid = true;
      } catch (err) { reason = (err as Error).message; }
      if (valid) for (const [contestId, chosen] of Object.entries(selections as Record<string, string[]>)) for (const cid of chosen) {
        const k = `${contestId}|${b.constituency_id}|${cid}`; counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      out.push({ constituency_id: b.constituency_id, selections: valid ? selections : null, valid, reason });
    }
  }
  // Fisher-Yates shuffle with a CSPRNG: published order reveals nothing about cast order.
  for (let i = out.length - 1; i > 0; i--) { const j = randomInt(0, i + 1); [out[i], out[j]] = [out[j], out[i]]; }

  const head = (await pools.admin.query('SELECT entry_hash, position FROM ballot.board WHERE election_id=$1 ORDER BY position DESC LIMIT 1', [id])).rows[0];
  const boardCount = head ? Number(head.position) : 0;
  if (boardCount !== total) throw new HttpError(500, `reconciliation failed: board ${boardCount} vs ballots ${total}`);
  const dh = createHash('sha256');

  return tx(pools.admin, async (c) => {
    const st = (await c.query('SELECT status FROM cfg.elections WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (st.status !== 'CLOSED') throw new HttpError(409, 'election is no longer CLOSED');
    for (let i = 0; i < out.length; i += 500) {
      const chunk = out.slice(i, i + 500);
      const params: unknown[] = [];
      const vals = chunk.map((r, j) => { const pos = i + j + 1; dh.update(`${pos}|${r.constituency_id}|${JSON.stringify(r.selections)}|${r.valid}\n`);
        params.push(id, pos, r.constituency_id, JSON.stringify(r.selections), r.valid, r.reason); const o = j * 6; return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6})`; });
      await c.query(`INSERT INTO ballot.decrypted(election_id, position, constituency_id, selections, valid, reason) VALUES ${vals.join(',')}`, params);
    }
    // Every candidate gets a row, including those with zero votes.
    for (const cand of cands) {
      await c.query('INSERT INTO adm.results(election_id, contest_id, constituency_id, candidate_id, votes) VALUES ($1,$2,$3,$4,$5)',
        [id, cand.contest_id, cand.constituency_id, cand.id, counts.get(`${cand.contest_id}|${cand.constituency_id}|${cand.id}`) ?? 0]);
    }
    const valid = out.filter((r) => r.valid).length;
    await c.query('INSERT INTO adm.tally_runs(election_id, ballots_total, valid, invalid, board_head, decrypted_hash) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, total, valid, total - valid, head?.entry_hash ?? Buffer.alloc(32), dh.digest()]);
    await c.query("UPDATE cfg.elections SET status='TALLIED', updated_at=now() WHERE id=$1", [id]);
    await audit(c, 'system', 'election.tallied', { electionId: id, trustees, total, valid, invalid: total - valid, constituencies: consts.length });
    return { status: 'TALLIED', total, valid, invalid: total - valid };
  });
}
