<script lang="ts">
  import { t } from '../lib/i18n';
  import { api } from '../lib/api';

  let elections: any[] = $state([]);
  let sel = $state('');
  let data: any = $state(null);
  let error = $state('');

  api('/api/public/elections').then((r) => { elections = r; if (r[0]) load(r[0].id); }).catch((e) => (error = e.message));

  async function load(id: string) {
    sel = id; data = null; error = '';
    try {
      const [info, turnout, rec, results] = await Promise.all([
        api(`/api/public/elections/${id}`), api(`/api/public/elections/${id}/turnout`),
        api(`/api/public/elections/${id}/reconciliation`), api(`/api/public/elections/${id}/results`)]);
      data = { info, turnout, rec, results };
    } catch (e) { error = (e as Error).message; }
  }

  const groups = $derived.by(() => {
    if (!data?.results?.available) return [];
    const m = new Map<string, { name: string; region: string; contests: Map<string, any[]> }>();
    for (const r of data.results.results) {
      if (!m.has(r.constituency_id)) m.set(r.constituency_id, { name: r.constituency, region: r.region, contests: new Map() });
      const g = m.get(r.constituency_id)!;
      if (!g.contests.has(r.contest)) g.contests.set(r.contest, []);
      g.contests.get(r.contest)!.push(r);
    }
    return [...m.values()];
  });
  const label = (s: string) => (s === 'DECLARED' ? t.declared : s === 'VERIFIED' ? t.verified : t.preliminary);
</script>

<h1>{t.results}</h1>
{#if error}<p class="notice bad" role="alert">{error}</p>{/if}
{#if elections.length > 1}
  <label for="el">{t.election}</label>
  <select id="el" value={sel} onchange={(e) => load((e.target as HTMLSelectElement).value)}>
    {#each elections as e}<option value={e.id}>{e.name}</option>{/each}
  </select>
{/if}

{#if data}
  <h2>{data.info.name}</h2>
  <p class="muted">Status: {data.info.status}</p>
  <div class="card">
    <strong>{t.turnout}: {data.turnout.turnoutPct}%</strong>
    <div class="muted">{t.participated}: {data.turnout.participated.toLocaleString()} · {t.registered}: {data.turnout.eligible.toLocaleString()}</div>
  </div>
  <details class="card">
    <summary>Reconciliation checks</summary>
    <table>
      <tbody>
        <tr><td>Anonymous tokens issued</td><td class="num">{data.rec.tokensIssued}</td></tr>
        <tr><td>Ballots accepted</td><td class="num">{data.rec.ballotsAccepted}</td></tr>
        <tr><td>Entries on public bulletin board</td><td class="num">{data.rec.boardEntries}</td></tr>
        <tr><td>Ballots counted</td><td class="num">{data.rec.ballotsDecrypted}</td></tr>
      </tbody>
    </table>
    {#each Object.entries(data.rec.checks) as [k, ok]}<div class={ok ? 'ok' : 'error'}>{ok ? '✓' : '✗'} {k.replace(/([A-Z])/g, ' $1').toLowerCase()}</div>{/each}
  </details>

  {#if !data.results.available}
    <p class="notice">{t.notYet}</p>
  {:else}
    <p class="notice {data.results.status === 'DECLARED' ? 'good' : 'warn'}" role="status"><strong>{label(data.results.status)}</strong></p>
    <p class="muted">Ballots counted: {data.results.summary.ballots_total} · valid {data.results.summary.valid} · rejected {data.results.summary.invalid}</p>
    <h2>By constituency</h2>
    {#each groups as g}
      <div class="card">
        <strong>{g.name}</strong> <span class="muted">({g.region})</span>
        {#each [...g.contests.entries()] as [contest, rows]}
          <table style="margin-top:.5rem">
            <caption class="muted" style="text-align:left">{contest}</caption>
            <thead><tr><th>Candidate</th><th class="num">Votes</th></tr></thead>
            <tbody>{#each rows as r}<tr><td>{r.candidate}</td><td class="num">{r.votes}</td></tr>{/each}</tbody>
          </table>
        {/each}
      </div>
    {/each}
    <details class="card"><summary>Audit fingerprints</summary>
      <div class="muted">Bulletin board head: <code>{data.results.summary.board_head}</code></div>
      <div class="muted">Published decrypted ballots hash: <code>{data.results.summary.decrypted_hash}</code></div>
    </details>
  {/if}
{/if}
