import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_NAME, KEY, PresetStore, StoreError, CHECKPOINT_KEY } from '../../docs/js/store.js';
import { DEFAULTS, parseSettings } from '../../docs/js/engine.js';
import { Sound } from '../../docs/js/sound.js';
import { FakeStorage } from './helpers.js';

const S = (o) => parseSettings({ ...DEFAULTS, ...o });

test('fresh store has the labelled demo preset and sound on', () => {
  const s = new PresetStore(new FakeStorage());
  assert.deepEqual(s.names(), [DEMO_NAME]);
  assert.match(s.get(DEMO_NAME).name.toLowerCase(), /example/);
  assert.equal(s.sound, true);
  assert.equal(s.last, DEMO_NAME);
});

test('presets, sound and last selection persist after reopening', () => {
  const storage = new FakeStorage();
  const s = new PresetStore(storage);
  const custom = S({ name: 'Wall sit', sets_enabled: false, sets: 2, reps_enabled: false, reps: 7, hold_enabled: false, hold: 15, rep_break: 0, rest_enabled: true, rest: 45, get_ready: 0 });
  s.put('Legs', custom);
  s.put('Arms', S({ name: 'Arms' }));
  s.setSound(false);
  s.setLast('Legs');
  const again = new PresetStore(storage);
  assert.deepEqual({ ...again.get('Legs') }, { ...custom });
  assert.deepEqual(again.names(), [DEMO_NAME, 'Legs', 'Arms']);
  assert.equal(again.sound, false);
  assert.equal(again.last, 'Legs');
  assert.equal(again.notice, '');
});

test('the saved data has the same shape as the Windows presets.json', () => {
  const storage = new FakeStorage();
  new PresetStore(storage).put('A', S({ name: 'a' }));
  const data = JSON.parse(storage.data.get(KEY));
  assert.deepEqual(Object.keys(data), ['version', 'sound', 'last', 'presets']);
  assert.equal(data.version, 1);
  assert.deepEqual(Object.keys(data.presets.A), ['name', 'sets_enabled', 'sets', 'reps_enabled', 'reps', 'hold_enabled', 'hold', 'rep_break', 'rest_enabled', 'rest', 'get_ready']);
});

test('replace, rename and delete keep list position and the case-insensitive rule', () => {
  const s = new PresetStore(new FakeStorage());
  s.put('A', S({ name: 'a' })); s.put('B', S({ name: 'b' }));
  s.put('a', S({ name: 'a2' }));
  assert.deepEqual(s.names(), [DEMO_NAME, 'a', 'B']);
  s.rename('a', 'Z');
  assert.deepEqual(s.names(), [DEMO_NAME, 'Z', 'B']);
  s.put('Q', S({ name: 'q' }));
  s.rename('Q', 'b');
  assert.deepEqual(s.names(), [DEMO_NAME, 'Z', 'b']);
  assert.equal(s.get('b').name, 'q');
  s.delete('Z');
  assert.equal(new PresetStore(s.storage).names().includes('Z'), false);
});

test('deleting the last-selected preset moves the selection', () => {
  const s = new PresetStore(new FakeStorage());
  s.put('X', S({ name: 'x' }));
  s.delete('X');
  assert.equal(s.last, DEMO_NAME);
});

test('corrupt stored data is kept aside, a notice is shown, and it is not replaced by an empty list silently', () => {
  const storage = new FakeStorage();
  storage.setItem(KEY, '{ not json');
  const s = new PresetStore(storage, () => Date.UTC(2026, 0, 2, 3, 4, 5));
  assert.deepEqual(s.names(), [DEMO_NAME]);
  assert.match(s.notice, /could not be read/);
  const copies = [...storage.data.keys()].filter((k) => k.startsWith(`${KEY}:bad-`));
  assert.equal(copies.length, 1);
  assert.equal(storage.data.get(copies[0]), '{ not json');
  assert.equal(storage.data.get(KEY), '{ not json');       // original untouched until the user saves
});

test('one damaged preset is skipped, others survive, and a copy is kept', () => {
  const storage = new FakeStorage();
  const good = { ...S({ name: 'ok' }) };
  storage.setItem(KEY, JSON.stringify({ version: 1, sound: true, last: 'good', presets: { good, bad: { ...good, reps: 'nope' } } }));
  const s = new PresetStore(storage);
  assert.deepEqual(s.names(), ['good']);
  assert.match(s.notice, /skipped/);
  assert.equal([...storage.data.keys()].filter((k) => k.includes(':bad-')).length, 1);
});

