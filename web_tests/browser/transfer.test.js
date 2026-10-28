// Browser tests: preset persistence, storage failures, import/export through the real UI.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { parseImport, exportText } from '../../docs/js/transfer.js';
import { fixturePath, launch, newContext, openSheet, startServer, text } from './helpers.mjs';

const KEY = 'exercise-timer:v1';
let server;
before(async () => { server = await startServer(); });
after(async () => { await server.close(); });

const bytes = (n) => new Uint8Array(readFileSync(fixturePath(n)));
const stored = (page) => page.evaluate((k) => localStorage.getItem(k), KEY);
const names = (page) => page.locator('#presetSelect option').allInnerTexts();
const modalButtons = (page) => page.locator('#modalButtons button').allInnerTexts();

async function newPage(browser, { init = [], context = null } = {}) {
  const ctx = context || await newContext(browser, { serviceWorkers: 'block' });
  for (const s of init) await ctx.addInitScript(s);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  await page.goto(server.url);
  return { ctx, page };
}

/** Pick a file in the sheet and return after the first dialog (or none) is up. */
async function importFile(page, file) {
  await openSheet(page);
  await page.setInputFiles('#importFile', typeof file === 'string' ? fixturePath(file) : file);
}
const answer = async (page, label) => { await page.locator('#modalButtons button', { hasText: label }).click(); };
const waitModal = (page) => page.waitForSelector('#modal:not([hidden])');
const modalTitle = (page) => text(page, 'modalTitle');

