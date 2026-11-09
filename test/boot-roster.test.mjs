// B2 (docs/PLAN_LEAN_BOOT_1109.md): one boot roster filter + 4k budget. 75 closed workers + 6 leads must list 1 lead, 0 closed workers.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubTeamsBlock } from "../server/brainstorm.mjs";
import { BOOT_CONTEXT_BUDGET, bootRoster } from "../server/boot-roster.mjs";
import { liveInFlightBlock } from "../server/in-flight.mjs";
import { whosHereBody } from "../server/whos-here.mjs";

const labels = (role, extra = {}) => ({ team: "vibesquad", lane: "own", role, ...extra });
const day = (n) => new Date(Date.UTC(2026, 10, 1 + n)).toISOString();

function fixture() {
  const agents = [];
  for (let i = 0; i < 6; i++) {
    agents.push({ id: `lead${i}`, title: `Lead ${i}`, status: "closed", resumable: true, createdAt: day(i), labels: labels("lead", { job: "j" }) });
  }
  for (let i = 0; i < 75; i++) {
    agents.push({ id: `w${i}`, title: `Worker ${i} · a long unit title to bloat the roster`, status: "closed", resumable: true, createdAt: day(i % 9), labels: labels("worker") });
  }
  agents.push({ id: "w-run", title: "Worker running", status: "running", createdAt: day(10), labels: labels("worker") });
  return agents;
}

test("75 closed workers + 6 leads: 1 lead, 0 closed workers, under budget", () => {
  const agents = fixture();
  const r = bootRoster(agents, "own");
  assert.equal(r.lead.id, "lead5");
  assert.deepEqual(r.workers.map((w) => w.id), ["w-run"]);
  const home = mkdtempSync(join(tmpdir(), "vs-b2-"));
  try {
    const block = liveInFlightBlock({ agents, laneId: "own", teamId: "vibesquad", home });
    assert.ok(block.length < BOOT_CONTEXT_BUDGET, `in-flight ${block.length}`);
    assert.match(block, /- Lead: Lead 5/);
    assert.equal((block.match(/Lead \d/g) ?? []).length, 1);
    assert.doesNotMatch(block, /Worker \d+ ·/);
    assert.match(block, /Worker running/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const who = whosHereBody(agents, "own");
  assert.match(who, /- Lead: Lead 5$/m);
  assert.match(who, /- Workers: 1$/m);
  const team = { id: "vibesquad", lanes: [{ id: "own", name: "Own", state: "pinned" }] };
  assert.match(hubTeamsBlock({ team, agents }), /lead working: j/);
});

test("a closed lead that is not the newest lead does not count", () => {
  const old = { id: "old", title: "Old lead", status: "closed", resumable: true, createdAt: day(1), labels: labels("lead") };
  const dead = { id: "new", title: "New lead", status: "closed", resumable: false, createdAt: day(5), labels: labels("lead") };
  assert.equal(bootRoster([old, dead], "own").lead, null);
  assert.equal(bootRoster([old], "own").lead.id, "old");
});

test("many running workers overflow into +N more, still under budget", () => {
  const agents = Array.from({ length: 80 }, (_, i) => ({ id: `r${i}`, title: `Running worker ${i} with a longish title`, status: "running", createdAt: day(i % 20), labels: labels("worker") }));
  const home = mkdtempSync(join(tmpdir(), "vs-b2-"));
  try {
    const block = liveInFlightBlock({ agents, laneId: "own", teamId: "vibesquad", home });
    assert.ok(block.length < BOOT_CONTEXT_BUDGET, `${block.length}`);
    assert.match(block, /\+\d+ more → vs who all/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
