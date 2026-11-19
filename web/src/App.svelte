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
  function changeLang(e: Event) { setLang((e.target as HTMLSelectElement).value as any); langKey++; }
</script>

<header class="top">
  <a class="brand" href="#/">{t.appName}</a>
  <label class="sr-only" for="lang">{t.language}</label>
  <select id="lang" style="width:auto" onchange={changeLang} value={lang()}>
    {#each Object.entries(languages) as [k, v]}<option value={k}>{v}</option>{/each}
  </select>
</header>
<div class="banner" role="note">{t.prototype}</div>
{#if net.waiting}<div class="notice warn" role="status" aria-live="polite" style="margin:.5rem 1rem">{t.waiting}</div>{/if}
{#if net.offline}<div class="notice bad" role="status" aria-live="polite" style="margin:.5rem 1rem">{t.offline}</div>{/if}

<main id="main">
  {#key langKey}
    {#if path === '/vote'}<Vote />
    {:else if path === '/results'}<Results />
    {:else if path === '/verify'}<Verify />
    {:else if path.startsWith('/admin')}<Admin />
    {:else}<Home />{/if}
  {/key}
</main>
