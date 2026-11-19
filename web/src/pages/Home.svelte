<script lang="ts">
  import { t } from '../lib/i18n';
  import { api } from '../lib/api';
  let demo: any = $state(null);
  let open: any = $state(null);
  api('/api/public/demo', { maxAttempts: 3 }).then((d) => (demo = d.enabled ? d : null)).catch(() => {});
  api('/api/public/elections', { maxAttempts: 3 }).then((r) => (open = r.find((e: any) => e.status === 'OPEN') ?? r[0] ?? null)).catch(() => {});
  const closes = (e: any) => new Date(e.closes_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<section class="hero">
  <div>
    <h1>Vote from your phone. Keep your choice secret.</h1>
    <p class="lead">Your ballot is sealed on your own device before it leaves. Nobody can match it to your name, and you can check it was counted.</p>
    <div class="actions" style="max-width:30rem">
      <a class="btn" href="#/vote">{t.vote}</a>
      <a class="btn ghost" href="#/results">See results</a>
    </div>
    {#if open}<p class="muted" style="margin-top:1rem">{open.name}: {open.status === 'OPEN' ? `voting open until ${closes(open)}` : open.status.toLowerCase()}</p>{/if}
  </div>

  {#if demo}
    <div class="slip">
      <div class="slip-head"><h2>Try the demo</h2><span class="where">Fictional voters</span></div>
      <p class="muted">Pick any ID to sign in. Each one can vote once.</p>
      <div class="chips">
        {#each demo.nationalIds as id}<a class="chip" href="#/vote?nid={id}">{id}</a>{/each}
      </div>
      <p style="margin-top:.8rem">Password <span class="mono">{demo.password}</span></p>
      <p class="muted">The SMS code is filled in for you in this demo.</p>
    </div>
  {:else}
    <div class="slip" aria-hidden="true">
      <div class="slip-head"><h2>Member of Parliament</h2><span class="where">Your inkhundla</span></div>
      <div class="cand on"><span><span class="name">Your candidate</span></span><span class="mark"><svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6" fill="none" stroke="var(--royal)" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></div>
      <div class="cand"><span><span class="name">Another candidate</span></span><span class="mark"></span></div>
    </div>
  {/if}
</section>

<section class="section">
  <h2>How your vote stays secret</h2>
  <ol class="steps-secret">
    <li>Your choices are locked on your phone before they are sent.</li>
    <li>You get a one-time pass that proves you may vote, without naming you.</li>
    <li>Your locked ballot travels with that pass only, separate from your name.</li>
    <li>After polls close, several independent trustees unlock the ballots together.</li>
  </ol>
</section>

<nav class="links" aria-label="More">
  <a href="#/verify"><strong>{t.checkReceipt}</strong><span>Use your tracking code</span></a>
  <a href="#/results"><strong>{t.results}</strong><span>Turnout, counts and official status</span></a>
  <a href="#/admin"><strong>{t.officials}</strong><span>Staff sign-in</span></a>
</nav>
