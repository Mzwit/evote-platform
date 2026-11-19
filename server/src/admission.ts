// Admission control ("waiting room").
// Each process admits at most `maxInflight` concurrent requests. Up to `maxQueue`
// more wait in FIFO order. Beyond that, or after `queueTimeoutMs`, the client gets
// 503 + Retry-After and a queue hint, and the PWA shows a calm waiting screen and
// retries automatically. Overload becomes a short wait, never a crash or a lost ballot.
import type { FastifyInstance } from 'fastify';
import { metrics } from './metrics.ts';

export function installAdmission(app: FastifyInstance, opts: { maxInflight: number; maxQueue: number; queueTimeoutMs: number }) {
  let inflight = 0;
  const queue: Array<{ go: () => void; timer: NodeJS.Timeout }> = [];

  const release = () => {
    inflight--;
    const next = queue.shift();
    if (next) { clearTimeout(next.timer); inflight++; next.go(); }
    metrics.inflight.set(inflight); metrics.queued.set(queue.length);
  };

  app.addHook('onRequest', (req, reply, done) => {
    // Health and metrics are never queued.
    if (req.url.startsWith('/healthz') || req.url.startsWith('/metrics') || !req.url.startsWith('/api/')) return done();
    (req as any).__admitted = true;
    if (inflight < opts.maxInflight) { inflight++; metrics.inflight.set(inflight); return done(); }
    if (queue.length >= opts.maxQueue) {
      (req as any).__admitted = false;
      metrics.rejectedBusy.inc();
      reply.code(503).header('Retry-After', '5').send({ error: 'busy', waitingRoom: true, retryAfterSeconds: 5, position: queue.length });
      return;
    }
    const item = {
      go: () => done(),
      timer: setTimeout(() => {
        const i = queue.indexOf(item);
        if (i >= 0) queue.splice(i, 1);
        (req as any).__admitted = false;
        metrics.rejectedBusy.inc();
        reply.code(503).header('Retry-After', '3').send({ error: 'busy', waitingRoom: true, retryAfterSeconds: 3 });
      }, opts.queueTimeoutMs),
    };
    (req as any).__queued = item;
    item.go = () => { (req as any).__queued = undefined; done(); };
    queue.push(item);
    metrics.queued.set(queue.length);
  });

  const finish = (req: any) => {
    if (req.__queued) { // aborted while still waiting: just leave the queue
      const i = queue.indexOf(req.__queued);
      if (i >= 0) { clearTimeout(req.__queued.timer); queue.splice(i, 1); }
      req.__queued = undefined; req.__admitted = false;
      return;
    }
    if (req.__admitted && !req.__released) { req.__released = true; release(); }
  };
  app.addHook('onResponse', (req, _reply, done) => { finish(req); done(); });
  app.addHook('onRequestAbort', (req, done) => { finish(req); done(); });
}

// Simple in-memory token bucket per key (production: Valkey so limits hold across instances).
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private capacity: number;
  private refillPerSec: number;
  constructor(capacity: number, refillPerSec: number) {
    this.capacity = capacity; this.refillPerSec = refillPerSec;
    setInterval(() => { const cut = Date.now() - 600_000; for (const [k, b] of this.buckets) if (b.at < cut) this.buckets.delete(k); }, 60_000).unref();
  }
  take(key: string, cost = 1): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.refillPerSec);
    b.at = now;
    if (b.tokens < cost) { this.buckets.set(key, b); return false; }
    b.tokens -= cost; this.buckets.set(key, b); return true;
  }
}
