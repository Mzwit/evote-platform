// Election administration (Phase 10): officials, configuration, voter registration,
// approvals, trustee ceremony, audit and incident reporting.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { pools, tx } from '../db.ts';
import { audit, verifyAuditChain } from '../audit.ts';
import { hashPassword, verifyPassword, verifyTotp, signSession, readSession, base32 } from '../security.ts';
import { HttpError, requestOrApprove, TRANSITIONS } from '../elections.ts';
import { RateLimiter } from '../admission.ts';
import { submitShare } from '../tally.ts';

type Official = { id: string; username: string; roles: string[] };
const limiter = new RateLimiter(10, 0.1);

async function official(req: FastifyRequest, ...roles: string[]): Promise<Official> {
  const s = readSession(req.headers.authorization?.replace(/^Bearer /, ''));
  if (!s || s.kind !== 'official') throw new HttpError(401, 'please sign in');
  const o = (await pools.admin.query('SELECT id, username, roles, active FROM adm.officials WHERE id=$1', [s.sub])).rows[0];
  if (!o || !o.active) throw new HttpError(401, 'account disabled');
  if (roles.length && !o.roles.some((r: string) => roles.includes(r))) throw new HttpError(403, `requires one of: ${roles.join(', ')}`);
  return o;
}

async function assertDraft(electionId: string) {
  const e = (await pools.admin.query('SELECT status FROM cfg.elections WHERE id=$1', [electionId])).rows[0];
  if (!e) throw new HttpError(404, 'election not found');
  // Ballot content is locked once published: no candidate substitution afterwards.
  if (e.status !== 'DRAFT') throw new HttpError(409, 'the ballot is locked because the election has been published');
}

const str = (min = 1, max = 200) => ({ type: 'string', minLength: min, maxLength: max });
const ROLES = ['SUPER_ADMIN', 'NATIONAL_ADMIN', 'REGIONAL_OFFICER', 'CONSTITUENCY_OFFICER', 'REGISTRATION_OFFICER', 'AUDITOR', 'OBSERVER', 'SECURITY_OFFICER', 'TRUSTEE'];

