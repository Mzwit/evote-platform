<script lang="ts">
  // Officials' console: elections, approvals, voter registration, trustee ceremony, audit.
  import { api, setSession, ApiError } from '../lib/api';

  let me: any = $state(null);
  let error = $state(''), info = $state('');
  let form = $state({ username: '', password: '', totp: '' });
  let tab = $state('elections');
  let elections: any[] = $state([]);
  let current: any = $state(null);
  let approvals: any[] = $state([]);
  let shares: string[] | null = $state(null);
  let audit: any[] = $state([]);
  let chain: any = $state(null);
  let voters: any[] = $state([]);
  let vq = $state('');
  let ne = $state({ name: '', opensAt: '', closesAt: '' });
  let nk = $state({ code: '', name: '', region: '' });
  let nc = $state({ name: '', maxChoices: 1 });
  let nd = $state({ contestId: '', constituencyId: '', name: '', bio: '' });
  let nv = $state({ nationalId: '', fullName: '', dateOfBirth: '', constituencyCode: '', phone: '', initialPassword: '' });
  let reason = $state('');
  let share = $state(''), shareElection = $state('');
  let rec: any = $state(null);

  const LIFE = ['DRAFT', 'PUBLISHED', 'OPEN', 'CLOSED', 'TALLIED', 'VERIFIED', 'DECLARED'];
  const LABEL: Record<string, string> = { DRAFT: 'Draft', PUBLISHED: 'Published', OPEN: 'Open', SUSPENDED: 'Suspended', CLOSED: 'Closed', TALLIED: 'Counted', VERIFIED: 'Verified', DECLARED: 'Declared' };
  const ACTION: Record<string, string> = { publish: 'Publish ballot', open: 'Open voting', suspend: 'Suspend voting', resume: 'Resume voting', close: 'Close voting', verify: 'Mark results verified', declare: 'Declare results' };
  const lifeIdx = (s: string) => LIFE.indexOf(s === 'SUSPENDED' ? 'OPEN' : s);

  const has = (...r: string[]) => me?.roles?.some((x: string) => r.includes(x));
  async function run(fn: () => Promise<void>, ok = '') {
    error = ''; info = '';
    try { await fn(); if (ok) info = ok; } catch (e) { error = e instanceof ApiError ? e.message : String(e); }
  }

  const login = () => run(async () => {
    const r = await api('/api/admin/login', { body: form, auth: false, maxAttempts: 3 });
    setSession(r.session); form.password = ''; me = { ...r, roles: r.roles };
    await refresh();
    if (elections[0]) await openElection(elections[0].id);
  });
  async function refresh() {
    elections = await api('/api/admin/elections');
    approvals = await api('/api/admin/approvals');
    if (current) await openElection(current.id);
  }
  const openElection = (id: string) => run(async () => {
    current = await api(`/api/admin/elections/${id}`);
    rec = await api(`/api/public/elections/${id}/reconciliation`).catch(() => null);
  });
  const createElection = () => run(async () => {
    const r = await api('/api/admin/elections', { body: { name: ne.name, opensAt: new Date(ne.opensAt).toISOString(), closesAt: new Date(ne.closesAt).toISOString() } });
    await refresh(); await openElection(r.id);
  }, 'Election created as a draft.');
  const addConst = () => run(async () => { await api(`/api/admin/elections/${current.id}/constituencies`, { body: nk }); nk = { code: '', name: '', region: '' }; await openElection(current.id); }, 'Inkhundla added.');
  const addContest = () => run(async () => { await api(`/api/admin/elections/${current.id}/contests`, { body: nc }); nc = { name: '', maxChoices: 1 }; await openElection(current.id); }, 'Contest added.');
  const addCand = () => run(async () => { await api(`/api/admin/elections/${current.id}/candidates`, { body: nd }); nd = { ...nd, name: '', bio: '' }; await openElection(current.id); }, 'Candidate added.');
  const act = (action: string) => run(async () => {
    const r = await api(`/api/admin/elections/${current.id}/actions/${action}`, { body: { reason } });
    if (r.trusteeShares) shares = r.trusteeShares;
    info = r.status === 'PENDING' ? `Your approval is recorded (${r.approvals} of ${r.required}). Another authorised official must approve.` : `Done. The election is now ${LABEL[r.newStatus] ?? r.newStatus}.`;
    reason = ''; await refresh();
  });
  const submitShare = () => run(async () => {
    const r = await api(`/api/admin/elections/${shareElection}/trustee-share`, { body: { share: share.trim() } });
    share = ''; info = r.status === 'WAITING' ? `Share accepted. ${r.sharesHeld} of ${r.threshold} shares entered.` : `Count complete: ${r.total} ballots, ${r.valid} valid, ${r.invalid} rejected.`;
  });
  const loadAudit = () => run(async () => { audit = await api('/api/admin/audit'); chain = has('AUDITOR', 'SECURITY_OFFICER') ? await api('/api/admin/audit/verify') : null; });
  const searchVoters = () => run(async () => { voters = await api(`/api/admin/voters?q=${encodeURIComponent(vq)}`); });
  const registerVoter = () => run(async () => {
    const r = await api('/api/admin/voters', { body: { ...nv, phone: nv.phone || undefined } });
    info = `Voter registered and waiting for a second officer's approval.${r.possibleDuplicates.length ? ' Possible duplicates: ' + r.possibleDuplicates.join(', ') : ''}`;
  });
  const approveVoter = (id: string) => run(async () => { await api(`/api/admin/voters/${id}/approve`, { body: {} }); await searchVoters(); }, 'Voter approved.');
  function downloadShares() {
    const blob = new Blob([shares!.map((s, i) => `Trustee ${i + 1}: ${s}`).join('\n')], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `trustee-shares-${current.id}.txt`; a.click();
  }
  const tabs = $derived([['elections', 'Elections', 0], ['approvals', 'Approvals', approvals.length], ['voters', 'Voters', 0], ['trustee', 'Counting ceremony', 0], ['audit', 'Audit log', 0]] as [string, string, number][]);
</script>

{#if !me}
  <div class="narrow">
    <h1>Officials sign in</h1>
    <p class="muted">For election staff, auditors and trustees. Every action is recorded in a tamper-evident log.</p>
    {#if error}<div class="msg bad" role="alert">{error}</div>{/if}
    <form class="slip" style="margin-top:1.2rem" onsubmit={(e) => { e.preventDefault(); login(); }}>
      <label class="field" for="u" style="margin-top:0">Username</label><input id="u" autocomplete="username" bind:value={form.username} required />
      <label class="field" for="p">Password</label><input id="p" type="password" autocomplete="current-password" bind:value={form.password} required />
      <label class="field" for="t">Authenticator code <span class="hint">6 digits from your authenticator app</span></label>
      <input id="t" class="big mono" inputmode="numeric" autocomplete="one-time-code" maxlength="6" bind:value={form.totp} required />
      <div class="actions"><button class="btn block">Sign in</button></div>
    </form>
  </div>
{:else}
  <div class="console">
    <nav class="side" role="tablist" aria-label="Console sections">
      <div class="who"><strong>{me.name}</strong>{me.roles.map((r: string) => r.toLowerCase().replace(/_/g, ' ')).join(', ')}</div>
      {#each tabs as [k, v, count]}
        <button role="tab" aria-selected={tab === k} onclick={() => { tab = k; if (k === 'audit') loadAudit(); }}>{v}{#if count}<span class="badge">{count}</span>{/if}</button>
      {/each}
    </nav>

    <div>
      {#if error}<div class="msg bad" role="alert">{error}</div>{/if}
      {#if info}<div class="msg good" role="status">{info}</div>{/if}

      {#if shares}
        <div class="panel" style="border:2px solid var(--seal)" role="alert">
          <h2>Trustee key shares: shown once</h2>
          <p>Give one share to each trustee in person. The system keeps no copy. Any {current?.trustee_threshold ?? 3} shares together unlock the count.</p>
          <ol>{#each shares as s}<li><span class="mono" style="font-size:.85rem; word-break:break-all">{s}</span></li>{/each}</ol>
          <div class="actions"><button class="btn ghost" onclick={downloadShares}>Download as text file</button><button class="btn" onclick={() => (shares = null)}>I have handed them out</button></div>
        </div>
      {/if}

      {#if tab === 'elections'}
        {#if current}
          <div class="panel">
            <div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap; align-items:baseline">
              <h1 style="font-size:1.6rem">{current.name}</h1>
              {#if elections.length > 1}
                <select style="width:auto" value={current.id} onchange={(e) => openElection((e.target as HTMLSelectElement).value)} aria-label="Choose election">
                  {#each elections as e}<option value={e.id}>{e.name}</option>{/each}
                </select>
              {/if}
            </div>
            <ol class="lifecycle" aria-label="Election stage">
              {#each LIFE as s, i}<li class:done={i < lifeIdx(current.status)} class:now={i === lifeIdx(current.status)}>{s === 'OPEN' && current.status === 'SUSPENDED' ? 'Suspended' : LABEL[s]}</li>{/each}
            </ol>
            <p class="muted">Voting {new Date(current.opens_at).toLocaleString()} to {new Date(current.closes_at).toLocaleString()}</p>
            {#if rec}
              <div class="stats">
                <div class="stat"><div class="n">{rec.tokensIssued.toLocaleString()}</div><div class="l">Voting passes issued</div></div>
                <div class="stat"><div class="n">{rec.ballotsAccepted.toLocaleString()}</div><div class="l">Ballots accepted</div></div>
                <div class="stat"><div class="n">{rec.boardEntries.toLocaleString()}</div><div class="l">On public list</div></div>
              </div>
            {/if}
          </div>

          {#if current.transitions.length}
            <div class="panel">
              <h2>Next step</h2>
              <p class="muted">Each step needs approval from two different authorised officials. Your reason goes into the audit log.</p>
              <label class="field" for="rs">Reason</label><input id="rs" bind:value={reason} placeholder="For example: polls closed at 18:00 as gazetted" />
              <div class="actions">{#each current.transitions as tr}<button class="btn {tr.action === 'suspend' ? 'ghost' : ''}" onclick={() => act(tr.action)} disabled={reason.length < 3}>{ACTION[tr.action] ?? tr.action}</button>{/each}</div>
            </div>
          {/if}

          <div class="panel">
            <h2>Ballot</h2>
            <div class="grid-2" style="margin-top:.8rem">
              {#each current.constituencies as k}
                <div>
                  <h3>{k.name} <span class="muted">{k.code} · {k.region}</span></h3>
                  {#each current.contests as c}
                    <p class="muted" style="margin:.6rem 0 .2rem">{c.name}</p>
                    <div style="font-size:.95rem">{current.candidates.filter((x: any) => x.contest_id === c.id && x.constituency_id === k.id).map((d: any) => d.name).join(', ') || 'No candidates yet'}</div>
                  {/each}
                </div>
              {/each}
            </div>
            {#if current.status === 'DRAFT' && has('NATIONAL_ADMIN')}
              <details style="margin-top:1.2rem"><summary>Add inkhundla</summary>
                <div class="form-grid">
                  <div><label class="field" for="kc">Code</label><input id="kc" bind:value={nk.code} placeholder="HH-MBE" /></div>
                  <div><label class="field" for="kn">Name</label><input id="kn" bind:value={nk.name} /></div>
                  <div><label class="field" for="kr">Region</label><input id="kr" bind:value={nk.region} /></div>
                </div><div class="actions"><button class="btn" onclick={addConst}>Add inkhundla</button></div></details>
              <details><summary>Add contest</summary>
                <div class="form-grid">
                  <div><label class="field" for="cn">Name</label><input id="cn" bind:value={nc.name} placeholder="Member of Parliament" /></div>
                  <div><label class="field" for="cm">Choices allowed</label><input id="cm" type="number" min="1" bind:value={nc.maxChoices} /></div>
                </div><div class="actions"><button class="btn" onclick={addContest}>Add contest</button></div></details>
              <details><summary>Add candidate</summary>
                <div class="form-grid">
                  <div><label class="field" for="dc">Contest</label><select id="dc" bind:value={nd.contestId}>{#each current.contests as c}<option value={c.id}>{c.name}</option>{/each}</select></div>
                  <div><label class="field" for="dk">Inkhundla</label><select id="dk" bind:value={nd.constituencyId}>{#each current.constituencies as k}<option value={k.id}>{k.name}</option>{/each}</select></div>
                  <div><label class="field" for="dn">Name</label><input id="dn" bind:value={nd.name} /></div>
                </div>
                <label class="field" for="db">Short biography</label><textarea id="db" rows="2" bind:value={nd.bio}></textarea>
                <div class="actions"><button class="btn" onclick={addCand}>Add candidate</button></div></details>
            {:else if current.status !== 'DRAFT'}<p class="muted" style="margin-top:1rem">The ballot is locked because the election has been published.</p>{/if}
          </div>

          <div class="panel">
            <h2>Approval history</h2>
            {#if !current.approvals.length}<p class="muted">No approvals yet.</p>{/if}
            <div class="row-list">
              {#each current.approvals as a}
                <div><span><strong>{ACTION[a.action] ?? a.action}</strong><br /><span class="muted">{(a.votes ?? []).map((v: any) => v.by).join(' and ')}</span></span><span class="status {a.status === 'EXECUTED' ? 'declared' : 'prelim'}">{a.status === 'EXECUTED' ? 'Done' : 'Waiting'}</span></div>
              {/each}
            </div>
          </div>
        {/if}

        {#if has('NATIONAL_ADMIN')}
          <details class="panel"><summary>Create a new election</summary>
            <label class="field" for="en">Name</label><input id="en" bind:value={ne.name} />
            <div class="form-grid">
              <div><label class="field" for="eo">Voting opens</label><input id="eo" type="datetime-local" bind:value={ne.opensAt} /></div>
              <div><label class="field" for="ec">Voting closes</label><input id="ec" type="datetime-local" bind:value={ne.closesAt} /></div>
            </div>
            <div class="actions"><button class="btn" onclick={createElection}>Create draft election</button></div>
          </details>
        {/if}

      {:else if tab === 'approvals'}
        <h1 style="font-size:1.6rem">Waiting for your approval</h1>
        {#if !approvals.length}<div class="panel"><p class="muted">Nothing is waiting. Requests from other officials appear here.</p></div>{/if}
        {#each approvals as a}
          <div class="panel">
            <h3>{ACTION[a.action] ?? a.action}</h3>
            <p class="muted">{a.election} · requested by {a.requested_by}: “{a.reason}”</p>
            <div class="actions"><button class="btn" onclick={() => { tab = 'elections'; openElection(a.election_id); }}>Review and approve</button></div>
          </div>
        {/each}

      {:else if tab === 'voters'}
        <h1 style="font-size:1.6rem">Voter register</h1>
        {#if has('REGISTRATION_OFFICER', 'AUDITOR')}
          <form class="actions" style="margin-top:.8rem" onsubmit={(e) => { e.preventDefault(); searchVoters(); }}>
            <input aria-label="Search by ID number or name" bind:value={vq} placeholder="ID number or name" style="flex:3 1 14rem" /><button class="btn">Search</button>
          </form>
          {#if voters.length}
            <div class="panel" style="margin-top:1rem; overflow-x:auto">
              <table><thead><tr><th>ID number</th><th>Name</th><th>Inkhundla</th><th>Status</th><th></th></tr></thead>
                <tbody>{#each voters as v}<tr><td class="mono">{v.national_id}</td><td>{v.full_name}</td><td>{v.constituency_code}</td><td>{v.status.toLowerCase()}</td>
                  <td>{#if v.status === 'PENDING' && has('REGISTRATION_OFFICER')}<button class="btn ghost sm" onclick={() => approveVoter(v.id)}>Approve</button>{/if}</td></tr>{/each}</tbody></table>
            </div>
          {/if}
        {/if}
        {#if has('REGISTRATION_OFFICER')}
          <details class="panel"><summary>Register a voter</summary>
            <div class="form-grid">
              <div><label class="field" for="vn">National ID</label><input id="vn" class="mono" inputmode="numeric" bind:value={nv.nationalId} /></div>
              <div><label class="field" for="vf">Full name</label><input id="vf" bind:value={nv.fullName} /></div>
              <div><label class="field" for="vd">Date of birth</label><input id="vd" type="date" bind:value={nv.dateOfBirth} /></div>
              <div><label class="field" for="vk">Inkhundla code</label><input id="vk" bind:value={nv.constituencyCode} /></div>
              <div><label class="field" for="vp">Mobile number</label><input id="vp" inputmode="tel" bind:value={nv.phone} /></div>
              <div><label class="field" for="vi">First password</label><input id="vi" bind:value={nv.initialPassword} /></div>
            </div>
            <p class="muted">Give the first password to the voter in person. A second registration officer must approve the record.</p>
            <div class="actions"><button class="btn" onclick={registerVoter}>Register voter</button></div></details>
        {:else if !has('AUDITOR')}<div class="panel"><p class="muted">Your role cannot see the voter register.</p></div>{/if}

      {:else if tab === 'trustee'}
        <h1 style="font-size:1.6rem">Counting ceremony</h1>
        {#if has('TRUSTEE')}
          <div class="panel">
            <p>After voting closes, each trustee enters their key share. Counting starts once enough shares are in. Shares are never saved.</p>
            <label class="field" for="se">Election</label><select id="se" bind:value={shareElection}>{#each elections.filter((e) => e.status === 'CLOSED') as e}<option value={e.id}>{e.name}</option>{/each}</select>
            <label class="field" for="sh">Your key share</label><input id="sh" class="mono" type="password" autocomplete="off" bind:value={share} />
            <div class="actions"><button class="btn" onclick={submitShare} disabled={!shareElection || !share}>Enter my share</button></div>
          </div>
        {:else}<div class="panel"><p class="muted">Only trustees take part in the counting ceremony.</p></div>{/if}

      {:else if tab === 'audit'}
        <h1 style="font-size:1.6rem">Audit log</h1>
        {#if chain}<div class="msg {chain.ok ? 'good' : 'bad'}">{chain.ok ? `Log intact: all ${chain.records} records link correctly.` : `Log broken at record ${chain.brokenAt}. Report this to the security officer now.`}</div>{/if}
        <div class="panel" style="overflow-x:auto">
          <table><thead><tr><th>#</th><th>When</th><th>Who</th><th>What</th></tr></thead>
            <tbody>{#each audit as a}<tr><td class="num">{a.seq}</td><td>{new Date(a.at).toLocaleString()}</td><td>{a.actor}</td><td>{a.action.replace(/[._]/g, ' ')}</td></tr>{/each}</tbody></table>
        </div>
      {/if}
    </div>
  </div>
{/if}
