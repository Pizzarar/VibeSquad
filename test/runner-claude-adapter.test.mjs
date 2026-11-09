import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
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

test('--mcp-config is a JSON file path, not inline JSON, and cleanup removes it', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vs-claude-mcp-'));
  const promptsDir = path.join(root, 'prompts');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const spawnImpl = fakeSpawn();
  const adapter = createClaudeAdapter({ spawnImpl, command: process.execPath, mcp: true, mcpPath: 'vs-mcp.mjs', promptsDir });
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

test('a synchronous spawn failure removes the files start() wrote', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vs-claude-mcp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const promptsDir = path.join(root, 'prompts');
  const spawnImpl = () => { throw new Error('boom'); };
  const adapter = createClaudeAdapter({ spawnImpl, command: process.execPath, mcp: true, mcpPath: 'vs-mcp.mjs', promptsDir });
  assert.throws(() => adapter.start({ id: 'rn-fail', cwd: os.tmpdir(), systemPrompt: 'hi', env: {}, emit() {}, onExit() {} }), /boom/);
  assert.deepEqual(readdirSync(promptsDir), []);
});

// Shape captured live by the K0 probe (claude 2.1.x, `/compact keep the plan` as a stream-json user turn).
const COMPACT_BOUNDARY = { type: 'system', subtype: 'compact_boundary', session_id: 's1', compact_metadata: { trigger: 'manual', pre_tokens: 35119, post_tokens: 10166, cumulative_dropped_tokens: 24953, duration_ms: 11293 } };

test('compact_boundary becomes a compacted event (before/after tokens) plus a usage reset, then the turn result closes normally', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vs-claude-compact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let child;
  const spawnImpl = (file, args, opts) => {
    child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    return child;
  };
  const adapter = createClaudeAdapter({ spawnImpl, command: process.execPath, mcp: false, promptsDir: path.join(root, 'prompts') });
  const events = [];
  const h = adapter.start({ id: 'rn-c', cwd: os.tmpdir(), env: {}, emit: (type, data) => events.push({ type, ...data }), onExit() {} });
  h.send('/compact keep the plan');
  child.stdout.write(JSON.stringify(COMPACT_BOUNDARY) + '\n');
  child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: '', usage: { input_tokens: 0 } }) + '\n');
  await new Promise((r) => setTimeout(r, 30));
  const c = events.find((e) => e.type === 'compacted');
  assert.deepEqual(c, { type: 'compacted', before: 35119, after: 10166, trigger: 'manual', durationMs: 11293 });
  assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', contextTokens: 10166, inputTokens: 10166, outputTokens: 0 });
  assert.ok(events.findIndex((e) => e.type === 'compacted') < events.findIndex((e) => e.type === 'turn_done'));
  assert.ok(!events.some((e) => e.type === 'raw'), 'not treated as an unparsed line');
  assert.equal(events.at(-1).status, 'idle');
});

test('compact_boundary without metadata still emits compacted (undefined counts) and no usage', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vs-claude-compact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let child;
  const spawnImpl = () => { child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {}; return child; };
  const events = [];
  createClaudeAdapter({ spawnImpl, command: process.execPath, mcp: false, promptsDir: path.join(root, 'prompts') })
    .start({ id: 'rn-c2', cwd: os.tmpdir(), env: {}, emit: (type, data) => events.push({ type, ...data }), onExit() {} });
  child.stdout.write(JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) + '\n');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(events.filter((e) => e.type === 'compacted').length, 1);
  assert.equal(events.filter((e) => e.type === 'compacted')[0].before, undefined);
  assert.ok(!events.some((e) => e.type === 'usage'));
});

// K4: lean tool load. Default = vibesquad MCP only + no user settings; extras are opt-in per profile / label.
function startArgs(t, meta) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vs-claude-k4-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const spawnImpl = fakeSpawn();
  const adapter = createClaudeAdapter({ spawnImpl, command: process.execPath, mcp: true, mcpPath: 'vs-mcp.mjs', promptsDir: path.join(root, 'prompts') });
  adapter.start({ id: 'rn-k4', cwd: os.tmpdir(), meta, env: {}, emit() {}, onExit() {} });
  const { args } = spawnImpl.calls[0];
  return { args, servers: JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers };
}

test('K4: default args are strict-MCP (vibesquad only), turn synced plugins off, keep the user setting source, never --bare', (t) => {
  const { args, servers } = startArgs(t, { profile: 'Implement - Sonnet' });
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('--setting-sources'), 'user settings + ~/.claude/CLAUDE.md must still load');
  const off = JSON.parse(args[args.indexOf('--settings') + 1]).enabledPlugins;
  for (const n of ['engineering', 'productivity', 'cowork-plugin-management', 'data']) assert.equal(off[`${n}@synced`], false);
  assert.deepEqual(Object.keys(servers), ['vibesquad']);
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__vibesquad');
  assert.ok(!args.includes('--bare') && !args.includes('--disable-slash-commands'));
});

test('K4: Playwright is opt-in via the vs.mcp label and is pre-allowed', (t) => {
  const on = startArgs(t, { labels: { 'vs.mcp': 'Playwright' } });
  assert.deepEqual(Object.keys(on.servers), ['vibesquad', 'playwright']);
  assert.ok(on.args.includes('mcp__playwright'));
  const off = startArgs(t, { labels: { 'vs.mcp': 'other' } });
  assert.deepEqual(Object.keys(off.servers), ['vibesquad']);
  assert.ok(!off.args.includes('mcp__playwright'));
});

test('K4: profiles opt into playwright by mcpExtras field (stored value wins, default pack is the fallback)', async () => {
  const { profileMcpExtras, DEFAULT_PACK_PROFILES } = await import('../server/profiles.mjs');
  for (const n of ['Review - Gemini', 'Review - Sonnet', 'Implement - Sonnet', 'Implement - Opus', 'Art Director - Gemini', 'Art Painter - Opus']) assert.deepEqual(profileMcpExtras(n), ['playwright'], n);
  assert.deepEqual(profileMcpExtras('Lead - Claude'), []);
  assert.deepEqual(profileMcpExtras('Review - Sonnet', [{ name: 'Review - Sonnet', mcpExtras: [] }]), []);
  assert.ok(DEFAULT_PACK_PROFILES.length > 0);
});
