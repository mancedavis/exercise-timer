import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMPLETE, GET_READY, HOLD, IDLE, REP_BREAK, SET_REST, parseSettings } from '../../docs/js/engine.js';
import { adv, drive, fixture, makeEngine } from './helpers.js';

const CASES = fixture('timing_cases.json');

test('shared timing fixtures: timelines, events, completion and display text match the Windows engine', () => {
  assert.ok(CASES.length >= 12);
  for (const c of CASES) {
    const r = drive(c);
    assert.deepEqual(r.timeline, c.expect.timeline, c.name);
    assert.deepEqual(r.events, c.expect.events, c.name);
    assert.equal(r.doneAt, c.expect.done_at, c.name);
    assert.equal(r.events.filter((x) => x === 'hold_start').length, c.expect.holds, c.name);
    if (c.expect.samples) assert.deepEqual(r.samples.slice(0, c.expect.samples.length), c.expect.samples, c.name);
  }
});

test('required example: 6 holds, 4 rep breaks, 1 set rest, 51 s, no final rest', () => {
  const c = CASES.find((x) => x.name.startsWith('required example'));
  const r = drive(c);
  const phases = r.timeline.map((t) => t[1]);
  assert.equal(r.events.filter((x) => x === 'hold_start').length, 6);
  assert.equal(phases.filter((p) => p === REP_BREAK).length, 4);
  assert.equal(phases.filter((p) => p === SET_REST).length, 1);
  assert.equal(r.doneAt, 51);
  assert.deepEqual(phases, [HOLD, REP_BREAK, HOLD, REP_BREAK, HOLD, SET_REST, HOLD, REP_BREAK, HOLD, REP_BREAK, HOLD, COMPLETE]);
});

test('every on/off combination of sets, reps and hold completes', () => {
  for (const sets of [true, false]) for (const reps of [true, false]) for (const hold of [true, false]) {
    const { e, clock } = makeEngine({ sets_enabled: sets, sets: 2, reps_enabled: reps, reps: 3, hold_enabled: hold, hold: 2, rep_break: 1, rest_enabled: true, rest: 2 });
    e.start();
    let holds = 0, rests = 0, last = null;
    for (let i = 0; i < 400 && e.phase !== COMPLETE; i++) {
      if (e.canFinishRep && e.elapsed >= 1) e.finishRep();
      if (e.canEndSet && e.repsDone >= 2) e.endSet();
      holds += e.popEvents().filter((x) => x === 'hold_start').length;
      if (e.phase === SET_REST && last !== SET_REST) rests++;
      last = e.phase;
      adv(e, clock, 0.5, 0.5);
    }
    const label = `sets=${sets} reps=${reps} hold=${hold}`;
    assert.equal(e.phase, COMPLETE, label);
    assert.equal(holds + e.popEvents().filter((x) => x === 'hold_start').length, (sets ? 2 : 1) * (reps ? 3 : 2), label);
    assert.equal(rests, sets ? 1 : 0, label);
  }
});

test('a disabled hold never advances by itself, even after a huge jump', () => {
  const { e, clock } = makeEngine({ hold_enabled: false, reps: 3 });
  e.start();
  adv(e, clock, 3000);
  assert.deepEqual([e.phase, e.repNo], [HOLD, 1]);
  clock.t += 1e7;
  e.update();
  assert.equal(e.paused, true);
  assert.deepEqual([e.phase, e.repNo], [HOLD, 1]);
});

