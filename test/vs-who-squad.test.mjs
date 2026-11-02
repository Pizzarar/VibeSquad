import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI_PATH = resolve(REPO_ROOT, "cli", "vs.mjs");

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "vs-who-squad-"));
  const vsHome = join(dir, ".vibesquad");
  const paseoHome = join(dir, ".paseo");
  const agentsDir = join(paseoHome, "agents", "srv_test");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(vsHome, { recursive: true });
  writeFileSync(
    join(vsHome, "teams.json"),
    JSON.stringify({
      teams: [
        {
          id: "efi",
          name: "Main Project",
          paths: ["main-project"],
          lanes: [
            { id: "main-game", name: "Main Game" },
            { id: "ui-lab", name: "UI Lab" },
          ],
        },
        { id: "site", name: "Example Site", paths: ["example-site"], lanes: [{ id: "site-polish", name: "Site Polish" }] },
      ],
    }) + "\n",
    "utf8",
  );
  const agent = (id, title, labels, extra = {}) =>
    writeFileSync(
      join(agentsDir, `${id}.json`),
      JSON.stringify({ id, title, lastStatus: "idle", cwd: join(dir, "elsewhere"), labels, lastUsage: { contextWindowUsedTokens: 5000 }, ...extra }),
      "utf8",
    );
  agent("lead-main", "LEAD main", { team: "efi", lane: "main-game", role: "lead", ord: "1" });
  agent("lead-ui", "LEAD ui", { team: "efi", lane: "ui-lab", role: "lead", ord: "1" });
  agent("buddy-ui", "BUDDY ui", { team: "efi", lane: "ui-lab", role: "brainstorm" });
  agent("worker-main", "WORKER main", { team: "efi", lane: "main-game", role: "worker" });
  agent("lead-site", "LEAD site", { team: "site", lane: "site-polish", role: "lead", ord: "1" });
  agent("no-lane", "NO LANE", { team: "efi", role: "worker" });
  return {
    run(args, extraEnv = {}) {
      return spawnSync(process.execPath, [CLI_PATH, ...args], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, VIBESQUAD_HOME: vsHome, PASEO_HOME: paseoHome, PASEO_AGENT_ID: "", VS_TEAM: "", VS_LANE: "", ...extraEnv },
      });
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("who all --team lists every lane in the squad, grouped by lane", () => {
  const env = makeEnv();
  try {
    const res = env.run(["who", "all", "--team", "efi"]);
    assert.equal(res.status, 0, res.stderr);
    const lines = res.stdout.trim().split(/\r?\n/);
    const headers = lines.filter((l) => l.startsWith("["));
    assert.deepEqual(headers, ["[main-game]", "[ui-lab]"]);
    assert.ok(res.stdout.includes("lead-main") && res.stdout.includes("worker-main"));
    assert.ok(res.stdout.includes("lead-ui") && res.stdout.includes("buddy-ui"));
    assert.ok(!res.stdout.includes("lead-site"), "other squads stay out");
    assert.ok(lines.indexOf("[main-game]") < lines.findIndex((l) => l.includes("lead-ui")));
  } finally {
    env.cleanup();
  }
});

test("who all --team --lane keeps single-lane scoping", () => {
  const env = makeEnv();
  try {
    const res = env.run(["who", "all", "--team", "efi", "--lane", "ui-lab"]);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes("lead-ui") && res.stdout.includes("buddy-ui"));
    assert.ok(!res.stdout.includes("lead-main"));
    assert.ok(!res.stdout.includes("["), "no lane headers when scoped to one lane");
  } finally {
    env.cleanup();
  }
});

test("who all with no flags lists the caller's whole squad", () => {
  const env = makeEnv();
  try {
    const res = env.run(["who", "all"], { PASEO_AGENT_ID: "worker-main" });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes("[main-game]") && res.stdout.includes("[ui-lab]"));
  } finally {
    env.cleanup();
  }
});

test("who lead with no --lane still resolves the caller's own lane from its label", () => {
  const env = makeEnv();
  try {
    const res = env.run(["who", "lead"], { PASEO_AGENT_ID: "buddy-ui" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "LEAD ui · lead-ui · idle · 5k");
  } finally {
    env.cleanup();
  }
});

test("who lead for a caller without a lane label in a multi-lane squad does not guess lanes[0]", () => {
  const env = makeEnv();
  try {
    const res = env.run(["who", "lead", "--team", "efi"]);
    assert.equal(res.status, 1);
    assert.equal(res.stdout.trim(), "NONE");
  } finally {
    env.cleanup();
  }
});

test("whoami for an agent with a team label but no lane label prints lane: unassigned", () => {
  const env = makeEnv();
  try {
    // Team but no lane is an orphan, never the Squad's first lane.
    const res = env.run(["whoami", "--agent", "no-lane"]);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /^lane: unassigned · squad: _unassigned/);
    const labelled = env.run(["whoami", "--agent", "worker-main"]);
    assert.match(labelled.stdout, /^lane: main-game · squad: efi/);
  } finally {
    env.cleanup();
  }
});
