// Timing logic for Exercise Timer (web). A port of exercise_timer/engine.py:
// same phases, same rules, same expected timelines (see fixtures/). No DOM here;
// the clock is injected (seconds, monotonic) so tests never wait.

export const IDLE = 'idle', GET_READY = 'get_ready', HOLD = 'hold', REP_BREAK = 'rep_break',
  SET_REST = 'set_rest', COMPLETE = 'complete';
export const ACTIVE = [GET_READY, HOLD, REP_BREAK, SET_REST];

// Not updated for longer than this while running (device slept, page frozen):
// pause at the last good time and require Resume; never credit or skip the gap.
export const GAP_LIMIT = 2.0;
export const MAX_NAME = 80, MAX_COUNT = 9999, MAX_SECONDS = 86400;

const LABELS = {
  idle: 'READY', get_ready: 'GET READY', hold: 'HOLD', rep_break: 'REP BREAK',
  set_rest: 'SET REST', complete: 'COMPLETE',
};

export const DEFAULTS = Object.freeze({
  name: 'Exercise', sets_enabled: true, sets: 3, reps_enabled: true, reps: 10,
  hold_enabled: true, hold: 10, rep_break: 5, rest_enabled: false, rest: 30, get_ready: 5,
});

// key, label, minimum, toggle key (null = always on)
const FIELDS = [
  ['sets', 'Sets', 1, 'sets_enabled'], ['reps', 'Reps per set', 1, 'reps_enabled'],
  ['hold', 'Hold seconds', 1, 'hold_enabled'], ['rep_break', 'Rep break', 0, null],
  ['rest', 'Set rest', 0, 'rest_enabled'], ['get_ready', 'Get-ready', 0, null],
];

export const chars = (s) => [...s].length;   // code points, like Python's len()

/** Raw UI/stored values (numbers may be strings) -> a plain settings object.
 *  Throws Error with a short message. Disabled fields are never validated. */
export function parseSettings(raw) {
  const name = String(raw.name ?? '').trim() || 'Exercise';
  if (chars(name) > MAX_NAME) throw new Error(`Name must be ${MAX_NAME} characters or fewer.`);
  const values = { name };
  for (const [key, label, minimum, toggle] of FIELDS) {
    const enabled = toggle === null ? true : (raw[toggle] ?? false);
    if (typeof enabled !== 'boolean') throw new Error(`${label}: enable flag must be true or false.`);
    if (toggle) values[toggle] = enabled;
    const maximum = key === 'sets' || key === 'reps' ? MAX_COUNT : MAX_SECONDS;
    const fallback = DEFAULTS[key];
    const text = raw[key] ?? fallback;
    let number = null;
    if (typeof text === 'number' && Number.isInteger(text)) number = text;
    else if (typeof text === 'string' && /^[0-9]+$/.test(text.trim())) number = Number(text.trim());
    if (number === null || number < minimum || number > maximum) {
      if (enabled) throw new Error(`${label} must be a whole number, ${minimum} to ${maximum}.`);
      number = fallback;
    }
    values[key] = number;
  }
  // same key order as the Windows files
  return Object.freeze({
    name: values.name, sets_enabled: values.sets_enabled, sets: values.sets,
    reps_enabled: values.reps_enabled, reps: values.reps, hold_enabled: values.hold_enabled,
    hold: values.hold, rep_break: values.rep_break, rest_enabled: values.rest_enabled,
    rest: values.rest, get_ready: values.get_ready,
  });
}

export const totalSets = (s) => (s.sets_enabled ? s.sets : 1);
// rest between sets; 0 means none (also when there is only one set)
export const restSeconds = (s) => (s.rest_enabled && totalSets(s) > 1 ? s.rest : 0);

export class Engine {
  constructor(settings, clock) {
    this.s = settings;
    this.clock = clock;
    this._events = [];
    this._reset();
  }

  _reset() {
    this.phase = IDLE;
    this.paused = false;
    this.pauseReason = null;   // 'user' | 'away' (hidden, long gap, or restored)
    this.setNo = 1;
    this.repNo = 0;            // reps started in the current set
    this.repsDone = 0;         // reps completed in the current set
    this._t0 = 0;
    this._frozen = 0;
    this._last = 0;
  }

