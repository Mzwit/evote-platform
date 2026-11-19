<script lang="ts">
  import { t } from '../lib/i18n';
  import { api, setSession, ApiError } from '../lib/api';
  import { b64, unb64, importBlindPublicKey, createBlindedToken, finalizeToken, encryptBallot } from '../../../shared/protocol';

  type Step = 'login' | 'otp' | 'elections' | 'ballot' | 'review' | 'casting' | 'receipt';
  let step: Step = $state('login');
  let busy = $state(false);
  let error = $state('');
  let nationalId = $state(''), password = $state(''), code = $state('');
  let challenge: any = $state(null);
  let me: any = $state(null);
  let ballot: any = $state(null);
  let idx = $state(0);
  let selections: Record<string, string[]> = $state({});
  let castStage = $state('');
  let receipt: any = $state(null);
  let copied = $state(false);
  let heading: HTMLElement | undefined = $state();

  $effect(() => { step; idx; heading?.focus(); }); // move focus to the new screen's heading (screen readers)

  async function run(fn: () => Promise<void>) {
    error = ''; busy = true;
    try { await fn(); } catch (e) { error = e instanceof ApiError ? e.message : (e as Error).message || t.error; } finally { busy = false; }
  }

  const login = () => run(async () => {
    challenge = await api('/api/voter/login', { body: { nationalId: nationalId.trim(), password }, auth: false, maxAttempts: 5 });
    password = '';
    setSession(challenge.session);
    if (challenge.devOtp) code = challenge.devOtp; // development builds only
    step = 'otp';
  });

  const verifyOtp = () => run(async () => {
    const r = await api('/api/voter/otp', { body: { challengeId: challenge.challengeId, code: code.trim() }, maxAttempts: 5 });
    setSession(r.session);
    me = await api('/api/voter/me');
    step = 'elections';
  });

  const openBallot = (id: string) => run(async () => {
    ballot = await api(`/api/voter/elections/${id}/ballot`);
    selections = Object.fromEntries(ballot.contests.map((c: any) => [c.id, []]));
    idx = 0; step = 'ballot';
  });

  function toggle(contest: any, candId: string) {
    const cur = selections[contest.id] ?? [];
    if (contest.max_choices === 1) selections[contest.id] = cur[0] === candId ? [] : [candId];
    else selections[contest.id] = cur.includes(candId) ? cur.filter((x) => x !== candId) : cur.length < contest.max_choices ? [...cur, candId] : cur;
  }

  const nameOf = (contest: any, id: string) => contest.candidates.find((c: any) => c.id === id)?.name ?? '?';

  // The cast: token and encrypted ballot exist only in memory on this page.
  // Kept in memory so a retry re-sends the SAME token and ballot (never a duplicate).
  let prepared: { pending: any; sig: Uint8Array; enc: Uint8Array; ct: Uint8Array } | null = $state.raw(null);
  const castVote = () => run(async () => {
    step = 'casting';
    if (!prepared) {
      castStage = t.securing;
      const pub = await importBlindPublicKey(unb64(ballot.signingKey));
      const pending = await createBlindedToken(pub);
      const { enc, ct } = await encryptBallot(unb64(ballot.electionKey), { v: 1, e: ballot.electionId, c: ballot.constituencyId, s: $state.snapshot(selections) });
      const { blindSig } = await api(`/api/voter/elections/${ballot.electionId}/token`, { body: { blinded: b64(pending.blinded) }, maxAttempts: 60 });
      prepared = { pending, sig: await finalizeToken(pub, pending, unb64(blindSig)), enc, ct };
      // Short random delay weakens timing correlation between token issue and cast.
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 1200));
    }
    castStage = t.sending;
    const p = prepared;
    receipt = await api('/api/cast', { auth: false, maxAttempts: 120,
      body: { electionId: ballot.electionId, constituencyId: ballot.constituencyId, token: b64(p.pending.prepared), sig: b64(p.sig), enc: b64(p.enc), ct: b64(p.ct) } });
    prepared = null;
    setSession(null);
    step = 'receipt';
  }).then(() => { if (step === 'casting' && error) step = 'review'; });

  async function copy() { await navigator.clipboard?.writeText(receipt.tracker); copied = true; }
  function finish() { setSession(null); location.hash = '#/'; }
</script>

