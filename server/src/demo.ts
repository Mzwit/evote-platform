// Demo data builder shared by the seed script and the test suite. NEVER use in production.
import pg from 'pg';
import { config } from './config.ts';
import { hashPassword, base32 } from './security.ts';
import { requestOrApprove } from './elections.ts';
import { migrate } from './migrate.ts';

export const DEMO_VOTER_PASSWORD = 'Demo-Voter-2026';
export const DEMO_OFFICIAL_PASSWORD = 'Demo-Official-2026!';

export async function createDemoElection(opts: { voters: number; open: boolean; graceSeconds?: number; windowHours?: number }) {
  if (config.isProd && !config.demoMode) throw new Error('refusing to create demo data in production');
  const N = opts.voters, OPEN = opts.open;
  await migrate(config.db.owner, false);
  const db = new pg.Client({ connectionString: config.db.owner });
  await db.connect();

  const officials = [
    ['superadmin', 'Demo Super Administrator', ['SUPER_ADMIN']],
    ['admin1', 'Demo National Admin One', ['NATIONAL_ADMIN']],
    ['admin2', 'Demo National Admin Two', ['NATIONAL_ADMIN']],
    ['auditor', 'Demo Independent Auditor', ['AUDITOR']],
    ['security', 'Demo Security Officer', ['SECURITY_OFFICER']],
    ['observer', 'Demo Election Observer', ['OBSERVER']],
    ['registrar1', 'Demo Registration Officer One', ['REGISTRATION_OFFICER']],
    ['registrar2', 'Demo Registration Officer Two', ['REGISTRATION_OFFICER']],
    ['trustee1', 'Demo Trustee 1', ['TRUSTEE']], ['trustee2', 'Demo Trustee 2', ['TRUSTEE']], ['trustee3', 'Demo Trustee 3', ['TRUSTEE']],
    ['trustee4', 'Demo Trustee 4', ['TRUSTEE']], ['trustee5', 'Demo Trustee 5', ['TRUSTEE']],
  ] as const;
  const pwHash = await hashPassword(DEMO_OFFICIAL_PASSWORD);
  const ids: Record<string, string> = {};
  const totp: Record<string, string> = {};
  for (const [u, name, roles] of officials) {
    const secret = Buffer.from(`demo-totp-secret-${u}`.padEnd(20, '.').slice(0, 20));
    const r = await db.query(`INSERT INTO adm.officials(username, full_name, password_hash, totp_secret, roles) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (username) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id`, [u, name, pwHash, secret, roles]);
    ids[u] = r.rows[0].id; totp[u] = base32(secret);
  }

  const now = Date.now();
  const e = (await db.query(`INSERT INTO cfg.elections(name, description, opens_at, closes_at, parties_enabled, trustee_count, trustee_threshold, close_grace_s, created_by)
    VALUES ($1,$2,$3,$4,false,5,3,$6,$5) RETURNING id`, [
    `Secondary Elections DEMO ${new Date().toISOString().slice(0, 16)}`,
    'Demonstration election with fictional candidates and voters. Not a real election.',
    new Date(now - 60_000), new Date(now + (opts.windowHours ?? 12) * 3600_000), ids.admin1, opts.graceSeconds ?? 5])).rows[0];

  const tinkhundla = [
    ['HH-MBE', 'Mbabane East', 'Hhohho'], ['HH-LOB', 'Lobamba', 'Hhohho'], ['MN-MZN', 'Manzini North', 'Manzini'],
    ['LU-SIT', 'Siteki', 'Lubombo'], ['SH-NHL', 'Nhlangano', 'Shiselweni'],
  ];
  const contests = [['Member of Parliament', 1, 1], ['Indvuna yeNkhundla', 1, 2], ['Bucopho', 1, 3]] as const;
  const first = ['Thandeka', 'Sipho', 'Nomsa', 'Bongani', 'Lindiwe', 'Mandla', 'Zanele', 'Themba', 'Sibusiso', 'Nokuthula', 'Mbuso', 'Phindile'];
  const last = ['Example', 'Sample', 'Demo', 'Testcase'];
  const contestIds: string[] = [];
  for (const [name, max, sort] of contests) contestIds.push((await db.query('INSERT INTO cfg.contests(election_id, name, max_choices, sort) VALUES ($1,$2,$3,$4) RETURNING id', [e.id, name, max, sort])).rows[0].id);
  let n = 0;
  for (const [code, name, region] of tinkhundla) {
    const k = (await db.query('INSERT INTO cfg.constituencies(election_id, code, name, region) VALUES ($1,$2,$3,$4) RETURNING id', [e.id, code, name, region])).rows[0];
    for (const cid of contestIds) for (let i = 0; i < 3; i++, n++) {
      await db.query('INSERT INTO cfg.candidates(contest_id, constituency_id, name, bio, sort) VALUES ($1,$2,$3,$4,$5)',
        [cid, k.id, `${first[n % first.length]} ${last[i]} (demo)`, 'Fictional candidate for demonstration only.', i]);
    }
  }

  // Voters (bulk insert, one shared demo password hash for speed).
  const vHash = await hashPassword(DEMO_VOTER_PASSWORD);
  const base = 9_000_000_000_000 + Math.floor(Math.random() * 1e6) * 1e5;
  for (let i = 0; i < N; i += 1000) {
    const params: unknown[] = []; const vals: string[] = [];
    for (let j = i; j < Math.min(N, i + 1000); j++) {
      const o = params.length;
      params.push(String(base + j), `Demo Voter ${j}`, '1990-01-01', tinkhundla[j % tinkhundla.length][0], `+2687600${String(j % 10000).padStart(4, '0')}`, vHash, ids.registrar1, ids.registrar2);
      vals.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},'ACTIVE',$${o + 7},$${o + 8})`);
    }
    await db.query(`INSERT INTO identity.voters(national_id, full_name, date_of_birth, constituency_code, phone, password_hash, status, registered_by, approved_by) VALUES ${vals.join(',')} ON CONFLICT DO NOTHING`, params);
  }
  await db.end();

  const out: Record<string, unknown> = { officialIds: ids, electionId: e.id, voters: { count: N, firstNationalId: String(base), password: DEMO_VOTER_PASSWORD },
    officials: { password: DEMO_OFFICIAL_PASSWORD, totpSecrets: totp } };
  if (OPEN) {
    const o = (u: string, roles: string[]) => ({ id: ids[u], username: u, roles });
    await requestOrApprove(e.id, 'publish', o('admin1', ['NATIONAL_ADMIN']), 'demo setup');
    const pub: any = await requestOrApprove(e.id, 'publish', o('admin2', ['NATIONAL_ADMIN']), 'demo setup');
    out.trusteeShares = pub.trusteeShares; out.rollSize = pub.rollSize;
    await requestOrApprove(e.id, 'open', o('admin1', ['NATIONAL_ADMIN']), 'demo setup');
    await requestOrApprove(e.id, 'open', o('admin2', ['NATIONAL_ADMIN']), 'demo setup');
  }
  return out as { electionId: string; voters: { count: number; firstNationalId: string; password: string }; officials: { password: string; totpSecrets: Record<string, string> }; trusteeShares?: string[]; rollSize?: number; officialIds: Record<string, string> };
}
