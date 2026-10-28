// Renders docs/icons/*.png (needs Playwright's Chromium): node tools/make-icons.mjs
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'icons');
// full-bleed square (iOS rounds it itself); content kept inside the central 80% for maskable use
const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
<rect width="100" height="100" fill="#050505"/>
<circle cx="50" cy="50" r="34" fill="none" stroke="#39ff7a" stroke-width="5"/>
<text x="50" y="50" text-anchor="middle" dominant-baseline="central" dy="2" font-family="Arial, Helvetica, sans-serif" font-weight="800" font-size="52" fill="#ffffff">7</text>
<rect x="30" y="80" width="40" height="4" rx="2" fill="#ffd23f"/></svg>`;

const browser = await chromium.launch();
for (const [name, size] of [['icon-192', 192], ['icon-512', 512], ['maskable-512', 512], ['apple-touch-icon', 180]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0">${svg(size)}</body>`);
  await page.screenshot({ path: join(out, `${name}.png`) });
  await page.close();
}
await browser.close();
console.log('icons written to', out);
