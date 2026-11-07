import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { afterEach } from "node:test";
import {
  laneArtifactDir,
  readLaneSpec,
  readLaneTasks,
  renderLaneArtifactBlock,
  upsertLaneTask,
  writeLaneSpec,
} from "../server/lane-spec.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI_PATH = resolve(REPO_ROOT, "cli", "vs.mjs");

const prevTeamsFile = process.env.VIBESQUAD_TEAMS_FILE;
afterEach(() => {
  if (prevTeamsFile === undefined) delete process.env.VIBESQUAD_TEAMS_FILE;
  else process.env.VIBESQUAD_TEAMS_FILE = prevTeamsFile;
});

function setupLib() {
  const base = mkdtempSync(join(tmpdir(), "vs-lane-spec-lib-"));
  const root = join(base, "repo");
  mkdirSync(root, { recursive: true });
  const teamsFile = join(base, "teams.json");
  writeFileSync(
    teamsFile,
    JSON.stringify({ teams: [{ id: "squad", name: "Squad", paths: [], lanes: [{ id: "feat-x", name: "Feat X" }] }] }),
    "utf8",
  );
  process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
  return { base, root, teamsFile };
}

function makeCliEnv() {
  const dir = mkdtempSync(join(tmpdir(), "vs-lane-spec-cli-"));
  const vsHome = join(dir, ".vibesquad");
  const specRoot = join(dir, "spec-root");
  const paseoHome = join(dir, ".paseo");
  mkdirSync(vsHome, { recursive: true });
  mkdirSync(specRoot, { recursive: true });
  mkdirSync(join(paseoHome, "agents", "srv_test"), { recursive: true });
  const teamsFile = join(dir, "teams.json");
  writeFileSync(
    teamsFile,
    JSON.stringify({ teams: [{ id: "squad", name: "Squad", paths: [], lanes: [{ id: "feat-x", name: "Feat X" }] }] }) + "\n",
    "utf8",
  );
  const baseEnv = () =>
    Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PASEO_(AGENT_|CLI)|VS_)/.test(k)));
  return {
    dir,
    vsHome,
    specRoot,
    paseoHome,
    teamsFile,
    run(args) {
      return spawnSync(process.execPath, [CLI_PATH, ...args], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...baseEnv(),
          VIBESQUAD_HOME: vsHome,
          VIBESQUAD_ROOT: specRoot,
          VIBESQUAD_TEAMS_FILE: teamsFile,
          PASEO_HOME: paseoHome,
        },
      });
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Library: writeLaneSpec / readLaneSpec
// ---------------------------------------------------------------------------

test("writeLaneSpec / readLaneSpec round-trip into docs/lanes/<lane>/SPEC.md", () => {
  const { root } = setupLib();
  const written = writeLaneSpec("squad", "feat-x", "# Spec\nLine two\n", root);
  assert.equal(written.laneId, "feat-x");
  assert.equal(written.path, "docs/lanes/feat-x/SPEC.md");
  assert.equal(written.fullPath, join(root, "docs", "lanes", "feat-x", "SPEC.md"));
  assert.equal(written.bytes, Buffer.byteLength("# Spec\nLine two\n", "utf8"));

  const read = readLaneSpec("squad", "feat-x", root);
  assert.equal(read.exists, true);
  assert.equal(read.content, "# Spec\nLine two\n");
  assert.equal(read.path, "docs/lanes/feat-x/SPEC.md");

  // A lane that was never written is missing, not an error.
  const missing = readLaneSpec("squad", "no-such-lane", root);
  assert.equal(missing.exists, false);
  assert.equal(missing.content, "");
});

