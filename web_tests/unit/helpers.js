import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPLETE, DEFAULTS, Engine, parseSettings } from '../../docs/js/engine.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const fixtureText = (name) => readFileSync(join(ROOT, 'fixtures', name), 'utf8');
export const fixture = (name) => JSON.parse(fixtureText(name));
export const fixtureBytes = (name) => new Uint8Array(readFileSync(join(ROOT, 'fixtures', name)));
export const bytes = (text) => new TextEncoder().encode(text);

export class Clock {
  constructor() { this.t = 100; }
  now() { return this.t; }
}

/** An engine on a fake clock. */
export function makeEngine(overrides = {}) {
  const clock = new Clock();
  const settings = parseSettings({ ...DEFAULTS, get_ready: 0, rep_break: 0, rest_enabled: false, ...overrides });
  return { e: new Engine(settings, () => clock.t), clock };
}

/** Advance in steps of at most `step` seconds, like a UI that keeps ticking. */
export function adv(e, clock, seconds, step = 1) {
  while (seconds > 1e-9) {
    const dt = Math.min(step, seconds);
    clock.t += dt;
    seconds -= dt;
    e.update();
  }
}

/** The shared fixture driver (rules in tools/gen_fixtures.py). */
export function drive(c) {
  const clock = new Clock();
  const e = new Engine(parseSettings(c.settings), () => clock.t);
  e.start();
  const t0 = clock.t;
  const timeline = [], events = [], samples = [];
  let doneAt = null, last = null, nextSample = 0;
  for (let n = 0; n < c.max_steps; n++) {
    if (e.canFinishRep && c.finish_after !== null && e.elapsed >= c.finish_after) e.finishRep();
    if (e.canEndSet && c.end_after_reps !== null && e.repsDone >= c.end_after_reps) e.endSet();
    const now = clock.t - t0;
    const ev = e.popEvents();
    events.push(...ev);
    if (e.phase !== last || ev.includes('hold_start')) { timeline.push([now, e.phase, e.setNo, e.repNo, e.repsDone]); last = e.phase; }
    if (e.phase === COMPLETE && doneAt === null) doneAt = now;
    while (now >= nextSample) {
      const d = e.display();
      samples.push([nextSample, d.phaseLabel, d.setText, d.repText, d.repTotalText, d.repCaption, d.timerText, d.timerSuffix]);
      nextSample += 1;
    }
    if (e.phase === COMPLETE) break;
    clock.t += c.step;
    e.update();
  }
  return { timeline, events, samples, doneAt };
}

/** localStorage stand-in that can be told to fail. */
export class FakeStorage {
  constructor() { this.data = new Map(); this.failWrites = false; this.failReads = false; }
  getItem(k) { if (this.failReads) throw new Error('blocked'); return this.data.has(k) ? this.data.get(k) : null; }
  setItem(k, v) {
    if (this.failWrites) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
    this.data.set(k, String(v));
  }
  removeItem(k) { this.data.delete(k); }
}
