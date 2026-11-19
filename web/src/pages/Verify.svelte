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

<h1>{t.receiptTitle}</h1>
<form onsubmit={(e) => { e.preventDefault(); check(); }}>
  <label for="el">{t.election}</label>
  <select id="el" bind:value={election}>{#each elections as e}<option value={e.id}>{e.name}</option>{/each}</select>
  <label for="tr">{t.tracker}</label>
  <input id="tr" autocapitalize="characters" autocomplete="off" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" required bind:value={tracker} />
  <div class="row"><button>{t.check}</button></div>
</form>
{#if error}<p class="notice bad" role="alert">{error}</p>{/if}
{#if result}
  <div class="notice {result.onBoard ? 'good' : result.found ? 'warn' : 'bad'}" role="status">
    {result.onBoard ? t.onBoard : result.found ? t.pending : t.notFound}
    {#if result.onBoard}<div class="muted">Position {result.position} · entry <code>{result.entry_hash.slice(0, 16)}…</code></div>{/if}
  </div>
  <p class="muted">This shows your ballot was recorded. It cannot show how you voted. If you are told otherwise, that is not true.</p>
{/if}
