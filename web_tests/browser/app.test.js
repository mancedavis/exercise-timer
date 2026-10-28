// Browser tests: exercise flow, layouts, interruptions, wake lock and audio.
// Functional tests run in WebKit and Chromium; layout runs on WebKit iPhone/iPad profiles.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { devices, launch, newContext, setSettings, startServer, text } from './helpers.mjs';

const WAKE_MOCK = (mode) => `(() => {
  const w = window.__wl = { requests: 0, released: 0 };
  const api = { request: async () => { w.requests++; if (${JSON.stringify(mode)} === 'deny') throw new DOMException('no', 'NotAllowedError');
    if (${JSON.stringify(mode)} === 'slow') await new Promise((r) => { w.resolve = r; });
    const s = new EventTarget(); s.release = async () => { w.released++; s.dispatchEvent(new Event('release')); }; return s; } };
  Object.defineProperty(navigator, 'wakeLock', { value: ${JSON.stringify(mode)} === 'none' ? undefined : api, configurable: true });
})();`;

const AUDIO_MOCK = (mode) => `(() => {
  const a = window.__audio = { contexts: 0, resumed: 0, osc: [] };
  class FakeAC {
    constructor() { if (${JSON.stringify(mode)} === 'throw') throw new Error('no audio'); a.contexts++; this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    resume() { a.resumed++; this.state = 'running'; return Promise.resolve(); }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    createOscillator() { const o = { frequency: {}, stops: [], connect() {}, disconnect() { o.disc = true; }, start() {}, stop(t) { o.stops.push(t); } }; a.osc.push(o); return o; }
  }
  window.AudioContext = FakeAC; window.webkitAudioContext = FakeAC;
})();`;

let server;
before(async () => { server = await startServer(); });
after(async () => { await server.close(); });

/** Page with a fake clock that only moves when the test says so. */
async function clockedPage(browser, { init = [], device, storageSeed } = {}) {
  const ctx = await newContext(browser, { device, serviceWorkers: 'block' });
  for (const s of init) await ctx.addInitScript(s);
  if (storageSeed) await ctx.addInitScript(([k, v]) => { if (!localStorage.getItem('__seeded')) { localStorage.setItem(k, v); localStorage.setItem('__seeded', '1'); } }, storageSeed);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.clock.install({ time: 0 });
  await page.goto(server.url);
  await page.clock.pauseAt(1000);
  page.errors = errors;
  return { ctx, page };
}

const states = async (page) => ({
  phase: await text(page, 'phase'), rep: await text(page, 'repNum'), timer: await text(page, 'timerNum'),
  banner: await text(page, 'banner'), name: await text(page, 'exName'),
});

