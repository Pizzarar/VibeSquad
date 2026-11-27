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
const verKey = (n) => n.replace(/^godot-/, '').split(/[.-]/).map((p) => (/^\d+$/.test(p) ? p.padStart(4, '0') : '~' + p)).join('.');
const verDirs = () => { try { return readdirSync(join(homedir(), '.local', 'share', 'godot', 'export_templates')); } catch { return []; } };
function resolveGodotBin() {
  for (const name of ['GODOT_BIN', 'GODOT_PATH']) {
    if (process.env[name]) { if (probe(process.env[name])) return { name, bin: process.env[name] }; throw new Error(`${name}=${process.env[name]} is set but does not run --version`); }
  }
  const dir = join(homedir(), '.local', 'bin');
  let versioned = [];
  try { versioned = readdirSync(dir).filter((n) => /^godot-4\./.test(n)); } catch { /* none */ }
  const tpl = verDirs();
  const hasTpl = (n) => tpl.some((t) => t.replace(/\.stable$/, '') === n.replace(/^godot-/, '').replace(/-(dev\d+)$/, '.$1').replace(/-stable$/, ''));
  versioned.sort((x, y) => (hasTpl(y) - hasTpl(x)) || (verKey(y) < verKey(x) ? -1 : verKey(y) > verKey(x) ? 1 : 0));
  const candidates = [['PATH godot', 'godot'], ['GODOT_4_8', process.env.GODOT_4_8], ['GODOT_4_7', process.env.GODOT_4_7], ...versioned.map((n) => [`~/.local/bin/${n}`, join(dir, n)])];
  const hit = candidates.find(([, b]) => probe(b));
  return hit ? { name: hit[0], bin: hit[1] } : { searched: ['GODOT_BIN', 'GODOT_PATH', ...candidates.map(([n]) => n)] };
}
const resolved = resolveGodotBin();
const godot = resolved.bin;
const run = (args, cwd) => spawnSync(godot, ['--headless', ...args], { cwd, encoding: 'utf8', timeout: 180000, shell });
const skip = !godot && `no Godot found; searched: ${resolved.searched.join(', ')}`;

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
