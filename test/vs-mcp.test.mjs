// Block 3/4: runner auto mode + child env, VS MCP server (stdio round trip + Paseo-name aliases), vs spawn/send/status,
// and rn- identity through the backend seam. Every filesystem touch is under a temp HOME/VIBESQUAD_HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner, agentEnv } from '../runner/runner.mjs';
import { createClaudeAdapter } from '../runner/adapters/claude.mjs';
import { createAcpAdapter } from '../runner/adapters/acp.mjs';
import { toAgent, readRunnerAgentSync } from '../server/backend/runner-backend.mjs';
import { ALIASES, callTool, createContext, VS_TOOLS } from '../server/mcp/tools.mjs';
import { handleMessage, toolList } from '../server/mcp/server.mjs';
import { runAgentVerb } from '../cli/vs.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MCP_SERVER = path.join(ROOT, 'server', 'mcp', 'server.mjs');
const CLI = path.join(ROOT, 'cli', 'vs.mjs');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'vs-mcp-'));
const tick = () => new Promise((r) => setTimeout(r, 15));

function isolatedEnv(extra = {}) {
  const home = tmp();
  return {
    ...process.env, HOME: home, USERPROFILE: home, VIBESQUAD_HOME: path.join(home, '.vibesquad'), PASEO_HOME: path.join(home, '.paseo'),
    PASEO_AGENT_ID: '', VS_AGENT_ID: '', VS_TEAM: '', VS_LANE: '', VS_ROLE: '', VS_ORD: '', VS_RUNNER_LANES: '', ...extra,
  };
}

function fakeSpawn() {
  const calls = [];
  const impl = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.written = [];
    child.stdin.on('data', (d) => { for (const l of String(d).split('\n').filter(Boolean)) child.written.push(JSON.parse(l)); });
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    calls.push({ file, args, opts, child });
    return child;
  };
  impl.calls = calls;
  return impl;
}

const flagValue = (args, name) => args[args.indexOf(name) + 1];

// ---------- runner: permission mode, MCP wiring, child env ----------

test('claude adapter: permission mode defaults to auto, explicit mode wins', () => {
  const spawnImpl = fakeSpawn();
  const adapter = createClaudeAdapter({ spawnImpl, command: process.execPath });
  adapter.start({ cwd: process.cwd(), meta: {}, emit() {}, onExit() {} });
  adapter.start({ cwd: process.cwd(), meta: { permissionMode: 'plan' }, emit() {}, onExit() {} });
  assert.equal(flagValue(spawnImpl.calls[0].args, '--permission-mode'), 'auto');
  assert.equal(flagValue(spawnImpl.calls[1].args, '--permission-mode'), 'plan');
});

test('toAgent: modeId reflects the effective claude mode', () => {
  assert.equal(toAgent({ id: 'rn-1', provider: 'claude', meta: {} }).modeId, 'auto');
  assert.equal(toAgent({ id: 'rn-1', provider: 'claude', meta: { permissionMode: 'plan' } }).modeId, 'plan');
  assert.equal(toAgent({ id: 'rn-1', provider: 'opencode', meta: {} }).modeId, null);
});

test('claude adapter: --mcp-config names the vibesquad server and tools are pre-allowed', () => {
  const spawnImpl = fakeSpawn();
  const adapter = createClaudeAdapter({ spawnImpl, command: process.execPath });
  const env = { VS_AGENT_ID: 'rn-a1', VS_LANE: 'own', SECRET_THING: 'nope' };
  adapter.start({ cwd: process.cwd(), meta: {}, env, emit() {}, onExit() {} });
  const { args } = spawnImpl.calls[0];
  const cfg = JSON.parse(flagValue(args, '--mcp-config'));
  assert.equal(cfg.mcpServers.vibesquad.command, process.execPath);
  assert.deepEqual(cfg.mcpServers.vibesquad.args, [MCP_SERVER]);
  assert.equal(cfg.mcpServers.vibesquad.env.VS_AGENT_ID, 'rn-a1');
  assert.equal(cfg.mcpServers.vibesquad.env.SECRET_THING, undefined);
  assert.equal(flagValue(args, '--allowedTools'), 'mcp__vibesquad');
  assert.ok(existsSync(cfg.mcpServers.vibesquad.args[0]));
});

