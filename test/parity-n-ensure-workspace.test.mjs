import assert from "node:assert/strict";
import test from "node:test";
import { createInflight, findWorkspaceForCwd, workspaceKey } from "../src/ensureWorkspaceLogic.ts";

test("workspaceKey normalises case, slashes, trailing slash and whitespace", () => {
  const k = workspaceKey("C:/Users/Me/Proj".replaceAll("/", "\\") + "\\");
  assert.equal(k, workspaceKey("c:/users/me/proj"));
  assert.equal(k, workspaceKey("  C:/Users/Me/Proj//  "));
});

test("findWorkspaceForCwd resolves existing (deepest wins) or null", () => {
  const ws = [["a", { workspaceDirectory: String.raw`C:\Repo` }], ["b", { directory: "c:/repo/wt" }]];
  assert.equal(findWorkspaceForCwd("C:/REPO/wt/src".replaceAll("/", "\\") + "\\", ws), "b");
  assert.equal(findWorkspaceForCwd("c:/repo/other", ws), "a");
  assert.equal(findWorkspaceForCwd("D:/x", ws), null);
});

test("createInflight shares concurrent calls and clears after settle", async () => {
  const f = createInflight();
  let calls = 0;
  const fn = () => new Promise((r) => setTimeout(() => r(++calls), 10));
  const [a, b] = await Promise.all([f.run("k", fn), f.run("k", fn)]);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(f.size(), 0);
  assert.equal(await f.run("k", fn), 2);
});

test("createInflight clears after a rejection so retry works", async () => {
  const f = createInflight();
  await assert.rejects(f.run("k", () => Promise.reject(new Error("x"))));
  assert.equal(await f.run("k", async () => 5), 5);
});
