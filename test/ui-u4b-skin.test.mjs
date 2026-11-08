// U4b: quiet tools (sidebar, chat pane, team top bar) on flat P0 with a calm spray-gradient wash, both themes.
// Guards: tokens + rules exist in both themes, one UI font, selector scope + specificity (the shared tool-surface rules must not
// beat the quiet sidebar buttons, and the scope must reach the hub), U3 world art untouched, static P0 contrast at every stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const U4_START = css.indexOf('U4b: quiet tools, loud world');
assert.ok(U4_START > 0, 'U4b block missing');
const u4 = css.slice(U4_START);
const u3 = css.slice(0, U4_START);

// ---- tiny CSS helpers ----
const rules = (src) => {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length)); // keep offsets
  const out = []; const re = /([^{}]+)\{([^{}]*)\}/g; let m;
  while ((m = re.exec(clean))) out.push({ sel: m[1].trim(), body: m[2], at: m.index });
  return out;
};
const u4rules = rules(u4);

// selector specificity [ids, classes/attrs/pseudo-classes, types]; :is/:not/:has take the max argument, :where is 0
function splitTop(s, sep = ',') {
  const out = []; let d = 0, cur = '';
  for (const ch of s) { if (ch === '(' || ch === '[') d++; if (ch === ')' || ch === ']') d--; if (ch === sep && d === 0) { out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur); return out.map((x) => x.trim()).filter(Boolean);
}
function spec(sel) {
  let a = 0, b = 0, c = 0, i = 0;
  const add = (s) => { a += s[0]; b += s[1]; c += s[2]; };
  const max = (list) => list.map(spec).reduce((m, s) => (s[0] - m[0] || s[1] - m[1] || s[2] - m[2] > 0 ? s : m), [0, 0, 0]);
  const cmp = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  while (i < sel.length) {
    const ch = sel[i];
    if (ch === '#') { a++; i++; while (/[\w-]/.test(sel[i] || '')) i++; }
    else if (ch === '.') { b++; i++; while (/[\w-]/.test(sel[i] || '')) i++; }
    else if (ch === '[') { b++; i = sel.indexOf(']', i) + 1; }
    else if (ch === ':') {
      const pe = sel[i + 1] === ':'; i += pe ? 2 : 1; let name = ''; while (/[\w-]/.test(sel[i] || '')) name += sel[i++];
      if (sel[i] === '(') {
        let d = 0, j = i; do { if (sel[j] === '(') d++; if (sel[j] === ')') d--; j++; } while (d && j < sel.length);
        const inner = sel.slice(i + 1, j - 1); i = j;
        if (name === 'where') continue;
        if (['is', 'not', 'has', 'matches'].includes(name)) { let best = [0, 0, 0]; for (const s of splitTop(inner)) { const x = spec(s); if (cmp(x, best) > 0) best = x; } add(best); }
        else b++;
      } else if (pe) c++; else b++;
    }
    else if (/[\w*]/.test(ch)) { let name = ''; while (/[\w*-]/.test(sel[i] || '')) name += sel[i++]; if (name !== '*') c++; }
    else i++;
  }
  return [a, b, c];
}
const cmpSpec = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
const specOfList = (sel) => splitTop(sel).map(spec).reduce((m, s) => (cmpSpec(s, m) > 0 ? s : m), [0, 0, 0]);

// ---- tokens ----
test('U4b tokens exist and the light theme only swaps the edge and on-fill ink', () => {
  assert.match(css, /:root\s*\{\s*\n\s*--u4-edge: var\(--violet\);/);
  assert.match(css, /--u4-ramp: linear-gradient\(180deg, var\(--bg\) 0%, var\(--panel\) 52%, var\(--panel-hi\) 100%\);/);
  assert.match(css, /--u4-wash:[\s\S]*?violet\) 14%[\s\S]*?hot-pink\) 9%[\s\S]*?linear-gradient\(180deg, var\(--bg\) 0%, var\(--panel\) 100%\);/);
  assert.match(css, /:root\[data-theme="light"\]\s*\{\s*--u4-edge: var\(--muted\); --u4-on-fill: var\(--marble\); \}/);
});