for (const engine of ['webkit', 'chromium']) {
  describe(`exercise flow (${engine})`, () => {
    let browser;
    before(async () => { browser = await launch(engine); });
    after(async () => { await browser.close(); });

    test('required example: 6 holds, 4 rep breaks, 1 set rest, done at 51 s, nothing extra', async () => {
      const { ctx, page } = await clockedPage(browser);
      await setSettings(page, { sets_enabled: true, sets: '2', reps_enabled: true, reps: '3', hold_enabled: true, hold: '4', rep_break: '5', rest_enabled: true, rest: '7', get_ready: '0' });
      await page.click('#startBtn');
      await page.clock.runFor(100);
      const segments = [];
      let doneAt = null;
      for (let t = 0; t < 60; t++) {
        const label = await text(page, 'phase');
        if (segments.at(-1) !== label) segments.push(label);
        if (label === 'COMPLETE' && doneAt === null) doneAt = t;
        await page.clock.runFor(1000);
      }
      assert.deepEqual(segments, ['HOLD', 'REP BREAK', 'HOLD', 'REP BREAK', 'HOLD', 'SET REST', 'HOLD', 'REP BREAK', 'HOLD', 'REP BREAK', 'HOLD', 'COMPLETE']);
      assert.equal(doneAt, 51);                       // first sample at 51.1 s shows COMPLETE, 50.1 s does not
      assert.equal(await text(page, 'timerNum'), 'Exercise complete');
      assert.equal(await page.locator('#startBtn').isEnabled(), true);      // result stays until Start/Reset
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    test('hold counts up with its target, break and rest count down and name what is next', async () => {
      const { ctx, page } = await clockedPage(browser);
      await setSettings(page, { sets: '2', reps: '2', hold: '4', rep_break: '3', rest_enabled: true, rest: '5', get_ready: '2' });
      await page.click('#startBtn');
      let s = await states(page);
      assert.deepEqual([s.phase, s.rep, s.timer], ['GET READY', '0', '2']);
      await page.clock.runFor(2100);
      await page.clock.runFor(2000);
      s = await states(page);
      assert.deepEqual([s.phase, s.rep, s.timer], ['HOLD', '1', '2']);
      assert.equal(await text(page, 'timerSuffix'), '/ 4 s');
      await page.clock.runFor(2000);
      s = await states(page);
      assert.deepEqual([s.phase, s.rep, s.banner, s.timer], ['REP BREAK', '1', 'NEXT: REP 2', '3']);
      assert.equal(await text(page, 'repCaption'), 'REP 1 COMPLETED');
      await page.clock.runFor(1000);
      assert.equal(await text(page, 'timerNum'), '2');
      await ctx.close();
    });

    test('pause freezes, resume continues, stop resets; manual rep never advances by itself', async () => {
      const { ctx, page } = await clockedPage(browser);
      await setSettings(page, { sets_enabled: false, hold_enabled: false, reps_enabled: false, rep_break: '2', get_ready: '0' });
      assert.equal(await page.locator('#finishBtn').isVisible(), true);
      assert.equal(await page.locator('#endBtn').isVisible(), true);
      await page.click('#startBtn');
      await page.clock.runFor(10_100);
      assert.equal(await text(page, 'timerNum'), '10');
      await page.click('#pauseBtn');
      assert.equal((await states(page)).phase, 'PAUSED');
      assert.equal(await page.locator('#finishBtn').isDisabled(), true);       // phase controls off while paused
      assert.equal(await page.locator('#endBtn').isDisabled(), true);
      await page.clock.runFor(60_000);
      assert.equal(await text(page, 'timerNum'), '10');
      await page.click('#pauseBtn');                                           // Resume
      await page.clock.runFor(2000);
      assert.equal(await text(page, 'timerNum'), '12');
      await page.clock.runFor(120_000);                                         // two minutes: still the same rep
      assert.equal((await states(page)).rep, '1');
      assert.equal((await states(page)).phase, 'HOLD');
      await page.click('#finishBtn');
      assert.equal((await states(page)).phase, 'REP BREAK');
      await page.clock.runFor(2100);
      assert.deepEqual([(await states(page)).phase, (await states(page)).rep, (await states(page)).timer], ['HOLD', '2', '0']);
      await page.click('#endBtn');
      assert.equal((await states(page)).phase, 'COMPLETE');
      await page.click('#stopBtn');
      assert.deepEqual([(await states(page)).phase, (await states(page)).rep], ['READY', '0']);
      assert.equal(await page.locator('#startBtn').isEnabled(), true);
      await ctx.close();
    });

    test('settings and presets are locked during a run', async () => {
      const { ctx, page } = await clockedPage(browser);
      await setSettings(page, { get_ready: '0' });
      await page.click('#startBtn');
      await page.click('#menuBtn');
      for (const id of ['f_reps', 'f_name', 'saveBtn', 'importBtn', 'presetSelect', 'deleteBtn']) assert.equal(await page.locator(`#${id}`).isDisabled(), true, id);
      assert.equal(await page.locator('#lockNote').isVisible(), true);
      await page.click('#closeSheet');
      await page.click('#stopBtn');
      await page.click('#menuBtn');
      assert.equal(await page.locator('#f_reps').isEnabled(), true);
      await ctx.close();
    });

    test('invalid input explains itself and does not start; disabled inputs never block', async () => {
      const { ctx, page } = await clockedPage(browser);
      await setSettings(page, { reps: '0' });
      await page.click('#startBtn');
      assert.equal(await page.locator('#formError').innerText(), 'Reps per set must be a whole number, 1 to 9999.');
      assert.equal((await states(page)).phase, 'READY');
      await page.click('#f_reps_enabled');
      await page.click('#closeSheet');
      await page.click('#startBtn');
      assert.notEqual((await states(page)).phase, 'READY');
      await ctx.close();
    });

    test('leaving the page pauses, time away is not counted, and Resume is required', async () => {
      const { ctx, page } = await clockedPage(browser);
      await setSettings(page, { get_ready: '0', hold: '30' });
      await page.click('#startBtn');
      await page.clock.runFor(5100);
      assert.equal(await text(page, 'timerNum'), '5');
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
      await page.clock.runFor(120_000);
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
      const s = await states(page);
      assert.deepEqual([s.phase, s.timer, s.banner], ['PAUSED', '5', 'Paused while away. Tap Resume.']);
      assert.equal(await page.locator('#pauseBtn').innerText(), 'Resume');
      await page.click('#pauseBtn');
      await page.clock.runFor(1000);
      assert.equal((await states(page)).phase, 'HOLD');
      assert.equal(await text(page, 'timerNum'), '6');
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));        // locking the device
      assert.equal((await states(page)).phase, 'PAUSED');
      await ctx.close();
    });

    test('an app killed without any event comes back paused from its last checkpoint', async () => {
      const first = await clockedPage(browser);
      await setSettings(first.page, { get_ready: '0', hold: '60', reps: '4' });
      await first.page.click('#startBtn');
      await first.page.clock.runFor(12_300);
      const saved = await first.page.evaluate(() => localStorage.getItem('exercise-timer:checkpoint:v1'));
      assert.ok(saved, 'a checkpoint exists');
      const cp = JSON.parse(saved);
      assert.equal(cp.snap.phase, 'hold');
      await first.ctx.close();                                                  // killed: nothing else runs
      const { ctx, page } = await clockedPage(browser, { storageSeed: ['exercise-timer:checkpoint:v1', saved] });
      const s = await states(page);
      assert.equal(s.phase, 'PAUSED');
      assert.equal(s.banner, 'Paused while away. Tap Resume.');
      assert.equal(s.timer, String(Math.floor(cp.snap.elapsed)));
      assert.ok(cp.snap.elapsed >= 7 && cp.snap.elapsed <= 12.3, `checkpoint is at most one interval behind (${cp.snap.elapsed})`);
      assert.match(await page.locator('#notices').innerText(), /up to 5 seconds/);
      assert.equal(await page.locator('#startBtn').isDisabled(), true);
      await page.clock.runFor(30_000);
      assert.equal((await states(page)).timer, s.timer);                          // closed time is not counted
      await page.click('#pauseBtn');
      await page.clock.runFor(1000);
      assert.equal(await text(page, 'timerNum'), String(Math.floor(cp.snap.elapsed) + 1));
      await ctx.close();
    });

    test('a corrupt checkpoint is discarded', async () => {
      const { ctx, page } = await clockedPage(browser, { storageSeed: ['exercise-timer:checkpoint:v1', '{"v":1,"settings":{},"snap":{"phase":"hold","set_no":99}}'] });
      assert.equal((await states(page)).phase, 'READY');
      assert.equal(await page.evaluate(() => localStorage.getItem('exercise-timer:checkpoint:v1')), null);
      await ctx.close();
    });

    test('wake lock: requested on start, released on pause, re-requested on resume, released at the end', async () => {
      const { ctx, page } = await clockedPage(browser, { init: [WAKE_MOCK('ok')] });
      await setSettings(page, { get_ready: '0', reps: '1', sets_enabled: false, hold: '3' });
      await page.click('#startBtn');
      await page.clock.runFor(100);
      assert.deepEqual(await page.evaluate(() => window.__wl), { requests: 1, released: 0 });
      await page.click('#pauseBtn');
      assert.equal((await page.evaluate(() => window.__wl)).released, 1);
      await page.click('#pauseBtn');
      await page.clock.runFor(100);
      assert.equal((await page.evaluate(() => window.__wl)).requests, 2);
      await page.clock.runFor(4000);
      assert.equal((await states(page)).phase, 'COMPLETE');
      assert.equal((await page.evaluate(() => window.__wl)).released, 2);
      await ctx.close();
    });

    test('wake lock: stopping while the request is still pending does not leave the screen locked awake', async () => {
      const { ctx, page } = await clockedPage(browser, { init: [WAKE_MOCK('slow')] });
      await setSettings(page, { get_ready: '0', hold: '30' });
      await page.click('#startBtn');
      await page.click('#pauseBtn');            // pause, then a quick Resume: still only one request in flight
      await page.click('#pauseBtn');
      assert.equal((await page.evaluate(() => window.__wl)).requests, 1);
      await page.click('#stopBtn');              // the user stops before the device answers
      await page.evaluate(() => window.__wl.resolve());
      await page.waitForFunction(() => window.__wl.released === 1);
      await page.clock.runFor(200);
      assert.deepEqual(await page.evaluate(() => ({ r: window.__wl.requests, rel: window.__wl.released })), { r: 1, rel: 1 });
      assert.equal(await page.locator('#notices .note').count(), 0);
      await ctx.close();
    });

    test('wake lock denied or unsupported: a note explains the Auto-Lock fallback and the timer keeps running', async () => {
      for (const mode of ['deny', 'none']) {
        const { ctx, page } = await clockedPage(browser, { init: [WAKE_MOCK(mode)] });
        await setSettings(page, { get_ready: '0', hold: '30' });
        await page.click('#startBtn');
        await page.clock.runFor(2100);
        assert.match(await page.locator('#notices').innerText(), /Auto-Lock/, mode);
        assert.equal(await text(page, 'timerNum'), '2', mode);
        await ctx.close();
      }
    });

    test('audio: created from the Start tap, cues are scheduled, pause/stop cancel them, mute and failure are safe', async () => {
      let { ctx, page } = await clockedPage(browser, { init: [AUDIO_MOCK('ok')] });
      await setSettings(page, { get_ready: '0', hold: '4', reps: '1', sets_enabled: false });
      assert.equal((await page.evaluate(() => window.__audio)).contexts, 0);      // nothing before a tap
      await page.click('#startBtn');
      await page.clock.runFor(100);
      let a = await page.evaluate(() => ({ contexts: window.__audio.contexts, resumed: window.__audio.resumed, osc: window.__audio.osc.length }));
      assert.deepEqual(a, { contexts: 1, resumed: 1, osc: 1 });                    // hold-start beep
      await page.click('#pauseBtn');
      const stopped = await page.evaluate(() => window.__audio.osc.every((o) => o.stops.includes(0) && o.disc));
      assert.equal(stopped, true);                                                  // stale cue cancelled by pause
      await page.click('#pauseBtn');
      await page.clock.runFor(4100);
      assert.equal((await page.evaluate(() => window.__audio.osc.length)), 1 + 3);  // + the completion tune (hold end is replaced by it)
      await ctx.close();
      ({ ctx, page } = await clockedPage(browser, { init: [AUDIO_MOCK('ok')] }));
      await setSettings(page, { get_ready: '0' });
      await page.click('#menuBtn');
      await page.click('#soundToggle');                                             // mute
      await page.click('#closeSheet');
      await page.click('#startBtn');
      await page.clock.runFor(100);
      assert.equal((await page.evaluate(() => window.__audio.contexts)), 0);
      await ctx.close();
      ({ ctx, page } = await clockedPage(browser, { init: [AUDIO_MOCK('throw')] }));
      await setSettings(page, { get_ready: '0', hold: '30' });
      await page.click('#startBtn');
      await page.clock.runFor(3100);
      assert.equal(await text(page, 'timerNum'), '3');                              // timer unaffected by an audio failure
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });
  });
}

