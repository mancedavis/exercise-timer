import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_NAME, PresetStore, StoreError } from '../../docs/js/store.js';
import { ImportFileError, exportFilename, exportText, parseImport, summary } from '../../docs/js/transfer.js';
import { FakeStorage, bytes, fixture, fixtureBytes, fixtureText } from './helpers.js';

const rejects = (data, fragment, label) => {
  assert.throws(() => parseImport(data), (e) => e instanceof ImportFileError && e.message.includes(fragment), label);
};

test('valid shared fixtures import, in file order', () => {
  for (const c of fixture('import_cases.json').valid) {
    const data = c.file ? fixtureBytes(c.file) : bytes(c.text);
    assert.deepEqual([...parseImport(data).keys()], c.names, c.name);
  }
});

test('every invalid shared fixture is rejected with the same message fragment as Windows', () => {
  const cases = fixture('import_cases.json').invalid;
  assert.ok(cases.length >= 30);
  for (const c of cases) rejects(bytes(c.text), c.error_contains, c.name);
});

test('binary, oversize, too many presets, deep nesting', () => {
  rejects(new Uint8Array([0xff, 0xfe, 0x00, 0x01]), 'not a valid JSON');
  rejects(new Uint8Array(256 * 1024 + 1).fill(120), 'too large');
  rejects(bytes('['.repeat(100000).slice(0, 200000)), 'not a valid JSON');
  const ok = JSON.parse(fixtureText('export_single.json')).presets['Open ended'];
  const many = { version: 1, presets: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`p${i}`, ok])) };
  rejects(bytes(JSON.stringify(many)), 'too many');
});

test('a UTF-8 BOM is accepted', () => {
  const body = fixtureBytes('export_all.json');
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
  assert.equal(parseImport(withBom).size, 4);
});

test('the Windows presets.json round-trips every field, flag and disabled value; export bytes match Windows', () => {
  const legacy = fixture('legacy_windows_presets.json');
  const parsed = parseImport(fixtureBytes('legacy_windows_presets.json'));
  for (const [name, s] of parsed) assert.deepEqual({ ...s }, legacy.presets[name], name);
  assert.deepEqual([...parsed.keys()], Object.keys(legacy.presets));
  assert.equal(parsed.get('Alpha hold').sets_enabled, false);
  assert.equal(parsed.get('Alpha hold').sets, 2);
  assert.equal(parsed.get('Manual stopwatch').hold_enabled, false);
  const text = exportText(parsed);
  assert.equal(text, fixtureText('export_all.json'));        // identical bytes to the Windows export
  assert.deepEqual([...parseImport(bytes(text))], [...parsed]);
});

test('export contains only version and presets', () => {
  const data = JSON.parse(exportText(parseImport(fixtureBytes('export_all.json'))));
  assert.deepEqual(Object.keys(data).sort(), ['presets', 'version']);
});

test('numeric-looking names keep their order in an export', () => {
  const ok = parseImport(fixtureBytes('export_single.json')).get('Open ended');
  const text = exportText(new Map([['b', ok], ['10', ok], ['2', ok]]));
  assert.deepEqual([...parseImport(bytes(text)).keys()], ['b', '10', '2']);
});

test('export filenames match the shared fixture', () => {
  for (const c of fixture('export_filenames.json')) assert.equal(exportFilename(c.name, c.today), c.expect);
});

test('summary wording', () => assert.equal(summary(3, 1, 2), '3 added, 1 replaced, 2 skipped'));

test('markup in names is stored verbatim as text and never interpreted', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const doc = JSON.parse(fixtureText('export_single.json'));
  doc.presets = { [evil]: { ...doc.presets['Open ended'], name: evil } };
  const parsed = parseImport(bytes(JSON.stringify(doc)));
  assert.equal([...parsed.keys()][0], evil);
  assert.equal(parsed.get(evil).name, evil);
  const proto = JSON.parse(fixtureText('export_single.json'));
  const body = proto.presets['Open ended'];
  const sneaky = `{"version":1,"presets":{"__proto__":${JSON.stringify(body)},"constructor":${JSON.stringify(body)}}}`;
  assert.deepEqual([...parseImport(bytes(sneaky)).keys()], ['__proto__', 'constructor']);
});

// ---- importing into a store ---------------------------------------------
function storeWithLegacy() {
  const storage = new FakeStorage();
  const store = new PresetStore(storage);
  store.presets = parseImport(fixtureBytes('legacy_windows_presets.json'));
  store.save();
  return { storage, store: new PresetStore(storage) };
}

test('conflict scenarios from the shared fixture', () => {
  const spec = fixture('conflict_scenarios.json');
  const entries = parseImport(fixtureBytes(spec.import_file));
  for (const c of spec.cases) {
    const { storage, store } = storeWithLegacy();
    const before = storage.data.get('exercise-timer:v1');
    const plan = store.planImport(entries);
    assert.deepEqual(plan.added, ['New One', 'Brand New 2'], c.name);
    assert.deepEqual(plan.conflicts.map((x) => x[0]), ['alpha hold', 'Open ended'], c.name);
    if (c.cancel) { assert.equal(storage.data.get('exercise-timer:v1'), before, c.name); continue; }
    const counts = store.applyImport(entries, new Map(Object.entries(c.decisions)));
    assert.equal(summary(...counts), c.summary, c.name);
    const reread = new PresetStore(storage);
    assert.deepEqual(store.names(), c.names, c.name);
    assert.deepEqual(reread.names(), c.names, c.name);
    assert.deepEqual(Object.fromEntries(reread.names().map((n) => [n, reread.get(n).name])), c.exercise_names, c.name);
  }
});

test('import never touches sound or last-selected', () => {
  const { storage, store } = storeWithLegacy();
  store.sound = true; store.last = DEMO_NAME; store.save();
  store.applyImport(parseImport(fixtureBytes('export_single.json')), { 'Open ended': 'skip' });
  const again = new PresetStore(storage);
  assert.equal(again.sound, true);
  assert.equal(again.last, DEMO_NAME);
});

test('a failed storage write during import leaves presets unchanged, in memory and in storage', () => {
  const { storage, store } = storeWithLegacy();
  const beforeData = storage.data.get('exercise-timer:v1');
  const beforeNames = store.names();
  storage.failWrites = true;
  assert.throws(() => store.applyImport(parseImport(fixtureBytes('import_overlap.json')), { 'alpha hold': 'replace', 'Open ended': 'replace' }),
    (e) => e instanceof StoreError && /Could not save/.test(e.message));
  assert.deepEqual(store.names(), beforeNames);
  assert.equal(store.get('Alpha hold').name, 'Alpha');
  assert.equal(storage.data.get('exercise-timer:v1'), beforeData);
});

test('import does not change a running engine (settings are immutable snapshots)', async () => {
  const { Engine } = await import('../../docs/js/engine.js');
  const { store } = storeWithLegacy();
  const e = new Engine(store.get('Open ended'), () => 0);
  e.start();
  const snap = e.s;
  store.applyImport(parseImport(fixtureBytes('import_overlap.json')), { 'Open ended': 'replace' });
  assert.equal(e.s, snap);
  assert.equal(e.s.name, 'Open set');
  assert.ok(Object.isFrozen(snap));
});
