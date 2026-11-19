<script lang="ts">
  import { t } from '../lib/i18n';
  import { api } from '../lib/api';
  let demo: any = $state(null);
  api('/api/public/demo', { maxAttempts: 3 }).then((d) => (demo = d.enabled ? d : null)).catch(() => {});
</script>

<h1>{t.appName}</h1>
<p>Vote securely from your phone or computer, check that your ballot was recorded, and follow official results.</p>
<div style="display:grid; gap:.75rem; margin-top:1.5rem">
  <a class="btn" href="#/vote">{t.vote}</a>
  <a class="btn secondary" href="#/verify">{t.checkReceipt}</a>
  <a class="btn secondary" href="#/results">{t.results}</a>
  <a class="btn secondary" href="#/admin">{t.officials}</a>
</div>
{#if demo}
  <div class="card" style="margin-top:1.5rem">
    <h2 style="margin-top:0">Try the demo</h2>
    <p>This is a <strong>public demonstration with fictional voters and candidates</strong>. It is not a real election. Sign in as any of these demo voters (each can vote once):</p>
    <p class="mono">{demo.nationalIds.join(' · ')}</p>
    <p>Password: <span class="mono">{demo.password}</span>. The SMS code is filled in for you.</p>
  </div>
{/if}
<h2>How your vote stays secret</h2>
<ol>
  <li>Your ballot is locked (encrypted) on your own device before it is sent.</li>
  <li>The system checks you may vote, then gives you a one-time anonymous pass. It cannot see the pass.</li>
  <li>Your locked ballot is sent with that pass only, separate from your name.</li>
  <li>It is unlocked only after polls close, by several independent trustees together.</li>
</ol>
