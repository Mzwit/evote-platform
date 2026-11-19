<script lang="ts">
  import { t, languages, setLang, lang } from './lib/i18n';
  import { onNetworkState } from './lib/api';
  import Home from './pages/Home.svelte';
  import Vote from './pages/Vote.svelte';
  import Results from './pages/Results.svelte';
  import Verify from './pages/Verify.svelte';
  import Admin from './pages/Admin.svelte';

  let route = $state(location.hash.slice(1) || '/');
  let langKey = $state(0);
  let net = $state({ waiting: false, offline: false });
  window.addEventListener('hashchange', () => { route = location.hash.slice(1) || '/'; window.scrollTo(0, 0); });
  onNetworkState((s) => (net = s));
  const path = $derived(route.split('?')[0]);
  const cur = (p: string) => (path === p || (p !== '/' && path.startsWith(p)) ? 'page' : undefined);
  function changeLang(e: Event) { setLang((e.target as HTMLSelectElement).value as any); langKey++; }
</script>

<div class="demo-strip" role="note">{t.prototype}</div>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="#/" aria-label="{t.appName} home">
      <svg viewBox="0 0 34 34" aria-hidden="true">
        <rect x="3" y="15" width="28" height="16" rx="4" fill="var(--ink)" />
        <rect x="9" y="17.5" width="16" height="2.5" rx="1.25" fill="var(--paper)" />
        <rect x="10" y="3" width="14" height="17" rx="2" fill="var(--slip)" stroke="var(--ink)" stroke-width="2" />
        <path d="M13.5 11.5l2.6 2.6 4.6-5.2" fill="none" stroke="var(--seal)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      {t.appName}
    </a>
    <nav class="nav" aria-label="Main">
      <a href="#/vote" aria-current={cur('/vote')}>{t.vote}</a>
      <a href="#/results" aria-current={cur('/results')}>{t.results}</a>
      <a class="hide-sm" href="#/verify" aria-current={cur('/verify')}>{t.checkReceipt}</a>
      <label class="sr-only" for="lang">{t.language}</label>
      <select id="lang" onchange={changeLang} value={lang()}>
        {#each Object.entries(languages) as [k, v]}<option value={k}>{v}</option>{/each}
      </select>
    </nav>
  </div>
</header>

<main id="main">
  {#key langKey}
    {#if path === '/vote'}<Vote />
    {:else if path === '/results'}<Results />
    {:else if path === '/verify'}<Verify />
    {:else if path.startsWith('/admin')}<Admin />
    {:else}<Home />{/if}
  {/key}
</main>

{#if net.waiting}<div class="net" role="status" aria-live="polite">{t.waiting}</div>
{:else if net.offline}<div class="net" role="status" aria-live="polite">{t.offline}</div>{/if}
