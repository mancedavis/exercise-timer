// Preset storage in the browser (localStorage), same data shape as the Windows
// presets.json. Storage is injected so tests can fail it on purpose.
import { DEFAULTS, parseSettings } from './engine.js';
import { FORMAT_VERSION, fold, parseStrict, presetsJson } from './transfer.js';

export const KEY = 'exercise-timer:v1';
export const CHECKPOINT_KEY = 'exercise-timer:checkpoint:v1';
export const DEMO_NAME = 'Demo (example)';
export const DEMO = parseSettings({ ...DEFAULTS, name: 'Demo exercise (example only)' });

export class StoreError extends Error {}

export class PresetStore {
  /** @param storage object with getItem/setItem/removeItem, or null if the browser has none */
  constructor(storage, now = () => Date.now()) {
    this.storage = storage;
    this.now = now;
    this.sound = true;
    this.last = null;
    this.presets = new Map();
    this.notice = '';        // shown to the user when stored data needed attention
    this.readOnly = false;   // data written by a newer app version: never overwritten
    this.available = !!storage;
    this.load();
  }

  load() {
    this.sound = true; this.last = null; this.presets = new Map(); this.notice = '';
    let text = null;
    if (!this.storage) {
      this.notice = 'This browser is not allowing saved data, so presets will be lost when you close the app. Use Export to keep a copy.';
    } else {
      try { text = this.storage.getItem(KEY); } catch {
        this.available = false;
        this.storage = null;   // unreadable is not the same as empty: never write over it
        this.notice = 'Saved data cannot be read in this browser, so presets will be lost when you close the app. Use Export to keep a copy.';
      }
    }
    if (text !== null) {
      let data = null;
      try { data = parseStrict(text); } catch { data = null; }
      if (!(data instanceof Map) || !(data.get('presets') instanceof Map)) this._setAside(text, 'Your saved presets could not be read.');
      else if (Number.isInteger(data.get('version')) && data.get('version') > FORMAT_VERSION) {
        this.readOnly = true;
        this.notice = 'Your saved presets were written by a newer version of Exercise Timer. They are shown read-only here; update the app to change them.';
        this._adopt(data);
      } else this._adopt(data, text);
    }
    if (this.presets.size === 0) this.presets.set(DEMO_NAME, DEMO);
    if (!this.presets.has(this.last)) this.last = this.presets.keys().next().value;
  }

  _adopt(data, rawText) {
    this.sound = data.get('sound') !== false;
    const last = data.get('last');
    this.last = typeof last === 'string' ? last : null;
    let dropped = 0;
    for (const [name, body] of data.get('presets')) {
      try {
        if (!(body instanceof Map) || !name.trim()) throw new Error('bad');
        const raw = Object.fromEntries(body);
        this.presets.set(name, parseSettings(raw));
      } catch { dropped += 1; }
    }
    if (dropped && rawText !== undefined) this._setAside(rawText, `${dropped} damaged preset(s) were skipped.`, true);
  }

  /** Keep a recoverable copy of data we could not fully use. */
  _setAside(text, message, keepCurrent = false) {
    const copyKey = `${KEY}:bad-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`;
    try {
      this.storage.setItem(copyKey, text);
      this.notice = `${message} A copy was kept in this app's storage (${copyKey}).`;
    } catch {
      this.notice = `${message} No copy could be made.`;
    }
    if (!keepCurrent) this.badKey = copyKey;
  }

  // ---- saving ------------------------------------------------------------
  save() {
    if (this.readOnly) throw new StoreError('Saved presets are from a newer app version and are read-only. Update the app first.');
    if (!this.storage) throw new StoreError('This browser is not allowing saved data. Your changes are kept until you close the app; use Export to keep a copy.');
    const body = presetsJson(this.presets, '  ');
    const prefs = `  "sound": ${JSON.stringify(this.sound)},\n  "last": ${JSON.stringify(this.last)},\n`;
    const wrapped = body.replace(/^(\{\n {2}"version": 1,\n)/, (head) => head + prefs);   // same order as Windows
    try { this.storage.setItem(KEY, wrapped); } catch (e) {
      throw new StoreError(`Could not save presets (${e && e.name ? e.name : 'storage error'}). Your changes are kept until you close the app; use Export to keep a copy.`);
    }
  }

  // ---- operations ----------------------------------------------------------
  names() { return [...this.presets.keys()]; }
  find(name) {
    const wanted = fold(name.trim());
    return this.names().find((n) => fold(n) === wanted) ?? null;
  }
  get(name) { return this.presets.get(name); }

  _replace(oldKey, newKey, settings) {
    const next = new Map();
    for (const [k, v] of this.presets) next.set(k === oldKey ? newKey : k, k === oldKey ? settings : v);
    if (!next.has(newKey)) next.set(newKey, settings);
    this.presets = next;
  }

  put(name, settings) {
    const clean = name.trim();
    this._replace(this.find(clean), clean, settings);
    this.last = clean;
    this.save();
  }

  rename(oldName, newName) {
    const clean = newName.trim();
    const clash = this.find(clean);
    const settings = this.presets.get(oldName);
    if (clash && clash !== oldName) this.presets.delete(clash);
    this._replace(oldName, clean, settings);
    this.last = clean;
    this.save();
  }

  delete(name) {
    this.presets.delete(name);
    if (this.last === name) this.last = this.presets.size ? this.presets.keys().next().value : null;
    this.save();
  }

  setSound(on) { this.sound = !!on; this.save(); }
  setLast(name) { if (this.presets.has(name) && this.last !== name) { this.last = name; this.save(); } }

  /** -> {added: [names], conflicts: [[incoming, existing], ...]} */
  planImport(entries) {
    const added = [], conflicts = [];
    for (const name of entries.keys()) {
      const existing = this.find(name);
      if (existing === null) added.push(name); else conflicts.push([name, existing]);
    }
    return { added, conflicts };
  }

  /** One operation. decisions: Map/obj incoming name -> 'replace' | 'skip'.
   *  Sound and last-selected are untouched. If the save fails the presets are
   *  exactly as before (memory and storage). Returns [added, replaced, skipped]. */
  applyImport(entries, decisions) {
    const before = this.presets;
    const merged = new Map(before);
    let added = 0, replaced = 0, skipped = 0;
    const decide = (n) => (decisions instanceof Map ? decisions.get(n) : decisions[n]);
    for (const [name, settings] of entries) {
      const existing = this.find(name);
      if (existing === null) { merged.set(name, settings); added += 1; }
      else if (decide(name) === 'replace') { merged.set(existing, settings); replaced += 1; }
      else skipped += 1;
    }
    this.presets = merged;
    try { this.save(); } catch (e) { this.presets = before; throw e; }
    return [added, replaced, skipped];
  }

  // ---- workout checkpoint (best effort, never throws) ----------------------
  saveCheckpoint(obj) {
    try { this.storage.setItem(CHECKPOINT_KEY, JSON.stringify(obj)); return true; } catch { return false; }
  }
  loadCheckpoint() {
    try { const t = this.storage.getItem(CHECKPOINT_KEY); return t ? JSON.parse(t) : null; } catch { return null; }
  }
  clearCheckpoint() { try { this.storage.removeItem(CHECKPOINT_KEY); } catch { /* ignore */ } }
}

/** localStorage if usable, else null (private modes, blocked storage). */
export function browserStorage() {
  try {
    const s = globalThis.localStorage;
    const probe = `${KEY}:probe`;
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch { return null; }
}
