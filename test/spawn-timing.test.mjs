import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSpawnTimer, performBrainstormRestart, resetBrainstormRestartState } from "../server/brainstorm.mjs";

test("spawn timer lists each marked step and a total", () => {
  const t = createSpawnTimer("new-buddy");
  t.mark("connect");
  t.mark("createAgent");
  assert.match(t.summary(), /^new-buddy: connect=\d+ms createAgent=\d+ms total=\d+ms$/);
});

test("a Buddy restart writes one spawn-timing metric with every step", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-spawn-timing-"));
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = join(dir, ".vibesquad");
  resetBrainstormRestartState();
  try {
    mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
    const daemon = {
      async createAgent() { return { id: "new-1" }; },
      async cancelAgent() {},
      async updateAgent() {},
      async archiveAgent() {},
    };
    const r = await performBrainstormRestart(
      {
        agentId: "bs-1", teamId: "site", laneId: "pinned", reason: "manual",
        oldAgent: { id: "bs-1", title: "BRAINSTORM · PINNED", cwd: dir, labels: { team: "site", lane: "pinned", role: "brainstorm" } },
        daemonClient: daemon,
      },
      dir,
    );
    assert.equal(r.newAgentId, "new-1");
    const lines = readFileSync(join(dir, ".vibesquad", "teams", "site", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const timing = lines.filter((e) => e.text.startsWith("spawn-timing buddy-restart:"));
    assert.equal(timing.length, 1);
    assert.equal(timing[0].type, "metric");
    for (const step of ["prep=", "createAgent=", "total="]) assert.ok(timing[0].text.includes(step), step);
  } finally {
    if (prev === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart replies before the old Buddy finishes retiring, and still retires it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-spawn-retire-"));
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = join(dir, ".vibesquad");
  resetBrainstormRestartState();
  try {
    mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
    const calls = [];
    let releaseArchive;
    const gate = new Promise((r) => (releaseArchive = r));
    const daemon = {
      async createAgent() { return { id: "new-2" }; },
      async cancelAgent(id) { calls.push(["cancel", id]); },
      async updateAgent(id) { calls.push(["update", id]); },
      async archiveAgent(id) { await gate; calls.push(["archive", id]); },
    };
    const r = await performBrainstormRestart(
      {
        agentId: "bs-2", teamId: "site", laneId: "pinned", reason: "manual",
        oldAgent: { id: "bs-2", title: "BRAINSTORM · PINNED", cwd: dir, labels: { team: "site", lane: "pinned", role: "brainstorm" } },
        daemonClient: daemon,
      },
      dir,
    );
    assert.equal(r.newAgentId, "new-2");
    assert.ok(!calls.some(([k]) => k === "archive"), "reply must not wait for archive");
    releaseArchive();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(calls.map(([k]) => k), ["cancel", "update", "archive"]);
  } finally {
    if (prev === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
