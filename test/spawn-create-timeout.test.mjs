import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isCreateTimeoutError, performBrainstormRestart, recoverTimedOutCreate, resetBrainstormRestartState } from "../server/brainstorm.mjs";

const labels = { team: "site", lane: "pinned", role: "brainstorm", "vs.restarted-from": "start-brainstorm" };
const fast = { pollMs: 1, waitMs: 50, sleep: () => new Promise((r) => setTimeout(r, 1)) };

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

test("timeout detection", () => {
  assert.ok(isCreateTimeoutError(new Error("Timed out waiting")));
  assert.ok(isCreateTimeoutError(Object.assign(new Error("x"), { name: "AbortError" })));
  assert.ok(!isCreateTimeoutError(new Error("provider exploded")));
});

test("idle agent with no activity gets the initial prompt exactly once", async () => {
  const b = fakeBackend([[], [mk({ status: "initializing" })], [mk()]]);
  const a = await recoverTimedOutCreate({ backend: b, labels, title: "BUDDY", initialPrompt: "BOOT", startedMs: Date.now() - 1000, ...fast });
  assert.equal(a.id, "a1");
  assert.deepEqual(b.sent, [["a1", "BOOT"]]);
});

test("an agent that already has activity is adopted without a second send", async () => {
  for (const over of [{ status: "running" }, { lastUserMessageAt: new Date().toISOString() }]) {
    const b = fakeBackend([[mk(over)]]);
    const a = await recoverTimedOutCreate({ backend: b, labels, title: "BUDDY", initialPrompt: "BOOT", startedMs: Date.now() - 1000, ...fast });
    assert.equal(a.id, "a1");
    assert.deepEqual(b.sent, []);
  }
});

test("no matching agent before the deadline returns null", async () => {
  const b = fakeBackend([[]]);
  assert.equal(await recoverTimedOutCreate({ backend: b, labels, title: "BUDDY", initialPrompt: "BOOT", startedMs: Date.now(), ...fast }), null);
  assert.deepEqual(b.sent, []);
});

test("performBrainstormRestart adopts the late agent after a createAgent timeout and sends the prompt once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-create-timeout-"));
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = join(dir, ".vibesquad");
  resetBrainstormRestartState();
  try {
    mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
    const b = fakeBackend([[]]);
    let created = false;
    b.createAgent = async function () { created = true; throw new Error("agent.create.request timed out after 300000ms"); };
    b.listAgents = async () => (created ? { entries: [{ agent: mk({ title: "BRAINSTORM · PINNED", labels: { ...labels, "vs.restarted-from": "bs-1" } }) }] } : { entries: [] });
    const r = await performBrainstormRestart(
      {
        agentId: "bs-1", teamId: "site", laneId: "pinned", reason: "manual",
        oldAgent: { id: "bs-1", title: "BRAINSTORM · PINNED", cwd: dir, labels: { team: "site", lane: "pinned", role: "brainstorm" } },
        daemonClient: b,
        createRecovery: fast,
      },
      dir,
    );
    assert.equal(r.newAgentId, "a1");
    assert.equal(b.sent.length, 1);
    assert.equal(b.sent[0][0], "a1");
    assert.ok(b.sent[0][1].length > 50);
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
        { agentId: "bs-1", teamId: "site", laneId: "pinned", reason: "manual", oldAgent: { id: "bs-1", title: "B", cwd: dir, labels: { team: "site", lane: "pinned", role: "brainstorm" } }, daemonClient: b, createRecovery: fast },
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

test("the daemon's provider-refresh deadline is not treated as a recoverable create timeout", () => {
  assert.ok(!isCreateTimeoutError(new Error("Timed out refreshing Claude after 120000ms; pending: version")));
});

test("recovery matches on role+lane+team+restart origin, not on title alone, and never adopts the predecessor", async () => {
  const decoys = [
    mk({ id: "other-lane", labels: { ...labels, lane: "other" } }), // same title, other lane
    mk({ id: "other-team", labels: { ...labels, team: "elsewhere" } }),
    mk({ id: "other-role", labels: { ...labels, role: "worker" } }),
    mk({ id: "older", labels: { ...labels, "vs.restarted-from": "something-else" } }),
    mk({ id: "start-brainstorm" }), // the predecessor itself
  ];
  const b = fakeBackend([decoys]);
  assert.equal(await recoverTimedOutCreate({ backend: b, labels, title: "BUDDY", initialPrompt: "BOOT", startedMs: Date.now() - 1000, ...fast }), null);
  assert.deepEqual(b.sent, []);
  const good = fakeBackend([[...decoys, mk({ id: "real", title: "DIFFERENT TITLE" })]]);
  const a = await recoverTimedOutCreate({ backend: good, labels, title: "BUDDY", initialPrompt: "BOOT", startedMs: Date.now() - 1000, ...fast });
  assert.equal(a.id, "real");
});

test("lastActivityAt alone (stamped at creation) is not activity: the prompt is still sent; used tokens are activity", async () => {
  const stamped = fakeBackend([[mk({ lastActivityAt: new Date().toISOString() })]]);
  await recoverTimedOutCreate({ backend: stamped, labels, title: "BUDDY", initialPrompt: "BOOT", startedMs: Date.now() - 1000, ...fast });
  assert.deepEqual(stamped.sent, [["a1", "BOOT"]]);
  const used = fakeBackend([[mk({ lastUsage: { contextWindowUsedTokens: 500 } })]]);
  await recoverTimedOutCreate({ backend: used, labels, title: "BUDDY", initialPrompt: "BOOT", startedMs: Date.now() - 1000, ...fast });
  assert.deepEqual(used.sent, []);
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
        { agentId: "bs-1", teamId: "site", laneId: "pinned", reason: "manual", oldAgent: { id: "bs-1", title: "B", cwd: dir, labels: { team: "site", lane: "pinned", role: "brainstorm" } }, daemonClient: b, createRecovery: fast },
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
