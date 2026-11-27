// PTO-B3: a Release export (no vs_playtest tag) has zero vs_playtest/adapter paths and boots clean,
// in Text and compiled script modes; a Playtest export (tag) keeps the addon; an attached McpBridge
// autoload never reaches the pack. Skips only when no Godot is found (see resolveGodotBin).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';

const proj = resolve(import.meta.dirname, '..', 'godot');
// Godot resolution follows the conventions the project already uses (GODOT_BIN: EFI run_godot.sh; GODOT_PATH:
// RUNBOOK; GODOT_4_x: forge systemd drop-in, docs/lanes/forge-host/ENV_GAPS.md), then bare `godot`, then any
// ~/.local/bin/godot-4.* (newest first, versions with export templates preferred).
const shell = process.platform === 'win32'; // .cmd/.bat shims need a shell on Windows; POSIX stays shell-free
const probe = (bin) => !!bin && spawnSync(bin, ['--version'], { encoding: 'utf8', shell }).status === 0;
// Version order: numeric parts compare as numbers (4.10 > 4.9; 4.8 == 4.8.0); within one version a stable
// release beats any pre-release (dev < alpha < beta < rc < stable); pre-release numbers compare numerically (dev10 > dev7).
const CHANNEL = { dev: 0, alpha: 1, beta: 2, rc: 3, stable: 4 };
const parseVer = (name) => {
  const m = /^godot-(\d+(?:\.\d+)*)(?:[-.]([a-z]+)(\d*))?/i.exec(name);
  if (!m) return { nums: [0], ch: 'stable', rank: -1, n: 0 };
  const ch = m[2] ? m[2].toLowerCase() : 'stable';
  return { nums: m[1].split('.').map(Number), ch, rank: CHANNEL[ch] ?? -1, n: m[3] ? Number(m[3]) : 0 };
};
const verCmp = (a, b) => {
  const x = parseVer(a), y = parseVer(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) { const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0); if (d) return d; }
  return (x.rank - y.rank) || (x.n - y.n);
};
// Godot's template dir names: 4.8.stable, 4.8.dev7, 4.8.rc1, 4.8.beta1, 4.8.alpha1, 4.8.1.stable
const tplDir = (name) => { const p = parseVer(name); return `${p.nums.join('.')}.${p.ch}${p.ch === 'stable' ? '' : p.n}`; };
const verDirs = () => { try { return readdirSync(join(homedir(), '.local', 'share', 'godot', 'export_templates')); } catch { return []; } };
function resolveGodotBin() {
  for (const name of ['GODOT_BIN', 'GODOT_PATH']) {
    if (process.env[name]) { if (probe(process.env[name])) return { name, bin: process.env[name] }; throw new Error(`${name}=${process.env[name]} is set but does not run --version`); }
  }
  const dir = join(homedir(), '.local', 'bin');
  let versioned = [];
  try { versioned = readdirSync(dir).filter((n) => /^godot-4\./.test(n)); } catch { /* none */ }
  const tpl = verDirs();
  const hasTpl = (n) => tpl.includes(tplDir(n));
  versioned.sort((x, y) => (hasTpl(y) - hasTpl(x)) || verCmp(y, x));
  const candidates = [['PATH godot', 'godot'], ['GODOT_4_8', process.env.GODOT_4_8], ['GODOT_4_7', process.env.GODOT_4_7], ...versioned.map((n) => [`~/.local/bin/${n}`, join(dir, n)])];
  const hit = candidates.find(([, b]) => probe(b));
  return hit ? { name: hit[0], bin: hit[1] } : { searched: ['GODOT_BIN', 'GODOT_PATH', ...candidates.map(([n]) => n)] };
}
const resolved = resolveGodotBin();
const godot = resolved.bin;
const run = (args, cwd) => spawnSync(godot, ['--headless', ...args], { cwd, encoding: 'utf8', timeout: 180000, shell });
const skip = !godot && `no Godot found; searched: ${resolved.searched.join(', ')}`;

