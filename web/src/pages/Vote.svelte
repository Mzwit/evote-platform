<script lang="ts">
  import { t } from '../lib/i18n';
  import { api, setSession, ApiError } from '../lib/api';
  import { b64, unb64, importBlindPublicKey, createBlindedToken, finalizeToken, encryptBallot } from '../../../shared/protocol';

  type Step = 'login' | 'otp' | 'elections' | 'ballot' | 'review' | 'casting' | 'receipt';
  let step: Step = $state('login');
  let busy = $state(false);
  let error = $state('');
  let nationalId = $state(new URLSearchParams(location.hash.split('?')[1] ?? '').get('nid') ?? ''), password = $state(''), code = $state('');
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

  const railSteps = ['Sign in', 'Code', 'Ballot', 'Check', 'Cast'];
  const railAt = $derived(({ login: 0, otp: 1, elections: 2, ballot: 2, review: 3, casting: 4, receipt: 5 } as Record<Step, number>)[step]);

  async function run(fn: () => Promise<void>) {
    error = ''; busy = true;
    try { await fn(); } catch (e) { error = e instanceof ApiError ? e.message : (e as Error).message || t.error; } finally { busy = false; }
  }

  const login = () => run(async () => {
    challenge = await api('/api/voter/login', { body: { nationalId: nationalId.trim(), password }, auth: false, maxAttempts: 5 });
    password = '';
    setSession(challenge.session);
    if (challenge.devOtp) code = challenge.devOtp; // development / demo only
    step = 'otp';
  });

  const verifyOtp = () => run(async () => {
    const r = await api('/api/voter/otp', { body: { challengeId: challenge.challengeId, code: code.trim() }, maxAttempts: 5 });
    setSession(r.session);
    me = await api('/api/voter/me');
    const openOnes = me.elections.filter((e: any) => e.status === 'OPEN' && !e.token_issued);
    if (openOnes.length === 1 && me.elections.length === 1) return openBallotNow(openOnes[0].id);
    step = 'elections';
  });

  async function openBallotNow(id: string) {
    ballot = await api(`/api/voter/elections/${id}/ballot`);
    selections = Object.fromEntries(ballot.contests.map((c: any) => [c.id, []]));
    idx = 0; step = 'ballot';
  }
  const openBallot = (id: string) => run(() => openBallotNow(id));

  function toggle(contest: any, candId: string) {
    const cur = selections[contest.id] ?? [];
    if (contest.max_choices === 1) selections[contest.id] = cur[0] === candId ? [] : [candId];
    else selections[contest.id] = cur.includes(candId) ? cur.filter((x) => x !== candId) : cur.length < contest.max_choices ? [...cur, candId] : cur;
  }
  const nameOf = (contest: any, id: string) => contest.candidates.find((c: any) => c.id === id)?.name ?? '?';

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
  const tick = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6" fill="none" stroke="var(--royal)" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
</script>

