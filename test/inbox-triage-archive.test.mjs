// `vs inbox triage --archive|--park <cardId...>`: the owner's shell (direct disk write when the server is down) and the
// server-side role gate (assertInboxTriageCaller). An agent id without its token is a 403 before any card is looked at
// (X1d); the verified-agent paths (lead/Buddy through the server, worker refusal) live in test/x1b-client-token.test.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // X1b: the owner cases hold the local token (owner proof); VIBESQUAD_PORT=1 keeps the VS server unreachable so the
  // owner path takes the direct-disk fallback this file exercises. An agent id without a token never gets that far (X1d).
  writeFileSync(path.join(home, "local-token"), "a".repeat(64) + String.fromCharCode(10));
  const statuses = () => Object.fromEntries((([j]) => (Array.isArray(j) ? j : j.cards))([JSON.parse(readFileSync(path.join(home, "inbox.json"), "utf8"))]).map((c) => [c.id, c.status]));
  const agent = (id, role, team = "vibesquad") => {
    const dir = path.join(home, "runner", "agents");
    mkdirSync(dir, { recursive: true });
    const ts = Date.now();
    const lines = [
      { seq: 0, ts, type: "created", provider: "claude", model: "m", cwd: home, meta: { title: id, labels: { role, team, lane: "bug-chaser" } } },
      { seq: 1, ts, type: "status", status: "parked" },
    ];
    writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10));
    return id;
  };
  const run = (args, env = {}) => {
    const e = { ...process.env, VIBESQUAD_HOME: home, VIBESQUAD_PORT: "1", ...env };
    delete e.PASEO_AGENT_ID;
    delete e.VS_AGENT_ID;
    delete e.VS_AGENT_TOKEN; // X1b: a token from the suite's own agent would turn the spawned CLI into a verified caller
    Object.assign(e, env);
    return spawnSync(process.execPath, [CLI, "inbox", "triage", ...args], { encoding: "utf8", env: e });
  };
  return { home, run, statuses, agent };
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

test("X1d guard: an agent id without a token (worker or lead record on disk, or no record at all) is a 403 on EVERY mutating triage action, before any card is looked at; nothing is written", (t) => {
  const { run, statuses, agent } = setup(t);
  const all = [
    ["--archive", "a"],
    ["--park", "a"],
    ["--set-status", "a", "--status", "archived"],
    ["--accept", "a"],
    ["--reject", "a"],
    ["--merge", "a", "b"],
    ["--bounce", "a", "--lane", "other-lane"],
    ["--delete", "a"],
  ];
  const cases = [
    [{ PASEO_AGENT_ID: agent("rn-worker1", "worker") }, all],
    [{ PASEO_AGENT_ID: agent("rn-lead1", "lead") }, all], // the lead's record on disk is not an identity
    [{ PASEO_AGENT_ID: "rn-lead1", VS_AGENT_TOKEN_REQUIRED: "0" }, [["--archive", "a"]]], // the X1a-X1b rollout flag is gone
    [{ PASEO_AGENT_ID: "rn-ghost", VS_AGENT_ID: "rn-ghost", VS_ROLE: "lead", VS_TEAM: "vibesquad" }, [["--archive", "a"]]], // no record, env claims lead
  ];
  for (const [env, list] of cases) {
    for (const args of list) {
      const r = run(args, env);
      assert.notEqual(r.status, 0, `${JSON.stringify(env)} ${args.join(" ")}`);
      assert.match(r.stderr, /403/, `${JSON.stringify(env)} ${args.join(" ")}: ${r.stderr}`);
    }
  }
  assert.deepEqual(statuses(), { a: "parked", b: "parked", c: "parked" });
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

test("--delete is owner-only: the owner can delete (a verified lead is told to use --archive in test/x1b-client-token.test.mjs)", (t) => {
  const { run, statuses } = setup(t);
  const o = run(["--delete", "a"]);
  assert.equal(o.status, 0, o.stderr);
  assert.equal(statuses().a, undefined);
});
