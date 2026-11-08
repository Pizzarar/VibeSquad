import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { performBrainstormRestart, resetBrainstormRestartState } from "../server/brainstorm.mjs";

// Mock-Paseo-daemon tests: the runner has a single owner and is never lazily started, so pin every lane to Paseo.
process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;

const labels = { team: "site", lane: "pinned", role: "brainstorm", "vs.restarted-from": "start-brainstorm" };

function fakeBackend(agentsSeq, { createErr } = {}) {
  const sent = [];
  let i = 0;
  return {
    sent,
    async createAgent() { throw createErr ?? new Error("agent.create.request timed out after 300000ms"); },
    async listAgents() { const l = agentsSeq[Math.min(i++, agentsSeq.length - 1)]; return { entries: l.map((agent) => ({ agent })) }; },
    async sendAgentPrompt(id, text) { sent.push([id, text]); },
    async archiveAgent() {},
    async cancelAgent() {},
    async updateAgent() {},
  };
}

const mk = (over = {}) => ({ id: "a1", title: "BUDDY", labels, status: "idle", createdAt: new Date().toISOString(), ...over });

test("performBrainstormRestart surfaces a createAgent timeout instead of adopting the late agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-create-timeout-"));
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = join(dir, ".vibesquad");
  resetBrainstormRestartState();
  try {
    mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
    const b = fakeBackend([[]]);
    let created = false;
    b.createAgent = async function () { created = true; throw new Error("agent.create.request timed out after 300000ms"); };
    // The late agent still appears on the list, but it is no longer adopted: the timeout surfaces instead.
    b.listAgents = async () => (created ? { entries: [{ agent: mk({ title: "BRAINSTORM · PINNED", labels: { ...labels, "vs.restarted-from": "bs-1" } }) }] } : { entries: [] });
    await assert.rejects(
      performBrainstormRestart(
        {
          agentId: "bs-1", teamId: "site", laneId: "pinned", reason: "manual",
          oldAgent: { id: "bs-1", title: "BRAINSTORM · PINNED", cwd: dir, labels: { team: "site", lane: "pinned", role: "brainstorm" } },
          agentClient: b,
        },
        dir,
      ),
      /agent\.create\.request timed out after 300000ms/,
    );
    assert.deepEqual(b.sent, [], "no late agent is adopted or prompted");
  } finally {
    if (prev === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-timeout createAgent error still throws and nothing is sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-create-err-"));
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = join(dir, ".vibesquad");
  resetBrainstormRestartState();
  try {
    mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
    const b = fakeBackend([[mk()]], { createErr: new Error("provider exploded") });
    await assert.rejects(
      performBrainstormRestart(
        { agentId: "bs-1", teamId: "site", laneId: "pinned", reason: "manual", oldAgent: { id: "bs-1", title: "B", cwd: dir, labels: { team: "site", lane: "pinned", role: "brainstorm" } }, agentClient: b },
        dir,
      ),
      /provider exploded/,
    );
    assert.deepEqual(b.sent, []);
  } finally {
    if (prev === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the spawn lag sampler is stopped on a throwing spawn path (no 50ms interval leaks)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-lag-leak-"));
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = join(dir, ".vibesquad");
  resetBrainstormRestartState();
  const started = new Set();
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms, ...r) => { const h = realSet(fn, ms, ...r); if (ms === 50) started.add(h); return h; };
  globalThis.clearInterval = (h) => { started.delete(h); return realClear(h); };
  try {
    mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
    const b = fakeBackend([[mk()]], { createErr: new Error("provider exploded") });
    await assert.rejects(
      performBrainstormRestart(
        { agentId: "bs-1", teamId: "site", laneId: "pinned", reason: "manual", oldAgent: { id: "bs-1", title: "B", cwd: dir, labels: { team: "site", lane: "pinned", role: "brainstorm" } }, agentClient: b },
        dir,
      ),
      /provider exploded/,
    );
    assert.equal(started.size, 0, "every 50ms sampler was cleared");
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
    for (const h of started) realClear(h);
    if (prev === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
