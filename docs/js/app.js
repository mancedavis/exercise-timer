// Exercise Timer web app: screen, controls, presets, import/export, offline.
// All timing decisions live in engine.js; this file draws and wires things up.
import { COMPLETE, DEFAULTS, Engine, MAX_NAME, chars, parseSettings } from './engine.js';
import { PresetStore, StoreError, browserStorage } from './store.js';
import { MAX_BYTES, ImportFileError, exportFilename, exportText, parseImport, summary } from './transfer.js';
import { Sound, browserAudio } from './sound.js';

const TICK_MS = 50;
const CHECKPOINT_MS = 5000;
const $ = (id) => document.getElementById(id);
const FIELD_KEYS = ['name', 'sets_enabled', 'sets', 'reps_enabled', 'reps', 'hold_enabled', 'hold',
  'rep_break', 'rest_enabled', 'rest', 'get_ready'];
const TOGGLED = { sets: 'sets_enabled', reps: 'reps_enabled', hold: 'hold_enabled', rest: 'rest_enabled' };

export class App {
  constructor({ storage = browserStorage(), clock = () => performance.now() / 1000,
    audio = browserAudio(), wakeLock = globalThis.navigator?.wakeLock, now = () => Date.now() } = {}) {
    this.clock = clock;
    this.now = now;
    this.store = new PresetStore(storage, now);
    this.sound = new Sound(audio, this.store.sound);
    this.wakeApi = wakeLock;
    this.wakeSentinel = null;
    this.engine = null;
    this.preview = new Engine(parseSettings(DEFAULTS), clock);
    this.current = null;
    this.tickId = null;
    this.lastCheckpoint = 0;
    this.lastKey = '';
    this.drawn = '';
    this.notes = new Map();
    this.waitingWorker = null;
    this.updating = false;
    this._bind();
    this.selectPreset(this.store.last, false);
    this.restoreCheckpoint();
    this.render();
    this.syncControls();
    this.applyLock();
    if (this.store.notice) this.note('storage', this.store.notice, 'error');
    if (globalThis.navigator?.storage?.persist) globalThis.navigator.storage.persist().catch(() => {});
    this.registerWorker();
  }

