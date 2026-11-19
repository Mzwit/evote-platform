// Browser end-to-end test (Playwright) of the real PWA on an emulated low-end phone,
// a tablet and a desktop, plus an automated WCAG check (axe-core) on every screen.
//   BASE=http://localhost:8080 CHROME=/usr/bin/google-chrome node tests/browser-e2e.ts
import { chromium, devices } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:8080';
const demo = JSON.parse(readFileSync('seed-output/demo.json', 'utf8'));
const axe = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
mkdirSync('docs/screenshots', { recursive: true });

const profiles = [
  { name: 'low-end-android', ...devices['Moto G4'], slow: true, voter: 100 },
  { name: 'ipad', ...devices['iPad (gen 7)'], voter: 101 },
  { name: 'desktop', viewport: { width: 1280, height: 800 }, voter: 102 },
];

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const report: any[] = [];
let failures = 0;

async function a11y(page: any, label: string) {
  await page.addScriptTag({ content: axe });
  const r = await page.evaluate(async () => (window as any).axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] }));
  const v = r.violations.map((x: any) => `${x.id} (${x.impact}, ${x.nodes.length})`);
  report.push({ screen: label, violations: v });
  if (v.length) console.log(`  a11y ${label}: ${v.join('; ')}`);
}

for (const p of profiles) {
  const { name, slow, voter, ...ctxOpts } = p as any;
  const ctx = await browser.newContext({ ...ctxOpts, bypassCSP: true }); // only so axe-core can be injected; the real CSP blocks inline scripts
  const page = await ctx.newPage();
  if (slow) { // emulate a slow 3G connection and a 4x slower CPU
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 300, downloadThroughput: (750 * 1024) / 8, uploadThroughput: (250 * 1024) / 8 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }
  const t0 = Date.now();
  try {
    await page.goto(BASE + '/');
    await page.getByRole('link', { name: 'Vote' }).first().waitFor();
    const firstScreen = Date.now() - t0;
    await a11y(page, `${name}: home`);
    await page.screenshot({ path: `docs/screenshots/${name}-1-home.png` });
    await page.getByRole('link', { name: 'Vote', exact: true }).click();
    const nid = String(BigInt(demo.voters.firstNationalId) + BigInt(voter + Math.floor(Math.random() * 600) * 3));
    await page.getByLabel('National ID number').fill(nid);
    await page.getByLabel('Password').fill(demo.voters.password);
    await a11y(page, `${name}: sign in`);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('One-time code').waitFor();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Start voting' }).first().click();
    for (let i = 0; i < 3; i++) {
      await page.locator('.choice').first().waitFor();
      if (i === 0) { await a11y(page, `${name}: ballot`); await page.screenshot({ path: `docs/screenshots/${name}-2-ballot.png` }); }
      await page.locator('.choice').nth(i % 3).click();
      await page.getByRole('button', { name: 'Continue' }).click();
    }
    await page.getByRole('heading', { name: 'Check your choices' }).waitFor();
    await a11y(page, `${name}: review`);
    await page.screenshot({ path: `docs/screenshots/${name}-3-review.png` });
    const c0 = Date.now();
    await page.getByRole('button', { name: 'Cast my vote' }).click();
    await page.getByRole('heading', { name: 'Your vote has been recorded' }).waitFor({ timeout: 60000 });
    const castMs = Date.now() - c0;
    const tracker = (await page.locator('.tracker').textContent())!.trim();
    await a11y(page, `${name}: receipt`);
    await page.screenshot({ path: `docs/screenshots/${name}-4-receipt.png` });
    await page.getByRole('link', { name: 'Check my receipt' }).click();
    await page.waitForTimeout(2500); // the sealer appends to the board every second
    await page.getByRole('button', { name: 'Check' }).click();
    await page.getByText('Found on the public bulletin board.').waitFor({ timeout: 15000 });
    console.log(`PASS ${name}: first screen ${firstScreen} ms, cast incl. on-device crypto ${castMs} ms, tracker ${tracker}`);
    report.push({ profile: name, firstScreenMs: firstScreen, castMs, tracker });
  } catch (e) {
    failures++; console.log(`FAIL ${name}: ${(e as Error).message.split('\n')[0]}`);
    await page.screenshot({ path: `docs/screenshots/${name}-FAIL.png` });
  }
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(report, null, 1));
process.exit(failures ? 1 : 0);
