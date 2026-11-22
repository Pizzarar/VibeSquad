import test from "node:test";
import assert from "node:assert/strict";
import { loginShellPath, loginShellPathAsync, mergePathLists, extraPathEntries, extraPathEntriesAsync, augmentedPath, cmpVersionDesc, resetLoginShellCache } from "../server/posix-path.mjs";
import { repairShellEnv } from "../scripts/restart-runtime.mjs";
import { inspectFirstRunStatus } from "../server/first-run.mjs";

const H = "/home/u";
// Fake fs: files = { path: content }; a path "exists" if it is a file or a directory prefix of one.
const mkfs = (obj) => {
  const m = new Map(Object.entries(obj)); const keys = [...m.keys()];
  const exists = (p) => m.has(p) || keys.some((f) => f.startsWith(p + "/"));
  const readdir = (d) => { const k = keys.filter((f) => f.startsWith(d + "/")).map((f) => f.slice(d.length + 1).split("/")[0]); if (!k.length) throw new Error("ENOENT"); return [...new Set(k)]; };
  const readFile = (p) => { if (!m.has(p)) throw new Error("ENOENT"); return m.get(p); };
  return { exists, readdir, readFile, existsA: async (p) => exists(p), readdirA: async (d) => readdir(d), readFileA: async (p) => readFile(p) };
};
const sync = (f) => ({ exists: f.exists, readdir: f.readdir, readFile: f.readFile });
const asy = (f) => ({ exists: f.existsA, readdir: f.readdirA, readFile: f.readFileA });
const MK = "__VSPATH__";

test("loginShellPath: parses markers amid noise; win32/unset/relative/unknown/missing SHELL -> null, never exec'd", () => {
  let ran = 0;
  const exec = (f, a) => { ran++; assert.equal(f, "/bin/zsh"); assert.equal(a[0], "-lc"); return `motd\n${MK}/a:/b${MK}\n`; };
  assert.equal(loginShellPath({ platform: "linux", env: { SHELL: "/bin/zsh" }, exec, exists: () => true }), "/a:/b");
  assert.equal(ran, 1);
  for (const [platform, SHELL, ex] of [["win32", "/bin/zsh", true], ["linux", undefined, true], ["linux", "zsh", true], ["linux", "/bin/zsh", false], ["linux", "/tmp/evil/payload", true], ["linux", "/usr/bin/python3", true]]) {
    assert.equal(loginShellPath({ platform, env: { SHELL }, exec, exists: () => ex }), null, `${platform} ${SHELL}`);
  }
  assert.equal(ran, 1);
});

test("loginShellPath: failure, timeout, empty output fall back to null; timeout passed", () => {
  const base = { platform: "linux", env: { SHELL: "/bin/sh" }, exists: () => true };
  assert.equal(loginShellPath({ ...base, exec: () => { throw new Error("ETIMEDOUT"); } }), null);
  assert.equal(loginShellPath({ ...base, exec: () => "garbage" }), null);
  assert.equal(loginShellPath({ ...base, exec: () => MK + MK }), null);
  let seen; loginShellPath({ ...base, exec: (f, a, o) => { seen = o.timeout; return ""; } });
  assert.ok(seen > 0 && seen <= 10000);
});

test("loginShellPath: default exec cached once per process (sync and async)", async () => {
  resetLoginShellCache();
  assert.equal(loginShellPath({ platform: "linux", env: { SHELL: "/nonexistent/sh" }, exists: () => false }), null);
  assert.equal(loginShellPath({ platform: "linux", env: { SHELL: "/bin/sh" }, exists: () => true }), null); // cached
  assert.equal(await loginShellPathAsync({ platform: "linux", env: { SHELL: "/nonexistent/sh" }, exists: async () => false }), null);
  assert.equal(await loginShellPathAsync({ platform: "linux", env: { SHELL: "/bin/sh" }, exists: async () => true }), null); // cached
  resetLoginShellCache();
});

test("loginShellPathAsync: parses, failure -> null, win32 -> null", async () => {
  const ok = await loginShellPathAsync({ platform: "linux", env: { SHELL: "/bin/bash" }, exists: async () => true, exec: async () => `x${MK}/q:/r${MK}` });
  assert.equal(ok, "/q:/r");
  assert.equal(await loginShellPathAsync({ platform: "linux", env: { SHELL: "/bin/bash" }, exists: async () => true, exec: async () => { throw new Error("t"); } }), null);
  assert.equal(await loginShellPathAsync({ platform: "win32", env: { SHELL: "/bin/bash" }, exec: async () => `${MK}/q${MK}` }), null);
});

test("mergePathLists: existing first, additions appended, deduped, empties dropped", () => {
  assert.deepEqual(mergePathLists("/x:/y", "/y:/z::/x", ["/w", "/z"]), ["/x", "/y", "/z", "/w"]);
});

test("cmpVersionDesc: numeric aware (v22 > v9, v20.10 > v20.9)", () => {
  assert.deepEqual(["v9.0.0", "v22.1.0", "v20.9.0", "v20.10.0"].sort(cmpVersionDesc), ["v22.1.0", "v20.10.0", "v20.9.0", "v9.0.0"]);
});

const files = {
  [`${H}/.nvm/versions/node/v9.0.0/bin/node`]: "", [`${H}/.nvm/versions/node/v18.1.0/bin/node`]: "", [`${H}/.nvm/versions/node/v22.0.0/bin/node`]: "", [`${H}/.nvm/alias/default`]: "18\n",
  [`${H}/.local/share/fnm/node-versions/v22.0.0/installation/bin/node`]: "", [`${H}/.volta/bin/node`]: "", "/opt/npm/bin/claude": "", "/bin/bash": "",
};
const want = [`${H}/.nvm/versions/node/v18.1.0/bin`, `${H}/.nvm/versions/node/v22.0.0/bin`, `${H}/.nvm/versions/node/v9.0.0/bin`, `${H}/.local/share/fnm/node-versions/v22.0.0/installation/bin`, `${H}/.volta/bin`];