export async function adminRoutes(app: FastifyInstance) {
  app.post('/api/admin/login', { schema: { body: { type: 'object', required: ['username', 'password', 'totp'], additionalProperties: false,
    properties: { username: str(3, 40), password: str(1, 200), totp: { type: 'string', pattern: '^[0-9]{6}$' } } } } }, async (req) => {
    const { username, password, totp } = req.body as Record<string, string>;
    if (!limiter.take(req.ip) || !limiter.take('u:' + username)) throw new HttpError(429, 'too many attempts');
    const o = (await pools.admin.query('SELECT * FROM adm.officials WHERE username=$1', [username])).rows[0];
    const ok = (await verifyPassword(password, o?.password_hash)) && o && o.active && verifyTotp(o.totp_secret, totp)
      && !(o.locked_until && new Date(o.locked_until) > new Date());
    if (!ok) {
      if (o) await pools.admin.query(`UPDATE adm.officials SET failed_logins=failed_logins+1, locked_until = CASE WHEN failed_logins+1>=5 THEN now()+interval '30 minutes' END WHERE id=$1`, [o.id]);
      await audit(pools.admin, username, 'official.login_failed', {});
      throw new HttpError(401, 'sign-in failed');
    }
    await pools.admin.query('UPDATE adm.officials SET failed_logins=0, locked_until=NULL WHERE id=$1', [o.id]);
    await audit(pools.admin, username, 'official.login', {});
    return { session: signSession({ sub: o.id, kind: 'official', stage: 'full', roles: o.roles }, 7200), roles: o.roles, name: o.full_name };
  });

  app.get('/api/admin/me', async (req) => official(req));

  // ----- officials (SUPER_ADMIN manages accounts but holds no election powers) -----
  app.get('/api/admin/officials', async (req) => {
    await official(req, 'SUPER_ADMIN', 'AUDITOR');
    return (await pools.admin.query('SELECT id, username, full_name, roles, active, created_at FROM adm.officials ORDER BY username')).rows;
  });
  app.post('/api/admin/officials', { schema: { body: { type: 'object', required: ['username', 'fullName', 'password', 'roles'], additionalProperties: false,
    properties: { username: { type: 'string', pattern: '^[a-z0-9._-]{3,40}$' }, fullName: str(), password: str(12, 200),
      roles: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ROLES } } } } } }, async (req) => {
    const me = await official(req, 'SUPER_ADMIN');
    const b = req.body as { username: string; fullName: string; password: string; roles: string[] };
    if (b.roles.includes('SUPER_ADMIN') && b.roles.length > 1) throw new HttpError(400, 'SUPER_ADMIN cannot be combined with election roles (separation of duties)');
    const secret = randomBytes(20);
    const r = (await pools.admin.query('INSERT INTO adm.officials(username, full_name, password_hash, totp_secret, roles) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [b.username, b.fullName, await hashPassword(b.password), secret, b.roles])).rows[0];
    await audit(pools.admin, me.username, 'official.created', { username: b.username, roles: b.roles });
    const totpSecret = base32(secret);
    return { id: r.id, totpSecret, otpauth: `otpauth://totp/EVote:${b.username}?secret=${totpSecret}&issuer=EVote` };
  });
  app.post('/api/admin/officials/:id/active', { schema: { body: { type: 'object', required: ['active'], properties: { active: { type: 'boolean' } } } } }, async (req) => {
    const me = await official(req, 'SUPER_ADMIN');
    const { id } = req.params as { id: string };
    if (id === me.id) throw new HttpError(400, 'you cannot change your own account');
    await pools.admin.query('UPDATE adm.officials SET active=$2 WHERE id=$1', [id, (req.body as any).active]);
    await audit(pools.admin, me.username, 'official.active_changed', { id, active: (req.body as any).active });
    return { ok: true };
  });

  // ----- elections -----
  app.get('/api/admin/elections', async (req) => {
    await official(req);
    return (await pools.admin.query('SELECT id, name, status, opens_at, closes_at, parties_enabled, trustee_count, trustee_threshold, roll_frozen_at FROM cfg.elections ORDER BY created_at DESC')).rows;
  });
  app.post('/api/admin/elections', { schema: { body: { type: 'object', required: ['name', 'opensAt', 'closesAt'], additionalProperties: false, properties: {
    name: str(3, 200), description: str(0, 2000), opensAt: { type: 'string', format: 'date-time' }, closesAt: { type: 'string', format: 'date-time' },
    partiesEnabled: { type: 'boolean' }, trusteeCount: { type: 'integer', minimum: 1, maximum: 15 }, trusteeThreshold: { type: 'integer', minimum: 1, maximum: 15 },
    closeGraceSeconds: { type: 'integer', minimum: 0, maximum: 3600 } } } } }, async (req) => {
    const me = await official(req, 'NATIONAL_ADMIN');
    const b = req.body as any;
    return tx(pools.admin, async (c) => {
      const r = (await c.query(`INSERT INTO cfg.elections(name, description, opens_at, closes_at, parties_enabled, trustee_count, trustee_threshold, close_grace_s, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [b.name, b.description ?? '', b.opensAt, b.closesAt, b.partiesEnabled ?? false,
        b.trusteeCount ?? 5, b.trusteeThreshold ?? 3, b.closeGraceSeconds ?? 120, me.id])).rows[0];
      await audit(c, me.username, 'election.created', { electionId: r.id, ...b });
      return r;
    });
  });
  app.get('/api/admin/elections/:id', async (req) => {
    await official(req);
    const { id } = req.params as { id: string };
    const e = (await pools.admin.query(`SELECT id, name, description, status, opens_at, closes_at, close_grace_s, parties_enabled, trustee_count, trustee_threshold, roll_frozen_at FROM cfg.elections WHERE id=$1`, [id])).rows[0];
    if (!e) throw new HttpError(404, 'election not found');
    const [constituencies, contests, candidates, approvals] = await Promise.all([
      pools.admin.query('SELECT * FROM cfg.constituencies WHERE election_id=$1 ORDER BY region, name', [id]),
      pools.admin.query('SELECT * FROM cfg.contests WHERE election_id=$1 ORDER BY sort, name', [id]),
      pools.admin.query('SELECT c.* FROM cfg.candidates c JOIN cfg.contests t ON t.id=c.contest_id WHERE t.election_id=$1 ORDER BY c.sort, c.name', [id]),
      pools.admin.query(`SELECT a.id, a.action, a.reason, a.status, a.requested_at, o.username AS requested_by,
          (SELECT json_agg(json_build_object('by', x.username, 'role', v.role_used, 'at', v.voted_at)) FROM adm.approval_votes v JOIN adm.officials x ON x.id=v.official_id WHERE v.approval_id=a.id) AS votes
        FROM adm.approvals a JOIN adm.officials o ON o.id=a.requested_by WHERE a.election_id=$1 ORDER BY a.requested_at DESC`, [id]),
    ]);
    return { ...e, constituencies: constituencies.rows, contests: contests.rows, candidates: candidates.rows, approvals: approvals.rows,
      transitions: Object.entries(TRANSITIONS).filter(([, t]) => t.from.includes(e.status)).map(([k, t]) => ({ action: k, to: t.to, approvers: t.roles })) };
  });
  app.post('/api/admin/elections/:id/constituencies', { schema: { body: { type: 'object', required: ['code', 'name', 'region'], additionalProperties: false,
    properties: { code: { type: 'string', pattern: '^[A-Z0-9-]{2,20}$' }, name: str(), region: str() } } } }, async (req) => {
    const me = await official(req, 'NATIONAL_ADMIN');
    const { id } = req.params as { id: string };
    await assertDraft(id);
    const b = req.body as any;
    const r = (await pools.admin.query('INSERT INTO cfg.constituencies(election_id, code, name, region) VALUES ($1,$2,$3,$4) RETURNING id', [id, b.code, b.name, b.region])).rows[0];
    await audit(pools.admin, me.username, 'constituency.created', { electionId: id, ...b });
    return r;
  });
  app.post('/api/admin/elections/:id/contests', { schema: { body: { type: 'object', required: ['name'], additionalProperties: false,
    properties: { name: str(), maxChoices: { type: 'integer', minimum: 1, maximum: 50 }, sort: { type: 'integer' } } } } }, async (req) => {
    const me = await official(req, 'NATIONAL_ADMIN');
    const { id } = req.params as { id: string };
    await assertDraft(id);
    const b = req.body as any;
    const r = (await pools.admin.query('INSERT INTO cfg.contests(election_id, name, max_choices, sort) VALUES ($1,$2,$3,$4) RETURNING id', [id, b.name, b.maxChoices ?? 1, b.sort ?? 0])).rows[0];
    await audit(pools.admin, me.username, 'contest.created', { electionId: id, ...b });
    return r;
  });
  app.post('/api/admin/elections/:id/candidates', { schema: { body: { type: 'object', required: ['contestId', 'constituencyId', 'name'], additionalProperties: false,
    properties: { contestId: { type: 'string', format: 'uuid' }, constituencyId: { type: 'string', format: 'uuid' }, name: str(), party: str(0, 200),
      bio: str(0, 2000), photoUrl: { type: 'string', pattern: '^(/|https://)[^\\s<>"]{1,500}$' }, sort: { type: 'integer' } } } } }, async (req) => {
    const me = await official(req, 'NATIONAL_ADMIN');
    const { id } = req.params as { id: string };
    await assertDraft(id);
    const b = req.body as any;
    const ok = (await pools.admin.query(`SELECT 1 FROM cfg.contests t, cfg.constituencies k WHERE t.id=$1 AND k.id=$2 AND t.election_id=$3 AND k.election_id=$3`, [b.contestId, b.constituencyId, id])).rowCount;
    if (!ok) throw new HttpError(400, 'contest or constituency does not belong to this election');
    const r = (await pools.admin.query('INSERT INTO cfg.candidates(contest_id, constituency_id, name, party, bio, photo_url, sort) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [b.contestId, b.constituencyId, b.name, b.party ?? null, b.bio ?? '', b.photoUrl ?? null, b.sort ?? 0])).rows[0];
    await audit(pools.admin, me.username, 'candidate.created', { electionId: id, ...b });
    return r;
  });
  app.delete('/api/admin/elections/:id/candidates/:cid', async (req) => {
    const me = await official(req, 'NATIONAL_ADMIN');
    const { id, cid } = req.params as { id: string; cid: string };
    await assertDraft(id);
    await pools.admin.query('DELETE FROM cfg.candidates c USING cfg.contests t WHERE c.id=$1 AND t.id=c.contest_id AND t.election_id=$2', [cid, id]);
    await audit(pools.admin, me.username, 'candidate.deleted', { electionId: id, candidateId: cid });
    return { ok: true };
  });

  // ----- state transitions with multi-person approval -----
  app.post('/api/admin/elections/:id/actions/:action', { schema: { body: { type: 'object', required: ['reason'], properties: { reason: str(3, 500) } } } }, async (req) => {
    const me = await official(req);
    const { id, action } = req.params as { id: string; action: string };
    return requestOrApprove(id, action, me, (req.body as any).reason);
  });
  app.get('/api/admin/approvals', async (req) => {
    await official(req);
    return (await pools.admin.query(`SELECT a.id, a.election_id, e.name AS election, a.action, a.reason, a.status, a.requested_at, o.username AS requested_by,
        (SELECT count(*) FROM adm.approval_votes v WHERE v.approval_id=a.id)::int AS votes
      FROM adm.approvals a JOIN cfg.elections e ON e.id=a.election_id JOIN adm.officials o ON o.id=a.requested_by
      WHERE a.status='PENDING' ORDER BY a.requested_at`)).rows;
  });

  // ----- trustee ceremony -----
  app.post('/api/admin/elections/:id/trustee-share', { schema: { body: { type: 'object', required: ['share'], properties: { share: { type: 'string', maxLength: 100 } } } } }, async (req) => {
    const me = await official(req, 'TRUSTEE');
    return submitShare((req.params as any).id, me, (req.body as any).share);
  });

  // ----- voter registration (two-officer approval) -----
  app.post('/api/admin/voters', { schema: { body: { type: 'object', required: ['nationalId', 'fullName', 'dateOfBirth', 'constituencyCode', 'initialPassword'], additionalProperties: false,
    properties: { nationalId: { type: 'string', pattern: '^[0-9]{6,20}$' }, fullName: str(), dateOfBirth: { type: 'string', format: 'date' },
      constituencyCode: { type: 'string', pattern: '^[A-Z0-9-]{2,20}$' }, phone: { type: 'string', pattern: '^\\+?[0-9]{8,15}$' }, initialPassword: str(10, 200) } } } }, async (req) => {
    const me = await official(req, 'REGISTRATION_OFFICER');
    const b = req.body as any;
    const age = (Date.now() - +new Date(b.dateOfBirth)) / (365.25 * 864e5);
    if (age < 18) throw new HttpError(400, 'voter must be at least 18 years old');
    const dup = (await pools.admin.query('SELECT national_id FROM identity.voters WHERE lower(full_name)=lower($1) AND date_of_birth=$2', [b.fullName, b.dateOfBirth])).rows;
    try {
      const r = (await pools.admin.query(`INSERT INTO identity.voters(national_id, full_name, date_of_birth, constituency_code, phone, password_hash, registered_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, status`, [b.nationalId, b.fullName, b.dateOfBirth, b.constituencyCode, b.phone ?? null, await hashPassword(b.initialPassword), me.id])).rows[0];
      await audit(pools.admin, me.username, 'voter.registered', { voterId: r.id, constituencyCode: b.constituencyCode, possibleDuplicates: dup.length });
      return { ...r, possibleDuplicates: dup.map((d) => d.national_id) };
    } catch (e: any) {
      if (e.code === '23505') throw new HttpError(409, 'a voter with this national ID is already registered');
      throw e;
    }
  });
  app.post('/api/admin/voters/:id/approve', async (req) => {
    const me = await official(req, 'REGISTRATION_OFFICER');
    const { id } = req.params as { id: string };
    const r = await pools.admin.query(`UPDATE identity.voters SET status='ACTIVE', approved_by=$2 WHERE id=$1 AND status='PENDING' AND registered_by IS DISTINCT FROM $2 RETURNING id`, [id, me.id]);
    if (!r.rowCount) throw new HttpError(409, 'not pending, or you registered this voter yourself (a second officer must approve)');
    await audit(pools.admin, me.username, 'voter.approved', { voterId: id });
    return { ok: true };
  });
  app.post('/api/admin/voters/:id/status', { schema: { body: { type: 'object', required: ['status', 'reason'], properties: { status: { enum: ['ACTIVE', 'SUSPENDED', 'REMOVED'] }, reason: str(3, 500) } } } }, async (req) => {
    const me = await official(req, 'REGISTRATION_OFFICER');
    const { id } = req.params as { id: string };
    const b = req.body as any;
    await pools.admin.query(`UPDATE identity.voters SET status=$2 WHERE id=$1 AND status <> 'PENDING'`, [id, b.status]);
    await audit(pools.admin, me.username, 'voter.status_changed', { voterId: id, ...b });
    return { ok: true };
  });
  app.get('/api/admin/voters', async (req) => {
    await official(req, 'REGISTRATION_OFFICER', 'AUDITOR');
    const q = String((req.query as any).q ?? '').slice(0, 100);
    return (await pools.admin.query(`SELECT id, national_id, full_name, date_of_birth, constituency_code, status, created_at FROM identity.voters
      WHERE $1 = '' OR national_id = $1 OR full_name ILIKE '%' || $1 || '%' ORDER BY created_at DESC LIMIT 100`, [q])).rows;
  });

  // ----- audit, monitoring, incidents -----
  app.get('/api/admin/audit', async (req) => {
    await official(req, 'AUDITOR', 'SECURITY_OFFICER', 'OBSERVER', 'NATIONAL_ADMIN');
    const after = Number((req.query as any).after ?? 0) | 0;
    return (await pools.admin.query(`SELECT seq, at, actor, action, details, encode(hash,'hex') AS hash FROM adm.audit_log WHERE seq>$1 ORDER BY seq LIMIT 500`, [after])).rows;
  });
  app.get('/api/admin/audit/verify', async (req) => { await official(req, 'AUDITOR', 'SECURITY_OFFICER'); return verifyAuditChain(pools.admin); });
  app.post('/api/admin/incidents', { schema: { body: { type: 'object', required: ['severity', 'title'], properties: {
    electionId: { type: 'string', format: 'uuid' }, severity: { enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] }, title: str(3, 200), details: str(0, 5000) } } } }, async (req) => {
    const me = await official(req);
    const b = req.body as any;
    const r = (await pools.admin.query('INSERT INTO adm.incidents(election_id, severity, title, details, reported_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [b.electionId ?? null, b.severity, b.title, b.details ?? '', me.id])).rows[0];
    await audit(pools.admin, me.username, 'incident.reported', { incidentId: r.id, severity: b.severity, title: b.title });
    return r;
  });
  app.get('/api/admin/incidents', async (req) => {
    await official(req);
    return (await pools.admin.query('SELECT i.*, o.username AS reporter FROM adm.incidents i LEFT JOIN adm.officials o ON o.id=i.reported_by ORDER BY reported_at DESC LIMIT 200')).rows;
  });
}
