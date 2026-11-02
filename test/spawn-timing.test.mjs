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
    for (const step of ["prep=", "createAgent=", "retire=", "total="]) assert.ok(timing[0].text.includes(step), step);
  } finally {
    if (prev === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
