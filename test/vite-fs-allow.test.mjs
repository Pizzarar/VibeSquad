import { after, test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, mkdirSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viteFsAllow } from "../server/vite-fs-allow.mjs";

const base = realpathSync(mkdtempSync(join(tmpdir(), "vs-fsa-")));
const main = join(base, "main");
const wt = join(base, "wt");
mkdirSync(join(main, "node_modules"), { recursive: true });
mkdirSync(wt, { recursive: true });

let junction = true;
try {
  symlinkSync(join(main, "node_modules"), join(wt, "node_modules"), "junction");
} catch {
  junction = false;
}

test("linked worktree: fs.allow covers the junction target (shared node_modules)", { skip: !junction }, () => {
  const root = realpathSync(wt);
  const allow = viteFsAllow(root);
  const target = realpathSync(join(main, "node_modules"));
  assert.ok(allow.includes(root), `workspace root allowed (got ${JSON.stringify(allow)})`);
  assert.ok(allow.includes(target), `junction realpath allowed (got ${JSON.stringify(allow)})`);
});

test("plain checkout: fs.allow keeps the workspace root", () => {
  const root = realpathSync(main);
  const allow = viteFsAllow(root);
  assert.ok(allow.includes(root), `workspace root allowed (got ${JSON.stringify(allow)})`);
});

test("missing node_modules: fs.allow is just the workspace root", () => {
  const bare = join(base, "bare");
  mkdirSync(bare, { recursive: true });
  assert.deepEqual(viteFsAllow(bare), [realpathSync(bare)]);
});

// Detach the node_modules junction FIRST (never recurse through it — a recursive
// rm would follow the link and delete the target), then drop the temp tree.
after(() => {
  const link = join(wt, "node_modules");
  try {
    if (lstatSync(link).isSymbolicLink()) {
      try {
        unlinkSync(link);
      } catch {
        rmdirSync(link); // non-recursive: removes the junction, not the target
      }
    }
  } catch {}
  rmSync(base, { recursive: true, force: true, maxRetries: 3 });
});