test('Finish Rep only in an active manual hold; End Set only for open-ended reps', () => {
  let { e } = makeEngine({ hold_enabled: true, hold: 5 });
  e.start();
  assert.equal(e.finishRep(), false);
  assert.equal(e.endSet(), false);
  const m = makeEngine({ hold_enabled: false, rep_break: 2, get_ready: 2, reps_enabled: false });
  e = m.e;
  assert.equal(e.finishRep(), false);                      // idle
  e.start();
  assert.equal(e.finishRep(), false);                      // get ready
  assert.equal(e.endSet(), false);
  adv(e, m.clock, 2);
  e.pause();
  assert.equal(e.finishRep(), false);                      // paused
  assert.equal(e.canEndSet, false);
  e.resume();
  assert.equal(e.finishRep(), true);
  assert.equal(e.phase, REP_BREAK);
  assert.equal(e.finishRep(), false);                      // in the break
  assert.equal(e.endSet(), true);                          // End Set works in a break
});

test('all disabled: open-ended stopwatch, Finish Rep -> break -> next rep, End Set finishes', () => {
  const { e, clock } = makeEngine({ sets_enabled: false, reps_enabled: false, hold_enabled: false, rep_break: 5 });
  e.start();
  adv(e, clock, 125);
  assert.equal(e.display().timerText, '125');
  e.finishRep();
  assert.equal(e.phase, REP_BREAK);
  adv(e, clock, 4);
  assert.equal(e.phase, REP_BREAK);
  adv(e, clock, 1);
  assert.deepEqual([e.phase, e.repNo, e.elapsed], [HOLD, 2, 0]);
  assert.equal(e.endSet(), true);
  assert.equal(e.phase, COMPLETE);
});

test('End Set with several sets: rest, next set, completion; unfinished rep not counted', () => {
  const { e, clock } = makeEngine({ reps_enabled: false, sets: 2, hold: 3, rep_break: 2, rest_enabled: true, rest: 6 });
  e.start();
  adv(e, clock, 3);
  assert.equal(e.phase, REP_BREAK);
  e.endSet();
  assert.deepEqual([e.phase, e.repsDone], [SET_REST, 1]);
  adv(e, clock, 6);
  assert.deepEqual([e.phase, e.setNo, e.repNo], [HOLD, 2, 1]);
  adv(e, clock, 1);
  e.endSet();
  assert.deepEqual([e.phase, e.repsDone], [COMPLETE, 0]);
});

test('pause freezes everything and resume keeps fractional seconds', () => {
  const { e, clock } = makeEngine({ hold: 10, reps: 1, sets_enabled: false });
  e.start();
  adv(e, clock, 3.5);
  e.pause();
  clock.t += 100;
  e.update();
  assert.equal(e.elapsed, 3.5);
  assert.equal(e.display().phaseLabel, 'PAUSED');
  e.resume();
  adv(e, clock, 0.25);
  assert.equal(e.elapsed, 3.75);
  adv(e, clock, 6.25);
  assert.equal(e.phase, COMPLETE);
});

test('pause works in get-ready, hold and set rest', () => {
  const { e, clock } = makeEngine({ get_ready: 4, reps: 1, hold: 2, sets: 2, rest_enabled: true, rest: 5 });
  e.start();
  for (const [expected, seconds] of [[GET_READY, 4], [HOLD, 2], [SET_REST, 5]]) {
    assert.equal(e.phase, expected);
    adv(e, clock, 1.5);
    e.pause();
    const frozen = e.remaining;
    clock.t += 50;
    e.update();
    assert.equal(e.remaining, frozen);
    e.resume();
    adv(e, clock, seconds - 1.5);
  }
});

test('stop resets counters, keeps settings, and nothing runs afterwards', () => {
  const { e, clock } = makeEngine({ sets: 2, reps: 3, hold: 2, get_ready: 1 });
  e.start();
  adv(e, clock, 3);
  e.stop();
  assert.deepEqual([e.phase, e.setNo, e.repNo, e.repsDone], [IDLE, 1, 0, 0]);
  assert.deepEqual(e.popEvents(), []);
  assert.equal(e.s.sets, 2);
  clock.t += 100;
  e.update();
  assert.equal(e.phase, IDLE);
  e.start();
  assert.equal(e.phase, GET_READY);
});