test("extraPathEntries (sync): login, npm prefix, nvm default-alias then newest, fnm, volta; npm sees widened PATH", () => {
  resetLoginShellCache();
  let npmEnvPath;
  const f = mkfs(files);
  const out = extraPathEntries({ SHELL: "/bin/bash", PATH: "/usr/bin" }, { platform: "linux", home: H, ...sync(f), shellExec: () => `${MK}/login/bin${MK}`, npmExec: (c, a, o) => { npmEnvPath = o.env.PATH; return "/opt/npm\n"; } });
  assert.deepEqual(out, ["/login/bin", "/opt/npm/bin", ...want]);
  assert.ok(npmEnvPath.startsWith("/usr/bin:/login/bin:") && npmEnvPath.includes(`${H}/.volta/bin`), npmEnvPath);
});

test("extraPathEntries (async): same result via async fs/exec", async () => {
  const f = mkfs(files); let npmEnvPath;
  const out = await extraPathEntriesAsync({ PATH: "/usr/bin" }, { platform: "linux", home: H, ...asy(f), shellExec: async () => "", npmExec: async (c, a, o) => { npmEnvPath = o.env.PATH; return "/opt/npm"; } });
  assert.deepEqual(out, ["/opt/npm/bin", ...want]);
  assert.ok(npmEnvPath.includes(`${H}/.nvm/versions/node/v18.1.0/bin`));
});

test("extraPathEntries: absent dirs skipped, npm failure / relative prefix / missing bin tolerated, VOLTA_HOME honoured, win32 -> []", async () => {
  const empty = mkfs({}); const boom = () => { throw new Error("no npm"); };
  assert.deepEqual(extraPathEntries({}, { platform: "linux", home: H, ...sync(empty), shellExec: () => "", npmExec: boom }), []);
  assert.deepEqual(await extraPathEntriesAsync({}, { platform: "linux", home: H, ...asy(empty), shellExec: async () => "", npmExec: async () => boom() }), []);
  assert.deepEqual(extraPathEntries({ VOLTA_HOME: "/v" }, { platform: "linux", home: H, ...sync(mkfs({ "/v/bin/node": "" })), shellExec: () => "", npmExec: () => "relative" }), ["/v/bin"]);
  assert.deepEqual(extraPathEntries({}, { platform: "linux", home: H, ...sync(empty), shellExec: () => "", npmExec: () => "/gone" }), []);
  assert.deepEqual(extraPathEntries({}, { platform: "win32", home: H, ...sync(mkfs(files)), npmExec: boom }), []);
  assert.deepEqual(await extraPathEntriesAsync({}, { platform: "win32", home: H, ...asy(mkfs(files)), npmExec: boom }), []);
});

test("augmentedPath: keeps existing, appends, no dupes; win32 untouched", () => {
  const f = mkfs({ [`${H}/.volta/bin/node`]: "", "/bin/bash": "" });
  const o = { platform: "linux", home: H, ...sync(f), shellExec: () => `${MK}/usr/bin:/bin:${H}/.volta/bin${MK}`, npmExec: () => { throw new Error("x"); } };
  resetLoginShellCache();
  assert.equal(augmentedPath({ SHELL: "/bin/bash", PATH: "/usr/bin:/custom" }, o), `/usr/bin:/custom:/bin:${H}/.volta/bin`);
  assert.equal(augmentedPath({ PATH: "C:\\a" }, { ...o, platform: "win32" }), "C:\\a");
});

test("repairShellEnv off win32: PATH widened via posixOpts, same object when nothing to add", () => {
  const posixOpts = { home: H, ...sync(mkfs({ [`${H}/.volta/bin/node`]: "" })), shellExec: () => "", npmExec: () => { throw new Error("x"); } };
  const out = repairShellEnv({ PATH: "/usr/bin", FOO: "1" }, { platform: "linux", posixOpts });
  assert.equal(out.PATH, `/usr/bin:${H}/.volta/bin`); assert.equal(out.FOO, "1");
  const same = { PATH: "/usr/bin" };
  assert.equal(repairShellEnv(same, { platform: "linux", posixOpts: { home: H, ...sync(mkfs({})), shellExec: () => "", npmExec: () => { throw new Error("x"); } } }), same);
});

test("first-run (injected platform): linux runs the augment + finds claude off thin PATH; win32 never calls augmentPath", async () => {
  const has = (p) => ["/opt/node/bin/claude", "/opt/node/bin/git"].includes(p);
  let calls = 0;
  const augmentPath = async () => { calls++; return ["/opt/node/bin"]; };
  const thin = { PATH: "/usr/bin" };
  const lin = await inspectFirstRunStatus({ env: thin, probeVersions: false, platform: "linux", exists: has, augmentPath });
  assert.equal(calls, 1);
  assert.equal(lin.claude.installed, true); assert.equal(lin.git.installed, true);
  const bare = await inspectFirstRunStatus({ env: thin, probeVersions: false, platform: "linux", exists: has, augmentPath: async () => [] });
  assert.equal(bare.claude.installed, false);
  calls = 0;
  const win = await inspectFirstRunStatus({ env: { PATH: "C:\\x" }, probeVersions: false, platform: "win32", exists: () => false, augmentPath });
  assert.equal(calls, 0); assert.equal(win.claude.installed, false);
});