test('acp adapter: session/new carries the vibesquad MCP server', async () => {
  const spawnImpl = fakeSpawn();
  const adapter = createAcpAdapter({ spawnImpl, command: process.execPath });
  adapter.start({ cwd: process.cwd(), env: { VS_AGENT_ID: 'rn-b2' }, emit() {}, onExit() {} });
  const child = spawnImpl.calls[0].child;
  await tick();
  child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
  await tick();
  const sessionNew = child.written.find((m) => m.method === 'session/new');
  assert.equal(sessionNew.params.mcpServers.length, 1);
  const srv = sessionNew.params.mcpServers[0];
  assert.equal(srv.name, 'vibesquad');
  assert.equal(srv.command, process.execPath);
  assert.deepEqual(srv.args, [MCP_SERVER]);
  assert.deepEqual(srv.env, [{ name: 'VS_AGENT_ID', value: 'rn-b2' }]);
});

test('agentEnv: stale runner identity is replaced by the agent\'s own', () => {
  const base = { PASEO_AGENT_ID: 'lead-that-started-runner', VS_AGENT_ID: 'stale', VS_TEAM: 'old', VS_LANE: 'old', VS_ROLE: 'lead', VS_ORD: '9', KEEP: '1' };
  const env = agentEnv('rn-abc', { team: 'efi', lane: 'own', role: 'worker', ord: 3 }, base);
  assert.equal(env.VS_AGENT_ID, 'rn-abc');
  assert.equal(env.PASEO_AGENT_ID, 'rn-abc');
  assert.deepEqual([env.VS_TEAM, env.VS_LANE, env.VS_ROLE, env.VS_ORD], ['efi', 'own', 'worker', '3']);
  assert.equal(env.KEEP, '1');
  const bare = agentEnv('rn-abc', {}, base);
  assert.equal(bare.VS_TEAM, undefined, 'no stale team leaks into an agent without one');
});

test('runner passes the per-agent env to the child process', () => {
  const spawnImpl = fakeSpawn();
  const runner = new Runner({ dir: tmp(), adapters: { claude: createClaudeAdapter({ spawnImpl, command: process.execPath }) } });
  const id = runner.create({ provider: 'claude', cwd: process.cwd(), meta: { team: 'efi', lane: 'own', role: 'worker' } });
  const { env } = spawnImpl.calls[0].opts;
  assert.equal(env.VS_AGENT_ID, id);
  assert.equal(env.PASEO_AGENT_ID, id);
  assert.equal(env.VS_LANE, 'own');
  assert.equal(env.VS_ROLE, 'worker');
});

// ---------- MCP server ----------

function fakeCtx({ identity = { agentId: 'rn-caller', team: 'efi', lane: 'own', role: 'lead' }, runnerBackend, paseoBackend } = {}) {
  const logs = [];
  const used = [];
  const profiles = [{ id: 'agent_profile_x', name: 'Implement - Sonnet', role: 'worker', provider: 'claude', model: 'claude-sonnet-5-5', modeId: 'auto', notes: 'be good' },
    { id: 'agent_profile_l', name: 'Lead - Opus', role: 'lead', provider: 'claude', model: 'claude-opus-5-5', modeId: 'auto', notes: 'lead it' }];
  return {
    logs, used, identity, cwd: '/work',
    loadProfiles: async () => profiles,
    resolveProfile: async (name) => {
      const p = profiles.find((x) => x.name === name || x.id === name);
      return p ? { profile: p, spawn: { provider: p.provider, model: p.model, modeId: p.modeId, systemPrompt: p.notes } } : null;
    },
    writeLog: async (e) => { logs.push(e); },
    withBackend: async (target, fn) => {
      const onRunner = String(target.id ?? '').startsWith('rn-') || (!target.id && target.lane === 'own');
      used.push(onRunner ? 'runner' : 'paseo');
      return fn(onRunner ? runnerBackend : paseoBackend);
    },
  };
}

function fakeBackend(tag) {
  const calls = [];
  return {
    calls,
    createAgent: async (req) => { calls.push(['createAgent', req]); return { id: `${tag}-new`, title: req.config.title }; },
    sendAgentPrompt: async (id, text) => { calls.push(['send', id, text]); },
    waitForFinish: async (id, ms) => { calls.push(['wait', id, ms]); return { status: 'idle' }; },
    fetchAgent: async (id) => ({ agent: { id, status: 'idle', title: 'T' } }),
    fetchAgentTimeline: async () => ({ entries: [{ item: { type: 'assistant_message', text: 'x'.repeat(5000) } }] }),
    fetchAgents: async () => ({ entries: [
      { agent: { id: `${tag}-1`, title: 'a', status: 'idle', labels: { lane: 'own', team: 'efi', role: 'worker' } } },
      { agent: { id: `${tag}-2`, title: 'b', status: 'idle', labels: { lane: 'other' } } },
    ] }),
    cancelAgent: async (id) => { calls.push(['cancel', id]); },
  };
}

