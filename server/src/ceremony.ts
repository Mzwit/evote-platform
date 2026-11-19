// Offline trustee ceremony (recommended for real elections).
// Run on an air-gapped, freshly installed machine with a direct database connection,
// in front of observers and on camera. Each trustee types their share; nothing is
// stored; the shares are combined, verified against the published commitment, and
// the tally is written and audit-logged.
//
//   node server/src/ceremony.ts --election <uuid>
import { createInterface } from 'node:readline/promises';
import { pools, closePools } from './db.ts';
import { tallyWithShares } from './tally.ts';

const i = process.argv.indexOf('--election');
const electionId = i > 0 ? process.argv[i + 1] : '';
const e = (await pools.admin.query('SELECT * FROM cfg.elections WHERE id=$1', [electionId])).rows[0];
if (!e) { console.error('election not found'); process.exit(1); }
if (e.status !== 'CLOSED') { console.error(`election is ${e.status}; it must be CLOSED`); process.exit(1); }
if (Date.now() < +new Date(e.updated_at) + e.close_grace_s * 1000) { console.error('the closing grace period has not ended yet'); process.exit(1); }

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
console.log(`Trustee ceremony for "${e.name}". ${e.trustee_threshold} of ${e.trustee_count} shares are needed.`);
const shares: Uint8Array[] = []; const names: string[] = [];
while (shares.length < e.trustee_threshold) {
  const name = (await rl.question(`Trustee ${shares.length + 1} name: `)).trim();
  const share = (await rl.question('Share (input is not echoed by most terminals if you paste with a password manager): ')).trim();
  const buf = new Uint8Array(Buffer.from(share, 'base64'));
  if (buf.length !== 33) { console.log('That is not a valid share. Try again.'); continue; }
  shares.push(buf); names.push(`ceremony:${name}`);
  process.stdout.write('\x1b[2A\x1b[0J'); // clear the share from the screen
}
rl.close();
const r = await tallyWithShares(e, shares, names);
console.log(`Tally complete: ${r.total} ballots, ${r.valid} valid, ${r.invalid} rejected. Status: ${r.status} (preliminary).`);
await closePools();