test("lane ids are safe-slugged and empty falls back to vibesquad", () => {
  const { root } = setupLib();
  const s = writeLaneSpec("squad", "Feat X", "y", root);
  assert.equal(s.laneId, "Feat-X");
  assert.equal(s.path, "docs/lanes/Feat-X/SPEC.md");

  const empty = writeLaneSpec("squad", "", "z", root);
  assert.equal(empty.laneId, "vibesquad");
  assert.equal(empty.path, "docs/lanes/vibesquad/SPEC.md");

  assert.equal(laneArtifactDir("squad", "A B/c", root), join(root, "docs", "lanes", "A-B-c"));
});

// ---------------------------------------------------------------------------
// Library: upsertLaneTask / readLaneTasks
// ---------------------------------------------------------------------------

test("upsertLaneTask appends, merges, and defaults; readLaneTasks reads the board", () => {
  const { root } = setupLib();

  const first = upsertLaneTask(
    "squad",
    "feat-x",
    { id: "u1", goal: "build it", files: ["a.mjs", "b.mjs"], doneCheck: "node --test", status: "running" },
    root,
  );
  assert.equal(first.unit.id, "u1");
  assert.equal(first.unit.goal, "build it");
  assert.deepEqual(first.unit.files, ["a.mjs", "b.mjs"]);
  assert.equal(first.unit.doneCheck, "node --test");
  assert.equal(first.unit.status, "running");
  assert.equal(first.units.length, 1);

  const board = readLaneTasks("squad", "feat-x", root);
  assert.equal(board.exists, true);
  assert.equal(board.path, "docs/lanes/feat-x/TASKS.json");
  assert.equal(board.units.length, 1);
  assert.equal(board.units[0].id, "u1");
  assert.ok(board.updatedAt, "updatedAt is stamped on write");

  // Append a second unit.
  upsertLaneTask("squad", "feat-x", { id: "u2", goal: "second" }, root);
  assert.equal(readLaneTasks("squad", "feat-x", root).units.length, 2);

  // Merge: update status only, keep the original goal.
  upsertLaneTask("squad", "feat-x", { id: "u1", status: "done" }, root);
  const u1 = readLaneTasks("squad", "feat-x", root).units.find((u) => u.id === "u1");
  assert.equal(u1.status, "done");
  assert.equal(u1.goal, "build it");

  // Defaults when only an id is supplied.
  upsertLaneTask("squad", "feat-x", { id: "u3" }, root);
  const u3 = readLaneTasks("squad", "feat-x", root).units.find((u) => u.id === "u3");
  assert.equal(u3.status, "todo");
  assert.deepEqual(u3.files, []);
  assert.equal(u3.goal, "");
  assert.equal(u3.doneCheck, "");
});

test("upsertLaneTask rejects a unit without an id and a missing board is empty", () => {
  const { root } = setupLib();
  assert.throws(() => upsertLaneTask("squad", "feat-x", { goal: "no id" }, root), /unit id/);

  const missing = readLaneTasks("squad", "never-written", root);
  assert.equal(missing.exists, false);
  assert.deepEqual(missing.units, []);
});

// ---------------------------------------------------------------------------
// Library: renderLaneArtifactBlock
// ---------------------------------------------------------------------------

test("renderLaneArtifactBlock returns '' when no artifacts exist and a deterministic block otherwise", () => {
  const { root } = setupLib();

  assert.equal(renderLaneArtifactBlock("squad", "fresh", root), "");

  // Spec only.
  writeLaneSpec("squad", "lane-a", "# Goal\nship it", root);
  const specOnly = renderLaneArtifactBlock("squad", "lane-a", root);
  assert.ok(specOnly.includes("<!-- vibesquad:lane-artifact:begin lane=lane-a -->"));
  assert.ok(specOnly.includes("Lane Artifact (`docs/lanes/lane-a/`"));
  assert.ok(specOnly.includes("[SPEC.md]"));
  assert.ok(specOnly.includes("# Goal"));
  assert.ok(specOnly.includes("[TASKS.json]"));
  assert.ok(specOnly.includes("(none)"));
  assert.ok(specOnly.includes("<!-- vibesquad:lane-artifact:end -->"));

  // Spec + tasks.
  upsertLaneTask("squad", "lane-a", { id: "u1", goal: "g", files: ["f1.mjs", "f2.mjs"], doneCheck: "dc" }, root);
  const full = renderLaneArtifactBlock("squad", "lane-a", root);
  assert.ok(full.includes('- u1 [todo] goal="g" files=[f1.mjs, f2.mjs] doneCheck="dc"'));
  assert.ok(full.includes("<!-- vibesquad:lane-artifact:end -->"));
});