test('godot candidate order: numeric versions, stable over pre-release, dev < alpha < beta < rc, template dirs', () => {
  const names = ['godot-4.8-dev7', 'godot-4.8', 'godot-4.10', 'godot-4.8.1', 'godot-4.8-dev10', 'godot-4.9',
    'godot-4.8-rc1', 'godot-4.8-alpha1', 'godot-4.8-beta2', 'godot-4.8.0'];
  const desc = [...names].sort((x, y) => verCmp(y, x));
  assert.deepEqual(desc.slice(0, 6), ['godot-4.10', 'godot-4.9', 'godot-4.8.1', 'godot-4.8', 'godot-4.8.0', 'godot-4.8-rc1']);
  assert.deepEqual(desc.slice(6), ['godot-4.8-beta2', 'godot-4.8-alpha1', 'godot-4.8-dev10', 'godot-4.8-dev7']);
  assert.equal(verCmp('godot-4.8', 'godot-4.8.0'), 0);
  assert.equal(verCmp('godot-4.8-stable', 'godot-4.8'), 0);
  assert.ok(verCmp('godot-4.8-dev7', 'godot-4.8') < 0);
  assert.equal(tplDir('godot-4.8-dev7'), '4.8.dev7');
  assert.equal(tplDir('godot-4.8-rc1'), '4.8.rc1');
  assert.equal(tplDir('godot-4.8-beta1'), '4.8.beta1');
  assert.equal(tplDir('godot-4.8-alpha1'), '4.8.alpha1');
  assert.equal(tplDir('godot-4.8'), '4.8.stable');
  assert.equal(tplDir('godot-4.8.1'), '4.8.1.stable');
});

function exportPack(out, preset) {
  const pck = join(out, `${preset}.pck`);
  const r = run(['--path', proj, '--export-pack', preset, pck]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const l = run(['--path', proj, '-s', 'tests/list_pck.gd', '--', pck]);
  return { pck, log: r.stdout + r.stderr, paths: Number(/vs_playtest=(\d+)/.exec(l.stdout)?.[1]), listing: l.stdout };
}
const boots = (out, pck) => { const b = run(['--main-pack', pck, '--quit-after', '5'], out); assert.doesNotMatch(b.stdout + b.stderr, /ERROR/); };
const withTmp = (fn) => { const out = mkdtempSync(join(tmpdir(), 'vsx-')); try { run(['--path', proj, '--import']); fn(out); } finally { rmSync(out, { recursive: true, force: true }); } };

test('Release (text) has no vs_playtest paths and boots; Playtest keeps the addon', { skip }, () => withTmp((out) => {
  const r = exportPack(out, 'Release');
  assert.equal(r.paths, 0, r.listing);
  assert.doesNotMatch(r.listing, /vs_playtest_adapter/);
  boots(out, r.pck);
  assert.ok(exportPack(out, 'Playtest').paths > 0);
}));

test('Release in compiled script mode (exclude filter) has no vs_playtest/adapter paths and boots', { skip }, () => withTmp((out) => {
  const r = exportPack(out, 'ReleaseCompiled');
  assert.equal(r.paths, 0, r.listing);
  assert.doesNotMatch(r.listing, /vs_playtest_adapter/);
  boots(out, r.pck);
}));

test('compiled preset without the exclude filter errors loudly', { skip }, () => withTmp((out) => {
  const r = exportPack(out, 'ReleaseCompiledUnsafe');
  assert.match(r.log, /VS Playtest: this preset exports compiled scripts/);
}));

test('McpBridge autoload is removed from the export and project.godot is unchanged', { skip }, () => withTmp((out) => {
  const file = join(proj, 'project.godot');
  const orig = readFileSync(file, 'utf8');
  try {
    writeFileSync(file, orig.replace(/^VSPlaytest=.*$/m, (m) => `${m}\nMcpBridge="*res://.mcp/godot-runtime/bridge/mcp_bridge.gd"`));
    const r = exportPack(out, 'Release');
    assert.match(r.log, /McpBridge autoload.*stop_project/s);
    assert.equal(readFileSync(r.pck).includes('McpBridge'), false);
    boots(out, r.pck);
  } finally { writeFileSync(file, orig); }
  assert.equal(readFileSync(file, 'utf8'), orig);
}));
