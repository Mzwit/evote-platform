// Appends accepted ballots to the public, hash-chained bulletin board.
// Runs in every cast-service process; a PostgreSQL advisory lock makes exactly
// one of them the active sealer at a time, so the chain stays linear.
import { pools } from './db.ts';
import { boardEntryHash, GENESIS } from '../../shared/protocol.ts';
import { metrics } from './metrics.ts';

export async function sealOnce(limit = 5000): Promise<number> {
  const c = await pools.ballot.connect();
  try {
    await c.query('BEGIN');
    const lock = await c.query('SELECT pg_try_advisory_xact_lock(888001) AS ok');
    if (!lock.rows[0].ok) { await c.query('ROLLBACK'); return 0; }
    const pending = (await c.query(
      `SELECT b.seq, b.election_id, b.tracker FROM ballot.ballots b
        WHERE b.seq > (SELECT coalesce(max(ballot_seq), 0) - 20000 FROM ballot.board)  -- window: ballots commit slightly out of seq order
          AND NOT EXISTS (SELECT 1 FROM ballot.board x WHERE x.ballot_seq = b.seq)
        ORDER BY b.seq LIMIT $1`, [limit])).rows;
    if (!pending.length) { await c.query('COMMIT'); return 0; }
    const heads = new Map<string, { pos: number; hash: Uint8Array }>();
    const rows: unknown[][] = [];
    for (const p of pending) {
      let h = heads.get(p.election_id);
      if (!h) {
        const last = (await c.query('SELECT position, entry_hash FROM ballot.board WHERE election_id=$1 ORDER BY position DESC LIMIT 1', [p.election_id])).rows[0];
        h = last ? { pos: Number(last.position), hash: new Uint8Array(last.entry_hash) } : { pos: 0, hash: GENESIS };
      }
      const pos = h.pos + 1;
      const entry = await boardEntryHash(h.hash, pos, p.tracker);
      rows.push([p.election_id, pos, p.seq, p.tracker, Buffer.from(h.hash), Buffer.from(entry)]);
      h = { pos, hash: entry };
      heads.set(p.election_id, h);
    }
    // Multi-row insert in chunks.
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      const params: unknown[] = [];
      const values = chunk.map((r, j) => { params.push(...r); const o = j * 6; return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6})`; });
      await c.query(`INSERT INTO ballot.board(election_id, position, ballot_seq, tracker, prev_hash, entry_hash) VALUES ${values.join(',')}`, params);
    }
    await c.query('COMMIT');
    for (const [e, h] of heads) metrics.boardHeight.set({ election: e }, h.pos);
    return pending.length;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export function startSealer(intervalMs: number, log: (e: unknown) => void) {
  let running = false;
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try { while ((await sealOnce()) >= 5000) { /* catch up */ } } catch (e) { log(e); } finally { running = false; }
  }, intervalMs);
  t.unref();
  return () => clearInterval(t);
}
