import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleFsRead, findInWorktrees } from "../server/file-search.mjs";
import { laneWorktreeCandidates, worktreeLabel } from "../server/vibesquad-api.mjs";

const base = realpathSync(mkdtempSync(join(tmpdir(), "vs-lwl-")));
const main = join(base, "projects", "Repo");
const sanct = join(base, "worktrees");
const wtA = join(sanct, "Repo", "art-a");
const wtB = join(sanct, "Repo", "art-b");
for (const d of [main, wtA, wtB]) mkdirSync(join(d, "scratch/shots"), { recursive: true });
writeFileSync(join(wtA, "scratch/shots/only-a.png"), "A");
writeFileSync(join(wtA, "scratch/shots/both.png"), "A");
writeFileSync(join(wtB, "scratch/shots/both.png"), "B");
writeFileSync(join(main, "scratch/shots/local.png"), "M");

const outside = realpathSync(mkdtempSync(join(tmpdir(), "vs-lwl-out-")));
mkdirSync(join(outside, "scratch"), { recursive: true });
writeFileSync(join(outside, "scratch/escaped.png"), "X");
let junction = true;
try { symlinkSync(outside, join(sanct, "Repo", "evil"), "junction"); } catch { junction = false; }

const call = (cwd, path, roots, wts) => {
  const out = {};
  const res = { statusCode: 0, headers: {}, setHeader() {}, end(b) { out.body = b; } };
  handleFsRead({ method: "GET", url: `/x?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}` }, res, roots, (r, st, j) => { out.status = st; out.json = j; }, wts, (d) => worktreeLabel(d, sanct));
  out.status ??= res.statusCode;
  return out;
};
const cands = (cwd) => laneWorktreeCandidates(cwd, [main], { sanctuary: sanct, agents: [] });

test("sanctuary candidates are the same repo's worktrees", () => {
  assert.deepEqual(cands(main).sort(), [wtA, wtB].sort());
});

test("worktree-only file resolves from the unique worktree", () => {
  const r = call(main, "scratch/shots/only-a.png", [main], cands);
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), "A");
});

test("file under cwd wins; no fallback needed", () => {
  assert.equal(call(main, "scratch/shots/local.png", [main], cands).body.toString(), "M");
});

test("ambiguous match is refused and lists the worktrees", () => {
  const r = call(main, "scratch/shots/both.png", [main], cands);
  assert.equal(r.status, 409);
  assert.equal(r.json.matches.length, 2);
  assert.match(r.json.error, /ambiguous/);
  assert.deepEqual([...r.json.matches].sort(), ["art-a/scratch/shots/both.png", "art-b/scratch/shots/both.png"]);
  assert.ok(!JSON.stringify(r.json).includes(base), "no raw host paths in the reply");
});

test("missing everywhere stays 404; traversal still refused", () => {
  assert.equal(call(main, "scratch/shots/nope.png", [main], cands).status, 404);
  assert.equal(call(main, "../Repo/x", [main], cands).status, 400);
  assert.equal(call(main, "../../worktrees/Repo/art-a/scratch/shots/only-a.png", [main], cands).status, 400);
  assert.deepEqual(findInWorktrees(main, "../x", [wtA]), {});
});

test("links carrying the sanctuary prefix resolve to the candidate", () => {
  for (const p of [
    "worktrees/Repo/art-a/scratch/shots/only-a.png",
    "worktrees\\Repo\\art-a\\scratch\\shots\\only-a.png",
    "Repo/art-a/scratch/shots/only-a.png",
    "art-a/scratch/shots/only-a.png",
  ]) {
    const r = call(main, p, [main], cands);
    assert.equal(r.status, 200, p);
    assert.equal(r.body.toString(), "A");
  }
});

test("prefix naming one worktree does not match another's file", () => {
  assert.equal(call(main, "art-a/scratch/shots/both.png", [main], cands).body.toString(), "A");
  assert.equal(call(main, "art-b/scratch/shots/only-a.png", [main], cands).status, 404);
});

test("prefixed link with .. is rejected", () => {
  assert.equal(call(main, "worktrees/Repo/art-a/../../other/x", [main], cands).status, 400);
  assert.deepEqual(findInWorktrees(main, "worktrees/Repo/art-a/../../other/x", [wtA]), {});
});

test("non-owner (no worktreesFor) gets no prefix fallback", () => {
  assert.equal(call(main, "worktrees/Repo/art-a/scratch/shots/only-a.png", [main], undefined).status, 404);
});

test("candidate that is a drive/home root is ignored", () => {
  assert.deepEqual(findInWorktrees(main, "scratch/shots/only-a.png", [join(base, "..")]), {});
});

test("a sanctuary entry that is a junction out of the sanctuary is skipped", { skip: !junction }, () => {
  assert.ok(!cands(main).some((d) => d.includes("evil") || d === outside));
  assert.equal(call(main, "scratch/escaped.png", [main], cands).status, 404);
});
