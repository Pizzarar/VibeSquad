import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "vs-orphan-"));
const rootDir = join(base, "runtime");
const proj = join(base, "MyGame");
mkdirSync(join(rootDir, "docs", "brainstorm"), { recursive: true });
mkdirSync(proj, { recursive: true });
writeFileSync(
  join(base, "teams.json"),
  JSON.stringify({ teams: [{ id: "t", name: "T", paths: ["MyGame"], lanes: [{ id: "a" }, { id: "b" }, { id: "c" }] }] }),
);
process.env.VIBESQUAD_TEAMS_FILE = join(base, "teams.json");
process.env.VIBESQUAD_HOME = join(base, "home");

const { sweepBriefOrphans, runBriefOrphanSweep } = await import("../server/brief-orphan-sweep.mjs");
const { NO_BRIEF_LINE } = await import("../server/brainstorm.mjs");

const orphan = (lane, text) => writeFileSync(join(rootDir, "docs", "brainstorm", `${lane}.md`), text);
const projFile = (lane) => join(proj, "docs", "brainstorm", `${lane}.md`);

test("sweep moves, keeps conflicts, leaves unresolvable, and is idempotent", () => {
  orphan("a", "brief A"); // missing project brief
  orphan("b", "brief B"); // placeholder project brief
  mkdirSync(join(proj, "docs", "brainstorm"), { recursive: true });
  writeFileSync(projFile("b"), NO_BRIEF_LINE);
  orphan("c", "orphan C"); // real project brief
  writeFileSync(projFile("c"), "real C");
  orphan("nolane", "stays");

  const logs = [];
  const log = (e) => logs.push(e);
  const r = sweepBriefOrphans(rootDir, { log });
  assert.deepEqual(r, { moved: 2, conflicts: 1, skipped: 1 });
  assert.equal(readFileSync(projFile("a"), "utf8"), "brief A");
  assert.equal(readFileSync(projFile("b"), "utf8"), "brief B");
  assert.equal(readFileSync(projFile("c"), "utf8"), "real C");
  assert.ok(!existsSync(join(rootDir, "docs", "brainstorm", "a.md")));
  assert.ok(!existsSync(join(rootDir, "docs", "brainstorm", "b.md")));
  assert.equal(readFileSync(join(rootDir, "docs", "brainstorm", "c.md"), "utf8"), "orphan C");
  assert.equal(readFileSync(join(rootDir, "docs", "brainstorm", "nolane.md"), "utf8"), "stays");
  assert.equal(logs.length, 1);
  assert.match(logs[0].text, /brief-orphan-conflict lane=c /);

  // Second run: only the conflict and the unresolvable lane remain; nothing moves, nothing is overwritten.
  const r2 = sweepBriefOrphans(rootDir, { log });
  assert.deepEqual(r2, { moved: 0, conflicts: 1, skipped: 1 });
  assert.equal(readFileSync(projFile("c"), "utf8"), "real C");
});

test("runBriefOrphanSweep logs the summary and never throws", () => {
  const logs = [];
  const r = runBriefOrphanSweep(rootDir, { log: (e) => logs.push(e.text) });
  assert.equal(r.moved, 0);
  assert.ok(logs.some((t) => t === "brief-orphan-sweep moved=0 conflicts=1 skipped=1"));
  assert.equal(runBriefOrphanSweep(rootDir, { log: () => { throw new Error("boom"); } }), null);
  assert.equal(runBriefOrphanSweep(join(base, "nope")).moved, 0);
  rmSync(base, { recursive: true, force: true });
});