  // ---------------------------------------------------------------- wiring
  _bind() {
    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
    on('startBtn', 'click', () => this.start());
    on('pauseBtn', 'click', () => this.pauseResume());
    on('stopBtn', 'click', () => this.stop());
    on('finishBtn', 'click', () => this.finishRep());
    on('endBtn', 'click', () => this.endSet());
    on('menuBtn', 'click', () => this.openSheet());
    on('closeSheet', 'click', () => this.closeSheet());
    on('presetSelect', 'change', () => this.selectPreset($('presetSelect').value));
    on('saveBtn', 'click', () => this.presetSave());
    on('saveAsBtn', 'click', () => this.presetSaveAs());
    on('renameBtn', 'click', () => this.presetRename());
    on('deleteBtn', 'click', () => this.presetDelete());
    on('importBtn', 'click', () => $('importFile').click());
    on('importFile', 'change', () => this.presetImport());
    on('exportBtn', 'click', () => this.presetExport());
    on('soundToggle', 'change', () => this.soundToggled());
    for (const k of FIELD_KEYS) {
      const el = $(`f_${k}`);
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => this.settingsChanged());
    }
    document.addEventListener('visibilitychange', () => (document.hidden ? this.away() : this.returned()));
    addEventListener('pagehide', () => this.away());
    document.addEventListener('freeze', () => this.away());
    addEventListener('resize', () => this.fit());
    addEventListener('orientationchange', () => setTimeout(() => this.fit(), 150));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sheet').hidden && $('modal').hidden) this.closeSheet(); });
  }

  // ---------------------------------------------------------------- form
  raw() {
    const o = {};
    for (const k of FIELD_KEYS) { const el = $(`f_${k}`); o[k] = el.type === 'checkbox' ? el.checked : el.value; }
    return o;
  }
  loadForm(s) {
    for (const k of FIELD_KEYS) { const el = $(`f_${k}`); if (el.type === 'checkbox') el.checked = s[k]; else el.value = String(s[k]); }
    $('formError').textContent = '';
  }
  get locked() { return !!this.engine && this.engine.phase !== COMPLETE; }

  applyLock() {
    const locked = this.locked;
    for (const k of FIELD_KEYS) {
      const el = $(`f_${k}`);
      const toggle = TOGGLED[k];
      el.disabled = locked || (toggle ? !$(`f_${toggle}`).checked : false);
    }
    for (const k of Object.values(TOGGLED)) $(`f_${k}`).disabled = locked;
    for (const id of ['presetSelect', 'saveBtn', 'saveAsBtn', 'renameBtn', 'deleteBtn', 'importBtn', 'exportBtn']) $(id).disabled = locked;
    $('lockNote').hidden = !locked;
    $('soundToggle').checked = this.sound.enabled;
  }

  settingsChanged() {
    if (this.locked) return;
    this.applyLock();
    try { this.preview = new Engine(parseSettings(this.raw()), this.clock); $('formError').textContent = ''; } catch { /* Start explains it */ }
    this.updateDirty();
    this.render();
    this.syncControls();
  }

  updateDirty() {
    let dirty = false;
    if (this.current && this.store.presets.has(this.current)) {
      try { dirty = JSON.stringify(parseSettings(this.raw())) !== JSON.stringify(this.store.get(this.current)); } catch { dirty = true; }
    }
    $('dirty').textContent = dirty ? '• unsaved changes' : '';
  }

  // ---------------------------------------------------------------- sheet / modal
  openSheet() { this.applyLock(); $('sheet').hidden = false; $('closeSheet').focus(); }
  closeSheet() { $('sheet').hidden = true; $('menuBtn').focus(); }

  /** Promise-based dialog. buttons: [{id,label,primary,cancel}]. Text is set with textContent only. */
  ask({ title, text = '', input = null, checkbox = null, buttons }) {
    return new Promise((resolve) => {
      $('modalTitle').textContent = title;
      $('modalText').textContent = text;
      const inp = $('modalInput');
      inp.hidden = input === null;
      if (input !== null) inp.value = input;
      $('modalCheckRow').hidden = checkbox === null;
      $('modalCheck').checked = false;
      $('modalCheckText').textContent = checkbox || '';
      const row = $('modalButtons');
      row.textContent = '';
      const done = (id) => { $('modal').hidden = true; resolve({ button: id, text: inp.value, checked: $('modalCheck').checked }); };
      const cancelId = (buttons.find((b) => b.cancel) || buttons[buttons.length - 1]).id;
      for (const b of buttons) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `btn small${b.primary ? ' primary' : ''}`;
        el.textContent = b.label;
        el.dataset.id = b.id;
        el.addEventListener('click', () => done(b.id));
        row.append(el);
      }
      $('modal').hidden = false;
      $('modal').onkeydown = (e) => {
        if (e.key === 'Escape') done(cancelId);
        if (e.key === 'Enter' && input !== null) { e.preventDefault(); done(buttons.find((b) => b.primary)?.id ?? cancelId); }
      };
      (input !== null ? inp : row.firstChild).focus();
    });
  }
  alert(title, text) { return this.ask({ title, text, buttons: [{ id: 'ok', label: 'OK', primary: true }] }); }

  // ---------------------------------------------------------------- notices
  note(key, text, kind = '', action = null) {
    let el = this.notes.get(key);
    if (!text) { if (el) { el.remove(); this.notes.delete(key); } return; }
    const sig = `${text}|${kind}|${action ? `${action.label}:${!!action.disabled}` : ''}`;
    if (el && el.dataset.sig === sig) return;   // unchanged: do not rebuild (keeps screen readers quiet)
    if (!el) { el = document.createElement('div'); this.notes.set(key, el); $('notices').append(el); }
    el.dataset.sig = sig;
    el.className = `note ${kind}`;
    el.textContent = text;
    if (action) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small'; b.textContent = action.label; b.disabled = !!action.disabled;
      b.addEventListener('click', action.run);
      el.append(b);
    }
  }

  // ---------------------------------------------------------------- drawing
  render() {
    const d = (this.engine || this.preview).display();
    const sig = JSON.stringify(d);
    const app = $('app');
    app.dataset.phase = d.phaseKey;
    if (sig === this.drawn) return;
    this.drawn = sig;
    $('exName').textContent = d.name;
    $('setText').textContent = d.setText;
    $('phase').textContent = d.phaseLabel;
    $('repNum').textContent = d.repText;
    $('repTotal').textContent = d.repTotalText;
    $('repCaption').textContent = d.repCaption;
    $('timerNum').textContent = d.timerText;
    $('timerSuffix').textContent = d.timerSuffix;
    $('banner').textContent = d.banner;
    document.title = `${d.phaseLabel} · Exercise Timer`;
    this.fit();
  }

  /** Shrink the big numbers until each row fits the screen width. */
  fit() {
    const root = document.documentElement.style;
    root.setProperty('--s', '1');
    for (const [row, prop] of [['repRow', '--rep-fit'], ['timerRow', '--timer-fit']]) {
      const el = $(row);
      root.setProperty(prop, '1');
      const avail = el.parentElement.clientWidth;
      // real content width: a centred flex row overflows on both sides, which scrollWidth under-reports
      const kids = [...el.children].filter((c) => c.textContent);
      const need = kids.reduce((w, c) => w + c.getBoundingClientRect().width, 0)
        + (parseFloat(getComputedStyle(el).columnGap) || 0) * Math.max(0, kids.length - 1);
      if (avail > 0 && need > avail) root.setProperty(prop, String(Math.max(0.2, (avail / need) * 0.97)));
    }
    // then shrink the whole stack until it fits the height left over by the controls
    const box = $('display');
    let s = 1;
    while (box.scrollHeight > box.clientHeight + 1 && s > 0.3) { s *= 0.94; root.setProperty('--s', s.toFixed(3)); }
  }

  syncControls() {
    const e = this.engine;
    const s = e ? e.s : this.preview.s;
    const active = !!(e && e.active);
    $('startBtn').disabled = active;
    $('pauseBtn').disabled = !active;
    $('pauseBtn').textContent = active && e.paused ? 'Resume' : 'Pause';
    $('stopBtn').disabled = !e;
    $('finishBtn').hidden = s.hold_enabled;
    $('endBtn').hidden = s.reps_enabled;
    $('finishBtn').disabled = !(e && e.canFinishRep);
    $('endBtn').disabled = !(e && e.canEndSet);
    this.updateUpdateNote();
  }

  // ---------------------------------------------------------------- run control
  start() {
    if (this.engine && this.engine.active) return;
    let s;
    try { s = parseSettings(this.raw()); } catch (err) {
      $('formError').textContent = err.message;
      this.openSheet();
      return;
    }
    $('formError').textContent = '';
    this.sound.unlock();   // must happen inside this tap
    this.sound.cancel();
    this.engine = new Engine(s, this.clock);
    this.engine.start();
    this.note('restore', '');
    this.lastKey = '';
    this.saveCheckpoint(true);
    this.applyLock();
    this.requestWake();
    this.tick();
  }

  pauseResume() {
    const e = this.engine;
    if (!e || !e.active) return;
    if (e.paused) {
      this.sound.unlock();
      e.resume();
      this.note('restore', '');
      this.requestWake();
      this.tick();
    } else {
      e.pause('user');
      this.tick();
    }
  }

  finishRep() { if (this.engine && this.engine.finishRep()) this.tick(); }
  endSet() { if (this.engine && this.engine.endSet()) this.tick(); }

  stop() {
    this.cancelTick();
    this.sound.cancel();
    this.releaseWake();
    this.store.clearCheckpoint();
    this.note('restore', '');
    this.engine = null;
    this.lastKey = '';
    this.applyLock();
    this.settingsChanged();
  }

  cancelTick() { if (this.tickId !== null) { clearTimeout(this.tickId); this.tickId = null; } }

  tick() {
    this.cancelTick();   // never two loops at once
    const e = this.engine;
    if (!e) return;
    e.update();
    this.playEvents(e.popEvents());
    this.render();
    this.syncControls();
    if (e.phase === COMPLETE) {
      this.releaseWake();   // the completion cue is allowed to finish, so no sound.cancel() here
      this.store.clearCheckpoint();
      this.applyLock();
    } else if (e.paused) {
      this.sound.cancel();
      this.releaseWake();
      this.saveCheckpoint(true);
    } else if (e.active) {
      this.saveCheckpoint(false);
      this.tickId = setTimeout(() => this.tick(), TICK_MS);
    }
  }

  playEvents(events) {
    for (const cue of ['complete', 'hold_start', 'hold_end']) {   // one cue per tick
      if (events.includes(cue)) { this.sound.play(cue); return; }
    }
  }

  // ---------------------------------------------------------------- interruptions
  away() {
    const e = this.engine;
    if (!e || !e.active) return;
    if (!e.paused) {
      e.pause('away');
      this.tick();
    } else this.saveCheckpoint(true);
  }
  returned() {
    this.render();
    this.syncControls();
    if (this.registration) this.registration.update().catch(() => {});
  }

  /** Lightweight progress checkpoint: at phase changes and every few seconds. */
  saveCheckpoint(force) {
    const e = this.engine;
    if (!e || !e.active) return;
    const key = `${e.phase}|${e.setNo}|${e.repNo}|${e.paused}`;
    const t = this.clock();
    if (!force && key === this.lastKey && (t - this.lastCheckpoint) * 1000 < CHECKPOINT_MS) return;   // clock is in seconds
    this.lastKey = key;
    this.lastCheckpoint = t;
    this.store.saveCheckpoint({ v: 1, saved: this.now(), settings: e.s, snap: e.snapshot() });
  }

  restoreCheckpoint() {
    const cp = this.store.loadCheckpoint();
    if (!cp) return;
    try {
      if (cp.v !== 1) throw new Error('version');
      const engine = new Engine(parseSettings(cp.settings), this.clock);
      if (!engine.restore(cp.snap)) throw new Error('invalid');
      this.engine = engine;
      this.note('restore', 'Restored your exercise from when the app closed. It is paused; your place may be up to 5 seconds behind. Tap Resume to continue or Stop / Reset to discard.');
    } catch {
      this.store.clearCheckpoint();
    }
  }

  async requestWake() {
    this.wakeWanted = true;
    if (!this.wakeApi || !this.wakeApi.request) {
      this.note('wake', "This device can't keep the screen awake from here. For longer exercises set Auto-Lock to Never (Settings > Display & Brightness) while you exercise.");
      return;
    }
    if (this.wakeSentinel || this.wakePending) return;   // one request at a time
    this.wakePending = true;
    try {
      const sentinel = await this.wakeApi.request('screen');
      if (!this.wakeWanted) {   // stopped, paused or hidden while the request was still pending
        try { await sentinel.release(); } catch { /* already gone */ }
        return;
      }
      this.wakeSentinel = sentinel;
      sentinel.addEventListener?.('release', () => { if (this.wakeSentinel === sentinel) this.wakeSentinel = null; });
      this.note('wake', '');
    } catch {
      if (this.wakeWanted) this.note('wake', "The device didn't allow keeping the screen awake. If it dims or locks, set Auto-Lock to Never (Settings > Display & Brightness) while you exercise.");
    } finally {
      this.wakePending = false;
    }
  }
  releaseWake() {
    this.wakeWanted = false;
    this.note('wake', '');
    const s = this.wakeSentinel;
    this.wakeSentinel = null;
    if (s && s.release) { try { Promise.resolve(s.release()).catch(() => {}); } catch { /* ignore */ } }
  }

  // ---------------------------------------------------------------- presets
  fillSelect() {
    const sel = $('presetSelect');
    sel.textContent = '';
    for (const n of this.store.names()) {
      const o = document.createElement('option');
      o.value = n; o.textContent = n;
      sel.append(o);
    }
    sel.value = this.current && this.store.presets.has(this.current) ? this.current : '';
  }

  selectPreset(name, save = true) {
    this.current = name && this.store.presets.has(name) ? name : null;
    if (this.current) {
      this.loadForm(this.store.get(this.current));
      if (save) this.trySave(() => this.store.setLast(this.current));
    }
    this.fillSelect();
    if (!this.locked) this.settingsChanged();
  }

  async trySave(fn) {
    try { fn(); return true; } catch (e) {
      if (e instanceof StoreError) { await this.alert('Could not save', e.message); return false; }
      throw e;
    }
  }

  parseOrComplain() {
    try { return parseSettings(this.raw()); } catch (e) { $('formError').textContent = e.message; return null; }
  }

  async askName(title, initial) {
    const r = await this.ask({ title, input: initial, buttons: [{ id: 'ok', label: 'OK', primary: true }, { id: 'cancel', label: 'Cancel', cancel: true }] });
    if (r.button !== 'ok') return null;
    const name = r.text.trim();
    if (!name) return null;
    if (chars(name) > MAX_NAME) { $('formError').textContent = `Preset names can be up to ${MAX_NAME} characters.`; return null; }
    return name;
  }
  async confirmReplace(name) {
    const r = await this.ask({ title: 'Replace preset?', text: `A preset named "${name}" already exists. Replace it?`,
      buttons: [{ id: 'yes', label: 'Replace', primary: true }, { id: 'no', label: 'Cancel', cancel: true }] });
    return r.button === 'yes';
  }

  async presetSave() {
    const s = this.parseOrComplain();
    if (!s) return;
    if (!this.current) return this.presetSaveAs();
    await this.trySave(() => this.store.put(this.current, s));
    this.selectPreset(this.current, false);
  }
  async presetSaveAs() {
    const s = this.parseOrComplain();
    if (!s) return;
    const name = await this.askName('Name for the new preset:', s.name);
    if (!name) return;
    const clash = this.store.find(name);
    if (clash && !(await this.confirmReplace(clash))) return;
    await this.trySave(() => this.store.put(name, s));
    this.selectPreset(name, false);
  }
  async presetRename() {
    if (!this.current) return;
    const name = await this.askName('New name for this preset:', this.current);
    if (!name || name === this.current) return;
    const clash = this.store.find(name);
    if (clash && clash !== this.current && !(await this.confirmReplace(clash))) return;
    await this.trySave(() => this.store.rename(this.current, name));
    this.selectPreset(name, false);
  }
  async presetDelete() {
    if (!this.current) return;
    const r = await this.ask({ title: 'Delete preset?', text: `Delete "${this.current}"?`,
      buttons: [{ id: 'yes', label: 'Delete', primary: true }, { id: 'no', label: 'Cancel', cancel: true }] });
    if (r.button !== 'yes') return;
    await this.trySave(() => this.store.delete(this.current));
    this.selectPreset(this.store.last, false);
  }

  async soundToggled() {
    this.sound.enabled = $('soundToggle').checked;
    if (this.sound.enabled) this.sound.unlock(); else this.sound.cancel();
    await this.trySave(() => this.store.setSound(this.sound.enabled));
  }

  // ---------------------------------------------------------------- import / export
  async presetImport() {
    const input = $('importFile');
    const file = input.files && input.files[0];
    input.value = '';   // allow choosing the same file again
    if (!file) return;
    const wasDirty = $('dirty').textContent !== '';
    let entries;
    try {
      if (file.size > MAX_BYTES) throw new ImportFileError('That file is too large to be a preset file (limit 256 KB).');
      entries = parseImport(new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      if (e instanceof ImportFileError) { await this.alert('Could not import', `${e.message}\n\nNothing was changed.`); return; }
      await this.alert('Could not import', 'The file could not be read. Nothing was changed.');
      return;
    }
    const { conflicts } = this.store.planImport(entries);
    const decisions = new Map();
    let remembered = null;
    for (let i = 0; i < conflicts.length; i++) {
      const [incoming, existing] = conflicts[i];
      let choice = remembered;
      if (!choice) {
        const more = conflicts.length - i - 1;
        const r = await this.ask({ title: 'Preset already exists', text: `A preset named "${existing}" already exists. Replace it with the imported one?`,
          checkbox: more ? `Do this for the other ${more} too` : null,
          buttons: [{ id: 'replace', label: 'Replace', primary: true }, { id: 'skip', label: 'Skip' }, { id: 'cancel', label: 'Cancel import', cancel: true }] });
        choice = r.button;
        if (r.checked && choice !== 'cancel') remembered = choice;
      }
      if (choice === 'cancel') { await this.alert('Import cancelled', 'Nothing was changed.'); return; }
      decisions.set(incoming, choice);
    }
    let counts;
    try { counts = this.store.applyImport(entries, decisions); } catch (e) {
      if (e instanceof StoreError) { await this.alert('Could not import', `${e.message}\n\nYour presets were not changed.`); return; }
      throw e;
    }
    this.fillSelect();
    if (!wasDirty && this.current && this.store.presets.has(this.current)) this.loadForm(this.store.get(this.current));   // the selected preset may have just been replaced
    this.settingsChanged();
    await this.alert('Import complete', `${summary(...counts)}.`);
  }

  async presetExport() {
    const names = this.store.names();
    if (!names.length) return;
    let only = null;
    if (this.current && this.store.presets.has(this.current) && names.length > 1) {
      const r = await this.ask({ title: 'Export presets', text: `Export all ${names.length} presets, or just "${this.current}"?`,
        buttons: [{ id: 'all', label: 'All presets', primary: true }, { id: 'one', label: 'Only this one' }, { id: 'cancel', label: 'Cancel', cancel: true }] });
      if (r.button === 'cancel') return;
      if (r.button === 'one') only = this.current;
    }
    const chosen = new Map(only ? [[only, this.store.get(only)]] : names.map((n) => [n, this.store.get(n)]));
    const d = new Date(this.now());
    const today = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const outcome = await exportFile(exportText(chosen), exportFilename(only, today));
    if (outcome === 'cancelled') this.note('export', 'Export cancelled.');
    else if (outcome === 'shared') this.note('export', 'Export shared.');
    else this.note('export', 'Export saved as a download. Look in Files > Downloads (or your browser downloads).');
    setTimeout(() => this.note('export', ''), 6000);
  }

  // ---------------------------------------------------------------- offline / updates
  async registerWorker() {
    const chip = $('statusChip');
    if (!('serviceWorker' in navigator)) { chip.textContent = 'Offline not available'; return; }
    try {
      this.registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    } catch {
      chip.textContent = 'Offline not available';
      return;
    }
    const reg = this.registration;
    if (!reg) { chip.textContent = 'Offline not available'; return; }
    chip.textContent = 'Setting up offline…';
    // An "update" is a worker that finishes installing while a DIFFERENT worker is already active.
    // (On the very first visit the only worker installs and takes over: that is not an update.)
    const watch = (worker) => worker && worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && reg.active && reg.active !== worker) { this.waitingWorker = reg.waiting || worker; this.updateUpdateNote(); }
    });
    if (reg.waiting && reg.active && reg.active !== reg.waiting) this.waitingWorker = reg.waiting;
    reg.addEventListener('updatefound', () => watch(reg.installing));
    watch(reg.installing);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (this.updating && !(this.engine && this.engine.active)) location.reload();
    });
    this.updateUpdateNote();
    const markReady = async () => {
      if (!(await this.offlineReady())) return false;
      chip.textContent = 'Offline ready'; chip.className = 'chip ok'; this.updateUpdateNote();
      return true;
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      if (await markReady()) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    chip.textContent = 'Offline setup incomplete (check connection)';
    navigator.serviceWorker.ready.then(markReady).catch(() => {});   // a slow install can still finish later
  }

  /** True only when the worker confirms every required file is in its cache. */
  async offlineReady() {
    try {
      // `ready` never settles if the worker failed to install, so do not wait for it forever
      const ready = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 4000))]);
      const worker = ready && ready.active;
      if (!worker) return false;
      return await new Promise((resolve) => {
        const ch = new MessageChannel();
        const timer = setTimeout(() => resolve(false), 3000);
        ch.port1.onmessage = (ev) => { clearTimeout(timer); resolve(!!(ev.data && ev.data.ready)); };
        worker.postMessage({ type: 'STATUS' }, [ch.port2]);
      });
    } catch { return false; }
  }

  updateUpdateNote() {
    if (!this.waitingWorker) { this.note('update', ''); return; }
    const idle = !(this.engine && this.engine.active);
    this.note('update', idle ? 'A new version is ready.' : 'A new version is ready. You can update when this exercise is finished.', '',
      { label: 'Update now', disabled: !idle, run: () => this.applyUpdate() });
  }
  applyUpdate() {
    if ((this.engine && this.engine.active) || !this.waitingWorker) return;   // never reload mid-exercise
    this.updating = true;
    this.waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  }
}

/** Share sheet when files can be shared, else a normal download. */
export async function exportFile(text, filename) {
  const file = new File([text], filename, { type: 'application/json' });
  const nav = globalThis.navigator;
  if (nav && nav.canShare && nav.share && nav.canShare({ files: [file] })) {
    try { await nav.share({ files: [file], title: 'Exercise Timer presets' }); return 'shared'; } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';   // user closed the share sheet
      // anything else: fall back to a download
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return 'downloaded';
}

if (typeof document !== 'undefined' && document.getElementById('app')) {
  globalThis.exerciseTimer = new App();
}
