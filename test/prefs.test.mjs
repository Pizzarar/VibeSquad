// @bor B1: app.vibe pref wiring and the standalone src/boring.css skin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getPref, setPref, applyPrefsToDom, PREF_DEFS, migrateVibeToNormalOnce, consumeVibeMigratedToast, VIBE_MIGRATED_NORMAL_KEY, PREFS_KEY, searchSettings, visiblePrefDefs } from '../src/prefs.ts';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('app.vibe defaults to boring and round-trips fun/boring', () => {
  assert.equal(getPref('app.vibe'), 'boring');
  assert.equal(setPref('app.vibe', 'fun'), true);
  assert.equal(getPref('app.vibe'), 'fun');
  assert.equal(setPref('app.vibe', 'boring'), true);
  assert.equal(getPref('app.vibe'), 'boring');
});

const memStore = (init = {}) => { const m = { ...init }; return { m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; };

test('migrateVibeToNormalOnce: fun -> boring once, then a deliberate fun stays', () => {
  const s = memStore({ [PREFS_KEY]: JSON.stringify({ 'app.vibe': 'fun', 'app.theme': 'dark' }) });
  migrateVibeToNormalOnce(s);
  assert.deepEqual(JSON.parse(s.m[PREFS_KEY]), { 'app.vibe': 'boring', 'app.theme': 'dark' });
  assert.equal(s.m[VIBE_MIGRATED_NORMAL_KEY], '1');
  s.m[PREFS_KEY] = JSON.stringify({ 'app.vibe': 'fun' }); // user turned Legacy: Psycho mode on afterwards
  migrateVibeToNormalOnce(s);
  assert.equal(JSON.parse(s.m[PREFS_KEY])['app.vibe'], 'fun');
  const fresh = memStore();
  migrateVibeToNormalOnce(fresh);
  assert.equal(fresh.m[VIBE_MIGRATED_NORMAL_KEY], '1');
  assert.equal(PREFS_KEY in fresh.m, false);
});

test('consumeVibeMigratedToast: true once only when fun -> boring actually flipped', () => {
  consumeVibeMigratedToast();
  migrateVibeToNormalOnce(memStore());
  assert.equal(consumeVibeMigratedToast(), false, 'fresh install: no toast');
  migrateVibeToNormalOnce(memStore({ [PREFS_KEY]: JSON.stringify({ 'app.vibe': 'boring' }) }));
  assert.equal(consumeVibeMigratedToast(), false, 'already boring: no toast');
  migrateVibeToNormalOnce(memStore({ [PREFS_KEY]: JSON.stringify({ 'app.vibe': 'fun' }) }));
  assert.equal(consumeVibeMigratedToast(), true);
  assert.equal(consumeVibeMigratedToast(), false, 'second call: consumed');
  migrateVibeToNormalOnce(memStore({ [VIBE_MIGRATED_NORMAL_KEY]: '1', [PREFS_KEY]: JSON.stringify({ 'app.vibe': 'fun' }) }));
  assert.equal(consumeVibeMigratedToast(), false, 'already migrated: deliberate fun, no toast');
});

test('app.vibe is not a Settings > App row, but Legacy: Psycho mode is searchable under About', () => {
  assert.ok(!visiblePrefDefs().some((d) => d.key === 'app.vibe'));
  for (const q of ['psycho', 'legacy', 'layout', 'vibe']) {
    const hit = searchSettings(q).find((h) => h.id === 'legacy-psycho');
    assert.ok(hit, q);
    assert.equal(hit.section, 'about');
  }
  assert.equal(searchSettings('layout vibe').some((h) => h.pref === 'app.vibe'), false);
});

test('app.vibe rejects invalid values', () => {
  assert.equal(setPref('app.vibe', 'corporate'), false);
  assert.equal(getPref('app.vibe'), 'boring');
});

test('applyPrefsToDom sets documentElement.dataset.vibe', () => {
  const root = { dataset: {}, style: { setProperty() {} } };
  globalThis.document = { documentElement: root };
  try {
    applyPrefsToDom();
    assert.equal(root.dataset.vibe, 'boring');
    setPref('app.vibe', 'fun');
    applyPrefsToDom();
    assert.equal(root.dataset.vibe, 'fun');
  } finally {
    setPref('app.vibe', 'boring');
    delete globalThis.document;
  }
});

test('app.vibe pref UI copy says Psycho/Normal and no pref copy says Hypnospace', () => {
  const vibe = PREF_DEFS.find((d) => d.key === 'app.vibe');
  assert.ok(vibe, 'app.vibe pref def exists');
  assert.equal(vibe.hint, 'Psycho or Normal layout.');
  assert.equal(vibe.hidden, true);
  assert.equal(vibe.options.find((o) => o.value === 'fun').label, 'Psycho');
  assert.equal(vibe.options.find((o) => o.value === 'boring').label, 'Normal');
  for (const d of PREF_DEFS) {
    assert.ok(!/hypnospace/i.test(d.label ?? ''), `label says Hypnospace: ${d.key}`);
    assert.ok(!/hypnospace/i.test(d.hint ?? ''), `hint says Hypnospace: ${d.key}`);
    for (const o of d.options ?? []) assert.ok(!/hypnospace/i.test(o.label ?? ''), `option label says Hypnospace: ${d.key} -> ${o.value}`);
  }
});

test('boring.css is imported after styles.css and every rule is scoped to html[data-vibe="boring"]', () => {
  assert.match(read('../src/main.tsx'), /import "\.\/styles\.css";\s*\nimport "\.\/boring\.css";/);
  const css = read('../src/boring.css').replace(/\/\*[\s\S]*?\*\//g, '')
    // boring-prefixed keyframes are namespaced (cannot collide with Psycho); drop their bodies
    .replace(/@keyframes boring-[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const selectors = css
    .split('}')
    .map((b) => b.replace(/@media[^{]*\{/g, '').split('{')[0]) // @media wrappers are fine; the rules inside must still be scoped
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  assert.ok(selectors.length > 20);
  for (const s of selectors) assert.ok(s.startsWith('html[data-vibe="boring"]'), `unscoped selector: ${s}`);
});

