// PTO-B3: a Release export (no vs_playtest tag) has zero vs_playtest/adapter paths and boots clean,
// in Text and compiled script modes; a Playtest export (tag) keeps the addon; an attached McpBridge
// autoload never reaches the pack. Skips when godot is not on PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const proj = resolve(import.meta.dirname, '..', 'godot');
const has = spawnSync('godot', ['--version'], { shell: true }).status === 0;
const run = (args, cwd) => spawnSync('godot', ['--headless', ...args], { cwd, shell: true, encoding: 'utf8', timeout: 180000 });
const skip = !has && 'godot not on PATH';

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