{#if error}<div class="notice bad" role="alert">{error}</div>{/if}

{#if step === 'login'}
  <h1 tabindex="-1" bind:this={heading}>{t.signIn}</h1>
  <form onsubmit={(e) => { e.preventDefault(); login(); }}>
    <label for="nid">{t.nationalId}</label>
    <input id="nid" inputmode="numeric" autocomplete="username" pattern="[0-9]*" required bind:value={nationalId} />
    <label for="pw">{t.password}</label>
    <input id="pw" type="password" autocomplete="current-password" required bind:value={password} />
    <div class="row"><button disabled={busy}>{t.continue}</button></div>
  </form>

{:else if step === 'otp'}
  <h1 tabindex="-1" bind:this={heading}>{t.otpTitle}</h1>
  <p class="muted">{t.otpHelp}{challenge?.phoneHint ? ` (${challenge.phoneHint})` : ''}.</p>
  {#if challenge?.devOtp}<p class="notice warn">Development mode: code pre-filled. Real deployments send it by SMS.</p>{/if}
  <form onsubmit={(e) => { e.preventDefault(); verifyOtp(); }}>
    <label for="otp">{t.otp}</label>
    <input id="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required bind:value={code} />
    <div class="row"><button disabled={busy}>{t.continue}</button></div>
  </form>

{:else if step === 'elections'}
  <h1 tabindex="-1" bind:this={heading}>{t.yourElections}</h1>
  <p class="muted">{me.name}</p>
  {#if !me.elections.length}<p>{t.noElections}</p>{/if}
  {#each me.elections as e}
    <div class="card">
      <strong>{e.name}</strong>
      <div class="muted">{t.constituency}: {e.constituency}</div>
      {#if e.token_issued}<p class="notice warn">{t.alreadyIssued}</p>
      {:else if e.status === 'OPEN'}<div class="row"><button disabled={busy} onclick={() => openBallot(e.id)}>{t.start}</button></div>
      {:else}<p class="muted">{t.notOpen} ({e.status})</p>{/if}
    </div>
  {/each}

{:else if step === 'ballot'}
  {@const contest = ballot.contests[idx]}
  <p class="muted">{t.stepOf(idx + 1, ballot.contests.length + 1)} · {ballot.constituency}</p>
  <div class="progress" aria-hidden="true"><div style="width:{(100 * (idx + 1)) / (ballot.contests.length + 1)}%"></div></div>
  <h1 tabindex="-1" bind:this={heading}>{contest.name}</h1>
  <fieldset style="border:0; padding:0; margin:0">
    <legend class="muted">{t.chooseUpTo(contest.max_choices)}</legend>
    {#each contest.candidates as c}
      {@const on = selections[contest.id]?.includes(c.id)}
      <label class="choice" class:selected={on}>
        <input type={contest.max_choices === 1 ? 'radio' : 'checkbox'} name={contest.id} checked={on} onchange={() => toggle(contest, c.id)} />
        <span><span class="name">{c.name}</span>{#if c.party}<br /><span class="muted">{c.party}</span>{/if}{#if c.bio}<br /><span class="muted">{c.bio}</span>{/if}</span>
      </label>
    {/each}
    <label class="choice" class:selected={!selections[contest.id]?.length}>
      <input type="checkbox" checked={!selections[contest.id]?.length} onchange={() => (selections[contest.id] = [])} />
      <span>{t.leaveBlank}</span>
    </label>
  </fieldset>
  <div class="row">
    <button class="secondary" onclick={() => (idx > 0 ? idx-- : (step = 'elections'))}>{t.back}</button>
    <button onclick={() => (idx < ballot.contests.length - 1 ? idx++ : (step = 'review'))}>{t.continue}</button>
  </div>

{:else if step === 'review'}
  <p class="muted">{t.stepOf(ballot.contests.length + 1, ballot.contests.length + 1)}</p>
  <h1 tabindex="-1" bind:this={heading}>{t.review}</h1>
  {#each ballot.contests as c, i}
    <div class="card">
      <div class="muted">{c.name}</div>
      <div class="name" style="font-weight:700">{selections[c.id]?.length ? selections[c.id].map((id) => nameOf(c, id)).join(', ') : t.noChoice}</div>
      {#if !prepared}<button class="secondary" style="margin-top:.5rem" onclick={() => { idx = i; step = 'ballot'; }}>{t.change}</button>{/if}
    </div>
  {/each}
  {#if prepared}<p class="notice warn">Your sealed ballot is ready but was not yet confirmed as received. Press the button to send the same ballot again.</p>{:else}<p class="notice warn">{t.confirmWarn}</p>{/if}
  <div class="row"><button disabled={busy} onclick={castVote}>{t.cast}</button></div>

{:else if step === 'casting'}
  <h1 tabindex="-1" bind:this={heading}>{t.cast}</h1>
  <p role="status" aria-live="polite">{castStage}</p>
  <div class="progress"><div style="width:{castStage === t.sending ? 80 : 40}%"></div></div>

{:else if step === 'receipt'}
  <h1 tabindex="-1" bind:this={heading} class="ok">{t.accepted}</h1>
  <label for="trk">{t.trackerLabel}</label>
  <div id="trk" class="tracker">{receipt.tracker}</div>
  <p>{t.trackerHelp}</p>
  <div class="row">
    <button class="secondary" onclick={copy}>{copied ? t.copied : t.copy}</button>
    <a class="btn secondary" href="#/verify?e={ballot.electionId}&t={receipt.tracker}">{t.checkReceipt}</a>
  </div>
  <div class="row"><button onclick={finish}>{t.done}</button></div>
{/if}