  get active() { return ACTIVE.includes(this.phase); }
  get canFinishRep() { return this.phase === HOLD && !this.s.hold_enabled && !this.paused; }
  get canEndSet() {
    return (this.phase === HOLD || this.phase === REP_BREAK) && !this.s.reps_enabled && !this.paused;
  }

  popEvents() { const e = this._events; this._events = []; return e; }

  _duration() {
    const s = this.s;
    switch (this.phase) {
      case GET_READY: return s.get_ready;
      case REP_BREAK: return s.rep_break;
      case SET_REST: return restSeconds(s);
      case HOLD: return s.hold_enabled ? s.hold : null;
      default: return null;
    }
  }

  /** Seconds in the current phase (frozen while paused). */
  get elapsed() {
    if (!this.active) return 0;
    return this.paused ? this._frozen : Math.max(0, this.clock() - this._t0);
  }

  get remaining() {
    const d = this._duration();
    return d === null ? null : Math.max(0, d - this.elapsed);
  }

  // ---- commands -------------------------------------------------------
  start() {
    if (this.active) return false;
    this._reset();
    this._events = [];
    const now = this._last = this.clock();
    if (this.s.get_ready > 0) { this.phase = GET_READY; this._t0 = now; } else this._beginHold(now);
    return true;
  }

  stop() { this._reset(); this._events = []; }

  pause(reason = 'user') {
    this.update();
    if (this.active && !this.paused) this._freeze(this.clock(), reason);
  }

  resume() {
    if (this.active && this.paused) {
      const now = this.clock();
      this._t0 = now - this._frozen;
      this._last = now;
      this.paused = false;
      this.pauseReason = null;
    }
  }

  finishRep() {
    this.update();
    if (this.canFinishRep) { this._finishRep(this.clock()); return true; }
    return false;
  }

  endSet() {
    this.update();
    if (this.canEndSet) {
      if (this.phase === HOLD) this._events.push('hold_end');   // unfinished rep not counted
      this._setDone(this.clock());
      return true;
    }
    return false;
  }

  /** Apply elapsed time. At most one phase change per call (plus skipped
   *  zero-length phases); each new phase starts "now", so a late call never
   *  shortens what follows and nothing is caught up. */
  update() {
    const now = this.clock();
    if (!this.active || this.paused) { this._last = now; return; }
    if (now - this._last > GAP_LIMIT) { this._freeze(this._last, 'away'); return; }
    this._last = now;
    const d = this._duration();
    if (d !== null && now - this._t0 >= d) this._advance(now);
  }

  // ---- checkpoint -----------------------------------------------------
  snapshot() {
    return { phase: this.phase, set_no: this.setNo, rep_no: this.repNo, reps_done: this.repsDone,
      elapsed: this.elapsed };
  }

  /** Rebuild a paused run from a snapshot. Returns false if it is not valid
   *  for these settings (the caller then discards it). */
  restore(snap) {
    const ok = snap && typeof snap === 'object' && ACTIVE.includes(snap.phase)
      && [snap.set_no, snap.rep_no, snap.reps_done, snap.elapsed].every((n) => Number.isFinite(n) && n >= 0)
      && Number.isInteger(snap.set_no) && Number.isInteger(snap.rep_no) && Number.isInteger(snap.reps_done)
      && snap.set_no >= 1 && snap.set_no <= totalSets(this.s)
      && (!this.s.reps_enabled || snap.rep_no <= this.s.reps)
      && snap.reps_done <= snap.rep_no;
    if (!ok) return false;
    this._reset();
    this.phase = snap.phase;
    const d = this._duration();
    if (d !== null && snap.elapsed > d) return false;
    if (snap.phase === SET_REST && restSeconds(this.s) <= 0) return false;
    if (snap.phase === GET_READY && this.s.get_ready <= 0) return false;
    if (snap.phase === HOLD && snap.rep_no < 1) return false;
    this.setNo = snap.set_no; this.repNo = snap.rep_no; this.repsDone = snap.reps_done;
    this._frozen = snap.elapsed;
    this._last = this._t0 = this.clock();
    this.paused = true;
    this.pauseReason = 'away';
    return true;
  }