test('MCP: initialize / tools/list / tools/call round trip over stdio', async () => {
  const env = isolatedEnv({ VS_AGENT_ID: 'rn-w1', VS_TEAM: 'efi', VS_LANE: 'own', VS_ROLE: 'worker' });
  const child = spawn(process.execPath, [MCP_SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const rpc = async (msg) => {
    child.stdin.write(JSON.stringify(msg) + '\n');
    for (let n = 0; n < 200; n++) { const hit = lines.find((l) => l.id === msg.id); if (hit) return hit; await tick(); }
    throw new Error('no response');
  };
  try {
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    assert.equal(init.result.serverInfo.name, 'vibesquad');
    assert.ok(init.result.capabilities.tools);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.result.tools.map((t) => t.name);
    for (const n of [...Object.keys(VS_TOOLS), ...Object.keys(ALIASES)]) assert.ok(names.includes(n), `tool ${n} listed`);
    const call = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'report', arguments: { type: 'done', text: 'finished the thing' } } });
    assert.ok(!call.result.isError, JSON.stringify(call));
    assert.deepEqual(JSON.parse(call.result.content[0].text), { logged: true, type: 'done' });
    const logPath = path.join(env.VIBESQUAD_HOME, 'teams', 'efi', 'log.jsonl');
    const entry = JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n').pop());
    assert.equal(entry.agent, 'rn-w1');
    assert.equal(entry.lane, 'own');
    assert.equal(entry.type, 'done');
    const bad = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'report', arguments: { type: 'nope', text: 'x' } } });
    assert.equal(bad.result.isError, true);
    const unknown = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'zzz', arguments: {} } });
    assert.ok(unknown.error);
  } finally {
    child.stdin.end();
    child.kill();
  }
});

