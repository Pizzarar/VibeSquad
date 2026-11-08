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
  JSON.stringify({ teams: [{ id: "t", name: "T", paths: ["MyGame"], lanes: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "e" }] }, { id: "u", name: "U", paths: ["Other"], lanes: [{ id: "dup" }, { id: "dup2" }] }, { id: "v", name: "V", paths: ["MyGame"], lanes: [{ id: "dup" }] }] }),
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
  orphan("dup", "ambiguous"); // lane id in two squads
  orphan("e", NO_BRIEF_LINE); // placeholder orphan is never moved
  mkdirSync(join(base, "Other"), { recursive: true });

  const logs = [];
  const log = (e) => logs.push(e);
  const r = sweepBriefOrphans(rootDir, { log });
  assert.deepEqual(r, { moved: 2, conflicts: 2, skipped: 2, failed: 0 });
  assert.equal(readFileSync(projFile("a"), "utf8"), "brief A");
  assert.equal(readFileSync(projFile("b"), "utf8"), "brief B");
  assert.equal(readFileSync(projFile("c"), "utf8"), "real C");
  assert.ok(!existsSync(join(rootDir, "docs", "brainstorm", "a.md")));
  assert.ok(!existsSync(join(rootDir, "docs", "brainstorm", "b.md")));
  assert.equal(readFileSync(join(rootDir, "docs", "brainstorm", "c.md"), "utf8"), "orphan C");
  assert.equal(readFileSync(join(rootDir, "docs", "brainstorm", "nolane.md"), "utf8"), "stays");
  assert.equal(logs.length, 2);
  assert.ok(logs.some((l) => /brief-orphan-conflict lane=c /.test(l.text)));
  assert.ok(logs.some((l) => /lane=dup reason=ambiguous/.test(l.text)));
  assert.equal(readFileSync(join(rootDir, "docs", "brainstorm", "dup.md"), "utf8"), "ambiguous");
  assert.ok(!existsSync(projFile("dup")) && !existsSync(projFile("e")));

  // Second run: only the conflict and the unresolvable lane remain; nothing moves, nothing is overwritten.
  const r2 = sweepBriefOrphans(rootDir, { log });
  assert.deepEqual(r2, { moved: 0, conflicts: 2, skipped: 2, failed: 0 });
  assert.equal(readFileSync(projFile("c"), "utf8"), "real C");
});

test("runBriefOrphanSweep logs the summary and never throws", () => {
  const logs = [];
  const r = runBriefOrphanSweep(rootDir, { log: (e) => logs.push(e.text) });
  assert.equal(r.moved, 0);
  assert.ok(logs.some((t) => t === "brief-orphan-sweep moved=0 conflicts=2 skipped=2 failed=0"));
  assert.equal(runBriefOrphanSweep(rootDir, { log: () => { throw new Error("boom"); } }), null);
  assert.equal(runBriefOrphanSweep(join(base, "nope")).moved, 0);
});

test("dev checkout (not the installed runtime) is a no-op", () => {
  const dev = join(base, "dev");
  mkdirSync(join(dev, "docs", "brainstorm"), { recursive: true });
  writeFileSync(join(dev, "docs", "brainstorm", "a.md"), "dev brief");
  assert.deepEqual(sweepBriefOrphans(dev, { log() {} }), { moved: 0, conflicts: 0, skipped: 0, failed: 0 });
  assert.ok(existsSync(join(dev, "docs", "brainstorm", "a.md")));
});

test.after(() => rmSync(base, { recursive: true, force: true }));
