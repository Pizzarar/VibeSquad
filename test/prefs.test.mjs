// @bor B1: app.vibe pref wiring and the standalone src/boring.css skin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { getPref, setPref, applyPrefsToDom } from '../src/prefs.ts';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('app.vibe defaults to fun and round-trips boring/fun', () => {
  assert.equal(getPref('app.vibe'), 'fun');
  assert.equal(setPref('app.vibe', 'boring'), true);
  assert.equal(getPref('app.vibe'), 'boring');
  assert.equal(setPref('app.vibe', 'fun'), true);
  assert.equal(getPref('app.vibe'), 'fun');
});

test('app.vibe rejects invalid values', () => {
  assert.equal(setPref('app.vibe', 'corporate'), false);
  assert.equal(getPref('app.vibe'), 'fun');
});

test('applyPrefsToDom sets documentElement.dataset.vibe', () => {
  const root = { dataset: {}, style: { setProperty() {} } };
  globalThis.document = { documentElement: root };
  try {
    applyPrefsToDom();
    assert.equal(root.dataset.vibe, 'fun');
    setPref('app.vibe', 'boring');
    applyPrefsToDom();
    assert.equal(root.dataset.vibe, 'boring');
  } finally {
    setPref('app.vibe', 'fun');
    delete globalThis.document;
  }
});

test('boring.css is imported after styles.css and every rule is scoped to html[data-vibe="boring"]', () => {
  assert.match(read('../src/main.tsx'), /import "\.\/styles\.css";\s*\nimport "\.\/boring\.css";/);
  const css = read('../src/boring.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = css
    .split('}')
    .map((b) => b.split('{')[0])
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  assert.ok(selectors.length > 20);
  for (const s of selectors) assert.ok(s.startsWith('html[data-vibe="boring"]'), `unscoped selector: ${s}`);
});

test('styles.css and art/ are untouched relative to master', () => {
  let diff = '';
  try {
    diff = execFileSync('git', ['diff', 'master', '--', 'src/styles.css', 'art/'], { encoding: 'utf8' });
  } catch {
    return; // no master ref available (shallow checkout): nothing to compare
  }
  assert.equal(diff, '');
});
