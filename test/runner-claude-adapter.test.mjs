import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudeAdapter } from '../runner/adapters/claude.mjs';

function fakeSpawn() {
  const impl = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    impl.calls.push({ file, args, opts });
    return child;
  };
  impl.calls = [];
  return impl;
}

test('--mcp-config is a JSON file path, not inline JSON, and cleanup removes it', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vs-claude-mcp-'));
  const promptsDir = path.join(root, 'prompts');
  // Fake absolute binary so resolution never depends on `claude` being on PATH (spawnImpl is a stub and never runs it).
  const command = path.join(root, process.platform === 'win32' ? 'claude.exe' : 'claude');
  writeFileSync(command, '');
  const spawnImpl = fakeSpawn();
  const adapter = createClaudeAdapter({ spawnImpl, command, mcp: true, mcpPath: 'vs-mcp.mjs', promptsDir });
  adapter.start({ id: 'rn-mcp', cwd: os.tmpdir(), env: { VS_LANE: 'x'.repeat(40000) }, emit() {}, onExit() {} });
  const { args } = spawnImpl.calls[0];
  const file = args[args.indexOf('--mcp-config') + 1];
  assert.ok(!file.trimStart().startsWith('{'), 'argv carries a path, not inline JSON');
  assert.ok(args.join(' ').length < 2000, 'argv stays small however large the server env is');
  assert.ok(existsSync(file));
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(Object.keys(cfg.mcpServers).length === 1);
  assert.equal(Object.values(cfg.mcpServers)[0].env.VS_LANE.length, 40000, 'the large env lands in the file, not argv');
  adapter.cleanup('rn-mcp');
  assert.ok(!existsSync(file), 'cleanup removes the mcp config file');
});
