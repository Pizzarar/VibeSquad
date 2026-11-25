// idea-816: `vs pin new` must start the lane's first Buddy (via the `vs buddy restart --lane` path) or fail loudly.
import "./setup/hermetic.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "vs-pin-start-"));
const home = join(dir, "home");
const root = join(dir, "root");
mkdirSync(home, { recursive: true });
mkdirSync(join(root, "docs", "brainstorm"), { recursive: true });
for (const k of Object.keys(process.env)) if (/^(VS_|PASEO_)/.test(k)) delete process.env[k];
process.env.VIBESQUAD_HOME = home;
process.env.VIBESQUAD_ROOT = root;
delete process.env.VIBESQUAD_TEAMS_FILE;
const teamsFile = join(home, "teams.json");
const { commandPin, startPinnedLaneBuddy } = await import("../cli/vs.mjs");

const reset = () =>
  writeFileSync(
    teamsFile,
    JSON.stringify({ teams: [{ id: "team-9", name: "Team Nine", paths: [], lanes: [{ id: "hub9", name: "Hub", state: "pinned" }] }] }),
  );
const quiet = async (fn) => {
  const o = process.stdout.write, e = process.stderr.write;
  let out = "", err = "";
  process.stdout.write = (s) => ((out += s), true);
  process.stderr.write = (s) => ((err += s), true);
  try {
    return { code: await fn(), out, err };
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
};

test("pin new in a non-default team starts that lane's first Buddy", async () => {
  reset();
  const started = [];
  const r = await quiet(() =>
    commandPin({ _: ["new", "Ledger"], brief: "books", team: "team-9", json: true, ref: [] }, { startBuddy: async (lane) => (started.push(lane), { started: true, buddyId: "rn-abc" }) }),
  );
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(started, ["ledger"]);
  const j = JSON.parse(r.out);
  assert.equal(j.squad, "team-9");
  assert.equal(j.buddy.started, true);
  assert.equal(JSON.parse(readFileSync(teamsFile, "utf8")).teams[0].lanes.at(-1).id, "ledger");
});

test("a failed Buddy start is loud: exit 1, stderr, result, vs log blocker (pin still lands)", async () => {
  reset();
  const logged = [];
  const r = await quiet(() =>
    commandPin(
      { _: ["new", "Payroll"], brief: "books", team: "team-9", json: true, ref: [] },
      { startBuddy: async () => ({ started: false, error: "cap reached" }), writeLog: async (t) => logged.push(t) },
    ),
  );
  assert.equal(r.code, 1);
  assert.match(r.err, /did NOT start: cap reached/);
  assert.equal(JSON.parse(r.out).buddy.started, false);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /payroll.*cap reached/);
  assert.equal(JSON.parse(readFileSync(teamsFile, "utf8")).teams[0].lanes.at(-1).id, "payroll");
});

test("--no-start keeps the old pin-only behavior", async () => {
  reset();
  let called = false;
  const r = await quiet(() => commandPin({ _: ["new", "Taxes"], brief: "b", team: "team-9", noStart: true, ref: [] }, { startBuddy: async () => ((called = true), { started: true }) }));
  assert.equal(r.code, 0);
  assert.equal(called, false);
  assert.match(r.out, /No agent started/);
});

test("startPinnedLaneBuddy turns a restart throw into a result, not a rejection", async () => {
  assert.deepEqual(await startPinnedLaneBuddy("x", { restart: async () => { throw new Error("cannot restart a Buddy: not a live lead"); } }), { started: false, error: "cannot restart a Buddy: not a live lead" });
  assert.deepEqual(await startPinnedLaneBuddy("x", { restart: async (l) => ({ id: `b-${l}` }) }), { started: true, buddyId: "b-x" });
});
