// K2b (docs/lanes/perfection/K2B.md) end to end: a fake agy ACP child under the real Runner + ACP adapter, its log events folded
// by the real reduceTurn into the backend's turn events, driving the real compact-step.
import "./helpers/clean-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Runner } from "../runner/runner.mjs";
import { createAcpAdapter } from "../runner/adapters/acp.mjs";
import { reduceTurn } from "../server/backend/runner-backend.mjs";
import { createCompactor } from "../server/compact-step.mjs";

const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} } });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), "vs-k2b-")); tmpDirs.push(d); return d; };
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

/** Fake `agy acp`: prompt n is answered by replies[n](child, msg); records every prompt text. */
function fakeAgy(replies) {
  const prompts = [];
  const impl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => child.emit("exit", null, "SIGTERM");
    const push = (o) => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
    child.stdin.on("data", (d) => {
      for (const l of String(d).split("\n").filter(Boolean)) {
        const m = JSON.parse(l);
        if (m.method === "initialize") push({ id: m.id, result: { protocolVersion: 1 } });
        if (m.method === "session/new") push({ id: m.id, result: { sessionId: "S" } });
        if (m.method === "session/prompt") {
          prompts.push(m.params.prompt[0].text);
          const reply = replies[Math.min(prompts.length - 1, replies.length - 1)];
          setTimeout(() => reply(push, m), 5);
        }
      }
    });
    return child;
  };
  return { impl, prompts };
}
const usageUpd = (push, used) => push({ method: "session/update", params: { update: { sessionUpdate: "usage_update", used, size: 1048576 } } });

/** The backend side, reduced: turn events from the log (reduceTurn), the meter from the last usage, fetchAgent = the runner now. */
function harness(replies, opts = {}) {
  const agy = fakeAgy(replies);
  const adapter = createAcpAdapter({ spawnImpl: agy.impl, provider: "antigravity-cli", mcp: false, resolved: { file: "/bin/agy", args: [] } });
  const runner = new Runner({ dir: tmp(), adapters: { "antigravity-cli": { start: (o) => adapter.start(o) } } });
  const listeners = new Set();
  const turn = new Map();
  const meter = new Map();
  const emit = (ev) => { for (const l of listeners) l(ev); };
  runner.subscribe((id, e) => {
    if (e.type === "usage" && Number.isFinite(e.contextTokens)) meter.set(id, e.contextTokens);
    if (e.type === "compacted") emit({ kind: "timeline", agentId: id, type: "compacted" });
    const t = turn.get(id) ?? turn.set(id, { status: "idle" }).get(id);
    const ev = reduceTurn(t, e);
    if (ev) emit({ ...ev, agentId: id });
  });
  const labels = [];
  const agentNow = (id) => ({ id, provider: "antigravity-cli", status: turn.get(id)?.status ?? "idle", usedTokens: meter.get(id) ?? 0, labels: {} });
  const shim = {
    subscribeEvents(l) { listeners.add(l); return () => listeners.delete(l); },
    async sendAgentPrompt(id, text) { const r = runner.send(id, text); return { ok: true, queued: r?.queued === true }; },
    async updateAgent(_id, p) { labels.push(p.labels); },
    async fetchAgent(id) { return { agent: agentNow(id) }; },
  };
  const lines = [];
  const c = createCompactor({ runner: shim, timeoutMs: 400, settleMs: 60, idlePollMs: 10, lateBoundaryMs: 80, maxAttempts: 2, readEvents: (id) => runner.timeline(id), log: (e) => lines.push(e.text), ...opts });
  return { runner, agy, c, lines, labels, agentNow };
}

test("K2b e2e: agy lead at 150k -> bare /compact, synthesized boundary, ok with after = the summary, spend off the log", async () => {
  const h = harness([
    (push, m) => { usageUpd(push, 150_000); push({ id: m.id, result: { stopReason: "end_turn" } }); },
    (push, m) => { usageUpd(push, 152_000); push({ id: m.id, result: { stopReason: "end_turn", usage: { inputTokens: 3_000, cachedReadTokens: 147_000, outputTokens: 4_000 } } }); },
  ]);
  const id = h.runner.create({ provider: "antigravity-cli", model: "gemini-4-neon-low", cwd: ".", prompt: "hello" });
  for (let i = 0; i < 20 && h.agentNow(id).usedTokens !== 150_000; i++) await tick();
  await tick(30);
  const res = await h.c.run(h.agentNow(id), { focus: "keep the plan", cap: 150_000, kind: "lead", armed: true, labels: { "vs.compact-count": "1" } });
  assert.equal(res.outcome, "ok", h.lines.join("\n"));
  assert.deepEqual([res.before, res.after, res.attempts, res.tokens], [150_000, 4_000, 1, 154_000]);
  assert.ok(res.costUsd > 0);
  assert.deepEqual(h.agy.prompts.slice(1), ["/compact"]);
  assert.equal(h.labels.length, 1);
  assert.match(h.lines[0], /^compact-step lead agent=\S+ outcome=ok before=150000 after=4000 cap=150000 ms=\d+ costUsd=[\d.]+ tokens=154000 attempts=1$/);
  h.runner.shutdown();
});

test("K2b e2e: an agy /compact that never ends in end_turn -> no boundary, failed after maxAttempts (the caller's handoff runs, no hang)", async () => {
  const h = harness([
    (push, m) => { usageUpd(push, 150_000); push({ id: m.id, result: { stopReason: "end_turn" } }); },
    (push, m) => push({ id: m.id, result: { stopReason: "max_tokens" } }),
  ]);
  const id = h.runner.create({ provider: "antigravity-cli", cwd: ".", prompt: "hello" });
  for (let i = 0; i < 20 && h.agentNow(id).usedTokens !== 150_000; i++) await tick();
  await tick(30);
  const t0 = Date.now();
  const res = await h.c.run(h.agentNow(id), { cap: 150_000, armed: true, labels: {} });
  assert.equal(res.outcome, "failed");
  assert.equal(res.reason, "no-boundary");
  assert.equal(res.attempts, 2);
  assert.deepEqual(h.agy.prompts.slice(1), ["/compact", "/compact"]);
  assert.ok(Date.now() - t0 < 2_000);
  h.runner.shutdown();
});
