import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleFsRead, findInWorktrees } from "../server/file-search.mjs";
import { laneWorktreeCandidates } from "../server/vibesquad-api.mjs";

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

const call = (cwd, path, roots, wts) => {
  const out = {};
  const res = { statusCode: 0, headers: {}, setHeader() {}, end(b) { out.body = b; } };
  handleFsRead({ method: "GET", url: `/x?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}` }, res, roots, (r, st, j) => { out.status = st; out.json = j; }, wts);
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
});

test("missing everywhere stays 404; traversal still refused", () => {
  assert.equal(call(main, "scratch/shots/nope.png", [main], cands).status, 404);
  assert.equal(call(main, "../Repo/x", [main], cands).status, 400);
  assert.equal(call(main, "../../worktrees/Repo/art-a/scratch/shots/only-a.png", [main], cands).status, 400);
  assert.deepEqual(findInWorktrees(main, "../x", [wtA]), {});
});

test("candidate that is a drive/home root is ignored", () => {
  assert.deepEqual(findInWorktrees(main, "scratch/shots/only-a.png", [join(base, "..")]), {});
});
