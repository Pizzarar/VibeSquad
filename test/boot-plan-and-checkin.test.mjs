import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findLanePlanFile } from "../server/brainstorm.mjs";
import { runCheckin } from "../src/railCheckin.ts";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "vs-lane-plan-"));
  mkdirSync(join(dir, "docs", "lanes", "bugc"), { recursive: true });
  writeFileSync(join(dir, "docs", "PLAN_OTHER_LANE.md"), "# other\n");
  writeFileSync(join(dir, "docs", "PLAN_BUGC.md"), "# mine\n");
  return dir;
}

test("fresh lane: another lane's PLAN_*.md in a shared docs/ is not picked up", () => {
  const dir = repo();
  assert.equal(findLanePlanFile(dir, dir, "fresh", "## Open\n- nothing"), "(none yet)");
});

test("plan named in the brief wins; TASKS.json is the fallback source", () => {
  const dir = repo();
  assert.equal(findLanePlanFile(dir, dir, "bugc", "Work follows `docs/PLAN_BUGC.md`."), "docs/PLAN_BUGC.md");
  writeFileSync(join(dir, "docs", "lanes", "bugc", "TASKS.json"), JSON.stringify({ units: [{ goal: "see docs/PLAN_OTHER_LANE.md" }] }));
  assert.equal(findLanePlanFile(dir, dir, "bugc", ""), "docs/PLAN_OTHER_LANE.md");
  assert.equal(findLanePlanFile(dir, dir, "bugc", "docs/PLAN_MISSING.md"), "docs/PLAN_OTHER_LANE.md", "a named but missing file is ignored");
});

test("double-click Check in sends once", async () => {
  const pin = { lead: { agent: { id: "L9", status: "idle" } } };
  const sent = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const deps = { open: () => {}, send: async (id) => (sent.push(id), gate) };
  const first = runCheckin(pin, deps);
  const second = await runCheckin(pin, deps);
  assert.equal(second, "busy");
  release();
  await first;
  assert.equal(sent.length, 1);
  await runCheckin(pin, { ...deps, send: async (id) => void sent.push(id) });
  assert.equal(sent.length, 2, "a later check-in works again");
});
