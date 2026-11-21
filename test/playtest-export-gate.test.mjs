// PTO-B3: a Release export (no vs_playtest tag) has zero vs_playtest paths and boots clean;
// a Playtest export (tag) keeps the addon. Skips when godot is not on PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const proj = resolve(import.meta.dirname, '..', 'godot');
const has = spawnSync('godot', ['--version'], { shell: true }).status === 0;
const run = (args, cwd) => spawnSync('godot', ['--headless', ...args], { cwd, shell: true, encoding: 'utf8', timeout: 120000 });

test('export gate', { skip: !has && 'godot not on PATH' }, () => {
  const out = mkdtempSync(join(tmpdir(), 'vsx-'));
  try {
    run(['--path', proj, '--import']);
    const counts = {};
    for (const p of ['Release', 'Playtest']) {
      const pck = join(out, `${p}.pck`);
      const r = run(['--path', proj, '--export-pack', p, pck]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const l = run(['--path', proj, '-s', 'tests/list_pck.gd', '--', pck]);
      counts[p] = Number(/vs_playtest=(\d+)/.exec(l.stdout)?.[1]);
    }
    assert.equal(counts.Release, 0);
    assert.ok(counts.Playtest > 0);
    const boot = run(['--main-pack', join(out, 'Release.pck'), '--quit-after', '5'], out);
    assert.doesNotMatch(boot.stdout + boot.stderr, /ERROR/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
