// `vs inbox triage --archive|--park <cardId...>`: leads/Buddies of the card's Squad + owner; workers get a clear error.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertInboxTriageCaller } from "../server/inbox.mjs";

const CLI = fileURLToPath(new URL("../cli/vs.mjs", import.meta.url));

function card(id, teamId, status = "parked") {
  const now = new Date().toISOString();
  return { id, text: id, title: id, teamId, laneId: "bug-chaser", scope: "infra", status, createdAt: now, updatedAt: now };
}

function setup(t) {
  const home = mkdtempSync(path.join(tmpdir(), "vs-inbox-arch-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(path.join(home, "inbox.json"), JSON.stringify({ cards: [card("a", "vibesquad"), card("b", "vibesquad"), card("c", "other")] }));
  const statuses = () => Object.fromEntries((([j]) => (Array.isArray(j) ? j : j.cards))([JSON.parse(readFileSync(path.join(home, "inbox.json"), "utf8"))]).map((c) => [c.id, c.status]));
  const run = (args, env = {}) => {
    const e = { ...process.env, VIBESQUAD_HOME: home, ...env };
    delete e.PASEO_AGENT_ID;
    delete e.VS_AGENT_ID;
    Object.assign(e, env);
    return spawnSync(process.execPath, [CLI, "inbox", "triage", ...args], { encoding: "utf8", env: e });
  };
  return { home, run, statuses };
}

test("CLI parses --archive <ids...> (owner, no agent id) and --park", (t) => {
  const { run, statuses } = setup(t);
  const r = run(["--archive", "a", "b"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /archived a/);
  assert.match(r.stdout, /archived b/);
  assert.deepEqual(statuses(), { a: "archived", b: "archived", c: "parked" });
  const p = run(["--park", "a"]);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(statuses().a, "parked");
});

test("a worker agent gets a clear error and nothing is archived", (t) => {
  const { run, statuses } = setup(t);
  const r = run(["--archive", "a"], { PASEO_AGENT_ID: "rn-not-a-real-agent" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /leads and Buddies of the card's Squad/);
  assert.equal(statuses().a, "parked");
});

test("assertInboxTriageCaller: lead/Buddy of the Squad pass, worker and other Squads are refused", (t) => {
  const { home } = setup(t);
  for (const role of ["lead", "brainstorm"]) {
    assert.doesNotThrow(() => assertInboxTriageCaller({ agentId: "rn-x", role, teamId: "vibesquad" }, ["a", "b"], home));
  }
  assert.throws(() => assertInboxTriageCaller({ agentId: "rn-x", role: "worker", teamId: "vibesquad" }, ["a"], home), /is a worker/);
  assert.throws(() => assertInboxTriageCaller({ agentId: "rn-x", role: "lead", teamId: "vibesquad" }, ["c"], home), /belongs to Squad "other"/);
  assert.throws(() => assertInboxTriageCaller({ agentId: "rn-x", role: "lead", teamId: "vibesquad" }, ["zzz"], home), /not found/);
  assert.doesNotThrow(() => assertInboxTriageCaller({ agentId: "", role: "worker", teamId: "" }, ["c"], home));
});
