// Development / demo seed. NEVER run against production.
// Creates demo officials, a demo election configured like an Eswatini secondary
// election (no parties; MP, Indvuna yeNkhundla and Bucopho contests), fictional
// candidates and N fictional voters. With --open it publishes and opens the
// election through the real two-person approval flow.
//
//   node server/src/seed.ts --voters 5000 --open
import { mkdirSync, writeFileSync } from 'node:fs';
import { createDemoElection } from './demo.ts';
import { closePools } from './db.ts';

const args = process.argv.slice(2);
const voters = Number(args[args.indexOf('--voters') + 1] || 2000);
const out = await createDemoElection({ voters, open: args.includes('--open'), graceSeconds: 120 });
mkdirSync('seed-output', { recursive: true });
writeFileSync('seed-output/demo.json', JSON.stringify(out, null, 2));
console.log(`seeded election ${out.electionId} with ${voters} voters; details (dev credentials, trustee shares) in seed-output/demo.json`);
await closePools();
