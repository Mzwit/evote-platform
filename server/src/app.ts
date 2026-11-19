import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { config } from './config.ts';
import { installAdmission } from './admission.ts';
import { metrics, registry } from './metrics.ts';
import { HttpError } from './elections.ts';
import { voterRoutes } from './routes/voter.ts';
import { castRoutes } from './routes/cast.ts';
import { publicRoutes } from './routes/public.ts';
import { adminRoutes } from './routes/admin.ts';
import { pools } from './db.ts';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : {
      level: config.logLevel,
      // Privacy: never log IP addresses, headers or bodies.
      serializers: { req: (r) => ({ method: r.method, url: r.url.split('?')[0] }), res: (r) => ({ statusCode: r.statusCode }) },
    },
    trustProxy: true,
    bodyLimit: 64 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
  });

  installAdmission(app, config.admission);

  // Security headers for every response.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (_req.url.startsWith('/assets/')) reply.header('Cache-Control', 'public, max-age=31536000, immutable'); // content-hashed files
    else if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', _req.url.startsWith('/api/') ? 'no-store' : 'no-cache');
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'static';
    metrics.http.observe({ route, method: req.method, code: String(reply.statusCode) }, reply.elapsedTime / 1000);
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, ...err.extra });
    if (err.validation) return reply.code(400).send({ error: 'invalid request', details: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    if (err.code === '23505') return reply.code(409).send({ error: 'already exists' });
    if (err.code === 'P0001') return reply.code(409).send({ error: err.message }); // raised by DB integrity triggers
    app.log.error({ err: { message: err.message, code: err.code } }, 'unhandled error');
    return reply.code(500).send({ error: 'internal error, please try again', retryable: true });
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try { await pools.ballot.query('SELECT 1'); return { ok: true }; } catch { return reply.code(503).send({ ok: false }); }
  });
  app.get('/metrics', async (_req, reply) => reply.type(registry.contentType).send(await registry.metrics()));

  const s = config.services;
  const all = s.has('all');
  if (all || s.has('identity')) await app.register(voterRoutes);
  if (all || s.has('cast')) await app.register(castRoutes);
  if (all || s.has('public')) await app.register(publicRoutes);
  if (all || s.has('admin')) await app.register(adminRoutes);

  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/', wildcard: false, cacheControl: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    });
  }
  return app;
}