// ---------------------------------------------------------------------------
// CLI: vs spec
// ---------------------------------------------------------------------------

test("vs spec write then vs spec show round-trips and prints the saved path", () => {
  const env = makeCliEnv();
  try {
    const none = env.run(["spec", "show", "--team", "squad", "--lane", "feat-x"]);
    assert.equal(none.status, 0);
    assert.equal(none.stdout, "(no lane spec yet)\n");

    const w = env.run(["spec", "write", "hello world spec", "--team", "squad", "--lane", "feat-x"]);
    assert.equal(w.status, 0);
    const specPath = w.stdout.trim();
    assert.equal(specPath, join(env.specRoot, "docs", "lanes", "feat-x", "SPEC.md"));
    assert.equal(existsSync(specPath), true);
    assert.equal(readFileSync(specPath, "utf8"), "hello world spec");

    const s = env.run(["spec", "show", "--team", "squad", "--lane", "feat-x"]);
    assert.equal(s.status, 0);
    assert.equal(s.stdout, "hello world spec\n");

    // `vs spec` (no subcommand) also shows.
    const bare = env.run(["spec", "--team", "squad", "--lane", "feat-x"]);
    assert.equal(bare.status, 0);
    assert.equal(bare.stdout, "hello world spec\n");
  } finally {
    env.cleanup();
  }
});

test("vs spec write --file and --stdin write SPEC.md", () => {
  const env = makeCliEnv();
  try {
    const srcFile = join(env.dir, "spec-source.md");
    writeFileSync(srcFile, "from a file\n", "utf8");
    const fromFile = env.run(["spec", "write", "--file", srcFile, "--team", "squad", "--lane", "feat-x"]);
    assert.equal(fromFile.status, 0);
    assert.equal(readFileSync(join(env.specRoot, "docs", "lanes", "feat-x", "SPEC.md"), "utf8"), "from a file\n");

    const fromStdin = spawnSync(
      process.execPath,
      [CLI_PATH, "spec", "write", "--stdin", "--team", "squad", "--lane", "feat-x"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        input: "from stdin\n",
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PASEO_(AGENT_|CLI)|VS_)/.test(k))),
          VIBESQUAD_HOME: env.vsHome,
          VIBESQUAD_ROOT: env.specRoot,
          VIBESQUAD_TEAMS_FILE: env.teamsFile,
          PASEO_HOME: env.paseoHome,
        },
      },
    );
    assert.equal(fromStdin.status, 0);
    assert.equal(readFileSync(join(env.specRoot, "docs", "lanes", "feat-x", "SPEC.md"), "utf8"), "from stdin\n");
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// CLI: vs task
// ---------------------------------------------------------------------------

