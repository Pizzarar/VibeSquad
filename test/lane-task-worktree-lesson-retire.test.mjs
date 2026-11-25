import "./setup/hermetic.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { appendLesson, readLessons, renderLessonsDigest, retireLesson } from "../server/lessons.mjs";
import { lessonsDigestBlock } from "../server/hooks/agent-duties.ts";

const CLI = resolve(import.meta.dirname, "..", "cli", "vs.mjs");
const git = (cwd, ...a) => {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};

// idea-932: lane dir resolves to the project's MAIN checkout; run from a linked worktree the write must land in the worktree.
test("vs task set from a linked worktree writes the worktree's TASKS.json, not the main checkout's", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vs-932-")));
  try {
    const projects = join(dir, "projects");
    const main = join(projects, "Proj");
    const specRoot = join(projects, "Spec");
    const wt = join(dir, "wt", "unit-x");
    mkdirSync(main, { recursive: true });
    mkdirSync(specRoot, { recursive: true });
    git(main, "init", "-q");
    git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "worktree", "add", "-q", wt, "-b", "unit-x");
    const teamsFile = join(dir, "teams.json");
    writeFileSync(teamsFile, JSON.stringify({ teams: [{ id: "squad", name: "Squad", paths: [main], lanes: [{ id: "feat-x", name: "Feat X" }] }] }));
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PASEO_(AGENT_|CLI)|VS_)/.test(k))),
      VIBESQUAD_HOME: join(dir, ".vibesquad"), VIBESQUAD_ROOT: specRoot, VIBESQUAD_TEAMS_FILE: teamsFile, PASEO_HOME: join(dir, ".paseo") };
    const run = (cwd, args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env });

    const set = run(wt, ["task", "set", "u1", "--status", "done", "--team", "squad", "--lane", "feat-x"]);
    assert.equal(set.status, 0, set.stderr);
    const wtFile = join(wt, "docs", "lanes", "feat-x", "TASKS.json");
    assert.ok(existsSync(wtFile), "TASKS.json written in the worktree");
    assert.equal(JSON.parse(readFileSync(wtFile, "utf8")).units[0].status, "done");
    assert.ok(!existsSync(join(main, "docs", "lanes", "feat-x", "TASKS.json")), "main checkout untouched");
    assert.match(set.stderr, /wrote .*unit-x.*TASKS\.json/);
    assert.equal(JSON.parse(run(wt, ["task", "list", "--json", "--team", "squad", "--lane", "feat-x"]).stdout).units.length, 1);

    // From the main checkout itself the write stays there.
    const set2 = run(main, ["task", "set", "u2", "--team", "squad", "--lane", "feat-x"]);
    assert.equal(set2.status, 0, set2.stderr);
    assert.ok(existsSync(join(main, "docs", "lanes", "feat-x", "TASKS.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// idea-991
test("lesson retire hides a lesson from reads and both digests but keeps the audit line", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-991-"));
  try {
    const store = join(dir, "lessons.jsonl");
    appendLesson({ id: "a", category: "general", title: "Pin Sonnet", cause: "c", rule: "pin it" }, { storePath: store });
    appendLesson({ id: "b", category: "general", title: "Keep me", cause: "c", rule: "keep" }, { storePath: store });
    assert.throws(() => retireLesson("nope", { storePath: store }), /no active lesson/);
    const res = retireLesson("pin sonnet", { reason: "obsolete", storePath: store });
    assert.equal(res.id, "a");
    assert.deepEqual(readLessons({ storePath: store }).map((l) => l.id), ["b"]);
    assert.ok(!renderLessonsDigest({ storePath: store }).includes("Pin Sonnet"));
    const block = lessonsDigestBlock({ storePath: store });
    assert.ok(block.includes("Keep me") && !block.includes("Pin Sonnet"));
    const raw = readFileSync(store, "utf8");
    assert.match(raw, /"title":"Pin Sonnet"/);
    assert.match(raw, /"retire":"a","reason":"obsolete"/);
    assert.throws(() => retireLesson("a", { storePath: store }), /no active lesson/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vs lesson retire CLI works by id and is in --help", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-991c-"));
  try {
    const env = { ...process.env, VIBESQUAD_HOME: dir };
    const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: "utf8", env });
    const add = run("lesson", "add", "T1", "R1", "--json");
    const id = JSON.parse(add.stdout).id;
    const r = run("lesson", "retire", id, "--reason", "x");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Retired lesson/);
    assert.match(run("lesson", "list").stdout, /no logged lessons/);
    assert.match(run("--help").stdout, /lesson add .*retire <title\|id>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