test('MCP: handleMessage ignores notifications and lists every tool', async () => {
  assert.equal(await handleMessage({}, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(toolList().length, Object.keys(VS_TOOLS).length + Object.keys(ALIASES).length);
});

test('spawn_worker: profile -> provider/model/mode, inherits team+lane, role=worker, routes to the runner lane', async () => {
  const runnerBackend = fakeBackend('rn');
  const ctx = fakeCtx({ runnerBackend, paseoBackend: fakeBackend('ps') });
  const out = await callTool(ctx, 'spawn_worker', { title: 'Do it', profile: 'Implement - Sonnet', prompt: 'go', labels: { role: 'brainstorm', lane: 'evil' } });
  assert.deepEqual(out, { id: 'rn-new', title: 'Do it' });
  const [, req] = runnerBackend.calls[0];
  assert.deepEqual([req.config.provider, req.config.model, req.config.modeId, req.config.cwd], ['claude', 'claude-sonnet-5-5', 'auto', '/work']);
  assert.equal(req.initialPrompt, 'go');
  assert.equal(req.labels.team, 'efi');
  assert.equal(req.labels.lane, 'own');
  assert.equal(req.labels.role, 'worker');
  assert.equal(req.labels.profile, 'Implement - Sonnet'); // by name: the plugin, failover and digest identity match names
  assert.equal(req.labels.job, 'Do it');
  assert.equal(req.env.VS_ROLE, 'worker');
  await assert.rejects(callTool(ctx, 'spawn_worker', { title: 't', profile: 'Nope', prompt: 'p' }), /unknown profile/);
});

const LEAD_TEAMS = [{ id: 'efi', name: 'EFI', paths: ['efi'], lanes: [{ id: 'own', name: 'Own', aliases: ['mine'] }, { id: 'ui', name: 'UI' }] }];
const leadAgent = (id, over = {}) => ({ id, title: id, status: 'idle', labels: { team: 'efi', lane: 'own', role: 'lead', ...over } });

// The real findLiveLeads (vs who filter) over a stubbed backend list; no runner needed.
function leadCtx({ role = 'brainstorm', lane = 'own', team = 'efi', agents = [], list, env = {} } = {}) {
  const runnerBackend = { ...fakeBackend('rn'), fetchAgents: list ?? (async () => ({ entries: agents.map((agent) => ({ agent })) })) };
  const ctx = fakeCtx({ identity: { agentId: 'rn-buddy', team, lane, role }, runnerBackend, paseoBackend: fakeBackend('ps') });
  ctx.teams = LEAD_TEAMS;
  ctx.findLiveLeads = createContext({ env, identity: ctx.identity, withBackend: ctx.withBackend, teams: LEAD_TEAMS }).findLiveLeads;
  return { ctx, runnerBackend };
}
const askLead = (ctx, extra = {}) => callTool(ctx, 'spawn_worker', { title: 'L', profile: 'Lead - Opus', prompt: 'lead', labels: { role: 'lead' }, ...extra });

test('spawn_worker: a Buddy starts the lane lead when none is live (lead labels + VS_ROLE=lead)', async () => {
  const { ctx, runnerBackend } = leadCtx({ agents: [leadAgent('rn-old', { role: 'former-lead' }), { ...leadAgent('rn-closed'), status: 'closed' }, leadAgent('rn-otherlane', { lane: 'ui' })] });
  assert.equal((await askLead(ctx)).id, 'rn-new');
  const req = runnerBackend.calls[0][1];
  assert.deepEqual([req.labels.role, req.labels.lane, req.labels.team, req.labels.lead, req.labels.profile], ['lead', 'own', 'efi', 'own', 'Lead - Opus']);
  assert.deepEqual([req.env.VS_ROLE, req.env.VS_LANE, req.env.VS_TEAM, req.env.VS_PROFILE], ['lead', 'own', 'efi', 'Lead - Opus']);
});

test('spawn_worker: lead request is an error (no downgrade) unless Buddy + own lane + Lead profile + no live lead', async () => {
  for (const role of ['worker', 'lead', '']) {
    const { ctx, runnerBackend } = leadCtx({ role });
    await assert.rejects(askLead(ctx), /only a brainstorm/, role);
    assert.equal(runnerBackend.calls.length, 0);
  }
  const live = leadCtx({ agents: [leadAgent('rn-live')] });
  await assert.rejects(askLead(live.ctx), /already has a live lead \(rn-live\)/);
  const plain = leadCtx();
  await assert.rejects(askLead(plain.ctx, { profile: 'Implement - Sonnet' }), /not a "Lead - " profile/);
  await assert.rejects(askLead(plain.ctx, { labels: { role: 'lead', lane: 'ui' } }), /not the caller's lane/);
  assert.equal(plain.runnerBackend.calls.length, 0);
});

test('spawn_worker: lead spawn refuses when the lane list cannot be verified (fail closed)', async () => {
  const down = leadCtx({ list: async () => null });
  await assert.rejects(askLead(down.ctx), /can't verify the lane has no live lead/);
  const thrown = leadCtx({ list: async () => { throw new Error('boom'); } });
  await assert.rejects(askLead(thrown.ctx), /can't verify the lane has no live lead: boom/);
  const partial = leadCtx({ env: { VS_PASEO_LANES: 'own' }, list: async () => ({ entries: [], paseoUnavailable: true }) });
  await assert.rejects(askLead(partial.ctx), /can't verify the lane has no live lead: Paseo is unavailable/);
  for (const c of [down, thrown, partial]) assert.equal(c.runnerBackend.calls.length, 0);
  // Paseo down is fine for a runner lane (default): the runner list is complete.
  const runnerOnly = leadCtx({ list: async () => ({ entries: [], paseoUnavailable: true }) });
  assert.equal((await askLead(runnerOnly.ctx)).id, 'rn-new');
});

test('spawn_worker: lead spawn normalizes team/lane through the registry; a mismatched label is rejected', async () => {
  const alias = leadCtx({ lane: 'mine', team: 'EFI', agents: [leadAgent('rn-live')] });
  await assert.rejects(askLead(alias.ctx), /already has a live lead \(rn-live\)/); // alias caller still sees the canonical lane's lead
  const ok = leadCtx({ lane: 'mine', team: 'EFI' });
  await askLead(ok.ctx, { labels: { role: 'lead', lane: 'own', team: 'efi' } });
  assert.deepEqual([ok.runnerBackend.calls[0][1].labels.lane, ok.runnerBackend.calls[0][1].labels.team], ['own', 'efi']);
  await assert.rejects(askLead(leadCtx().ctx, { labels: { role: 'lead', team: 'other' } }), /not the caller's team/);
  await assert.rejects(askLead(leadCtx({ lane: 'ghost' }).ctx), /not in the team registry/);
});

test('spawn_worker: identity-affecting labels are stripped on the lead and worker paths', async () => {
  const smuggle = { digestFor: 'x', lead: 'ui', orphan: '1', topic: 't', ord: '9' };
  const lead = leadCtx();
  await askLead(lead.ctx, { labels: { role: 'lead', ...smuggle } });
  const l = lead.runnerBackend.calls[0][1].labels;
  assert.deepEqual([l.digestFor, l.orphan, l.topic, l.ord, l.lead, l.role], [undefined, undefined, undefined, undefined, 'own', 'lead']);
  const worker = leadCtx();
  await callTool(worker.ctx, 'spawn_worker', { title: 'W', provider: 'claude', model: 'm', prompt: 'p', labels: { role: 'worker', ...smuggle } });
  const w = worker.runnerBackend.calls[0][1].labels;
  assert.deepEqual([w.digestFor, w.lead, w.orphan, w.topic, w.ord, w.role], [undefined, undefined, undefined, undefined, undefined, 'worker']);
});

test('spawn_worker: a Buddy without a lead request still gets a worker; role smuggling is ignored', async () => {
  const { ctx, runnerBackend } = leadCtx();
  await callTool(ctx, 'spawn_worker', { title: 'W', profile: 'Implement - Sonnet', prompt: 'p', labels: { role: 'brainstorm' } });
  await callTool(ctx, 'spawn_worker', { title: 'W2', profile: 'Lead - Opus', prompt: 'p' });
  for (const [, req] of runnerBackend.calls) assert.deepEqual([req.labels.role, req.env.VS_ROLE], ['worker', 'worker']);
});

test('send / wait / status / cancel / list route by id and lane; status caps lastMessage', async () => {
  const runnerBackend = fakeBackend('rn');
  const paseoBackend = fakeBackend('ps');
  const ctx = fakeCtx({ runnerBackend, paseoBackend });
  await callTool(ctx, 'send', { id: 'rn-1', text: 'hi' });
  await callTool(ctx, 'send', { id: 'uuid-1', text: 'yo' });
  assert.deepEqual(runnerBackend.calls[0], ['send', 'rn-1', 'hi']);
  assert.deepEqual(paseoBackend.calls[0], ['send', 'uuid-1', 'yo']);
  const w = await callTool(ctx, 'wait', { id: 'rn-1', timeoutSec: 7 });
  assert.equal(w.status, 'idle');
  assert.equal(w.lastMessage.length, 2000);
  assert.deepEqual(runnerBackend.calls[1], ['wait', 'rn-1', 7000]);
  const s = await callTool(ctx, 'status', { id: 'rn-1' });
  assert.deepEqual([s.status, s.title, s.lastMessage.length], ['idle', 'T', 2000]);
  await callTool(ctx, 'cancel', { id: 'rn-1' });
  assert.deepEqual(runnerBackend.calls.at(-1), ['cancel', 'rn-1']);
  const l = await callTool(ctx, 'list', {});
  assert.deepEqual(l.map((a) => a.id), ['rn-1'], 'lane-scoped');
});

test('report writes as the caller; types are restricted', async () => {
  const ctx = fakeCtx({ runnerBackend: fakeBackend('rn'), paseoBackend: fakeBackend('ps') });
  await callTool(ctx, 'report', { type: 'blocker', text: 'stuck' });
  assert.deepEqual(ctx.logs, [{ type: 'blocker', text: 'stuck', refs: undefined }]);
  await assert.rejects(callTool(ctx, 'report', { type: 'metric', text: 'x' }), /type must be/);
});

test('every Paseo-name alias maps to its VS tool and logs a metric with caller + lane', async () => {
  const runnerBackend = fakeBackend('rn');
  const ctx = fakeCtx({ runnerBackend, paseoBackend: fakeBackend('ps') });
  const created = await callTool(ctx, 'create_agent', { title: 'W', provider: 'claude', model: 'claude-haiku-5-5', mode: 'plan', initialPrompt: 'hello', cwd: '/x', labels: { profile: 'Implement - Sonnet' } });
  assert.equal(created.agentId, 'rn-new');
  assert.equal(created.id, 'rn-new');
  const [, req] = runnerBackend.calls[0];
  assert.deepEqual([req.config.provider, req.config.model, req.config.modeId, req.config.cwd, req.initialPrompt], ['claude', 'claude-haiku-5-5', 'plan', '/x', 'hello']);
  assert.equal(req.labels.profile, 'Implement - Sonnet'); // by name: the plugin, failover and digest identity match names

  await callTool(ctx, 'send_agent_prompt', { agentId: 'rn-1', prompt: 'next' });
  assert.deepEqual(runnerBackend.calls.at(-1), ['send', 'rn-1', 'next']);
  const st = await callTool(ctx, 'get_agent_status', { agentId: 'rn-1' });
  assert.equal(st.agentId, 'rn-1');
  assert.equal(st.status, 'idle');
  const la = await callTool(ctx, 'list_agents', {});
  assert.equal(la.agents[0].agentId, 'rn-1');
  await callTool(ctx, 'cancel_agent', { agentId: 'rn-1' });
  assert.deepEqual(runnerBackend.calls.at(-1), ['cancel', 'rn-1']);
  await callTool(ctx, 'wait_for_agent', { agentId: 'rn-1', timeout: 3 });
  assert.deepEqual(runnerBackend.calls.at(-1), ['wait', 'rn-1', 3000]);

  const metrics = ctx.logs.filter((l) => l.type === 'metric').map((l) => l.text);
  for (const name of Object.keys(ALIASES)) assert.ok(metrics.includes(`mcp-alias: tool=${name} caller=rn-caller lane=own`), `metric for ${name}`);
  assert.equal(metrics.length, Object.keys(ALIASES).length);
  await callTool(ctx, 'send', { id: 'rn-1', text: 'canonical' });
  assert.equal(ctx.logs.filter((l) => l.type === 'metric').length, Object.keys(ALIASES).length, 'canonical tools log no alias metric');
});

// ---------- vs CLI parity ----------

test('vs spawn / send / status run the shared tools against a fake backend', async () => {
  const runnerBackend = fakeBackend('rn');
  const ctx = fakeCtx({ runnerBackend, paseoBackend: fakeBackend('ps') });
  const spawned = await runAgentVerb('spawn', { _: [], title: 'CLI job', profile: 'Implement - Sonnet', prompt: 'do x' }, ctx);
  assert.deepEqual(spawned, { id: 'rn-new', title: 'CLI job' });
  assert.equal(runnerBackend.calls[0][1].labels.role, 'worker');
  assert.deepEqual(await runAgentVerb('send', { _: ['rn-1', 'hello', 'there'] }, ctx), { id: 'rn-1', sent: true });
  assert.deepEqual(runnerBackend.calls.at(-1), ['send', 'rn-1', 'hello there']);
  const st = await runAgentVerb('status', { _: ['rn-1'] }, ctx);
  assert.equal(st.status, 'idle');
  assert.equal(st.lastMessage.length, 2000);
});

function writeRunnerAgent(home, id, meta) {
  const dir = path.join(home, 'runner', 'agents');
  mkdirSync(dir, { recursive: true });
  const ev = (seq, type, data) => JSON.stringify({ seq, ts: Date.now(), type, ...data });
  writeFileSync(path.join(dir, `${id}.jsonl`), [
    ev(0, 'created', { provider: 'claude', model: 'm', cwd: process.cwd(), meta }),
    ev(1, 'status', { status: 'idle' }),
  ].join('\n') + '\n');
}

test('rn- agents resolve through the runner log: vs log as a runner lead, vs who lists runner agents', () => {
  const env = isolatedEnv();
  mkdirSync(env.VIBESQUAD_HOME, { recursive: true });
  writeFileSync(path.join(env.VIBESQUAD_HOME, 'teams.json'), JSON.stringify({ teams: [{ id: 'efi', name: 'EFI', paths: ['efi'], lanes: [{ id: 'own', name: 'Own' }, { id: 'ui', name: 'UI' }] }] }));
  writeRunnerAgent(env.VIBESQUAD_HOME, 'rn-lead1', { team: 'efi', lane: 'own', role: 'lead', title: 'Lead One' });
  writeRunnerAgent(env.VIBESQUAD_HOME, 'rn-work1', { team: 'efi', lane: 'own', role: 'worker', title: 'Worker One' });
  Object.assign(env, { VIBESQUAD_ROOT: env.VIBESQUAD_HOME });
  const asLead = spawnSync(process.execPath, [CLI, 'log', 'decision', 'runner lead can log'], { env: { ...env, PASEO_AGENT_ID: 'rn-lead1' }, encoding: 'utf8' });
  assert.equal(asLead.status, 0, asLead.stderr);
  assert.equal(JSON.parse(asLead.stdout).agent, 'rn-lead1');
  const asWorker = spawnSync(process.execPath, [CLI, 'log', 'decision', 'worker may not'], { env: { ...env, PASEO_AGENT_ID: 'rn-work1' }, encoding: 'utf8' });
  assert.notEqual(asWorker.status, 0);
  assert.match(asWorker.stderr, /role=worker cannot write/);
  const who = spawnSync(process.execPath, [CLI, 'who', 'all', '--lane', 'own', '--json'], { env: { ...env, VS_TEAM: 'efi' }, encoding: 'utf8' });
  const ids = JSON.parse(who.stdout).entries.map((e) => `${e.id}:${e.role}`).sort();
  assert.deepEqual(ids, ['rn-lead1:lead', 'rn-work1:worker']);
  assert.equal(readRunnerAgentSync('rn-lead1', { env })?.labels.role, 'lead');
});

test('aliases expose Paseo-shaped schemas and every alias result carries agentId', async () => {
  const tools = Object.fromEntries(toolList().map((t) => [t.name, t]));
  assert.ok(tools.create_agent.inputSchema.properties.initialPrompt);
  assert.deepEqual(tools.create_agent.inputSchema.required, []);
  for (const n of ['send_agent_prompt', 'get_agent_status', 'cancel_agent', 'wait_for_agent']) assert.ok(tools[n].inputSchema.properties.agentId, n);
  assert.ok(tools.spawn_worker.inputSchema.required.includes('profile'), 'canonical schema untouched');
  const ctx = fakeCtx({ runnerBackend: fakeBackend('rn'), paseoBackend: fakeBackend('ps') });
  for (const [name, args] of [['send_agent_prompt', { agentId: 'rn-1', prompt: 'x' }], ['cancel_agent', { agentId: 'rn-1' }], ['wait_for_agent', { agentId: 'rn-1' }]]) {
    assert.equal((await callTool(ctx, name, args)).agentId, 'rn-1', name);
  }
});

test('agentEnv clears a stale VS_PROFILE; spawn_worker drops labels.ord', async () => {
  assert.equal(agentEnv('rn-1', {}, { VS_PROFILE: 'old' }).VS_PROFILE, undefined);
  assert.equal(agentEnv('rn-1', { profile: 'p' }, {}).VS_PROFILE, 'p');
  const runnerBackend = fakeBackend('rn');
  await callTool(fakeCtx({ runnerBackend, paseoBackend: fakeBackend('ps') }), 'spawn_worker', { title: 't', profile: 'Implement - Sonnet', prompt: 'p', labels: { ord: '9' } });
  assert.equal(runnerBackend.calls[0][1].labels.ord, undefined);
});

test('whoami reads rn- agents from the runner log; installVsShim ships server/mcp and server/backend (isolated HOME)', async () => {
  const env = isolatedEnv();
  mkdirSync(env.VIBESQUAD_HOME, { recursive: true });
  writeFileSync(path.join(env.VIBESQUAD_HOME, 'teams.json'), JSON.stringify({ teams: [{ id: 'efi', name: 'EFI', paths: ['efi'], lanes: [{ id: 'own', name: 'Own' }, { id: 'ui', name: 'UI' }] }] }));
  writeRunnerAgent(env.VIBESQUAD_HOME, 'rn-lead2', { team: 'efi', lane: 'ui', role: 'lead', title: 'L2' });
  const out = spawnSync(process.execPath, [CLI, 'whoami', '--agent', 'rn-lead2', '--json'], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /"lead"/);
  assert.match(out.stdout, /"ui"/);
  const { installVsShim } = await import('../cli/vs.mjs');
  const binDir = path.join(env.HOME, 'bin');
  mkdirSync(binDir, { recursive: true });
  installVsShim({ binDirs: [binDir], baseHome: path.join(env.HOME, 'base') });
  for (const rel of ['server/mcp/server.mjs', 'server/mcp/tools.mjs', 'server/backend/index.mjs', 'server/backend/runner-backend.mjs']) {
    assert.ok(existsSync(path.join(env.HOME, 'base', 'runtime', rel)), rel);
  }
});
