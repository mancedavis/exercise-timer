// Browser tests: subdirectory deployment, offline launch, offline import/export, updates.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { generate } from '../../tools/build-assets.mjs';
import { PREFIX, fixturePath, launch, makeVersion2, newContext, openSheet, setSettings, startServer, text } from './helpers.mjs';

let server;
before(async () => { server = await startServer(); });
after(async () => { await server.close(); });

const ready = (page) => page.waitForFunction(() => document.getElementById('statusChip').textContent === 'Offline ready', null, { timeout: 20_000 });
const modalTitle = (page) => text(page, 'modalTitle');
const waitModal = (page) => page.waitForSelector('#modal:not([hidden])');
const answer = (page, label) => page.locator('#modalButtons button', { hasText: label }).click();

for (const engine of ['webkit', 'chromium']) {
  describe(`offline and deployment (${engine})`, () => {
    let browser;
    before(async () => { browser = await launch(engine); });
    after(async () => { await browser.close(); });

    test('served under /exercise-timer/: every request stays inside the subdirectory, the worker has the right scope, all assets are cached', async () => {
      server.state.log.length = 0;
      const ctx = await newContext(browser);
      const page = await ctx.newPage();
      const failed = [];
      page.on('requestfailed', (r) => failed.push(r.url()));
      page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
      await page.goto(server.url);
      await ready(page);
      const info = await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        const names = await caches.keys();
        const cache = await caches.open(names[0]);
        return { scope: reg.scope, names, cached: (await cache.keys()).map((r) => new URL(r.url).pathname) };
      });
      assert.equal(new URL(info.scope).pathname, PREFIX);
      assert.equal(info.names.length, 1);
      const { assets } = generate();
      assert.equal(info.cached.length, assets.length);
      for (const a of assets) assert.ok(info.cached.includes(PREFIX + a.slice(2)), a);
      assert.deepEqual(failed, []);
      assert.equal(await page.locator('.note:has-text("new version")').count(), 0);     // first visit is not an "update"
      assert.ok(server.state.log.every((l) => l.path.startsWith(PREFIX) && l.status === 200), JSON.stringify(server.state.log.filter((l) => l.status !== 200)));
      const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
      assert.equal(manifest.start_url, './');
      for (const icon of manifest.icons) {
        const r = await page.request.get(new URL(icon.src, server.url).href);
        assert.equal(r.status(), 200, icon.src);
      }
      await ctx.close();
    });

    test('offline: the installed app relaunches, runs an exercise, imports and exports files, and opens Help', async () => {
      const ctx = await newContext(browser, { acceptDownloads: true });
      const page = await ctx.newPage();
      await page.goto(server.url);
      await ready(page);
      await ctx.setOffline(true);
      await page.reload();
      await page.waitForFunction(() => document.getElementById('phase').textContent === 'READY');
      assert.equal(await page.title(), 'READY · Exercise Timer');
      // run for real, offline
      await setSettings(page, { get_ready: '0', hold: '30' });
      await page.click('#startBtn');
      await page.waitForFunction(() => document.getElementById('timerNum').textContent === '1', null, { timeout: 5000 });
      await page.click('#stopBtn');
      // import offline
      await openSheet(page);
      await page.setInputFiles('#importFile', fixturePath('export_single.json'));
      await waitModal(page);
      assert.equal(await modalTitle(page), 'Import complete');
      assert.equal(await text(page, 'modalText'), '1 added, 0 replaced, 0 skipped.');
      await answer(page, 'OK');
      // export offline
      const dl = page.waitForEvent('download');
      await page.click('#exportBtn'); await waitModal(page);
      await answer(page, 'All presets');
      const file = await dl;
      assert.match(file.suggestedFilename(), /^exercise-timer-presets-/);
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(await file.path(), 'utf8')).presets), ['Demo (example)', 'Open ended']);
      // help and the instructions file, offline
      await page.goto(`${server.url}help.html`);
      await page.waitForFunction(() => document.getElementById('text').textContent.startsWith('EXERCISE TIMER'));
      const txt = await page.evaluate(async () => (await fetch('IOS_Install_Instructions.txt')).text());
      assert.ok(txt.includes('https://mancedavis.github.io/exercise-timer/'));
      await ctx.close();
    });

    test('a worker that fails to install never claims "Offline ready" and says setup is incomplete', async () => {
      if (engine !== 'chromium') return;
      const broken = makeVersion2();
      const { rmSync } = await import('node:fs');
      rmSync(`${broken}/help.html`);                 // listed in sw.js, now missing: the install must fail
      const v1 = server.state.root;
      server.setRoot(broken);
      const ctx = await newContext(browser);
      const page = await ctx.newPage();
      await page.goto(server.url);
      await page.waitForFunction(() => /incomplete/.test(document.getElementById('statusChip').textContent), null, { timeout: 40_000 });
      assert.notEqual(await text(page, 'statusChip'), 'Offline ready');
      server.setRoot(v1);
      await ctx.close();
    });

    test('update: a new version is offered only at an idle moment, never reloads mid-exercise, and keeps presets', async () => {
      const v2 = makeVersion2();
      const v1 = server.state.root;
      const ctx = await newContext(browser);
      const page = await ctx.newPage();
      await page.goto(server.url);
      await ready(page);
      // a preset and a running exercise exist before the update
      await openSheet(page);
      await page.click('#saveAsBtn'); await waitModal(page);
      await page.fill('#modalInput', 'Keep me'); await answer(page, 'OK');
      await page.click('#closeSheet');
      await setSettings(page, { get_ready: '0', hold: '600', reps: '2' });
      await page.evaluate(() => { window.__marker = 'same page'; });
      await page.click('#startBtn');
      // the site changes
      server.setRoot(v2);
      await page.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration(); await reg.update(); });
      await page.waitForSelector('.note:has-text("new version is ready")', { timeout: 20_000 });
      assert.match(await page.locator('#notices').innerText(), /when this exercise is finished/);
      assert.equal(await page.locator('#notices button').isDisabled(), true);            // not while running
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => window.__marker), 'same page');             // no reload happened
      assert.equal(await page.locator('#startBtn').isDisabled(), true);                  // still exercising
      // finish: now it is offered
      await page.click('#stopBtn');
      assert.equal(await page.locator('#notices button').isEnabled(), true);
      const oldNames = await page.evaluate(() => caches.keys());
      await Promise.all([page.waitForEvent('load'), page.click('#notices button')]);
      await ready(page);
      const names = await page.evaluate(() => caches.keys());
      assert.equal(names.length, 1);                                                      // old cache removed
      assert.notDeepEqual(names, oldNames);
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('exName')).textTransform), 'uppercase');   // new files in use
      await openSheet(page);
      assert.ok((await page.locator('#presetSelect option').allInnerTexts()).includes('Keep me'));
      assert.equal(await page.locator('#notices .note:has-text("new version")').count(), 0);
      server.setRoot(v1);
      await ctx.close();
    });
  });
}