<div class="narrow">
  {#if step !== 'receipt'}
    <ol class="rail" aria-label="Progress">
      {#each railSteps as s, i}<li class:done={i < railAt} class:now={i === railAt} aria-current={i === railAt ? 'step' : undefined}>{s}</li>{/each}
    </ol>
  {/if}

  {#if error}<div class="msg bad" role="alert">{error}</div>{/if}

  {#if step === 'login'}
    <h1 tabindex="-1" bind:this={heading}>{t.signIn}</h1>
    <p class="muted">Use the ID number and password from your registration.</p>
    <form onsubmit={(e) => { e.preventDefault(); login(); }}>
      <label class="field" for="nid">{t.nationalId}</label>
      <input id="nid" class="big mono" inputmode="numeric" autocomplete="username" pattern="[0-9]*" required bind:value={nationalId} />
      <label class="field" for="pw">{t.password}</label>
      <input id="pw" type="password" autocomplete="current-password" required bind:value={password} />
      <div class="actions"><button class="btn block" disabled={busy}>{busy ? 'Checking…' : t.continue}</button></div>
    </form>

  {:else if step === 'otp'}
    <h1 tabindex="-1" bind:this={heading}>{t.otpTitle}</h1>
    <p class="muted">{t.otpHelp}{challenge?.phoneHint ? ` to ${challenge.phoneHint}` : ''}.</p>
    {#if challenge?.devOtp}<div class="msg warn">Demo: the code is filled in for you. A real election sends it by SMS.</div>{/if}
    <form onsubmit={(e) => { e.preventDefault(); verifyOtp(); }}>
      <label class="field" for="otp">{t.otp}</label>
      <input id="otp" class="big mono" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required bind:value={code} />
      <div class="actions"><button class="btn block" disabled={busy}>{busy ? 'Checking…' : t.continue}</button></div>
    </form>

  {:else if step === 'elections'}
    <h1 tabindex="-1" bind:this={heading}>{t.yourElections}</h1>
    <p class="muted">Signed in as {me.name}</p>
    {#if !me.elections.length}<div class="msg info">{t.noElections}</div>{/if}
    {#each me.elections as e}
      <div class="slip" style="margin-top:1rem">
        <div class="slip-head"><h2>{e.name}</h2></div>
        <p class="muted">{t.constituency}: {e.constituency}</p>
        {#if e.token_issued}<div class="msg warn">{t.alreadyIssued}</div>
        {:else if e.status === 'OPEN'}<div class="actions"><button class="btn block" disabled={busy} onclick={() => openBallot(e.id)}>{t.start}</button></div>
        {:else}<p><span class="status other">{t.notOpen}</span></p>{/if}
      </div>
    {/each}

  {:else if step === 'ballot'}
    {@const contest = ballot.contests[idx]}
    <p class="muted">Contest {idx + 1} of {ballot.contests.length}</p>
    <fieldset class="slip" style="border:0; margin:.5rem 0 0">
      <legend class="sr-only">{contest.name}</legend>
      <div class="slip-head">
        <h1 tabindex="-1" bind:this={heading} style="font-size:1.6rem">{contest.name}</h1>
        <span class="where">{ballot.constituency}<br />{t.chooseUpTo(contest.max_choices)}</span>
      </div>
      {#each contest.candidates as c}
        {@const on = selections[contest.id]?.includes(c.id)}
        <label class="cand" class:on>
          <input type={contest.max_choices === 1 ? 'radio' : 'checkbox'} name={contest.id} checked={on} onchange={() => toggle(contest, c.id)} />
          <span><span class="name">{c.name}</span>{#if c.party}<span class="bio">{c.party}</span>{/if}{#if c.bio}<span class="bio">{c.bio}</span>{/if}</span>
          <span class="mark">{@html tick}</span>
        </label>
      {/each}
      <label class="cand blank" class:on={!selections[contest.id]?.length}>
        <input type="checkbox" checked={!selections[contest.id]?.length} onchange={() => (selections[contest.id] = [])} />
        <span class="name">{t.leaveBlank}</span>
        <span class="mark">{@html tick}</span>
      </label>
    </fieldset>
    <div class="actions">
      <button class="btn ghost" onclick={() => (idx > 0 ? idx-- : (step = 'elections'))}>{t.back}</button>
      <button class="btn" onclick={() => (idx < ballot.contests.length - 1 ? idx++ : (step = 'review'))}>{idx < ballot.contests.length - 1 ? 'Next contest' : 'Check my choices'}</button>
    </div>

  {:else if step === 'review'}
    <h1 tabindex="-1" bind:this={heading}>{t.review}</h1>
    <div class="slip" style="margin-top:1rem">
      <div class="slip-head"><h2>{ballot.name}</h2><span class="where">{ballot.constituency}</span></div>
      {#each ballot.contests as c, i}
        <div class="review-row">
          <div><div class="k">{c.name}</div><div class="v">{selections[c.id]?.length ? selections[c.id].map((id) => nameOf(c, id)).join(', ') : t.noChoice}</div></div>
          {#if !prepared}<button class="btn ghost sm" onclick={() => { idx = i; step = 'ballot'; }}>{t.change}</button>{/if}
        </div>
      {/each}
    </div>
    {#if prepared}<div class="msg warn">Your sealed ballot is ready but was not yet confirmed as received. Press the button to send the same ballot again.</div>
    {:else}<div class="msg info">{t.confirmWarn}</div>{/if}
    <div class="actions"><button class="btn seal block" disabled={busy} onclick={castVote}>{t.cast}</button></div>

  {:else if step === 'casting'}
    <h1 tabindex="-1" bind:this={heading}>Sealing your ballot</h1>
    <div class="slip" style="margin-top:1.2rem">
      <p role="status" aria-live="polite" style="font-weight:700">{castStage}</p>
      <div class="turnout"><div style="width:{castStage === t.sending ? 80 : 35}%; transition: width .6s"></div></div>
      <p class="muted">Keep this page open. If the connection drops, it continues by itself.</p>
    </div>

  {:else if step === 'receipt'}
    <div class="stub">
      <svg class="stamp" viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r="54" fill="none" stroke="currentColor" stroke-width="5" />
        <circle cx="60" cy="60" r="44" fill="none" stroke="currentColor" stroke-width="2" />
        <text x="60" y="54" text-anchor="middle" font-size="13" font-weight="700" letter-spacing="1" fill="currentColor" font-family="Atkinson, sans-serif">RECORDED</text>
        <path d="M44 70l11 10 22-23" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <div class="top">
        <h1 tabindex="-1" bind:this={heading} style="font-size:1.6rem; max-width:12ch">{t.accepted}</h1>
        <p class="muted" style="margin-top:.6rem">{ballot.name}<br />{new Date(receipt.acceptedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</p>
      </div>
      <div class="perf" aria-hidden="true"><span></span><span></span></div>
      <div class="bottom">
        <div class="muted">{t.trackerLabel}</div>
        <div class="code" style="margin-top:.3rem" aria-label={receipt.tracker}>{#each receipt.tracker.split('-') as g}<span>{g}</span>{/each}</div>
      </div>
    </div>
    <p style="margin-top:1.2rem">{t.trackerHelp}</p>
    <div class="actions">
      <button class="btn ghost" onclick={copy}>{copied ? t.copied : t.copy}</button>
      <a class="btn ghost" href="#/verify?e={ballot.electionId}&t={receipt.tracker}">{t.checkReceipt}</a>
    </div>
    <div class="actions"><button class="btn block" onclick={finish}>{t.done}</button></div>
  {/if}
</div>