// ---------------------------------------------------------------- layouts
const PROFILES = ['iPhone SE', 'iPhone SE landscape', 'iPhone 15', 'iPhone 15 landscape', 'iPad (gen 7)', 'iPad (gen 7) landscape', 'iPad Pro 11', 'iPad Pro 11 landscape']
  .filter((n) => devices[n]);

async function measure(page) {
  return page.evaluate(() => {
    const vw = innerWidth, vh = innerHeight;
    const ids = ['topbar', 'exName', 'setText', 'phase', 'repNum', 'repTotal', 'repCaption', 'timerNum', 'timerSuffix', 'banner', 'startBtn', 'pauseBtn', 'stopBtn', 'finishBtn', 'endBtn', 'menuBtn', 'statusChip'];
    const out = { vw, vh, outside: [], small: [], sizes: {}, overlaps: [] };
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el || el.hidden || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) out.outside.push([id, Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]);
      if (/Btn$/.test(id) && (r.height < 44 || r.width < 44)) out.small.push([id, r.width, r.height]);
      out.sizes[id] = parseFloat(getComputedStyle(el).fontSize);
    }
    const rects = (id) => document.getElementById(id).getBoundingClientRect();
    const controls = document.getElementById('controls').getBoundingClientRect();
    for (const id of ['banner', 'timerNum', 'repNum']) if (rects(id).bottom > controls.top + 1) out.overlaps.push(id);
    const stack = ['exName', 'setText', 'phase', 'repRow', 'repCaption', 'timerRow', 'banner'].filter((id) => document.getElementById(id).getClientRects().length);
    for (const row of ['repRow', 'timerRow']) { const el = document.getElementById(row); if (el.scrollWidth > el.clientWidth + 1) out.overlaps.push(`${row} wider than its box`); }
    out.scrollX = document.documentElement.scrollWidth - vw;
    out.scrollY = document.documentElement.scrollHeight - vh;
    out.stack = stack;
    return out;
  });
}