  // ---- transitions ----------------------------------------------------
  _freeze(at, reason) {
    this._frozen = Math.max(0, at - this._t0);
    this.paused = true;
    this.pauseReason = reason;
  }

  _advance(now) {
    if (this.phase === HOLD) this._finishRep(now);
    else if (this.phase === SET_REST) this._nextSet(now);
    else this._beginHold(now);   // GET_READY or REP_BREAK
  }

  _beginHold(now) {
    this.repNo += 1;
    this.phase = HOLD;
    this._t0 = now;
    this._events.push('hold_start');
  }

  _finishRep(now) {
    this._events.push('hold_end');
    this.repsDone = this.repNo;
    if (this.s.reps_enabled && this.repsDone >= this.s.reps) this._setDone(now);
    else if (this.s.rep_break > 0) { this.phase = REP_BREAK; this._t0 = now; }
    else this._beginHold(now);
  }

  _setDone(now) {
    if (this.setNo >= totalSets(this.s)) { this.phase = COMPLETE; this._events.push('complete'); }
    else if (restSeconds(this.s) > 0) { this.phase = SET_REST; this._t0 = now; }
    else this._nextSet(now);
  }

  _nextSet(now) {
    this.setNo += 1;
    this.repNo = this.repsDone = 0;
    this._beginHold(now);
  }

  // ---- what to show ---------------------------------------------------
  display() {
    const s = this.s, ph = this.phase, nSets = totalSets(s);
    const restLike = ph === SET_REST || ph === COMPLETE;
    let setText = '';
    if (s.sets_enabled) setText = restLike ? `SET ${this.setNo} of ${nSets} DONE` : `SET ${this.setNo} of ${nSets}`;
    let rep = 0;
    if (ph === HOLD) rep = this.repNo;
    else if (ph === REP_BREAK || restLike) rep = this.repsDone;
    let caption = '';
    if (ph === REP_BREAK || restLike) caption = rep ? `REP ${rep} COMPLETED` : 'SET ENDED';

    let timer, suffix = 's left';
    if (ph === COMPLETE) { timer = 'Exercise complete'; suffix = ''; }
    else if (ph === IDLE) { timer = '0'; suffix = s.hold_enabled ? `/ ${s.hold} s` : 's'; }
    else if (ph === HOLD) {
      suffix = s.hold_enabled ? `/ ${s.hold} s` : 's';
      const e = Math.floor(this.elapsed + 1e-9);
      timer = String(s.hold_enabled ? Math.min(e, s.hold) : e);
    } else timer = String(Math.ceil(this.remaining - 1e-9));

    const hint = !s.reps_enabled && (ph === HOLD || ph === REP_BREAK) ? 'End Set finishes this set' : '';
    let banner;
    if (ph === IDLE) banner = 'Tap Start';
    else if (ph === GET_READY) banner = 'REP 1 starts when this reaches 0';
    else if (ph === HOLD) banner = [s.hold_enabled ? '' : 'Tap Finish Rep when done', hint].filter(Boolean).join(' · ');
    else if (ph === REP_BREAK) banner = [`NEXT: REP ${rep + 1}`, hint].filter(Boolean).join(' · ');
    else if (ph === SET_REST) banner = `NEXT: SET ${this.setNo + 1}, REP 1`;
    else banner = 'Tap Start to run again';

    let key = ph, label = LABELS[ph];
    if (this.paused) {
      key = 'paused'; label = 'PAUSED';
      banner = this.pauseReason === 'away' ? 'Paused while away. Tap Resume.' : `${LABELS[ph]} paused. Tap Resume.`;
    }
    return {
      name: s.name, phaseKey: key, phaseLabel: label, setText, repText: String(rep),
      repTotalText: s.reps_enabled ? `of ${s.reps}` : '', repCaption: caption,
      timerText: timer, timerSuffix: suffix, banner,
    };
  }
}
