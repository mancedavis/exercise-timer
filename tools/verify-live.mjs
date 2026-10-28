// Checks a deployed copy of the web app:  node tools/verify-live.mjs https://<user>.github.io/exercise-timer/
// Every file in docs/ must be served over HTTPS with the same bytes; the app must register its worker with the
// right scope, report "Offline ready", and relaunch with the network switched off.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { generate } from './build-assets.mjs';
import { DOCS } from '../web_tests/browser/helpers.mjs';

const base = (process.argv[2] || '').replace(/\/?$/, '/');
if (!/^https:\/\//.test(base)) { console.error('usage: node tools/verify-live.mjs https://.../exercise-timer/'); process.exit(2); }
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures.push(what); };

const { assets } = generate();
for (const a of assets) {
  const url = new URL(a, base).href;
  const res = await fetch(url, { cache: 'no-store' });
  const rel = a === './' ? 'index.html' : a.slice(2);
  const same = res.ok && Buffer.compare(Buffer.from(await res.arrayBuffer()), readFileSync(join(DOCS, rel))) === 0;
  check(same, `${res.status} ${url} matches docs/${rel}`);
}
const sw = await fetch(new URL('sw.js', base));
check(sw.ok && /javascript/.test(sw.headers.get('content-type') || ''), `sw.js served as JavaScript (${sw.headers.get('content-type')})`);
const manifest = await (await fetch(new URL('manifest.webmanifest', base))).json();
check(manifest.start_url === './' && manifest.scope === './' && manifest.display === 'standalone', 'manifest start_url, scope and display');
const txt = await (await fetch(new URL('IOS_Install_Instructions.txt', base))).text();
check(txt.includes(base), 'IOS_Install_Instructions.txt contains the live address');

for (const [name, engine] of [['webkit', webkit], ['chromium', chromium]]) {
  const browser = await engine.launch();
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base);
  await page.waitForFunction(() => document.getElementById('statusChip').textContent === 'Offline ready', null, { timeout: 45_000 })
    .then(() => check(true, `${name}: "Offline ready" shown`), () => check(false, `${name}: "Offline ready" shown`));
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope);
  check(scope === base, `${name}: service worker scope ${scope}`);
  await ctx.setOffline(true);
  await page.reload();
  check((await page.locator('#phase').innerText()) === 'READY', `${name}: relaunches offline`);
  await page.goto(`${base}help.html`);
  await page.waitForFunction(() => document.getElementById('text').textContent.startsWith('EXERCISE TIMER'), null, { timeout: 10_000 })
    .then(() => check(true, `${name}: help page shows the instructions offline`), () => check(false, `${name}: help page offline`));
  check(errors.length === 0, `${name}: no page errors ${errors.join('; ')}`);
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll live checks passed');
process.exit(failures.length ? 1 : 0);
