// Preset interchange files (version 1), shared with the Windows app
// (exercise_timer/transfer.py). Same shape as the Windows presets.json:
//   {"version": 1, "presets": {"<preset name>": {<11 settings fields>}}}
// Extra top-level keys (sound, last, ...) are ignored on import.
// Everything here validates BEFORE anything is changed; imported names are
// plain strings and are only ever drawn with textContent.
import { MAX_COUNT, MAX_NAME, MAX_SECONDS, chars, parseSettings } from './engine.js';

export const FORMAT_VERSION = 1;
export const MAX_BYTES = 256 * 1024;
export const MAX_PRESETS = 500;

export class ImportFileError extends Error {}

// key, label, min, max (null = boolean)
const FIELDS = [
  ['sets_enabled', 'Sets on/off', null, null], ['sets', 'Sets', 1, MAX_COUNT],
  ['reps_enabled', 'Reps on/off', null, null], ['reps', 'Reps per set', 1, MAX_COUNT],
  ['hold_enabled', 'Hold on/off', null, null], ['hold', 'Hold seconds', 1, MAX_SECONDS],
  ['rep_break', 'Rep break', 0, MAX_SECONDS],
  ['rest_enabled', 'Set rest on/off', null, null], ['rest', 'Set rest', 0, MAX_SECONDS],
  ['get_ready', 'Get-ready', 0, MAX_SECONDS],
];

/** Case-insensitive comparison key for preset names (same rule as Windows). */
export const fold = (name) => name.normalize('NFC').toLowerCase();

// ---- strict JSON ------------------------------------------------------
// JSON.parse silently keeps the last of two equal keys and cannot tell 4 from
// 4.0, so imports use this small parser: objects become Maps, duplicate keys
// are an error, and numbers with a fraction/exponent are marked as floats.
class Float { constructor(v) { this.value = v; } }
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
const BAD_JSON = 'That is not a valid JSON preset file.';

export function parseStrict(text) {
  let i = 0;
  const fail = () => { throw new ImportFileError(BAD_JSON); };
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const str = () => {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) fail();
    i++;
    try { return JSON.parse(text.slice(start, i)); } catch { return fail(); }
  };
  const value = (depth) => {
    if (depth > 100) fail();
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws();
      const map = new Map();
      if (text[i] === '}') { i++; return map; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        const key = str();
        if (map.has(key)) throw new ImportFileError(`The file lists "${key}" more than once.`);
        ws();
        if (text[i++] !== ':') fail();
        map.set(key, value(depth + 1));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i++] === '}') return map;
        fail();
      }
    }
    if (c === '[') {
      i++; ws();
      const arr = [];
      if (text[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i++] === ']') return arr;
        fail();
      }
    }
    if (c === '"') return str();
    for (const [word, v] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, i)) { i += word.length; return v; }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) fail();
    i += m[0].length;
    return m[1] || m[2] ? new Float(Number(m[0])) : Number(m[0]);
  };
  const result = value(0);
  ws();
  if (i !== text.length) fail();
  return result;
}

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

function checkPreset(name, raw) {
  const where = `Preset "${name}"`;
  if (!(raw instanceof Map)) throw new ImportFileError(`${where} is not a set of settings.`);
  const ex = raw.get('name');
  if (typeof ex !== 'string' || !ex.trim() || ex !== ex.trim() || chars(ex) > MAX_NAME) {
    throw new ImportFileError(`${where} has an invalid exercise name.`);
  }
  const out = { name: ex };
  for (const [key, label, lo, hi] of FIELDS) {
    const v = raw.get(key);
    if (lo === null) {
      if (typeof v !== 'boolean') throw new ImportFileError(`${where}: ${label} must be true or false.`);
    } else if (!isInt(v) || v < lo || v > hi) {
      throw new ImportFileError(`${where}: ${label} must be a whole number, ${lo} to ${hi}.`);
    }
    out[key] = v;
  }
  return parseSettings(out);   // normalised, frozen, key order matches Windows
}

/** bytes (Uint8Array) -> Map(name -> settings). Throws ImportFileError. */
export function parseImport(bytes) {
  if (bytes.byteLength > MAX_BYTES) {
    throw new ImportFileError('That file is too large to be a preset file (limit 256 KB).');
  }
  let data;
  try {
    data = parseStrict(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (e) {
    if (e instanceof ImportFileError) throw e;
    throw new ImportFileError(BAD_JSON);
  }
  if (!(data instanceof Map) || !(data.get('presets') instanceof Map)) {
    throw new ImportFileError('That file does not contain Exercise Timer presets.');
  }
  const version = data.get('version');
  if (!isInt(version)) throw new ImportFileError('That file has no format version, so it cannot be imported.');
  if (version !== FORMAT_VERSION) {
    throw new ImportFileError(`That file uses format version ${version}; this app reads version ${FORMAT_VERSION}.`
      + (version > 1 ? ' Update the app and try again.' : ''));
  }
  const presets = data.get('presets');
  if (presets.size === 0) throw new ImportFileError('That file contains no presets.');
  if (presets.size > MAX_PRESETS) throw new ImportFileError(`That file has too many presets (limit ${MAX_PRESETS}).`);
  const result = new Map();
  const folded = new Set();
  for (const [name, body] of presets) {
    if (!name.trim() || name !== name.trim() || chars(name) > MAX_NAME) {
      throw new ImportFileError('The file has a preset with a blank or over-long name.');
    }
    const key = fold(name);
    if (folded.has(key)) throw new ImportFileError(`The file lists "${name}" more than once (names ignore case).`);
    folded.add(key);
    result.set(name, checkPreset(name, body));
  }
  return result;
}

/** presets: Map(name -> settings). Written by hand so key order is preserved
 *  (plain objects reorder numeric-looking names). */
export function presetsJson(presets, indent = '  ') {
  const items = [...presets].map(([n, s]) => {
    const body = Object.entries(s).map(([k, v]) => `${indent}${indent}${indent}${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    return `${indent}${indent}${JSON.stringify(n)}: {\n${body.join(',\n')}\n${indent}${indent}}`;
  });
  return `{\n${indent}"version": ${FORMAT_VERSION},\n${indent}"presets": {\n${items.join(',\n')}\n${indent}}\n}\n`;
}
export const exportText = (presets) => presetsJson(presets);

export function exportFilename(name = null, today = '19700101') {
  if (name === null) return `exercise-timer-presets-${today}.json`;
  const safe = name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'preset';
  return `exercise-timer-${safe}.json`;
}

export const summary = (added, replaced, skipped) => `${added} added, ${replaced} replaced, ${skipped} skipped`;