for (const engine of ['webkit', 'chromium']) {
  describe(`presets, import and export (${engine})`, () => {
    let browser;
    before(async () => { browser = await launch(engine); });
    after(async () => { await browser.close(); });

    test('create, select, update, rename, delete with confirmations; persists after closing and reopening', async () => {
      const { ctx, page } = await newPage(browser);
      assert.deepEqual(await names(page), ['Demo (example)']);
      await openSheet(page);
      await page.fill('#f_name', 'Plank'); await page.fill('#f_reps', '4'); await page.fill('#f_hold', '30');
      await page.click('#saveAsBtn'); await waitModal(page);
      await page.fill('#modalInput', 'Core'); await answer(page, 'OK');
      assert.deepEqual(await names(page), ['Demo (example)', 'Core']);
      assert.equal(await page.locator('#presetSelect').inputValue(), 'Core');
      await page.fill('#f_reps', '5');
      assert.match(await text(page, 'dirty'), /unsaved/);
      await page.click('#saveBtn');
      assert.equal(await text(page, 'dirty'), '');
      // saving as an existing name asks first
      await page.click('#saveAsBtn'); await waitModal(page);
      await page.fill('#modalInput', 'demo (EXAMPLE)'); await answer(page, 'OK'); await waitModal(page);
      assert.equal(await modalTitle(page), 'Replace preset?');
      await answer(page, 'Cancel');
      assert.deepEqual(await names(page), ['Demo (example)', 'Core']);
      // rename
      await page.click('#renameBtn'); await waitModal(page);
      await page.fill('#modalInput', 'Core work'); await answer(page, 'OK');
      assert.deepEqual(await names(page), ['Demo (example)', 'Core work']);
      // reload: same data, same selection
      await page.reload();
      assert.deepEqual(await names(page), ['Demo (example)', 'Core work']);
      await openSheet(page);
      assert.equal(await page.locator('#f_reps').inputValue(), '5');
      assert.equal(await page.locator('#f_hold').inputValue(), '30');
      // delete asks first
      await page.click('#deleteBtn'); await waitModal(page);
      await answer(page, 'Cancel');
      assert.equal((await names(page)).length, 2);
      await page.click('#deleteBtn'); await waitModal(page);
      await answer(page, 'Delete');
      assert.deepEqual(await names(page), ['Demo (example)']);
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    test('sound preference and last-selected preset persist', async () => {
      const { ctx, page } = await newPage(browser);
      await importFile(page, 'export_all.json');
      await waitModal(page); await answer(page, 'Skip');                        // Demo collides
      await page.waitForFunction(() => document.getElementById('modalTitle').textContent === 'Import complete');
      await answer(page, 'OK');
      await page.selectOption('#presetSelect', 'Open ended');
      await page.click('#soundToggle');
      await page.reload();
      await openSheet(page);
      assert.equal(await page.locator('#presetSelect').inputValue(), 'Open ended');
      assert.equal(await page.locator('#soundToggle').isChecked(), false);
      await ctx.close();
    });

    test('import the Windows presets.json: added/skipped summary, Replace/Skip/Cancel, one commit', async () => {
      const { ctx, page } = await newPage(browser);
      await importFile(page, 'legacy_windows_presets.json');
      await waitModal(page);
      assert.equal(await modalTitle(page), 'Preset already exists');          // the Demo preset collides
      assert.deepEqual(await modalButtons(page), ['Replace', 'Skip', 'Cancel import']);
      await answer(page, 'Skip');
      await page.waitForFunction(() => document.getElementById('modalTitle').textContent === 'Import complete');
      assert.equal(await text(page, 'modalText'), '3 added, 0 replaced, 1 skipped.');
      await answer(page, 'OK');
      assert.deepEqual(await names(page), ['Demo (example)', 'Alpha hold', 'Open ended', 'Manual stopwatch']);
      const afterFirst = await stored(page);
      // overlap file: two conflicts; Cancel on the second changes nothing at all
      await page.setInputFiles('#importFile', fixturePath('import_overlap.json'));
      await waitModal(page);
      assert.match(await text(page, 'modalText'), /"Alpha hold"/);              // matched ignoring case
      await answer(page, 'Replace');
      await page.waitForFunction(() => document.getElementById('modalText').textContent.includes('Open ended'));
      await answer(page, 'Cancel import');
      await page.waitForFunction(() => document.getElementById('modalTitle').textContent === 'Import cancelled');
      await answer(page, 'OK');
      assert.equal(await stored(page), afterFirst);
      // same file, "apply to all" -> Replace
      await page.setInputFiles('#importFile', fixturePath('import_overlap.json'));
      await waitModal(page);
      await page.check('#modalCheck');
      await answer(page, 'Replace');
      await page.waitForFunction(() => document.getElementById('modalTitle').textContent === 'Import complete');
      assert.equal(await text(page, 'modalText'), '2 added, 2 replaced, 0 skipped.');
      await answer(page, 'OK');
      assert.deepEqual(await names(page), ['Demo (example)', 'Alpha hold', 'Open ended', 'Manual stopwatch', 'New One', 'Brand New 2']);
      const data = JSON.parse(await stored(page));
      assert.equal(data.presets['Alpha hold'].name, 'Alpha REPLACED');
      assert.equal(data.sound, true);                                           // preferences untouched
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    test('invalid, unsupported-version and oversized files change nothing and say why', async () => {
      const { ctx, page } = await newPage(browser);
      await openSheet(page);
      const before = await stored(page);
      const cases = [
        [{ name: 'a.json', mimeType: 'application/json', buffer: Buffer.from('{nope') }, /not a valid JSON/],
        [{ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from('{"version":2,"presets":{"A":{}}}') }, /format version 2/],
        [{ name: 'c.json', mimeType: 'application/json', buffer: Buffer.alloc(300_000, 32) }, /too large/],
        [{ name: 'd.json', mimeType: 'application/json', buffer: Buffer.from('{"version":1,"presets":{"A":5}}') }, /not a set of settings/],
      ];
      for (const [file, pattern] of cases) {
        await page.setInputFiles('#importFile', file);
        await waitModal(page);
        assert.equal(await modalTitle(page), 'Could not import');
        assert.match(await text(page, 'modalText'), pattern);
        assert.match(await text(page, 'modalText'), /Nothing was changed/);
        await answer(page, 'OK');
        assert.equal(await stored(page), before);
      }
      await ctx.close();
    });

    test('an imported name with markup is shown as text and never runs', async () => {
      const { ctx, page } = await newPage(browser);
      const evil = '<img src=x onerror=window.__pwned=1>';
      const doc = JSON.parse(readFileSync(fixturePath('export_single.json'), 'utf8'));
      doc.presets = { [evil]: { ...doc.presets['Open ended'], name: evil } };
      await importFile(page, { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
      await waitModal(page); await answer(page, 'OK');
      assert.ok((await names(page)).includes(evil));
      await page.selectOption('#presetSelect', evil);
      await page.click('#closeSheet');
      assert.equal(await text(page, 'exName'), evil);
      assert.equal(await page.evaluate(() => window.__pwned), undefined);
      assert.equal(await page.locator('#exName img, #presetSelect img').count(), 0);
      await ctx.close();
    });

    test('export all and selected via the download fallback; Windows -> web -> Windows keeps every byte', async () => {
      const { ctx, page } = await newPage(browser);
      await importFile(page, 'export_all.json');
      await waitModal(page);                                                    // Demo collides
      await answer(page, 'Replace');
      await page.waitForFunction(() => document.getElementById('modalTitle').textContent === 'Import complete');
      await answer(page, 'OK');
      await page.selectOption('#presetSelect', 'Open ended');
      const dl = page.waitForEvent('download');
      await page.click('#exportBtn'); await waitModal(page);
      await answer(page, 'All presets');
      const all = await dl;
      assert.match(all.suggestedFilename(), /^exercise-timer-presets-\d{8}\.json$/);
      const allText = readFileSync(await all.path(), 'utf8');
      assert.equal(allText, readFileSync(fixturePath('export_all.json'), 'utf8'));      // identical to the Windows export
      assert.equal(parseImport(new TextEncoder().encode(allText)).size, 4);
      const dl2 = page.waitForEvent('download');
      await page.click('#exportBtn'); await waitModal(page);
      await answer(page, 'Only this one');
      const one = await dl2;
      assert.equal(one.suggestedFilename(), 'exercise-timer-Open-ended.json');
      assert.equal(readFileSync(await one.path(), 'utf8'), readFileSync(fixturePath('export_single.json'), 'utf8'));
      await ctx.close();
    });

    test('export uses the share sheet when available; closing it is a cancel, not an error', async () => {
      const share = (mode) => `(() => {
        window.__shared = null;
        navigator.canShare = (d) => !!(d && d.files && d.files.length);
        navigator.share = async (d) => { if (${JSON.stringify(mode)} === 'abort') throw new DOMException('closed', 'AbortError');
          if (${JSON.stringify(mode)} === 'fail') throw new Error('share broke');
          window.__shared = { name: d.files[0].name, type: d.files[0].type }; };
      })();`;
      let { ctx, page } = await newPage(browser, { init: [share('ok')] });
      await openSheet(page);
      await page.click('#exportBtn');                                           // one preset: no question
      await page.waitForFunction(() => window.__shared);
      const shared = await page.evaluate(() => window.__shared);
      assert.match(shared.name, /^exercise-timer-presets-\d{8}\.json$/);
      assert.equal(shared.type, 'application/json');
      assert.match(await page.locator('#notices').innerText(), /Export shared/);
      await ctx.close();
      ({ ctx, page } = await newPage(browser, { init: [share('abort')] }));
      await openSheet(page);
      await page.click('#exportBtn');
      await page.waitForFunction(() => document.getElementById('notices').textContent.includes('cancelled'));
      assert.equal(await page.locator('#modal:not([hidden])').count(), 0);        // no error dialog
      assert.deepEqual(page.errors, []);
      await ctx.close();
      ({ ctx, page } = await newPage(browser, { init: [share('fail')] }));
      await openSheet(page);
      const dl = page.waitForEvent('download');
      await page.click('#exportBtn');
      await dl;                                                                 // a failing share falls back to a download
      await ctx.close();
    });

    test('storage unavailable: visible notice, presets work in memory, failed saves are reported', async () => {
      const block = 'Object.defineProperty(window, "localStorage", { get() { throw new DOMException("blocked", "SecurityError"); }, configurable: true });';
      const { ctx, page } = await newPage(browser, { init: [block] });
      assert.match(await page.locator('#notices').innerText(), /not allowing saved data/);
      await openSheet(page);
      await page.click('#saveAsBtn'); await waitModal(page);
      await page.fill('#modalInput', 'Temp'); await answer(page, 'OK'); await waitModal(page);
      assert.equal(await modalTitle(page), 'Could not save');
      assert.match(await text(page, 'modalText'), /not allowing saved data/);
      await answer(page, 'OK');
      assert.ok((await names(page)).includes('Temp'));                             // still usable this session
      await ctx.close();
    });

    test('a failed write is reported and an import that cannot be saved changes nothing', async () => {
      const { ctx, page } = await newPage(browser);
      await openSheet(page);
      const before = await stored(page);
      await page.evaluate(() => { const orig = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'exercise-timer:v1') { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } return orig.call(this, k, v); }; });
      await page.setInputFiles('#importFile', fixturePath('export_all.json'));
      await waitModal(page); await answer(page, 'Replace');
      await page.waitForFunction(() => document.getElementById('modalTitle').textContent === 'Could not import');
      assert.match(await text(page, 'modalText'), /presets were not changed/);
      await answer(page, 'OK');
      assert.deepEqual(await names(page), ['Demo (example)']);
      assert.equal(await stored(page), before);
      await ctx.close();
    });

    test('corrupt saved data is kept aside with a notice, not silently replaced', async () => {
      const ctx0 = await newContext(browser, { serviceWorkers: 'block' });
      const page0 = await ctx0.newPage();
      await page0.goto(server.url);
      await page0.evaluate((k) => localStorage.setItem(k, '{ broken'), KEY);
      await page0.reload();
      assert.match(await page0.locator('#notices').innerText(), /could not be read/);
      const keys = await page0.evaluate(() => Object.keys(localStorage));
      assert.equal(keys.filter((k) => k.includes(':bad-')).length, 1);
      assert.equal(await page0.evaluate((k) => localStorage.getItem(k), KEY), '{ broken');
      await ctx0.close();
    });
  });
}

describe('round trip with the Windows format', () => {
  test('every field and flag survive Windows -> web -> Windows (parsed and byte-exact)', () => {
    const legacy = parseImport(bytes('legacy_windows_presets.json'));
    assert.equal(exportText(legacy), readFileSync(fixturePath('export_all.json'), 'utf8'));
  });
});
