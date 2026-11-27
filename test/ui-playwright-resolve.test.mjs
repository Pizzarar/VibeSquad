// idea-1147: resolvePlaywright fallback order. Everything is injected (env, home, readdir/exists/mtime, load), so
// no real Playwright is loaded and nothing is installed. The durable dir must survive /tmp clears and reboots, so
// it lives under ~/.vibesquad, not /tmp and not the npx cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  isSnapBrowser, snapSafeTmpdir,
  playwrightCandidates, resolvePlaywrightInfo, browserSkipReason, shellQuote,
  PLAYWRIGHT_INSTALL_CMD, PLAYWRIGHT_MISSING, DURABLE_TOOLS_DIR,
} from "../scripts/ui-overlap/env.mjs";

const HOME = path.join("/", "home", "tester");
const DURABLE = path.join(HOME, ".vibesquad", "tools", "playwright", "node_modules");
const NPX = path.join(HOME, ".npm", "_npx");
const LAD = path.join("/", "win", "AppData", "Local");
const WIN_NPX = path.join(LAD, "npm-cache", "_npx");
const PW_DIR = path.join("/", "opt", "pw");
const REPO_NM = path.join("/", "repo", "node_modules");
const noLocal = () => { throw new Error("not installed"); };

/**
 * Fake fs. npxDirs: cache entries with a playwright-core package.json; noPw: entries without one; winDirs: entries under
 * %LOCALAPPDATA%/npm-cache/_npx (throws on read when winThrows). mtimes is keyed by the hash-dir name.
 */
