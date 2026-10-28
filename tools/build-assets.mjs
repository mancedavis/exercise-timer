// Regenerates the BUILD id and precache list inside docs/sw.js from the files
// in docs/. Run after any change to docs/:  node tools/build-assets.mjs
// `--check` only verifies that sw.js is up to date (used by the tests).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDocs = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const SKIP = new Set(['sw.js', '.nojekyll']);

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** dir: the site folder (tests pass a temporary copy to build a "version 2"). */
export function generate(docs = defaultDocs) {
  const files = walk(docs).map((p) => relative(docs, p).split(sep).join('/')).filter((f) => !SKIP.has(f)).sort();
  const hash = createHash('sha256');
  for (const f of files) { hash.update(f); hash.update('\0'); hash.update(readFileSync(join(docs, f))); hash.update('\0'); }
  const build = hash.digest('hex').slice(0, 12);
  const assets = ['./', ...files.map((f) => `./${f}`)];
  const block = `// BEGIN GENERATED\nconst BUILD = '${build}';\nconst ASSETS = ${JSON.stringify(assets)};\n// END GENERATED`;
  const sw = readFileSync(join(docs, 'sw.js'), 'utf8');
  const next = sw.replace(/\/\/ BEGIN GENERATED[\s\S]*?\/\/ END GENERATED/, () => block);
  return { sw, next, build, assets };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { sw, next, build, assets } = generate();
  if (process.argv.includes('--check')) {
    if (sw !== next) { console.error('docs/sw.js is out of date; run: node tools/build-assets.mjs'); process.exit(1); }
    console.log(`sw.js is current (${build}, ${assets.length} files)`);
  } else {
    writeFileSync(join(defaultDocs, 'sw.js'), next);
    console.log(`sw.js updated: build ${build}, ${assets.length} precached entries`);
  }
}
