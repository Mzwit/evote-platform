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

  const has = (...r: string[]) => me?.roles?.some((x: string) => r.includes(x));
  async function run(fn: () => Promise<void>, ok = '') {
    error = ''; info = '';
    try { await fn(); if (ok) info = ok; } catch (e) { error = e instanceof ApiError ? e.message : String(e); }
  }

  const login = () => run(async () => {
    const r = await api('/api/admin/login', { body: form, auth: false, maxAttempts: 3 });
    setSession(r.session); form.password = ''; me = { ...r, roles: r.roles };
    await refresh();
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
  }, 'Election created (DRAFT).');
  const addConst = () => run(async () => { await api(`/api/admin/elections/${current.id}/constituencies`, { body: nk }); nk = { code: '', name: '', region: '' }; await openElection(current.id); });
  const addContest = () => run(async () => { await api(`/api/admin/elections/${current.id}/contests`, { body: nc }); nc = { name: '', maxChoices: 1 }; await openElection(current.id); });
  const addCand = () => run(async () => { await api(`/api/admin/elections/${current.id}/candidates`, { body: nd }); nd = { ...nd, name: '', bio: '' }; await openElection(current.id); });
  const act = (action: string) => run(async () => {
    const r = await api(`/api/admin/elections/${current.id}/actions/${action}`, { body: { reason } });
    if (r.trusteeShares) shares = r.trusteeShares;
    info = r.status === 'PENDING' ? `Approval recorded (${r.approvals}/${r.required}). Another authorised official must approve.` : `Done: election is now ${r.newStatus}.`;
    reason = ''; await refresh();
  });
  const submitShare = () => run(async () => {
    const r = await api(`/api/admin/elections/${shareElection}/trustee-share`, { body: { share: share.trim() } });
    share = ''; info = r.status === 'WAITING' ? `Share accepted. ${r.sharesHeld} of ${r.threshold} shares held.` : `Tally complete: ${r.total} ballots, ${r.valid} valid, ${r.invalid} rejected.`;
  });
  const loadAudit = () => run(async () => { audit = await api('/api/admin/audit'); chain = has('AUDITOR', 'SECURITY_OFFICER') ? await api('/api/admin/audit/verify') : null; });
  const searchVoters = () => run(async () => { voters = await api(`/api/admin/voters?q=${encodeURIComponent(vq)}`); });
  const registerVoter = () => run(async () => {
    const r = await api('/api/admin/voters', { body: { ...nv, phone: nv.phone || undefined } });
    info = `Registered (PENDING). A second registration officer must approve.${r.possibleDuplicates.length ? ' Possible duplicates: ' + r.possibleDuplicates.join(', ') : ''}`;
  });
  const approveVoter = (id: string) => run(async () => { await api(`/api/admin/voters/${id}/approve`, { body: {} }); await searchVoters(); }, 'Voter approved.');
  function downloadShares() {
    const blob = new Blob([shares!.map((s, i) => `Trustee ${i + 1}: ${s}`).join('\n')], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `trustee-shares-${current.id}.txt`; a.click();
  }
</script>

<h1>Election officials</h1>
{#if error}<p class="notice bad" role="alert">{error}</p>{/if}
{#if info}<p class="notice good" role="status">{info}</p>{/if}

{#if !me}
  <form onsubmit={(e) => { e.preventDefault(); login(); }}>
    <label for="u">Username</label><input id="u" autocomplete="username" bind:value={form.username} required />
    <label for="p">Password</label><input id="p" type="password" autocomplete="current-password" bind:value={form.password} required />
    <label for="t">Authenticator code</label><input id="t" inputmode="numeric" autocomplete="one-time-code" maxlength="6" bind:value={form.totp} required />
    <div class="row"><button>Sign in</button></div>
  </form>
{:else}
  <p class="muted">Signed in as {me.name} · {me.roles.join(', ')}</p>
  <div class="tabs" role="tablist">
    {#each [['elections', 'Elections'], ['approvals', `Approvals (${approvals.length})`], ['voters', 'Voters'], ['trustee', 'Trustee ceremony'], ['audit', 'Audit log']] as [k, v]}
      <button role="tab" aria-selected={tab === k} class:secondary={tab !== k} onclick={() => { tab = k; if (k === 'audit') loadAudit(); }}>{v}</button>
    {/each}
  </div>

  {#if shares}
    <div class="notice warn" role="alert">
      <strong>Trustee key shares: shown once only.</strong> Give one share to each trustee in person. The system does not keep them.
      Any {current?.trustee_threshold ?? 3} shares are needed to count the votes.
      <ol>{#each shares as s}<li><code>{s}</code></li>{/each}</ol>
      <div class="row"><button class="secondary" onclick={downloadShares}>Download</button><button onclick={() => (shares = null)}>I have distributed them</button></div>
    </div>
  {/if}

  {#if tab === 'elections'}
    {#each elections as e}
      <div class="card"><strong>{e.name}</strong> <span class="muted">{e.status}</span>
        <div class="row"><button class="secondary" onclick={() => openElection(e.id)}>Open</button></div></div>
    {/each}
    {#if has('NATIONAL_ADMIN')}
      <details class="card"><summary>Create election</summary>
        <label for="en">Name</label><input id="en" bind:value={ne.name} />
        <label for="eo">Voting opens</label><input id="eo" type="datetime-local" bind:value={ne.opensAt} />
        <label for="ec">Voting closes</label><input id="ec" type="datetime-local" bind:value={ne.closesAt} />
        <div class="row"><button onclick={createElection}>Create</button></div>
      </details>
    {/if}

    {#if current}
      <h2>{current.name}</h2>
      <p>Status: <strong>{current.status}</strong> · Opens {new Date(current.opens_at).toLocaleString()} · Closes {new Date(current.closes_at).toLocaleString()}</p>
      {#if rec}<p class="muted">Tokens issued {rec.tokensIssued} · ballots accepted {rec.ballotsAccepted} · on board {rec.boardEntries}</p>{/if}

      {#if current.transitions.length}
        <div class="card">
          <strong>Next steps (need approval from distinct officials)</strong>
          <label for="rs">Reason (recorded in the audit log)</label><input id="rs" bind:value={reason} />
          <div class="row">{#each current.transitions as tr}<button onclick={() => act(tr.action)} disabled={reason.length < 3}>{tr.action} → {tr.to}</button>{/each}</div>
        </div>
      {/if}

      <h2>Ballot</h2>
      {#each current.constituencies as k}
        <div class="card"><strong>{k.name}</strong> <span class="muted">{k.code} · {k.region}</span>
          {#each current.contests as c}
            <div class="muted" style="margin-top:.5rem">{c.name}</div>
            <ul>{#each current.candidates.filter((x: any) => x.contest_id === c.id && x.constituency_id === k.id) as d}<li>{d.name}</li>{/each}</ul>
          {/each}
        </div>
      {/each}
      {#if current.status === 'DRAFT' && has('NATIONAL_ADMIN')}
        <details class="card"><summary>Add constituency (inkhundla)</summary>
          <label for="kc">Code</label><input id="kc" bind:value={nk.code} placeholder="HH-MBE" />
          <label for="kn">Name</label><input id="kn" bind:value={nk.name} />
          <label for="kr">Region</label><input id="kr" bind:value={nk.region} />
          <div class="row"><button onclick={addConst}>Add</button></div></details>
        <details class="card"><summary>Add contest</summary>
          <label for="cn">Name</label><input id="cn" bind:value={nc.name} placeholder="Member of Parliament" />
          <label for="cm">Maximum choices</label><input id="cm" type="number" min="1" bind:value={nc.maxChoices} />
          <div class="row"><button onclick={addContest}>Add</button></div></details>
        <details class="card"><summary>Add candidate</summary>
          <label for="dc">Contest</label><select id="dc" bind:value={nd.contestId}>{#each current.contests as c}<option value={c.id}>{c.name}</option>{/each}</select>
          <label for="dk">Constituency</label><select id="dk" bind:value={nd.constituencyId}>{#each current.constituencies as k}<option value={k.id}>{k.name}</option>{/each}</select>
          <label for="dn">Name</label><input id="dn" bind:value={nd.name} />
          <label for="db">Short biography</label><textarea id="db" bind:value={nd.bio}></textarea>
          <div class="row"><button onclick={addCand}>Add</button></div></details>
      {/if}

      <h2>Approval history</h2>
      <table><thead><tr><th>Action</th><th>Status</th><th>Approved by</th></tr></thead>
        <tbody>{#each current.approvals as a}<tr><td>{a.action}</td><td>{a.status}</td><td>{(a.votes ?? []).map((v: any) => `${v.by} (${v.role})`).join(', ')}</td></tr>{/each}</tbody></table>
    {/if}

  {:else if tab === 'approvals'}
    {#if !approvals.length}<p>No pending approvals.</p>{/if}
    {#each approvals as a}
      <div class="card"><strong>{a.action}</strong> · {a.election}<div class="muted">Requested by {a.requested_by}: “{a.reason}” · {a.votes} approval(s)</div>
        <div class="row"><button class="secondary" onclick={() => { tab = 'elections'; openElection(a.election_id); }}>Review and approve</button></div></div>
    {/each}

  {:else if tab === 'voters'}
    {#if has('REGISTRATION_OFFICER', 'AUDITOR')}
      <form class="row" onsubmit={(e) => { e.preventDefault(); searchVoters(); }}><input aria-label="Search by ID or name" bind:value={vq} placeholder="ID number or name" /><button>Search</button></form>
      <table><thead><tr><th>ID</th><th>Name</th><th>Inkhundla</th><th>Status</th><th></th></tr></thead>
        <tbody>{#each voters as v}<tr><td>{v.national_id}</td><td>{v.full_name}</td><td>{v.constituency_code}</td><td>{v.status}</td>
          <td>{#if v.status === 'PENDING' && has('REGISTRATION_OFFICER')}<button class="secondary" onclick={() => approveVoter(v.id)}>Approve</button>{/if}</td></tr>{/each}</tbody></table>
    {/if}
    {#if has('REGISTRATION_OFFICER')}
      <details class="card"><summary>Register a voter</summary>
        <label for="vn">National ID</label><input id="vn" inputmode="numeric" bind:value={nv.nationalId} />
        <label for="vf">Full name</label><input id="vf" bind:value={nv.fullName} />
        <label for="vd">Date of birth</label><input id="vd" type="date" bind:value={nv.dateOfBirth} />
        <label for="vk">Inkhundla code</label><input id="vk" bind:value={nv.constituencyCode} />
        <label for="vp">Mobile number</label><input id="vp" inputmode="tel" bind:value={nv.phone} />
        <label for="vi">Initial password (given to voter in person)</label><input id="vi" bind:value={nv.initialPassword} />
        <div class="row"><button onclick={registerVoter}>Register</button></div></details>
    {:else}<p>Your role cannot register voters.</p>{/if}

  {:else if tab === 'trustee'}
    {#if has('TRUSTEE')}
      <p>After the election is closed, each trustee enters their share here. Counting starts when enough shares are entered. Shares are held in memory only.</p>
      <label for="se">Election</label><select id="se" bind:value={shareElection}>{#each elections.filter((e) => e.status === 'CLOSED') as e}<option value={e.id}>{e.name}</option>{/each}</select>
      <label for="sh">Your key share</label><input id="sh" type="password" autocomplete="off" bind:value={share} />
      <div class="row"><button onclick={submitShare} disabled={!shareElection || !share}>Submit share</button></div>
    {:else}<p>Only trustees take part in the key ceremony.</p>{/if}

  {:else if tab === 'audit'}
    {#if chain}<p class={chain.ok ? 'ok' : 'error'}>{chain.ok ? `✓ Audit chain intact (${chain.records} records)` : `✗ Audit chain broken at record ${chain.brokenAt}`}</p>{/if}
    <table><thead><tr><th>#</th><th>When</th><th>Who</th><th>What</th></tr></thead>
      <tbody>{#each audit as a}<tr><td>{a.seq}</td><td>{new Date(a.at).toLocaleString()}</td><td>{a.actor}</td><td>{a.action}</td></tr>{/each}</tbody></table>
  {/if}
{/if}
