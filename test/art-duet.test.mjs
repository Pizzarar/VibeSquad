// Block B4: spawning one half of the Art Painter + Art Director duet starts the other, linked by id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../server/mcp/tools.mjs';

const PROFILES = ['Art Painter - Opus', 'Art Director - Gemini', 'Implement - Sonnet'].map((name, i) => ({
  id: `p${i}`, name, role: 'worker', provider: 'claude', model: 'm', modeId: 'auto', notes: 'n',
}));

function ctxWith(existing = []) {
  const calls = [];
  let n = 0;
  const backend = {
    createAgent: async (req) => { const id = `rn-${++n}`; calls.push(['create', id, req]); return { id, title: req.config.title }; },
    sendAgentPrompt: async (id, text) => { calls.push(['send', id, text]); },
    fetchAgents: async () => ({ entries: existing.map((a) => ({ agent: a })) }),
  };
  return {
    calls, identity: { agentId: 'rn-lead', team: 'efi', lane: 'own', role: 'lead' }, cwd: '/w',
    loadProfiles: async () => PROFILES,
    resolveProfile: async (name) => { const p = PROFILES.find((x) => x.name === name); return p ? { profile: p, spawn: { provider: p.provider, model: p.model, modeId: p.modeId } } : null; },
    withBackend: async (_t, fn) => fn(backend),
  };
}

test('Art Painter spawn also starts the Director, each prompt names the other', async () => {
  const ctx = ctxWith();
  const out = await callTool(ctx, 'spawn_worker', { title: 'neon', profile: 'Art Painter - Opus', prompt: 'draw it' });
  assert.equal(out.id, 'rn-1');
  assert.equal(out.partner, 'rn-2');
  const creates = ctx.calls.filter((c) => c[0] === 'create');
  assert.equal(creates.length, 2);
  assert.equal(creates[1][2].labels.profile, 'Art Director - Gemini');
  assert.equal(creates[1][2].labels.job, 'neon');
  assert.match(creates[1][2].initialPrompt, /Painter is agent rn-1/);
  assert.match(creates[1][2].initialPrompt, /draw it/);
  assert.ok(ctx.calls.some((c) => c[0] === 'send' && c[1] === 'rn-1' && /rn-2/.test(c[2])));
});

test('Art Director spawn starts the Painter; a live partner for the job is not duplicated', async () => {
  const ctx = ctxWith();
  const out = await callTool(ctx, 'spawn_worker', { title: 'neon', profile: 'Art Director - Gemini', prompt: 'judge' });
  assert.equal(out.partner, 'rn-2');
  assert.equal(ctx.calls.find((c) => c[0] === 'create' && c[1] === 'rn-2')[2].labels.profile, 'Art Painter - Opus');
  const live = ctxWith([{ id: 'rn-9', status: 'running', labels: { profile: 'Art Painter - Opus', job: 'neon', lane: 'own' } }]);
  const out2 = await callTool(live, 'spawn_worker', { title: 'neon', profile: 'Art Director - Gemini', prompt: 'judge' });
  assert.equal(out2.partner, undefined);
  assert.equal(live.calls.filter((c) => c[0] === 'create').length, 1);
});

test('non-art profiles spawn alone', async () => {
  const ctx = ctxWith();
  const out = await callTool(ctx, 'spawn_worker', { title: 'x', profile: 'Implement - Sonnet', prompt: 'go' });
  assert.deepEqual(out, { id: 'rn-1', title: 'x' });
  assert.equal(ctx.calls.length, 1);
});

test('a failed partner spawn still returns the primary id with partnerError', async () => {
  const ctx = ctxWith();
  const realWith = ctx.withBackend;
  let creates = 0;
  ctx.withBackend = async (t, fn) => realWith(t, (b) => fn({ ...b, createAgent: async (req) => { if (++creates === 2) throw new Error('boom'); return b.createAgent(req); } }));
  const out = await callTool(ctx, 'spawn_worker', { title: 'neon', profile: 'Art Painter - Opus', prompt: 'draw it' });
  assert.equal(out.id, 'rn-1');
  assert.equal(out.partner, undefined);
  assert.equal(out.partnerError, 'boom');
});

test('Art partner does not inherit the caller provider/model/thinking (M2)', async () => {
  const ctx = ctxWith();
  await callTool(ctx, 'spawn_worker', { title: 'neon', profile: 'Art Painter - Opus', prompt: 'draw it', provider: 'claude', model: 'claude-opus-5-5', thinkingOptionId: 'high', modeId: 'x' });
  const [painter, director] = ctx.calls.filter((c) => c[0] === 'create').map((c) => c[2].config);
  assert.equal(painter.model, 'claude-opus-5-5');
  assert.equal(painter.thinkingOptionId, 'high');
  assert.equal(director.model, 'm');
  assert.equal(director.thinkingOptionId, undefined);
  assert.equal(director.modeId, 'auto');
});
