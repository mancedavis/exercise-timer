import { cpSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, webkit } from 'playwright';
import { generate } from '../../tools/build-assets.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DOCS = join(ROOT, 'docs');
export const PREFIX = '/exercise-timer/';
export { devices };
export const engines = { webkit, chromium };

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

/** Serves a folder ONLY under /exercise-timer/ (like GitHub Pages project sites);
 *  anything outside the prefix is a 404, so root-absolute URLs show up as failures. */
export async function startServer(root = DOCS) {
  const state = { root, log: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let status = 404, body = 'not found', type = 'text/plain';
    if (url.pathname.startsWith(PREFIX)) {
      let rel = decodeURIComponent(url.pathname.slice(PREFIX.length));
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      const file = normalize(join(state.root, rel));
      if (file.startsWith(normalize(state.root))) {
        try {
          if (statSync(file).isFile()) { body = readFileSync(file); status = 200; type = TYPES[extname(file)] || 'application/octet-stream'; }
        } catch { /* 404 */ }
      }
    }
    state.log.push({ path: url.pathname, status });
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, url: origin + PREFIX, state, setRoot: (r) => { state.root = r; }, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}

/** A copy of docs/ with a changed file and a regenerated sw.js: "version 2" of the site. */
export function makeVersion2() {
  const dir = mkdtempSync(join(tmpdir(), 'et-v2-'));
  cpSync(DOCS, dir, { recursive: true });
  const css = join(dir, 'styles.css');
  writeFileSync(css, `${readFileSync(css, 'utf8')}\n/* version 2 */\n#exName { text-transform: uppercase; }\n`);
  writeFileSync(join(dir, 'sw.js'), generate(dir).next);
  return dir;
}

export const launch = (name) => engines[name].launch();

/** Fresh context. opts.device: a Playwright device name (WebKit). */
export async function newContext(browser, { device, viewport, ...rest } = {}) {
  const base = device ? devices[device] : { viewport: viewport || { width: 393, height: 852 } };
  return browser.newContext({ ...base, ...rest });
}

export const text = (page, id) => page.locator(`#${id}`).innerText();
export async function openSheet(page) { await page.click('#menuBtn'); }
export async function closeSheet(page) { await page.click('#closeSheet'); }

/** Fill the settings sheet (values: strings/booleans keyed like f_<key>) and close it. */
export async function setSettings(page, values) {
  await openSheet(page);
  for (const [k, v] of Object.entries(values)) {
    const el = page.locator(`#f_${k}`);
    if (typeof v === 'boolean') { if ((await el.isChecked()) !== v) await el.click(); } else await el.fill(String(v));
  }
  await closeSheet(page);
}

export const fixturePath = (n) => join(ROOT, 'fixtures', n);
