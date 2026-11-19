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
  const statusOf = (s: string) => s === 'DECLARED' ? ['declared', 'Officially declared'] : s === 'VERIFIED' ? ['verified', 'Verified by the auditor, not yet declared'] : s === 'TALLIED' ? ['prelim', 'Preliminary, not yet verified'] : s === 'OPEN' ? ['open', 'Voting open'] : ['other', s.charAt(0) + s.slice(1).toLowerCase()];
  const n = (x: number) => Number(x).toLocaleString();
  const checkNames: Record<string, string> = { noBallotWithoutToken: 'Every ballot carries a valid voting pass', boardMatchesAccepted: 'Public list matches accepted ballots', tallyMatchesAccepted: 'Count matches accepted ballots' };
</script>

<div class="section" style="margin-top:0">
  <h1>{t.results}</h1>
  {#if elections.length > 1}
    <label class="field" for="el">{t.election}</label>
    <select id="el" style="max-width:32rem" value={sel} onchange={(e) => load((e.target as HTMLSelectElement).value)}>
      {#each elections as e}<option value={e.id}>{e.name}</option>{/each}
    </select>
  {/if}
</div>
{#if error}<div class="msg bad" role="alert">{error}</div>{/if}

{#if data}
  {@const st = statusOf(data.results.available ? data.results.status : data.info.status)}
  <div style="margin-top:1.4rem; display:flex; flex-wrap:wrap; gap:.8rem; align-items:center; justify-content:space-between">
    <h2>{data.info.name}</h2>
    <span class="status {st[0]}" role="status">{st[1]}</span>
  </div>

  <div class="stats">
    <div class="stat"><div class="n">{data.turnout.turnoutPct}%</div><div class="l">{t.turnout}</div></div>
    <div class="stat"><div class="n">{n(data.turnout.participated)}</div><div class="l">{t.participated}</div></div>
    <div class="stat"><div class="n">{n(data.turnout.eligible)}</div><div class="l">{t.registered}</div></div>
    <div class="stat"><div class="n">{n(data.rec.ballotsAccepted)}</div><div class="l">Ballots recorded</div></div>
  </div>

  <div class="panel">
    <h3>Turnout by inkhundla</h3>
    <div class="bars">
      {#each data.turnout.constituencies as k}
        {@const pct = k.eligible ? (100 * k.participated) / k.eligible : 0}
        <div class="bar-row"><span class="who">{k.name} <span class="muted">· {k.region}</span></span><div class="bar"><div style="width:{pct}%"></div></div><span class="num">{pct.toFixed(1)}%</span></div>
      {/each}
    </div>
  </div>

  {#if !data.results.available}
    <div class="msg info">{t.notYet}</div>
  {:else}
    <p class="muted">Ballots counted {n(data.results.summary.ballots_total)} · valid {n(data.results.summary.valid)} · rejected {n(data.results.summary.invalid)}</p>
    <div class="grid-2">
      {#each groups as g}
        <section class="panel">
          <h2>{g.name}</h2>
          <p class="muted">{g.region}</p>
          {#each [...g.contests.entries()] as [contest, rows]}
            {@const max = Math.max(1, ...rows.map((r: any) => r.votes))}
            {@const total = rows.reduce((s: number, r: any) => s + r.votes, 0)}
            <h3 style="margin-top:1.1rem">{contest}</h3>
            <div class="bars">
              {#each rows as r, i}
                <div class="bar-row" class:lead={i === 0 && r.votes > 0}>
                  <span class="who">{r.candidate}</span>
                  <div class="bar"><div style="width:{(100 * r.votes) / max}%"></div></div>
                  <span class="num" title="{total ? ((100 * r.votes) / total).toFixed(1) : 0}%">{n(r.votes)}</span>
                </div>
              {/each}
            </div>
          {/each}
        </section>
      {/each}
    </div>
  {/if}

  <details class="panel">
    <summary>Integrity checks anyone can repeat</summary>
    <div style="margin-top:.6rem">
      {#each Object.entries(data.rec.checks) as [k, ok]}<div class="check {ok ? 'ok' : 'no'}"><strong>{ok ? '✓' : '✗'}</strong> {checkNames[k] ?? k}</div>{/each}
    </div>
    <table style="margin-top:.8rem">
      <tbody>
        <tr><td>Voting passes issued</td><td class="num">{n(data.rec.tokensIssued)}</td></tr>
        <tr><td>Ballots accepted</td><td class="num">{n(data.rec.ballotsAccepted)}</td></tr>
        <tr><td>Entries on the public list</td><td class="num">{n(data.rec.boardEntries)}</td></tr>
        <tr><td>Ballots counted</td><td class="num">{n(data.rec.ballotsDecrypted)}</td></tr>
      </tbody>
    </table>
    {#if data.results.available}
      <p class="muted" style="margin-top:.8rem">Public list fingerprint <span class="mono">{data.results.summary.board_head.slice(0, 16)}</span><br />Counted ballots fingerprint <span class="mono">{data.results.summary.decrypted_hash.slice(0, 16)}</span></p>
    {/if}
  </details>
{/if}
