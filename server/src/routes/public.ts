// Public, read-only endpoints: election information, bulletin board, turnout,
// reconciliation and results (Phase 11). Safe to cache at the edge for a few seconds.
import type { FastifyInstance } from 'fastify';
import { pools } from '../db.ts';
import { HttpError } from '../elections.ts';
import { config } from '../config.ts';
import { DEMO_VOTER_PASSWORD } from '../demo.ts';

const LABEL: Record<string, string> = { TALLIED: 'PRELIMINARY', VERIFIED: 'VERIFIED', DECLARED: 'OFFICIALLY DECLARED' };
const uuid = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } };

export async function publicRoutes(app: FastifyInstance) {
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/public/')) reply.header('Cache-Control', 'public, max-age=5, stale-while-revalidate=30');
  });

  // Public demo only: a few fictional voter IDs visitors can sign in with.
  app.get('/api/public/demo', async () => {
    if (!config.demoMode) return { enabled: false };
    const ids = (await pools.admin.query(`SELECT national_id FROM identity.voters WHERE full_name LIKE 'Demo Voter %' AND status='ACTIVE' ORDER BY random() LIMIT 8`)).rows.map((r) => r.national_id);
    return { enabled: true, password: DEMO_VOTER_PASSWORD, nationalIds: ids };
  });

  app.get('/api/public/elections', async () =>
    (await pools.admin.query(`SELECT id, name, description, status, opens_at, closes_at FROM cfg.elections WHERE status <> 'DRAFT' ORDER BY opens_at DESC`)).rows);

  app.get('/api/public/elections/:id', { schema: { params: uuid } }, async (req) => {
    const { id } = req.params as { id: string };
    const e = (await pools.admin.query(`SELECT id, name, description, status, opens_at, closes_at, parties_enabled, trustee_count, trustee_threshold,
        encode(hpke_public_key,'base64') AS election_key, encode(receipt_public_key,'base64') AS receipt_key, roll_frozen_at
        FROM cfg.elections WHERE id=$1 AND status <> 'DRAFT'`, [id])).rows[0];
    if (!e) throw new HttpError(404, 'election not found');
    const constituencies = (await pools.admin.query(`SELECT k.id, k.code, k.name, k.region, encode(s.public_spki,'base64') AS signing_key
        FROM cfg.constituencies k LEFT JOIN cfg.signing_keys s ON s.constituency_id=k.id WHERE k.election_id=$1 ORDER BY k.region, k.name`, [id])).rows;
    const contests = (await pools.admin.query('SELECT id, name, max_choices FROM cfg.contests WHERE election_id=$1 ORDER BY sort, name', [id])).rows;
    const candidates = (await pools.admin.query(`SELECT c.id, c.contest_id, c.constituency_id, c.name, CASE WHEN $2 THEN c.party END AS party, c.bio, c.photo_url
        FROM cfg.candidates c JOIN cfg.contests t ON t.id=c.contest_id WHERE t.election_id=$1 ORDER BY c.sort, c.name`, [id, e.parties_enabled])).rows;
    return { ...e, constituencies, contests, candidates };
  });

  app.get('/api/public/elections/:id/board', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { after?: string; limit?: string };
    const after = Math.max(0, Number(q.after ?? 0) | 0), limit = Math.min(5000, Math.max(1, Number(q.limit ?? 1000) | 0));
    const rows = (await pools.ballot.query(`SELECT position, tracker, encode(prev_hash,'hex') AS prev_hash, encode(entry_hash,'hex') AS entry_hash
        FROM ballot.board WHERE election_id=$1 AND position>$2 ORDER BY position LIMIT $3`, [id, after, limit])).rows;
    return { entries: rows };
  });

  app.get('/api/public/elections/:id/board/:tracker', async (req) => {
    const { id, tracker } = req.params as { id: string; tracker: string };
    const t = tracker.toUpperCase().replace(/[^A-Z0-9]/g, '').match(/.{1,4}/g)?.join('-') ?? '';
    const r = (await pools.ballot.query(`SELECT position, encode(entry_hash,'hex') AS entry_hash, sealed_at FROM ballot.board WHERE election_id=$1 AND tracker=$2`, [id, t])).rows[0];
    if (r) return { found: true, onBoard: true, tracker: t, ...r };
    const pending = (await pools.ballot.query('SELECT 1 FROM ballot.ballots WHERE election_id=$1 AND tracker=$2', [id, t])).rowCount;
    return { found: !!pending, onBoard: false, tracker: t, message: pending ? 'Accepted; it will appear on the board within a few seconds.' : 'No ballot with this tracking code.' };
  });

  // Full encrypted ballots with their anonymous tokens, so independent observers
  // can check every ballot was authorised and count the board themselves.
  app.get('/api/public/elections/:id/ballots', async (req) => {
    const { id } = req.params as { id: string };
    const after = Math.max(0, Number((req.query as any).after ?? 0) | 0);
    const rows = (await pools.ballot.query(`SELECT seq, constituency_id, tracker, encode(token,'base64') AS token, encode(token_sig,'base64') AS sig,
        encode(enc,'base64') AS enc, encode(ct,'base64') AS ct FROM ballot.ballots WHERE election_id=$1 AND seq>$2 ORDER BY seq LIMIT 500`, [id, after])).rows;
    return { ballots: rows };
  });

  app.get('/api/public/elections/:id/turnout', async (req) => {
    const { id } = req.params as { id: string };
    const rows = (await pools.admin.query(`SELECT k.id, k.code, k.name, k.region, coalesce(r.eligible,0) AS eligible, coalesce(i.issued,0) AS participated
        FROM cfg.constituencies k LEFT JOIN identity.roll_counts r ON r.constituency_id=k.id AND r.election_id=k.election_id
        LEFT JOIN identity.issuance_counts i ON i.constituency_id=k.id AND i.election_id=k.election_id
        WHERE k.election_id=$1 ORDER BY k.region, k.name`, [id])).rows;
    const eligible = rows.reduce((n, r) => n + r.eligible, 0), participated = rows.reduce((n, r) => n + r.participated, 0);
    return { eligible, participated, turnoutPct: eligible ? +(100 * participated / eligible).toFixed(2) : 0, constituencies: rows };
  });

  app.get('/api/public/elections/:id/reconciliation', async (req) => {
    const { id } = req.params as { id: string };
    const [issued, accepted, board, dec] = await Promise.all([
      pools.admin.query('SELECT coalesce(sum(issued),0)::bigint AS n FROM identity.issuance_counts WHERE election_id=$1', [id]),
      pools.admin.query('SELECT count(*)::bigint AS n FROM ballot.ballots WHERE election_id=$1', [id]),
      pools.admin.query('SELECT coalesce(max(position),0)::bigint AS n FROM ballot.board WHERE election_id=$1', [id]),
      pools.admin.query('SELECT count(*)::bigint AS n, count(*) FILTER (WHERE valid)::bigint AS v FROM ballot.decrypted WHERE election_id=$1', [id]),
    ]);
    const r = { tokensIssued: issued.rows[0].n, ballotsAccepted: accepted.rows[0].n, boardEntries: board.rows[0].n, ballotsDecrypted: dec.rows[0].n, validBallots: dec.rows[0].v };
    return { ...r, checks: {
      noBallotWithoutToken: r.ballotsAccepted <= r.tokensIssued,
      boardMatchesAccepted: r.boardEntries === r.ballotsAccepted,
      tallyMatchesAccepted: r.ballotsDecrypted === 0 || r.ballotsDecrypted === r.ballotsAccepted,
    } };
  });

  app.get('/api/public/elections/:id/results', async (req) => {
    const { id } = req.params as { id: string };
    const e = (await pools.admin.query('SELECT status FROM cfg.elections WHERE id=$1', [id])).rows[0];
    if (!e) throw new HttpError(404, 'election not found');
    if (!LABEL[e.status]) return { available: false, status: e.status, message: 'Results are published only after the official tally.' };
    const run = (await pools.admin.query(`SELECT ballots_total, valid, invalid, encode(board_head,'hex') AS board_head, encode(decrypted_hash,'hex') AS decrypted_hash, finished_at FROM adm.tally_runs WHERE election_id=$1`, [id])).rows[0];
    const rows = (await pools.admin.query(`SELECT r.contest_id, t.name AS contest, r.constituency_id, k.name AS constituency, k.region,
          r.candidate_id, c.name AS candidate, r.votes
        FROM adm.results r JOIN cfg.contests t ON t.id=r.contest_id JOIN cfg.constituencies k ON k.id=r.constituency_id JOIN cfg.candidates c ON c.id=r.candidate_id
        WHERE r.election_id=$1 ORDER BY k.region, k.name, t.sort, r.votes DESC`, [id])).rows;
    return { available: true, status: e.status, label: LABEL[e.status], summary: run, results: rows };
  });

  app.get('/api/public/elections/:id/decrypted', async (req) => {
    const { id } = req.params as { id: string };
    const after = Math.max(0, Number((req.query as any).after ?? 0) | 0);
    return { ballots: (await pools.ballot.query('SELECT position, constituency_id, selections, valid, reason FROM ballot.decrypted WHERE election_id=$1 AND position>$2 ORDER BY position LIMIT 2000', [id, after])).rows };
  });
}