test('body, sidebar and chat pane use the wash/ramp (no U3 stars, grain or url() art) in both themes', () => {
  const body = u4rules.find((r) => r.sel === 'body');
  assert.ok(body && /var\(--u4-wash\)/.test(body.body), 'body wash');
  assert.ok(!/stars|url\(/.test(body.body), 'no stars/url on body');
  const side = u4rules.find((r) => r.sel === '.sidebar');
  assert.ok(side && /var\(--u4-ramp\)/.test(side.body));
  const pane = u4rules.find((r) => r.sel === '.agent-panes:not(:has(.sky-zones))');
  assert.ok(pane && /var\(--u4-wash\)/.test(pane.body) && /border-image: none/.test(pane.body));
  // theme-independent: the wash is built from theme tokens only, no per-theme override needed
  assert.ok(!/data-theme/.test(body.body + side.body + pane.body));
});

test('one UI font: everything in the tool surfaces is --mono (brand block, terminals, diagrams exempt)', () => {
  const stripped = u4.replace(/\/\*[\s\S]*?\*\//g, '');
  const fam = u4rules.filter((r) => /font-family\s*:/.test(r.body));
  assert.equal(fam.length, 1, 'exactly one font-family rule in U4b');
  const r = fam[0];
  assert.match(r.sel, /^:is\(\.sidebar, \.agent-panes:not\(:has\(\.sky-zones\)\), \.pin-focus-bar\) :not\(/);
  assert.match(r.body, /font-family:\s*var\(--mono\)\s*!important/);
  for (const ex of ['.brand-text', '.brand-text *', '.xterm', 'svg']) assert.ok(r.sel.includes(ex), `exempts ${ex}`);
  assert.doesNotMatch(stripped, /var\(--(arcade|display)\)/);
  // --arcade / --display stay defined for the floor, sky and brand (not aliased globally)
  assert.match(css, /--arcade: "Silkscreen"/);
  assert.match(css, /--display: "Pixelify Sans"/);
  assert.ok(!/--(arcade|display)\s*:\s*var\(--mono\)/.test(css));
  // every arcade/display rule outside U4b that targets a tool surface is overridden by the !important scope above
  assert.ok(cmpSpec(specOfList(r.sel), [0, 1, 0]) >= 0);
});

test('U4b surfaces carry no U3 painted layers (only the --u3-px kit pixel is referenced)', () => {
  const used = new Set([...u4.matchAll(/var\((--u3-[\w-]+)\)/g)].map((m) => m[1]));
  assert.deepEqual([...used].filter((v) => v !== '--u3-px'), []);
  assert.doesNotMatch(u4.replace(/\/\*[\s\S]*?\*\//g, ''), /border-image(?:-source)?:\s*(?!none)\S/);
  assert.doesNotMatch(u4.replace(/\/\*[\s\S]*?\*\//g, ''), /url\(/);
});

// ---- scope + specificity ----
test('scope reaches every chat pane and top bar (hub, .app.focus, .app.with-panes) and never needs .app.pin-focus', () => {
  assert.doesNotMatch(u4, /\.app\.pin-focus/);
  assert.match(u4, /:is\(\.sidebar, \.agent-panes:not\(:has\(\.sky-zones\)\), \.pin-focus-bar\)/);
  assert.ok(u4rules.some((r) => /^\.pin-focus-bar\b/.test(r.sel)), 'direct .pin-focus-bar rules');
  // U3 pane painting only survives on the sky-zone (world) pane; the old strip/bar/select overrides for the chat bar are gone
  assert.match(u3, /\.app\.pin-focus > \.agent-panes:has\(\.sky-zones\)\s*\{/);
  assert.doesNotMatch(u3, /\.app\.pin-focus > \.agent-panes\s*\{/);
  assert.doesNotMatch(u3, /\.pin-focus-bar :is\(select, input\)\s*\{[^}]*u3-lt-text/);
  assert.doesNotMatch(u3, /u3-tb-ramp\), var\(--u3-tb-peach\);\n\s*background-size[^\n]*\n\s*background-position: 0 calc\(var\(--u3-px\) \* -2\)/);
});

test('quiet sidebar buttons beat the shared tool-surface rules (specificity guard)', () => {
  const quiet = u4rules.filter((r) => /^:root:root \.sidebar :is\(\.tchip/.test(r.sel));
  assert.equal(quiet.length, 2, 'quiet + quiet:hover');
  const shared = u4rules.filter((r) => r.at < quiet[0].at && /\.tchip\b/.test(r.sel) && !/\.on\b/.test(r.sel) && /^:is\(\.sidebar/.test(r.sel)); // selected (.on) states intentionally win
  assert.ok(shared.length >= 3, 'found shared rules touching .tchip');
  for (const s of shared) {
    const q = quiet.find((r) => /:hover/.test(r.sel) === /:hover/.test(s.sel) && /:active/.test(r.sel) === /:active/.test(s.sel)) || quiet[0];
    if (/:active/.test(s.sel) || /:disabled\s*\{?$/.test(s.sel.replace(/\s/g, ''))) continue;
    assert.ok(cmpSpec(specOfList(q.sel), specOfList(s.sel)) >= 0, `quiet ${JSON.stringify(specOfList(q.sel))} must be >= shared ${JSON.stringify(specOfList(s.sel))}: ${s.sel.slice(0, 90)}`);
  }
  // the dead restatement of the quiet rule is gone (one definition each)
  assert.equal([...u4.matchAll(/\.sidebar :is\(\.tchip, \.sidebar-collapse-all-btn/g)].length, 2);
});

test('the shared scope outranks the U3 button/chip rules it replaces', () => {
  const u3btn = specOfList('.btn.ghost');
  const shared = u4rules.find((r) => r.sel.startsWith(':is(.sidebar, .agent-panes') && r.sel.includes(':is(.btn, .tchip') && /background: var\(--panel-hi\)/.test(r.body));
  assert.ok(shared, 'shared button rule');
  assert.ok(cmpSpec(specOfList(shared.sel), u3btn) > 0);
});

test('rows that dimmed with opacity use the muted token; unselected Inbox and assistant hover are P0', () => {
  const get = (sel) => u4rules.find((r) => r.sel === sel);
  assert.match(get('.sidebar .pin-row.no-session .pin-row-name').body, /opacity: 1;[^}]*color: var\(--muted\)/);
  assert.match(get('.sidebar .pin-row.done').body, /opacity: 1;[^}]*color: var\(--muted\)/);
  assert.match(get(':root .sidebar .sidebar-inbox-badge:not(.on)').body, /background: var\(--panel-hi\);[^}]*color: var\(--text\) !important/);
  assert.match(get('.timeline .tl-assistant:hover').body, /background-color: transparent/);
  assert.match(get('.sidebar-signals-toggle').body, /background: var\(--panel-hi\);[^}]*color: var\(--text\)/);
});

// ---- U3 world art untouched ----
test('U3 world art stays: sky zones, floor, brand mark/text are neither touched nor restyled by U4b', () => {
  const u4NoFont = u4rules.filter((r) => !/font-family/.test(r.body)).map((r) => r.sel + '{' + r.body + '}').join('\n'); // the font rule only EXEMPTS .brand-text
  assert.doesNotMatch(u4NoFont, /\.sky-zone(?!s\)\)|\))|\.sq-floor|\.brand-mark|\.brand-text|\.chrome-glyph|--u3-brand|--u3-sprites|--u3-stars/);
  assert.match(css, /\.brand-text > span:first-child\s*\{[^}]*--u3-brand-vibesquad/);
  assert.match(css, /\.hub-body \.sq-floor\s*\{/);
  assert.match(css, /:root\[data-theme="light"\] \.sky-zones\s*\{/);
  assert.match(css, /\.brand-mark-light\s*\{/);
  assert.match(u3, /\.app\.pin-focus > \.agent-panes:has\(\.sky-zones\)[\s\S]*?--u3-cloud-corner/);
});

// ---- static P0 contrast at every ramp/wash stop ----
function themeTokens(block) {
  const t = {}; for (const m of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) t[m[1]] = m[2].replace(/\/\*.*?\*\//g, '').trim(); return t;
}
const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf(':root[data-theme="light"] {'));
const lightBlock = css.slice(css.indexOf(':root[data-theme="light"] {'), css.indexOf('* {\n  box-sizing'));
const dark = themeTokens(rootBlock);
const light = { ...dark, ...themeTokens(lightBlock) };
function color(tokens, v, depth = 0) {
  v = v.trim(); if (depth > 8) throw new Error('loop ' + v);
  let m;
  if ((m = /^var\((--[\w-]+)\)$/.exec(v))) return color(tokens, tokens[m[1]], depth + 1);
  if ((m = /^#([0-9a-f]{6})$/i.exec(v))) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  if ((m = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/.exec(v))) { const a = color(tokens, m[1], depth + 1), b = color(tokens, m[3], depth + 1), p = +m[2] / 100; return a.map((x, i) => x * p + b[i] * (1 - p)); }
  throw new Error('cannot resolve ' + v);
}
const lum = (c) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mixc = (a, b, p) => a.map((x, i) => x * p + b[i] * (1 - p));

for (const [name, tokens] of [['dark', dark], ['light', light]]) {
  const c = (n) => color(tokens, `var(${n})`);
  const bg = c('--bg'), panel = c('--panel'), hi = c('--panel-hi');
  const sidebarStops = { 'bg': bg, 'panel': panel, 'panel-hi': hi };
  const pageStops = { 'bg': bg, 'panel': panel, 'violet pool (14%)': mixc(c('--violet'), bg, 0.14), 'pink pool (9%)': mixc(c('--hot-pink'), panel, 0.09) };
  const allStops = { ...sidebarStops, ...pageStops };
  const edge = name === 'light' ? c('--muted') : c('--violet');
  const onFill = name === 'light' ? c('--marble') : c('--bg');

  test(`${name}: text and muted text pass 4.5:1 at every ramp/wash stop`, () => {
    for (const [fgName, fg] of [['--text', c('--text')], ['--muted', c('--muted')]])
      for (const [sn, s] of Object.entries(allStops)) assert.ok(ratio(fg, s) >= 4.5, `${fgName} on ${sn}: ${ratio(fg, s).toFixed(2)}`);
  });

  test(`${name}: accent text tokens pass 4.5:1 on panel and panel-hi (tool rows, chips, glyphs)`, () => {
    for (const n of ['--cyan-t', '--violet-t', '--coral-t', '--pink-t', '--amber-t', '--mint-t'])
      for (const [sn, s] of Object.entries({ panel, 'panel-hi': hi })) assert.ok(ratio(c(n), s) >= 4.5, `${n} on ${sn}: ${ratio(c(n), s).toFixed(2)}`);
  });

  test(`${name}: filled controls (primary, hot, selected, warn, needs-you) keep >= 4.5:1 label ink`, () => {
    const pairs = [['primary', c('--on-cyan-fill'), c('--cyan-fill')], ['hot/needs-you', onFill, c('--pink-fill')], ['selected', c('--on-pastel'), c('--violet')], ['warn', c('--on-amber'), c('--amber')]];
    for (const [n, fg, bgc] of pairs) assert.ok(ratio(fg, bgc) >= 4.5, `${n}: ${ratio(fg, bgc).toFixed(2)}`);
  });

  test(`${name}: non-text edges, accent bar, pips and disabled labels pass 3:1 at every stop`, () => {
    for (const [sn, s] of Object.entries(allStops)) assert.ok(ratio(edge, s) >= 3, `edge on ${sn}: ${ratio(edge, s).toFixed(2)}`);
    for (const [sn, s] of Object.entries({ panel, 'panel-hi': hi })) assert.ok(ratio(c('--cyan-fill'), s) >= 3, `accent bar on ${sn}: ${ratio(c('--cyan-fill'), s).toFixed(2)}`);
    for (const [sn, s] of Object.entries(sidebarStops)) assert.ok(ratio(c('--muted'), s) >= 3, `idle pip outline on ${sn}`);
    assert.ok(ratio(c('--muted'), panel) >= 3, 'disabled label on panel');
    // status pip fill (dark) / INK rim (light, sprite rim #35204c) at every sidebar stop
    const pip = name === 'light' ? [0x35, 0x20, 0x4c] : null;
    for (const [sn, s] of Object.entries(sidebarStops)) {
      if (pip) assert.ok(ratio(pip, s) >= 3, `pip rim on ${sn}`);
      else for (const n of ['--emerald', '--hot-pink', '--amber']) assert.ok(ratio(c(n), s) >= 3, `${n} pip on ${sn}`);
    }
  });
}
