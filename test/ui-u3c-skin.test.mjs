// U3c: the painted kit wiring in src/styles.css points at real assets, and the team-name chrome hook stays scoped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CHROME_FONT, chromeGlyphStyle } from '../src/chromeFont.ts';

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
  assert.deepEqual(chromeGlyphStyle('a'), { width: a.w * 2, height: a.h * 2, backgroundPosition: `${-a.x * 2}px ${-a.y * 2}px`, marginRight: (a.advance - a.w) * 2 });
  assert.deepEqual(chromeGlyphStyle('☃'), chromeGlyphStyle('?'));
});

test('TeamNameEdit keeps the real name as live text next to the aria-hidden glyph copy', () => {
  const src = read('src/QuickWinsUi.tsx');
  assert.match(src, /<span className="chrome-real">\{name\}<\/span>/);
  assert.match(src, /className="chrome-glyphs" aria-hidden="true"/);
});