test('a late callback neither skips reps nor shortens later phases', () => {
  let { e, clock } = makeEngine({ hold: 4, rep_break: 5, reps: 3, sets_enabled: false });
  e.start();
  adv(e, clock, 3);
  clock.t += 1.7;
  e.update();
  assert.equal(e.phase, REP_BREAK);
  adv(e, clock, 4.75);
  assert.equal(e.phase, REP_BREAK);
  adv(e, clock, 0.25);
  assert.deepEqual([e.phase, e.repNo], [HOLD, 2]);
  ({ e, clock } = makeEngine({ hold: 1, rep_break: 1, reps: 5, sets_enabled: false }));
  e.start();
  clock.t += 1.9;
  e.update();
  assert.deepEqual([e.phase, e.repsDone], [REP_BREAK, 1]);
});

test('a long gap pauses as "away" and needs Resume; the gap is not credited', () => {
  const { e, clock } = makeEngine({ hold: 10, reps: 3, sets_enabled: false, rep_break: 3 });
  e.start();
  adv(e, clock, 1);
  clock.t += 3600;
  e.update();
  assert.equal(e.paused, true);
  assert.equal(e.pauseReason, 'away');
  assert.equal(e.elapsed, 1);
  assert.equal(e.display().banner, 'Paused while away. Tap Resume.');
  clock.t += 60;
  e.update();
  assert.deepEqual([e.phase, e.repNo], [HOLD, 1]);
  e.resume();
  adv(e, clock, 8.5);
  assert.equal(e.phase, HOLD);
  adv(e, clock, 0.5);
  assert.equal(e.phase, REP_BREAK);
});

test('checkpoint snapshot restores paused and resumes from the saved position', () => {
  const { e, clock } = makeEngine({ sets: 2, reps: 3, hold: 10, rep_break: 2 });
  e.start();
  adv(e, clock, 10);
  adv(e, clock, 2);       // second rep begins
  adv(e, clock, 3.25);
  const snap = JSON.parse(JSON.stringify(e.snapshot()));
  const other = makeEngine({ sets: 2, reps: 3, hold: 10, rep_break: 2 });
  assert.equal(other.e.restore(snap), true);
  assert.equal(other.e.paused, true);
  assert.equal(other.e.pauseReason, 'away');
  assert.deepEqual([other.e.phase, other.e.setNo, other.e.repNo, other.e.elapsed], [HOLD, 1, 2, 3.25]);
  other.clock.t += 500;
  other.e.update();
  assert.equal(other.e.elapsed, 3.25);               // time while closed is not counted
  other.e.resume();
  adv(other.e, other.clock, 6.75);
  assert.equal(other.e.phase, REP_BREAK);
});

test('invalid checkpoints are refused', () => {
  const bad = [null, {}, { phase: 'hold' }, { phase: 'idle', set_no: 1, rep_no: 0, reps_done: 0, elapsed: 0 },
    { phase: 'hold', set_no: 9, rep_no: 1, reps_done: 0, elapsed: 1 },
    { phase: 'hold', set_no: 1, rep_no: 99, reps_done: 0, elapsed: 1 },
    { phase: 'hold', set_no: 1, rep_no: 1, reps_done: 0, elapsed: 999 },
    { phase: 'hold', set_no: 1, rep_no: 1, reps_done: 0, elapsed: -1 },
    { phase: 'hold', set_no: 1.5, rep_no: 1, reps_done: 0, elapsed: 1 },
    { phase: 'set_rest', set_no: 1, rep_no: 3, reps_done: 3, elapsed: 1 }];   // no rest configured
  for (const b of bad) {
    const { e } = makeEngine({ sets: 2, reps: 3, hold: 10 });
    assert.equal(e.restore(b), false, JSON.stringify(b));
  }
});