describe('mobile layouts (WebKit iPhone and iPad profiles, portrait and landscape)', () => {
  let browser;
  before(async () => { browser = await launch('webkit'); });
  after(async () => { await browser.close(); });

  const scenarios = [
    ['default idle', {}, 0],
    ['3-digit reps, long name, running', { name: 'A very long exercise name that needs to wrap on a small phone screen without clipping', reps: '100', sets: '10', get_ready: '0', hold: '90' }, 1100],
    ['manual stopwatch with all five controls', { name: 'Wall sit', hold_enabled: false, reps_enabled: false, get_ready: '0' }, 100_100],
    ['rep break with 3-digit total', { name: 'x', reps: '100', hold: '1', rep_break: '30', get_ready: '0' }, 1100],
    ['complete', { reps: '1', sets_enabled: false, hold: '1', get_ready: '0' }, 1500],
  ];

  for (const profile of PROFILES) {
    test(profile, async () => {
      for (const [label, settings, advance] of scenarios) {
        const { ctx, page } = await clockedPage(browser, { device: profile });
        if (Object.keys(settings).length) await setSettings(page, settings);
        if (advance) {
          await page.click('#startBtn');
          await page.clock.runFor(advance);
        }
        const m = await measure(page);
        const where = `${profile} / ${label}`;
        assert.deepEqual(m.outside, [], `${where}: elements outside the screen`);
        assert.deepEqual(m.small, [], `${where}: touch targets under 44px`);
        assert.deepEqual(m.overlaps, [], `${where}: overlaps`);
        assert.ok(m.scrollX <= 1, `${where}: horizontal scroll ${m.scrollX}`);
        assert.ok(m.scrollY <= 1, `${where}: vertical scroll ${m.scrollY}`);
        const { repNum, timerNum, exName, phase } = m.sizes;
        assert.ok(repNum > timerNum, `${where}: rep (${repNum}) larger than timer (${timerNum})`);
        assert.ok(timerNum > Math.max(exName, phase) || label === 'complete', `${where}: timer (${timerNum}) larger than labels`);
        await ctx.close();
      }
    });
  }

  test('every control in the settings sheet is at least 44px tall (iPhone SE and iPad)', async () => {
    for (const profile of ['iPhone SE', 'iPad (gen 7)'].filter((n) => devices[n])) {
      const { ctx, page } = await clockedPage(browser, { device: profile });
      await page.click('#menuBtn');
      const small = await page.evaluate(() => [...document.querySelectorAll('#sheet button, #sheet label, #sheet select, #sheet input[type=text]')]
        .filter((el) => el.getClientRects().length && !el.closest('[hidden]'))
        .map((el) => [el.id || el.textContent.trim().slice(0, 20), Math.round(el.getBoundingClientRect().height)])
        .filter(([, h]) => h < 44));
      assert.deepEqual(small, [], `${profile}: controls under 44px`);
      await ctx.close();
    }
  });

  test('safe-area padding is applied to the layout', async () => {
    const { ctx, page } = await clockedPage(browser, { device: 'iPhone 15' });
    const css = await page.evaluate(() => [...document.styleSheets[0].cssRules].map((r) => r.cssText).join('\n'));
    assert.match(css, /env\(safe-area-inset-top\)/);
    assert.match(css, /env\(safe-area-inset-bottom\)/);
    await page.screenshot({ path: process.env.ET_SHOT_DIR ? `${process.env.ET_SHOT_DIR}/iphone15-portrait.png` : undefined });
    await ctx.close();
  });
});
