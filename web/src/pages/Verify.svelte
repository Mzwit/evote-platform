<script lang="ts">
  import { t } from '../lib/i18n';
  import { api } from '../lib/api';

  const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
  let elections: any[] = $state([]);
  let election = $state(q.get('e') ?? '');
  let tracker = $state(q.get('t') ?? '');
  let result: any = $state(null);
  let error = $state('');

  api('/api/public/elections').then((r) => { elections = r; if (!election && r[0]) election = r[0].id; if (election && tracker) check(); });

  async function check() {
    error = ''; result = null;
    try { result = await api(`/api/public/elections/${election}/board/${encodeURIComponent(tracker.trim())}`); } catch (e) { error = (e as Error).message; }
  }
</script>

<div class="narrow">
  <h1>{t.receiptTitle}</h1>
  <p class="muted">Every accepted ballot appears on a public list. Enter your tracking code to find yours.</p>
  <form class="slip" style="margin-top:1.2rem" onsubmit={(e) => { e.preventDefault(); check(); }}>
    {#if elections.length > 1}
      <label class="field" for="el" style="margin-top:0">{t.election}</label>
      <select id="el" bind:value={election}>{#each elections as e}<option value={e.id}>{e.name}</option>{/each}</select>
    {/if}
    <label class="field" for="tr" style={elections.length > 1 ? '' : 'margin-top:0'}>{t.tracker}</label>
    <input id="tr" class="big mono" autocapitalize="characters" autocomplete="off" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" required bind:value={tracker} />
    <div class="actions"><button class="btn block">{t.check}</button></div>
  </form>
  {#if error}<div class="msg bad" role="alert">{error}</div>{/if}
  {#if result}
    <div class="msg {result.onBoard ? 'good' : result.found ? 'warn' : 'bad'}" role="status">
      <strong>{result.onBoard ? t.onBoard : result.found ? t.pending : t.notFound}</strong>
      {#if result.onBoard}<div class="muted" style="margin-top:.3rem">Entry {result.position.toLocaleString()} on the board · fingerprint <span class="mono">{result.entry_hash.slice(0, 12)}</span></div>{/if}
    </div>
    <p class="muted">This shows that your ballot was recorded. It cannot show how you voted, so nobody can use it to check your choice.</p>
  {/if}
</div>