test('display text: hold counts up with target, break names completed and next rep, rest names next set', () => {
  let { e, clock } = makeEngine({ hold: 10, reps: 10, rep_break: 5 });
  e.start();
  adv(e, clock, 3.9);
  let d = e.display();
  assert.deepEqual([d.phaseLabel, d.repText, d.repTotalText, d.timerText, d.timerSuffix], ['HOLD', '1', 'of 10', '3', '/ 10 s']);
  adv(e, clock, 6.1);
  d = e.display();
  assert.deepEqual([d.phaseLabel, d.repText, d.repCaption, d.banner, d.timerText], ['REP BREAK', '1', 'REP 1 COMPLETED', 'NEXT: REP 2', '5']);
  ({ e, clock } = makeEngine({ hold: 1, reps: 1, sets: 2, rest_enabled: true, rest: 3 }));
  e.start();
  adv(e, clock, 1);
  d = e.display();
  assert.deepEqual([d.phaseLabel, d.setText, d.banner], ['SET REST', 'SET 1 of 2 DONE', 'NEXT: SET 2, REP 1']);
  adv(e, clock, 3);
  adv(e, clock, 1);
  assert.deepEqual([e.display().phaseLabel, e.display().timerText], ['COMPLETE', 'Exercise complete']);
});

test('get-ready does not show a started rep; open-ended reps hide the total; sets hidden when disabled', () => {
  let { e } = makeEngine({ get_ready: 5 });
  e.start();
  let d = e.display();
  assert.deepEqual([d.phaseLabel, d.repText, d.timerText], ['GET READY', '0', '5']);
  ({ e } = makeEngine({ reps_enabled: false, sets_enabled: false }));
  e.start();
  d = e.display();
  assert.equal(d.repTotalText, '');
  assert.equal(d.setText, '');
  assert.ok(d.banner.includes('End Set'));
});

test('no countdown ever goes negative', () => {
  const { e, clock } = makeEngine({ sets: 2, reps: 2, hold: 2, rep_break: 2, rest_enabled: true, rest: 3, get_ready: 2 });
  e.start();
  for (let i = 0; i < 120; i++) {
    adv(e, clock, 0.25, 0.25);
    assert.ok(e.elapsed >= 0);
    if (e.remaining !== null) assert.ok(e.remaining >= 0);
    assert.ok(!e.display().timerText.startsWith('-'));
  }
});

test('validation: enabled values, disabled values, limits and messages', () => {
  const base = { name: 'x', sets_enabled: true, sets: '3', reps_enabled: true, reps: '10', hold_enabled: true, hold: '10', rep_break: '5', rest_enabled: false, rest: '30', get_ready: '5' };
  const bad = (o) => assert.throws(() => parseSettings({ ...base, ...o }));
  for (const key of ['sets', 'reps', 'hold']) for (const v of ['0', '-2', '1.5', 'abc', '', ' ', '+5', '1_000', '10000x']) bad({ [key]: v });
  bad({ reps: '10000' }); bad({ hold: '86401' }); bad({ rep_break: '-1' }); bad({ get_ready: '-1' });
  bad({ rest_enabled: true, rest: 'x' }); bad({ name: 'x'.repeat(81) });
  const s = parseSettings({ ...base, rep_break: '0', get_ready: '0', rest_enabled: true, rest: '0' });
  assert.deepEqual([s.rep_break, s.get_ready, s.rest], [0, 0, 0]);
  const d = parseSettings({ ...base, sets_enabled: false, sets: 'zzz', reps_enabled: false, reps: '0', hold_enabled: false, hold: '', rest: '-4' });
  assert.deepEqual([d.sets, d.reps, d.hold, d.rest], [3, 10, 10, 30]);
  assert.equal(parseSettings({ ...base, name: '   ' }).name, 'Exercise');
  assert.throws(() => parseSettings({ ...base, reps: '0' }), { message: 'Reps per set must be a whole number, 1 to 9999.' });
  assert.equal(parseSettings({ ...base, hold: '86400', reps: '9999' }).hold, 86400);
});
