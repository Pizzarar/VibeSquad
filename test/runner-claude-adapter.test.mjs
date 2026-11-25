import "./helpers/clean-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
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
function startArgs(t, meta, { home, events } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vs-claude-k4-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const spawnImpl = fakeSpawn();
  const adapter = createClaudeAdapter({ spawnImpl, command: process.execPath, mcp: true, mcpPath: 'vs-mcp.mjs', promptsDir: path.join(root, 'prompts'), ...(home ? { home } : {}) });
  adapter.start({ id: 'rn-k4', cwd: os.tmpdir(), meta, env: {}, emit(k, v) { events?.push([k, v]); }, onExit() {} });
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

function fakeHome(t, mcpServers) {
  const h = mkdtempSync(path.join(os.tmpdir(), 'vs-claude-home-'));
  t.after(() => rmSync(h, { recursive: true, force: true }));
  if (mcpServers) writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ mcpServers }));
  return h;
}

test('godot-runtime extra: reuses the owner config entry, comma list with playwright, pre-allowed', (t) => {
  const home = fakeHome(t, { 'godot-runtime': { command: 'ssh', args: ['devpc', 'node', 'x.js'], env: { GODOT_PATH: 'C:/g.exe' } } });
  const r = startArgs(t, { labels: { 'vs.mcp': 'playwright, godot-runtime' } }, { home });
  assert.deepEqual(Object.keys(r.servers), ['vibesquad', 'playwright', 'godot-runtime']);
  assert.deepEqual(r.servers['godot-runtime'], { command: 'ssh', args: ['devpc', 'node', 'x.js'], env: { GODOT_PATH: 'C:/g.exe' } });
  assert.ok(r.args.includes('mcp__godot-runtime') && r.args.includes('mcp__playwright'));
  const only = startArgs(t, { labels: { 'vs.mcp': 'godot-runtime' } }, { home });
  assert.deepEqual(Object.keys(only.servers), ['vibesquad', 'godot-runtime']);
});

test('godot-runtime extra: no owner entry -> not added, one warning on the agent stream, never invented', (t) => {
  const events = [];
  const r = startArgs(t, { labels: { 'vs.mcp': 'godot-runtime' } }, { home: fakeHome(t, { playwright: { command: 'x' } }), events });
  assert.deepEqual(Object.keys(r.servers), ['vibesquad']);
  assert.ok(!r.args.includes('mcp__godot-runtime'));
  const w = events.filter(([k, v]) => k === 'stderr' && /godot-runtime/.test(v.line));
  assert.equal(w.length, 1);
  assert.match(w[0][1].line, /^warning:/);
  const none = [];
  startArgs(t, { labels: { 'vs.mcp': 'playwright' } }, { home: fakeHome(t), events: none });
  assert.equal(none.length, 0);
});

test('K4: profiles opt into playwright by mcpExtras field (stored value wins, default pack is the fallback)', async () => {
  const { profileMcpExtras, DEFAULT_PACK_PROFILES } = await import('../server/profiles.mjs');
  for (const n of ['Review - Gemini', 'Review - Sonnet', 'Implement - Sonnet', 'Implement - Opus', 'Art Director - Gemini', 'Art Painter - Opus', 'UX Reviewer - Opus']) assert.deepEqual(profileMcpExtras(n), ['playwright'], n);
  assert.deepEqual(profileMcpExtras('Lead - Claude'), []);
  assert.deepEqual(profileMcpExtras('Review - Sonnet', [{ name: 'Review - Sonnet', mcpExtras: [] }]), []);
  assert.ok(DEFAULT_PACK_PROFILES.length > 0);
});

// idea-112 (rn-4131b28b10ed, 11-13): a run_in_background task finished after the turn ended and the CLI opened a turn of
// its own (system/init, Read of the task output, final report, result). With no 'running' the runner and server saw idle ->
// idle: no turn_started/turn_ended, the final reached nobody and the lead pinged "you went idle without a final".
test('a turn the CLI opens on its own (background task finished) reads running -> idle, once, like a prompted one', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vs-claude-selfturn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let child;
  const spawnImpl = () => { child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {}; return child; };
  const events = [];
  const h = createClaudeAdapter({ spawnImpl, command: process.execPath, mcp: false, promptsDir: path.join(root, 'prompts') })
    .start({ id: 'rn-self', cwd: os.tmpdir(), env: {}, emit: (type, data) => events.push({ type, ...data }), onExit() {} });
  const out = (o) => child.stdout.write(JSON.stringify(o) + '\n');
  const flush = () => new Promise((r) => setTimeout(r, 30));
  const statuses = () => events.filter((e) => e.type === 'status').map((e) => e.status);
  // prompted turn: running from send(), no second running from its init/assistant lines
  h.send('run the suite in the background');
  out({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: "I'll pick it up when it finishes." }] } });
  out({ type: 'result', subtype: 'success', stop_reason: 'end_turn' });
  await flush();
  assert.deepEqual(statuses(), ['running', 'idle']);
  assert.equal(h.steerable(), false, 'no open turn');
  // the task finishes: the CLI's own turn
  out({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'x.output' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: '55/55 pass' }] } });
  await flush();
  assert.deepEqual(statuses(), ['running', 'idle', 'running'], 'the self-opened turn reads running at its first assistant line, once');
  assert.equal(h.steerable(), true, 'a send now merges into the open self-turn (no second slot)');
  out({ type: 'result', subtype: 'success', stop_reason: 'end_turn' });
  await flush();
  assert.deepEqual(statuses(), ['running', 'idle', 'running', 'idle']);
  assert.equal(events.filter((e) => e.type === 'turn_done').length, 2);
  // stray non-turn lines while idle (an init, rate limits, a compact boundary) open nothing
  out({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' });
  out({ type: 'rate_limit_event', rate_limit_info: {} });
  out({ type: 'system', subtype: 'compact_boundary' });
  await flush();
  assert.deepEqual(statuses(), ['running', 'idle', 'running', 'idle']);
  // after kill(), late lines open nothing
  h.kill();
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'late' }] } });
  await flush();
  assert.equal(statuses().at(-1), 'idle');
});