test('data written by a newer version is read-only and never overwritten', () => {
  const storage = new FakeStorage();
  const text = JSON.stringify({ version: 2, presets: { A: { ...S({ name: 'a' }) } } });
  storage.setItem(KEY, text);
  const s = new PresetStore(storage);
  assert.equal(s.readOnly, true);
  assert.deepEqual(s.names(), ['A']);
  assert.throws(() => s.put('B', S({ name: 'b' })), StoreError);
  assert.equal(storage.data.get(KEY), text);
});

test('unavailable storage: presets work in memory with a visible notice and a clear save error', () => {
  const s = new PresetStore(null);
  assert.match(s.notice, /not allowing saved data/);
  assert.deepEqual(s.names(), [DEMO_NAME]);
  assert.throws(() => s.put('A', S({ name: 'a' })), (e) => e instanceof StoreError && /Export/.test(e.message));
  assert.ok(s.names().includes('A'));      // kept in memory, not silently dropped
  const blocked = new FakeStorage();
  blocked.failReads = true;
  const unreadable = new PresetStore(blocked);
  assert.match(unreadable.notice, /cannot be read/);
  blocked.failReads = false;
  blocked.data.set(KEY, 'older data that was only temporarily unreadable');
  assert.throws(() => unreadable.put('X', S({ name: 'x' })), StoreError);      // never writes over unreadable data
  assert.equal(blocked.data.get(KEY), 'older data that was only temporarily unreadable');
});

test('a failed write is reported and the previous saved copy stays', () => {
  const storage = new FakeStorage();
  const s = new PresetStore(storage);
  s.put('A', S({ name: 'a' }));
  const before = storage.data.get(KEY);
  storage.failWrites = true;
  assert.throws(() => s.put('B', S({ name: 'b' })), (e) => e instanceof StoreError && /Could not save presets/.test(e.message));
  assert.equal(storage.data.get(KEY), before);
});

test('checkpoint save/load/clear never throws, even when storage fails', () => {
  const storage = new FakeStorage();
  const s = new PresetStore(storage);
  assert.equal(s.saveCheckpoint({ v: 1, a: 1 }), true);
  assert.deepEqual(s.loadCheckpoint(), { v: 1, a: 1 });
  s.clearCheckpoint();
  assert.equal(s.loadCheckpoint(), null);
  storage.failWrites = true;
  assert.equal(s.saveCheckpoint({ v: 1 }), false);
  storage.setItem = () => { throw new Error('x'); };
  storage.data.set(CHECKPOINT_KEY, '{bad');
  assert.equal(s.loadCheckpoint(), null);
});

// ---- sound -------------------------------------------------------------
class FakeCtx {
  constructor() { this.state = 'suspended'; this.currentTime = 0; this.made = []; this.destination = {}; this.resumed = 0; }
  resume() { this.resumed++; this.state = 'running'; return Promise.resolve(); }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  createOscillator() {
    const o = { frequency: {}, stopped: [], started: [], connect() {}, disconnect() { o.disconnected = true; },
      start(t) { o.started.push(t); }, stop(t) { o.stopped.push(t); } };
    this.made.push(o);
    return o;
  }
}

test('sound: unlocks from a tap, plays cues, and cancel stops every queued tone', () => {
  const ctx = new FakeCtx();
  const snd = new Sound(() => ctx);
  snd.play('complete');
  assert.equal(ctx.made.length, 0);          // not unlocked yet: nothing scheduled
  snd.unlock();
  assert.equal(ctx.resumed, 1);
  snd.play('complete');
  assert.equal(ctx.made.length, 3);
  snd.cancel();
  assert.ok(ctx.made.every((o) => o.stopped.includes(0) && o.disconnected));
  assert.equal(snd.active.size, 0);
});

test('sound: muted plays nothing; failures are swallowed', () => {
  const ctx = new FakeCtx();
  const snd = new Sound(() => ctx, false);
  snd.unlock(); snd.play('hold_start');
  assert.equal(ctx.made.length, 0);
  const broken = new Sound(() => { throw new Error('no audio'); });
  broken.unlock(); broken.play('hold_start'); broken.cancel();      // none of these throw
  const bad = new FakeCtx();
  bad.createOscillator = () => { throw new Error('boom'); };
  const s2 = new Sound(() => bad);
  s2.unlock(); s2.play('hold_end'); s2.cancel();
  const none = new Sound(null);
  none.unlock(); none.play('hold_start');
});
