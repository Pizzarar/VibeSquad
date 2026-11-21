// U1: theme pick/persist logic (src/theme.ts) and its wiring in prefs + the pre-paint script.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseThemePref, resolveTheme, themeFromPrefsBlob, THEME_PREFS, parseVibePref, vibeFromPrefsBlob, VIBE_PREFS } from '../src/theme.ts';
// localStorage/matchMedia are absent in node; prefs.ts guards both.
import { PREF_DEFAULTS, PREF_DEFS, PREFS_KEY } from '../src/prefs.ts';

test('parseThemePref accepts the three picks and defaults to system', () => {
  for (const p of THEME_PREFS) assert.equal(parseThemePref(p), p);
  for (const bad of [undefined, null, '', 'Dark', 'auto', 3, {}]) assert.equal(parseThemePref(bad), 'system');
});

test('resolveTheme: explicit pick wins, system follows prefers-color-scheme', () => {
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});

test('themeFromPrefsBlob reads the persisted pick, tolerating missing or corrupt storage', () => {
  assert.equal(themeFromPrefsBlob(JSON.stringify({ 'app.theme': 'light' }), true), 'light');
  assert.equal(themeFromPrefsBlob(JSON.stringify({ 'app.theme': 'dark' }), false), 'dark');
  assert.equal(themeFromPrefsBlob(JSON.stringify({ 'app.density': 'compact' }), false), 'light');
  assert.equal(themeFromPrefsBlob(null, true), 'dark');
  assert.equal(themeFromPrefsBlob('{not json', false), 'light');
});

test('app.theme is a registered enum pref defaulting to system, with System/Dark/Light options', () => {
  assert.equal(PREF_DEFAULTS['app.theme'], 'system');
  const d = PREF_DEFS.find((x) => x.key === 'app.theme');
  assert.equal(d.section, 'app');
  assert.equal(d.kind, 'enum');
  assert.deepEqual(d.options.map((o) => o.value), [...THEME_PREFS]);
});

test('index.html pre-paint script agrees with themeFromPrefsBlob', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const code = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  for (const blob of [null, '{"app.theme":"dark"}', '{"app.theme":"light"}', '{"app.theme":"system"}', '{bad']) {
    for (const sysDark of [true, false]) {
      const documentElement = { dataset: {} };
      vm.runInNewContext(code, {
        document: { documentElement },
        localStorage: { getItem: (k) => (k === PREFS_KEY ? blob : null) },
        window: { matchMedia: () => ({ matches: sysDark }) },
        matchMedia: () => ({ matches: sysDark }),
      });
      assert.equal(documentElement.dataset.theme, themeFromPrefsBlob(blob, sysDark), `${blob} sysDark=${sysDark}`);
    }
  }
});

test('parseVibePref / vibeFromPrefsBlob default to boring (Normal) and only accept an explicit fun', () => {
  assert.deepEqual([...VIBE_PREFS], ['fun', 'boring']);
  assert.equal(parseVibePref('boring'), 'boring');
  assert.equal(parseVibePref('fun'), 'fun');
  for (const bad of [undefined, null, '', 'Boring', 'corp', 3, {}]) assert.equal(parseVibePref(bad), 'boring');
  assert.equal(vibeFromPrefsBlob(JSON.stringify({ 'app.vibe': 'boring' })), 'boring');
  assert.equal(vibeFromPrefsBlob(JSON.stringify({ 'app.theme': 'dark' })), 'boring');
  assert.equal(vibeFromPrefsBlob(null), 'boring');
  assert.equal(vibeFromPrefsBlob('{not json'), 'boring');
});

test('app.vibe is a registered (hidden, Legacy: Psycho mode lives in About) enum pref right after app.theme, defaulting to boring', () => {
  assert.equal(PREF_DEFAULTS['app.vibe'], 'boring');
  assert.equal(PREF_DEFS.find((x) => x.key === 'app.vibe').hidden, true);
  const i = PREF_DEFS.findIndex((x) => x.key === 'app.vibe');
  assert.equal(i, PREF_DEFS.findIndex((x) => x.key === 'app.theme') + 1);
  const d = PREF_DEFS[i];
  assert.equal(d.section, 'app');
  assert.equal(d.kind, 'enum');
  assert.deepEqual(d.options.map((o) => o.value), [...VIBE_PREFS]);
});

test('index.html pre-paint script sets dataset.vibe like vibeFromPrefsBlob', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const code = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  for (const blob of [null, '{"app.vibe":"boring"}', '{"app.vibe":"fun"}', '{"app.vibe":"x"}', '{"app.theme":"dark"}', '{bad']) {
    const documentElement = { dataset: {} };
    vm.runInNewContext(code, {
      document: { documentElement },
      localStorage: { getItem: (k) => (k === PREFS_KEY ? blob : k === 'vs.vibeMigratedNormal' ? '1' : null) },
      window: { matchMedia: () => ({ matches: true }) },
      matchMedia: () => ({ matches: true }),
    });
    assert.equal(documentElement.dataset.vibe, vibeFromPrefsBlob(blob), String(blob));
    // Before the one-time migration runs, a stored fun still paints Normal (no Psycho flash).
    const pre = { dataset: {} };
    vm.runInNewContext(code, {
      document: { documentElement: pre },
      localStorage: { getItem: (k) => (k === PREFS_KEY ? blob : null) },
      window: { matchMedia: () => ({ matches: true }) },
      matchMedia: () => ({ matches: true }),
    });
    assert.equal(pre.dataset.vibe, 'boring', `unmigrated ${blob}`);
  }
});
