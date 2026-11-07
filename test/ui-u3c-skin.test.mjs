// U3c: the painted kit wiring in src/styles.css points at real assets, and the team-name chrome hook stays scoped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CHROME_FONT, chromeGlyphStyle } from '../src/chromeFont.ts';
import { kitPixel } from '../src/uiScale.ts';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const css = read('src/styles.css');

test('every --u3-* url() in styles.css exists under public/ui/u3 for both themes', () => {
  const urls = [...css.matchAll(/--u3-[\w-]+:\s*url\("(\/ui\/u3\/[^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(urls.length > 100);
  for (const u of urls) assert.ok(fs.existsSync(new URL(`../public${u}`, import.meta.url)), `missing ${u}`);
});

test('border-image rules in the U3c layer never stretch (repeat is explicit)', () => {
  const u3 = css.slice(css.indexOf('U3c: painted airbrush kit'));
  for (const m of u3.matchAll(/border-image:\s*([^;]+);/g)) {
    if (/^none\b/.test(m[1].trim())) continue;
    assert.match(m[1], /\brepeat\b/, `border-image without repeat: ${m[1]}`);
  }
});

test('team-name chrome hook: TeamNameEdit tags the name, the chrome skin is scoped to the team header h1', () => {
  assert.match(read('src/QuickWinsUi.tsx'), /className="team-name-chrome"/);
  assert.match(css, /\.team-header h1 \.team-name-chrome\s*\{/);
  assert.doesNotMatch(css.replace(/\.team-header h1 \.team-name-chrome/g, ''), /(^|[\s,])\.team-name-chrome\s*[{,]/m);
});

test('chromeFont.ts mirrors public/ui/u3/font-chrome-big.json and styles 2x glyph cells', () => {
  const j = JSON.parse(read('public/ui/u3/font-chrome-big.json'));
  assert.equal(Object.keys(CHROME_FONT.glyphs).length, Object.keys(j.glyphs).length);
  for (const [ch, g] of Object.entries(j.glyphs)) assert.deepEqual([...CHROME_FONT.glyphs[ch]], [g.x, g.y, g.w, g.h, g.advance], ch);
  const a = j.glyphs.A;
  const kit = (n) => `calc(var(--u3-px) * ${n})`;
  assert.deepEqual(chromeGlyphStyle('a'), { width: kit(a.w), height: kit(a.h), backgroundPosition: `${kit(-a.x)} ${kit(-a.y)}`, marginRight: kit(a.advance - a.w) });
  assert.deepEqual(chromeGlyphStyle('☃'), chromeGlyphStyle('?'));
});

test('TeamNameEdit keeps the real name as live text next to the aria-hidden glyph copy', () => {
  const src = read('src/QuickWinsUi.tsx');
  assert.match(src, /<span className="chrome-real">\{name\}<\/span>/);
  assert.match(src, /className="chrome-glyphs" aria-hidden="true"/);
});

test('kitPixel: a kit pixel is always a whole number of device px, near the nominal 2 CSS px', () => {
  for (const dpr of [1, 1.25, 1.5, 1.75, 2, 3]) {
    for (const zoom of [0.8, 1, 1.1, 1.15, 1.2, 1.25, 1.5, 1.75, 2]) {
      const { device, css } = kitPixel(dpr, zoom);
      assert.ok(Number.isInteger(device) && device >= 2, `${dpr}x${zoom}`);
      assert.ok(Math.abs(css * dpr * zoom - device) < 1e-9, `${dpr}x${zoom}`);
      assert.ok(Math.abs(css / 2 - 1) <= 0.26, `${dpr}x${zoom} css=${css}`);
    }
  }
  assert.deepEqual(kitPixel(1.25, 1.2), { device: 3, css: 2 });
  assert.equal(kitPixel(1, 1).device, 2);
});

test('U3 layer lengths come from --u3-px (no raw px background sizes or border-image widths left in the layer)', () => {
  const u3 = css.slice(css.indexOf('U3d: every kit length'));
  for (const m of u3.matchAll(/(background-size|border-image):\s*([^;]+);/g)) {
    const v = m[2].replace(/calc\(var\(--u3-px\) \* -?[\d.]+\)/g, '');
    assert.doesNotMatch(v, /\d+px/, `raw px in ${m[1]}: ${m[2]}`);
  }
});