test("vs task set then vs task list round-trips and merges", () => {
  const env = makeCliEnv();
  try {
    const set = env.run([
      "task", "set", "u1",
      "--goal", "build", "--files", "a.mjs,b.mjs", "--done-check", "node --test", "--status", "running",
      "--team", "squad", "--lane", "feat-x",
    ]);
    assert.equal(set.status, 0);
    assert.equal(set.stdout, '- u1 [running] goal="build" files=[a.mjs, b.mjs] doneCheck="node --test"\n');

    const list = env.run(["task", "list", "--team", "squad", "--lane", "feat-x"]);
    assert.equal(list.status, 0);
    assert.equal(list.stdout, '- u1 [running] goal="build" files=[a.mjs, b.mjs] doneCheck="node --test"\n');

    const listJson = env.run(["task", "list", "--team", "squad", "--lane", "feat-x", "--json"]);
    assert.equal(listJson.status, 0);
    const board = JSON.parse(listJson.stdout);
    assert.equal(board.units.length, 1);
    assert.equal(board.units[0].id, "u1");

    // Merge: flip status, keep goal.
    const merge = env.run(["task", "set", "u1", "--status", "done", "--team", "squad", "--lane", "feat-x"]);
    assert.equal(merge.status, 0);
    assert.equal(merge.stdout, '- u1 [done] goal="build" files=[a.mjs, b.mjs] doneCheck="node --test"\n');

    const after = JSON.parse(env.run(["task", "list", "--json", "--team", "squad", "--lane", "feat-x"]).stdout);
    const u1 = after.units.find((u) => u.id === "u1");
    assert.equal(u1.status, "done");
    assert.equal(u1.goal, "build");
  } finally {
    env.cleanup();
  }
});

test("vs task set validates status and requires an id", () => {
  const env = makeCliEnv();
  try {
    const badStatus = env.run(["task", "set", "u1", "--status", "bogus", "--team", "squad", "--lane", "feat-x"]);
    assert.equal(badStatus.status, 1);
    assert.match(badStatus.stderr, /--status must be todo\|running\|done\|blocked/);

    const noId = env.run(["task", "set", "--team", "squad", "--lane", "feat-x"]);
    assert.equal(noId.status, 1);
    assert.match(noId.stderr, /needs a unit id/);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// CLI: vs cap
// ---------------------------------------------------------------------------

test("vs cap add / list / clear manage capped-providers.json", () => {
  const env = makeCliEnv();
  try {
    const add = env.run(["cap", "add", "claude"]);
    assert.equal(add.status, 0);
    assert.equal(add.stdout, "capped claude\n");

    const capFile = join(env.vsHome, "capped-providers.json");
    assert.equal(existsSync(capFile), true);
    const doc = JSON.parse(readFileSync(capFile, "utf8"));
    assert.equal(doc.capped.claude.reason, "cli cap");
    assert.ok(doc.capped.claude.updatedAt);

    const list = env.run(["cap", "list"]);
    assert.equal(list.status, 0);
    assert.ok(list.stdout.includes("claude"));
    assert.ok(list.stdout.includes("cli cap"));

    const clear = env.run(["cap", "clear", "claude"]);
    assert.equal(clear.status, 0);
    assert.equal(clear.stdout, "cleared claude\n");

    const after = env.run(["cap", "list"]);
    assert.equal(after.status, 0);
    assert.equal(after.stdout, "(no capped providers)\n");
  } finally {
    env.cleanup();
  }
});

test("renderLaneArtifactBlock lists only non-done units and a done count line", () => {
  const { root } = setupLib();
  writeLaneSpec("squad", "lane-b", "# Goal", root);
  upsertLaneTask("squad", "lane-b", { id: "d1", goal: "old", status: "done" }, root);
  upsertLaneTask("squad", "lane-b", { id: "d2", goal: "old2", status: "done" }, root);
  upsertLaneTask("squad", "lane-b", { id: "r1", goal: "live", status: "running" }, root);
  const out = renderLaneArtifactBlock("squad", "lane-b", root);
  assert.ok(!out.includes("- d1 ") && !out.includes("- d2 "));
  assert.ok(out.includes('- r1 [running] goal="live"'));
  assert.ok(out.includes("2 done units (full list: docs/lanes/lane-b/TASKS.json)"));

  // N = 0 omits the line.
  writeLaneSpec("squad", "lane-c", "# Goal", root);
  upsertLaneTask("squad", "lane-c", { id: "t1", goal: "g" }, root);
  assert.ok(!renderLaneArtifactBlock("squad", "lane-c", root).includes("done units"));
});
