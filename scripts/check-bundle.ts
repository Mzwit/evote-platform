// CI gate: the JavaScript sent to voters must stay under 150 KB compressed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const dir = new URL('../web/dist/assets/', import.meta.url);
let js = 0, css = 0;
for (const f of readdirSync(dir)) {
  const gz = gzipSync(readFileSync(new URL(f, dir))).length;
  if (f.endsWith('.js')) js += gz; else if (f.endsWith('.css')) css += gz;
  console.log(`${f.padEnd(40)} ${(statSync(new URL(f, dir)).size / 1024).toFixed(1).padStart(7)} KB raw ${(gz / 1024).toFixed(1).padStart(7)} KB gzip`);
}
console.log(`total JS ${(js / 1024).toFixed(1)} KB gzip, CSS ${(css / 1024).toFixed(1)} KB gzip`);
if (js > 150 * 1024) { console.error('FAIL: JavaScript budget (150 KB gzip) exceeded'); process.exit(1); }