function fakeFs({ npxDirs = [], noPw = [], winDirs = [], winThrows = false, mtimes = {} } = {}) {
  const files = new Set();
  for (const d of [...npxDirs, ...winDirs]) {
    const root = winDirs.includes(d) ? WIN_NPX : NPX;
    files.add(path.join(root, d, "node_modules", "playwright-core", "package.json"));
  }
  return {
    readdir: (p) => {
      if (p === NPX) return [...npxDirs, ...noPw];
      if (p === WIN_NPX) { if (winThrows) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return winDirs; }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    exists: (p) => files.has(p),
    mtime: (p) => mtimes[p.split(path.sep).slice(-3, -2)[0]] ?? 0,
  };
}

test("candidate order: PLAYWRIGHT_DIR, require resolution, durable dir, then the npx scan", () => {
  const c = playwrightCandidates({ npx: true,
    home: HOME,
    env: { PLAYWRIGHT_DIR: PW_DIR },
    resolveLocal: (n) => path.join(REPO_NM, n),
    ...fakeFs({ npxDirs: ["abc"] }),
  });
  assert.deepEqual(c, [
    path.join(PW_DIR, "playwright-core"),
    path.join(REPO_NM, "playwright-core"),
    path.join(REPO_NM, "playwright"),
    path.join(DURABLE, "playwright-core"),
    path.join(DURABLE, "playwright"),
    path.join(NPX, "abc", "node_modules", "playwright-core"),
  ]);
});

test("npx scan: only dirs with a playwright-core package.json, newest first", () => {
  const c = playwrightCandidates({ npx: true,
    home: HOME, env: {}, resolveLocal: noLocal,
    ...fakeFs({ npxDirs: ["old", "new"], noPw: ["nopw"], mtimes: { old: 100, new: 900 } }),
  });
  const npx = c.filter((p) => p.startsWith(NPX));
  assert.deepEqual(npx, [path.join(NPX, "new", "node_modules", "playwright-core"), path.join(NPX, "old", "node_modules", "playwright-core")]);
});

test("npx scan is bounded: at most 50 cache entries are considered", () => {
  const dirs = Array.from({ length: 120 }, (_, i) => `h${String(i).padStart(3, "0")}`);
  const c = playwrightCandidates({ npx: true, home: HOME, env: {}, resolveLocal: noLocal, ...fakeFs({ npxDirs: dirs }) });
  assert.equal(c.filter((p) => p.startsWith(NPX)).length, 50);
});

test("a missing ~/.npm/_npx and a missing durable dir yield no candidates and no throw", () => {
  const c = playwrightCandidates({ npx: true, home: HOME, env: {}, resolveLocal: noLocal, readdir: () => { throw new Error("ENOENT"); }, exists: () => false, mtime: () => 0 });
  assert.ok(c.every((p) => !p.startsWith(NPX)));
  assert.deepEqual(c, [path.join(DURABLE, "playwright-core"), path.join(DURABLE, "playwright")]);
});

test("LOCALAPPDATA set: the Windows npm cache is scanned too, merged with the home cache by mtime", () => {
  const c = playwrightCandidates({ npx: true,
    home: HOME, env: { LOCALAPPDATA: LAD }, resolveLocal: noLocal,
    ...fakeFs({ npxDirs: ["posix"], winDirs: ["win"], mtimes: { posix: 100, win: 900 } }),
  });
  const npx = c.filter((p) => p.startsWith(NPX) || p.startsWith(WIN_NPX));
  assert.deepEqual(npx, [path.join(WIN_NPX, "win", "node_modules", "playwright-core"), path.join(NPX, "posix", "node_modules", "playwright-core")]);
});

test("LOCALAPPDATA unset: the Windows npm cache is never read", () => {
  const reads = [];
  const c = playwrightCandidates({ npx: true,
    home: HOME, env: {}, resolveLocal: noLocal,
    readdir: (p) => { reads.push(p); return []; }, exists: () => false, mtime: () => 0,
  });
  assert.deepEqual(reads, [NPX]);
  assert.ok(c.every((p) => !p.startsWith(WIN_NPX)));
});

test("LOCALAPPDATA cache unreadable: caught, the home npx cache and the durable dir still come through", () => {
  const c = playwrightCandidates({ npx: true,
    home: HOME, env: { LOCALAPPDATA: LAD }, resolveLocal: noLocal,
    ...fakeFs({ npxDirs: ["posix"], winDirs: ["win"], winThrows: true }),
  });
  assert.ok(c.includes(path.join(NPX, "posix", "node_modules", "playwright-core")));
  assert.ok(c.includes(path.join(DURABLE, "playwright-core")));
  assert.ok(c.every((p) => !p.startsWith(WIN_NPX)));
});

test("the npx bound applies per cache root: 120 Windows entries still contribute at most 50", () => {
  const dirs = Array.from({ length: 120 }, (_, i) => `w${String(i).padStart(3, "0")}`);
  const c = playwrightCandidates({ npx: true, home: HOME, env: { LOCALAPPDATA: LAD }, resolveLocal: noLocal, ...fakeFs({ winDirs: dirs }) });
  assert.equal(c.filter((p) => p.startsWith(WIN_NPX)).length, 50);
});

test("resolvePlaywrightInfo tries candidates in order and returns the first that loads", () => {
  const tried = [];
  const load = (c) => {
    tried.push(c);
    if (c === path.join(DURABLE, "playwright-core")) return { chromium: "durable" };
    throw new Error("cannot load");
  };
  const info = resolvePlaywrightInfo({ npx: true,
    home: HOME, env: { PLAYWRIGHT_DIR: PW_DIR }, resolveLocal: noLocal, load,
    ...fakeFs({ npxDirs: ["abc"] }),
  });
  assert.deepEqual(info, { mod: { chromium: "durable" }, from: path.join(DURABLE, "playwright-core") });
  assert.deepEqual(tried, [path.join(PW_DIR, "playwright-core"), path.join(DURABLE, "playwright-core")], "stops at the first success");
});

test("PLAYWRIGHT_DIR beats the durable dir when both load", () => {
  const info = resolvePlaywrightInfo({ npx: true,
    home: HOME, env: { PLAYWRIGHT_DIR: PW_DIR }, resolveLocal: noLocal,
    load: (c) => ({ from: c }), ...fakeFs(),
  });
  assert.equal(info.from, path.join(PW_DIR, "playwright-core"));
});

test("falls through to the npx scan when the durable dir is absent", () => {
  const npxCore = path.join(NPX, "abc", "node_modules", "playwright-core");
  const info = resolvePlaywrightInfo({ npx: true,
    home: HOME, env: {}, resolveLocal: noLocal,
    load: (c) => { if (c === npxCore) return { chromium: "npx" }; throw new Error("missing"); },
    ...fakeFs({ npxDirs: ["abc"] }),
  });
  assert.equal(info.from, npxCore);
});

test("default (no npx option, as the test suite calls it) skips the npx scan on both roots but keeps the durable dir", () => {
  const c = playwrightCandidates({
    home: HOME, env: { LOCALAPPDATA: LAD }, resolveLocal: noLocal,
    ...fakeFs({ npxDirs: ["posix"], winDirs: ["win"] }),
  });
  assert.deepEqual(c.filter((p) => p.startsWith(NPX) || p.startsWith(WIN_NPX)), []);
  assert.ok(c.some((p) => p.includes(path.join(".vibesquad", "tools", "playwright"))));
  const npxCore = path.join(NPX, "abc", "node_modules", "playwright-core");
  assert.equal(resolvePlaywrightInfo({ home: HOME, env: {}, resolveLocal: noLocal, load: (x) => { if (x === npxCore) return {}; throw new Error("m"); }, ...fakeFs({ npxDirs: ["abc"] }) }), null);
});

test("shellQuote: a home dir with spaces stays one argument; POSIX escapes $ and quotes; cmd.exe takes it as-is", () => {
  assert.equal(shellQuote("/home/a b/.vibesquad", "linux"), `"/home/a b/.vibesquad"`);
  assert.equal(shellQuote(`/x/$y"z\\`, "darwin"), `"/x/\\$y\\"z\\\\"`);
  assert.equal(shellQuote("C:\\Users\\a b\\.vibesquad", "win32"), `"C:\\Users\\a b\\.vibesquad"`);
});

test("nothing resolves: null, and the missing-Playwright message names the exact quoted durable install command", () => {
  assert.equal(resolvePlaywrightInfo({ npx: true, home: HOME, env: {}, resolveLocal: noLocal, load: () => { throw new Error("x"); }, ...fakeFs() }), null);
  assert.equal(PLAYWRIGHT_INSTALL_CMD, `npm i --prefix ${shellQuote(path.join(os.homedir(), ".vibesquad", "tools", "playwright"))} playwright-core`);
  assert.equal(DURABLE_TOOLS_DIR, path.join(os.homedir(), ".vibesquad", "tools", "playwright"));
  assert.ok(PLAYWRIGHT_MISSING.includes(PLAYWRIGHT_INSTALL_CMD));
  assert.ok(browserSkipReason({ pw: null, exe: "/usr/bin/chromium" }).includes(PLAYWRIGHT_INSTALL_CMD));
});

test("the durable dir is never under /tmp or the npx cache", () => {
  assert.ok(!DURABLE_TOOLS_DIR.startsWith("/tmp"));
  assert.ok(!DURABLE_TOOLS_DIR.includes(`${path.sep}_npx${path.sep}`));
});

test("snapSafeTmpdir: only a snap browser with a tmpdir under a hidden $HOME dir gets redirected", () => {
  const base = { home: "/home/u", platform: "linux" };
  const hidden = "/home/u/.cache/vibesquad-tmp";
  assert.equal(snapSafeTmpdir({ ...base, tmpdir: hidden, snap: true }), "/tmp");
  assert.equal(snapSafeTmpdir({ ...base, tmpdir: hidden, snap: false }), null, "non-snap browsers keep TMPDIR");
  assert.equal(snapSafeTmpdir({ ...base, tmpdir: "/tmp", snap: true }), null, "already outside $HOME");
  assert.equal(snapSafeTmpdir({ ...base, tmpdir: "/home/u/work/tmp", snap: true }), null, "visible home dir is fine for snap");
  assert.equal(snapSafeTmpdir({ ...base, tmpdir: hidden, snap: true, platform: "win32" }), null);
  assert.equal(snapSafeTmpdir({ ...base, tmpdir: "/home/u2/.x", snap: true }), null, "a sibling home is not $HOME");
});

test("isSnapBrowser: /snap paths and the wrapper that execs /snap/bin/chromium", () => {
  assert.equal(isSnapBrowser("/snap/bin/chromium"), true);
  assert.equal(isSnapBrowser("/usr/bin/chromium-browser", { readHead: () => "#!/bin/sh\nexec /snap/bin/chromium \"$@\"" }), true);
  assert.equal(isSnapBrowser("/usr/bin/google-chrome", { readHead: () => "\x7fELF" }), false);
  assert.equal(isSnapBrowser("/nope", { readHead: () => { throw new Error("ENOENT"); } }), false);
  assert.equal(isSnapBrowser(null), false);
});
