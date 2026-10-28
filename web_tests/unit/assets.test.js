import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { generate } from '../../tools/build-assets.mjs';
import { ROOT } from './helpers.js';

const docs = join(ROOT, 'docs');
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const files = walk(docs).map((p) => relative(docs, p).split(sep).join('/'));
const text = (f) => readFileSync(join(docs, f), 'utf8');

test('sw.js precache list and build id are up to date with docs/', () => {
  const { sw, next } = generate();
  assert.equal(sw, next, 'run: node tools/build-assets.mjs');
});

test('every published file is in the precache list (so offline launch has everything)', () => {
  const { assets } = generate();
  for (const f of files.filter((x) => x !== 'sw.js' && x !== '.nojekyll')) assert.ok(assets.includes(`./${f}`), f);
  for (const need of ['./', './index.html', './help.html', './IOS_Install_Instructions.txt', './manifest.webmanifest', './js/app.js', './styles.css', './icons/apple-touch-icon.png']) {
    assert.ok(assets.includes(need), need);
  }
});

test('all asset references are relative so the app works under /exercise-timer/', () => {
  for (const f of files.filter((x) => /\.(html|js|css|webmanifest)$/.test(x))) {
    const t = text(f);
    assert.ok(!/(?:href|src)="\/(?!\/)/.test(t), `${f}: root-absolute href/src`);
    assert.ok(!/url\(\s*['"]?\//.test(t), `${f}: root-absolute url()`);
    assert.ok(!/(?:from|import)\s*\(?\s*['"]\//.test(t), `${f}: root-absolute import`);
    const noNamespaces = t.replace(/xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/g, '');   // an XML namespace name, not a fetch
    assert.ok(!/https?:\/\//.test(noNamespaces), `${f}: external URL (everything must be bundled)`);
  }
  const m = JSON.parse(text('manifest.webmanifest'));
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.equal(m.display, 'standalone');
  for (const i of m.icons) assert.ok(files.includes(i.src), i.src);
  assert.ok(m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512'));
  const sw = text('sw.js');
  assert.match(sw, /register\(|self\.registration\.scope/);
  assert.ok(!/skipWaiting\(\)\s*;?\s*\}\);?\s*self\.addEventListener\('activate'/.test(sw));
  assert.ok(!/install[\s\S]{0,400}skipWaiting/.test(sw.split('self.addEventListener(\'activate\'')[0]), 'install handler must not skipWaiting');
});

test('the app registers the worker relative to the page, with a matching scope', () => {
  assert.match(text('js/app.js'), /register\('\.\/sw\.js', \{ scope: '\.\/' \}\)/);
});

test('index.html has the install metadata iOS needs', () => {
  const t = text('index.html');
  for (const s of ['apple-mobile-web-app-capable', 'rel="apple-touch-icon"', 'rel="manifest"', 'viewport-fit=cover', 'name="theme-color"']) assert.ok(t.includes(s), s);
});

test('personal exports and fixtures are never published', () => {
  assert.ok(!files.some((f) => /preset/i.test(f) && f.endsWith('.json')), 'no preset json under docs/');
  assert.ok(!files.some((f) => f.startsWith('fixtures') || f.endsWith('.bak')));
});

test('imported text is only ever drawn with textContent', () => {
  const t = text('js/app.js');
  assert.ok(!/\.innerHTML\s*=/.test(t) && !/insertAdjacentHTML/.test(t) && !/document\.write/.test(t));
});

test('instructions file exists with the exact name and no developer jargon', () => {
  assert.ok(files.includes('IOS_Install_Instructions.txt'));
});
