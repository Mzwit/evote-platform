import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { buildApp } from './app.ts';
import { config } from './config.ts';
import { startSealer } from './sealer.ts';
import { closePools } from './db.ts';

// WORKERS=n runs n processes sharing the port (one per CPU core is typical).
// Password hashing runs in libuv's thread pool; give it room (must be set before first use).
process.env.UV_THREADPOOL_SIZE ??= String(Math.max(4, availableParallelism()));
const workers = Number(process.env.WORKERS ?? 1) || availableParallelism();

if (cluster.isPrimary && workers > 1) {
  for (let i = 0; i < workers; i++) cluster.fork();
  cluster.on('exit', (w, code) => { console.error(`worker ${w.process.pid} exited (${code}); restarting`); cluster.fork(); });
} else {
  const app = await buildApp();
  if (config.services.has('all') || config.services.has('cast')) startSealer(config.sealIntervalMs, (e) => app.log.error(e));
  await app.listen({ port: config.port, host: config.host });
  console.log(`evote listening on :${config.port} (pid ${process.pid}, services: ${[...config.services].join(',')})`);
  const stop = async () => { await app.close(); await closePools(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
