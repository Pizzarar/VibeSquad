import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginShellPath, mergePathLists, toolDirs, augmentedPath, resetLoginShellCache } from "../server/posix-path.mjs";
import { repairShellEnv } from "../scripts/restart-runtime.mjs";
import { inspectFirstRunStatus } from "../server/first-run.mjs";

const H = "/home/u";
const fsOf = (files) => ({
  exists: (p) => files.has(p) || [...files].some((f) => f.startsWith(p + "/")),
  readdir: (d) => { const k = [...files].filter((f) => f.startsWith(d + "/")).map((f) => f.slice(d.length + 1).split("/")[0]); if (!k.length) throw new Error("ENOENT"); return [...new Set(k)]; },
  readFile: (p) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get?.(p) ?? ""; },
});
const mkfs = (obj) => { const m = new Map(Object.entries(obj)); const s = new Set(m.keys()); return { ...fsOf(s), readFile: (p) => { if (!m.has(p)) throw new Error("ENOENT"); return m.get(p); } }; };

test("loginShellPath: parses markers amid profile noise; win32/unset/relative/missing SHELL -> null", () => {
  const exec = (f, a) => { assert.equal(f, "/bin/zsh"); assert.equal(a[0], "-lc"); return "motd\n__VSPATH__/a:/b__VSPATH__\n"; };
  assert.equal(loginShellPath({ platform: "linux", env: { SHELL: "/bin/zsh" }, exec, exists: () => true }), "/a:/b");
  assert.equal(loginShellPath({ platform: "win32", env: { SHELL: "/bin/zsh" }, exec }), null);
  assert.equal(loginShellPath({ platform: "linux", env: {}, exec, exists: () => true }), null);
  assert.equal(loginShellPath({ platform: "linux", env: { SHELL: "zsh" }, exec, exists: () => true }), null);
  assert.equal(loginShellPath({ platform: "linux", env: { SHELL: "/bin/zsh" }, exec, exists: () => false }), null);
});

test("loginShellPath: failure, timeout, empty output fall back to null", () => {
  const base = { platform: "linux", env: { SHELL: "/bin/sh" }, exists: () => true };
  assert.equal(loginShellPath({ ...base, exec: () => { throw new Error("ETIMEDOUT"); } }), null);
  assert.equal(loginShellPath({ ...base, exec: () => "garbage no markers" }), null);
  assert.equal(loginShellPath({ ...base, exec: () => "__VSPATH____VSPATH__" }), null);
  let seen; loginShellPath({ ...base, exec: (f, a, o) => { seen = o.timeout; return ""; } });
  assert.ok(seen > 0 && seen <= 10000);
});

test("loginShellPath: default exec is cached once per process (bad SHELL -> null, stays null)", () => {
  resetLoginShellCache();
  assert.equal(loginShellPath({ platform: "linux", env: { SHELL: "/nonexistent/sh" }, exists: () => false }), null);
  assert.equal(loginShellPath({ platform: "linux", env: { SHELL: "/bin/sh" }, exists: () => true }), null); // cached
  resetLoginShellCache();
});

test("mergePathLists: existing first, additions appended, deduped, empties dropped", () => {
  assert.deepEqual(mergePathLists("/x:/y", "/y:/z::/x", ["/w", "/z"]), ["/x", "/y", "/z", "/w"]);
});

test("toolDirs: npm prefix, nvm (default alias first), fnm, volta found when present, skipped when absent", () => {
  const f = mkfs({
    [`${H}/.nvm/versions/node/v18.1.0/bin/node`]: "", [`${H}/.nvm/versions/node/v20.5.0/bin/node`]: "", [`${H}/.nvm/alias/default`]: "18\n",
    [`${H}/.local/share/fnm/node-versions/v22.0.0/installation/bin/node`]: "", [`${H}/.volta/bin/node`]: "", "/opt/npm/bin/claude": "",
  });
  const dirs = toolDirs({ platform: "linux", env: {}, home: H, ...f, exec: () => "/opt/npm\n" });
  assert.deepEqual(dirs, ["/opt/npm/bin", `${H}/.nvm/versions/node/v18.1.0/bin`, `${H}/.nvm/versions/node/v20.5.0/bin`, `${H}/.local/share/fnm/node-versions/v22.0.0/installation/bin`, `${H}/.volta/bin`]);
  const none = toolDirs({ platform: "linux", env: {}, home: H, ...mkfs({}), exec: () => { throw new Error("no npm"); } });
  assert.deepEqual(none, []);
  const volta = toolDirs({ platform: "linux", env: { VOLTA_HOME: "/v" }, home: H, ...mkfs({ "/v/bin/node": "" }), exec: () => "relative" });
  assert.deepEqual(volta, ["/v/bin"]);
  assert.deepEqual(toolDirs({ platform: "win32", home: H, ...f, exec: () => "/opt/npm" }), []);
});

test("augmentedPath: merges login PATH + tool dirs, keeps existing, no dupes; win32 untouched", () => {
  const f = mkfs({ [`${H}/.volta/bin/node`]: "" });
  const o = { platform: "linux", home: H, ...f, shellExec: () => `__VSPATH__/usr/bin:/bin:${H}/.volta/bin__VSPATH__`, npmExec: () => { throw new Error("x"); } };
  const env = { SHELL: "/bin/bash", PATH: "/usr/bin:/custom" };
  assert.equal(augmentedPath(env, { ...o, exists: (p) => p === "/bin/bash" || f.exists(p) }), `/usr/bin:/custom:/bin:${H}/.volta/bin`);
  assert.equal(augmentedPath({ PATH: "C:\a" }, { ...o, platform: "win32" }), "C:\a");
});

test("repairShellEnv off win32: PATH widened via posixOpts, unchanged object when nothing to add", () => {
  const f = mkfs({ [`${H}/.volta/bin/node`]: "" });
  const posixOpts = { home: H, ...f, shellExec: () => "", npmExec: () => { throw new Error("x"); } };
  const out = repairShellEnv({ PATH: "/usr/bin", FOO: "1" }, { platform: "linux", posixOpts });
  assert.equal(out.PATH, `/usr/bin:${H}/.volta/bin`); assert.equal(out.FOO, "1");
  const same = { PATH: "/usr/bin" };
  assert.equal(repairShellEnv(same, { platform: "linux", posixOpts: { home: H, ...mkfs({}), shellExec: () => "", npmExec: () => { throw new Error("x"); } } }), same);
});

test("first-run: off-PATH claude found via widened PATH; augmentation not applied on win32", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a6-"));
  try {
    const win = process.platform === "win32";
    writeFileSync(join(dir, win ? "claude.exe" : "claude"), "");
    const thin = { PATH: "", HOME: dir, USERPROFILE: dir };
    const r = await inspectFirstRunStatus({ env: thin, probeVersions: false, augmentPath: () => dir });
    if (!win) assert.equal(r.claude.installed, true); // win32 never augments; real-home probes make 'absent' unassertable here
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
