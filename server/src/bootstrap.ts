// Runs before the server starts on a hosted deployment:
//   1. applies database migrations;
//   2. in DEMO_MODE, creates the demo election the first time (fictional data only).
// The demo officials' credentials and the trustee key shares are written to the
// service log ONCE (visible only to whoever controls the hosting account).
import { migrate } from './migrate.ts';
import { config } from './config.ts';
import { pools, closePools } from './db.ts';
import { createDemoElection } from './demo.ts';

await migrate();
if (config.demoMode) {
  const n = (await pools.admin.query('SELECT count(*)::int AS n FROM cfg.elections')).rows[0].n;
  if (n === 0) {
    const out = await createDemoElection({ voters: Number(process.env.DEMO_VOTERS ?? 2000), open: true, graceSeconds: 120, windowHours: 24 * 60 });
    console.log('=== DEMO ELECTION CREATED (fictional data) ===');
    console.log(JSON.stringify({ electionId: out.electionId, voters: out.voters, officials: out.officials, trusteeShares: out.trusteeShares }, null, 2));
    console.log('=== keep the officials TOTP secrets and trustee shares private ===');
  } else {
    console.log(`demo mode: ${n} election(s) already exist, nothing to create`);
  }
}
await closePools();
