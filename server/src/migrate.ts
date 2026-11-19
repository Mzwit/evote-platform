// Applies SQL migrations in order, once each, as the database owner.
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { config } from './config.ts';

const dir = new URL('../../db/migrations/', import.meta.url);

export async function migrate(url = config.db.owner, log = true) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
    await c.query('SELECT pg_advisory_lock(424242)');
    const done = new Set((await c.query('SELECT name FROM public.schema_migrations')).rows.map((r) => r.name));
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      let sql = readFileSync(new URL(f, dir), 'utf8');
      // Replace development role passwords with the configured ones (never committed).
      for (const [role, pw] of Object.entries(config.db.rolePasswords)) {
        if (pw) sql = sql.replaceAll(`'dev-${role.replace('evote_', '')}'`, `'${pw.replaceAll("'", "''")}'`);
      }
      await c.query(sql);
      await c.query('INSERT INTO public.schema_migrations(name) VALUES ($1)', [f]);
      await c.query('COMMIT');
      if (log) console.log('applied', f);
    }
    // Keep role passwords in step with the environment (e.g. after a secret rotation).
    for (const [role, pw] of Object.entries(config.db.rolePasswords)) {
      if (pw) await c.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${pw.replaceAll("'", "''")}'`);
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    await c.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(() => console.log('migrations complete'), (e) => { console.error(e); process.exit(1); });
}
