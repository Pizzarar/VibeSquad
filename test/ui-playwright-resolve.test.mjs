// idea-1147: resolvePlaywright fallback order. Everything is injected (env, home, readdir/exists/mtime, load), so
// no real Playwright is loaded and nothing is installed. The durable dir must survive /tmp clears and reboots, so
// it lives under ~/.vibesquad, not /tmp and not the npx cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  playwrightCandidates, resolvePlaywrightInfo, browserSkipReason,
  PLAYWRIGHT_INSTALL_CMD, PLAYWRIGHT_MISSING, DURABLE_TOOLS_DIR,
} from "../scripts/ui-overlap/env.mjs";

const HOME = "/home/tester";
const DURABLE = path.join(HOME, ".vibesquad", "tools", "playwright", "node_modules");
const NPX = path.join(HOME, ".npm", "_npx");
const noLocal = () => { throw new Error("not installed"); };

/** Fake fs: npx cache entries (hash dirs, each with a playwright-core package.json) and their mtimes. */
function fakeFs({ npxDirs = [], noPw = [], extraFiles = [], mtimes = {} } = {}) {
  const files = new Set(extraFiles);
  for (const d of npxDirs) files.add(path.join(NPX, d, "node_modules", "playwright-core", "package.json"));
  return {
    readdir: (p) => {
      if (p !== NPX) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return [...npxDirs, ...noPw];
    },
    exists: (p) => files.has(p),
    mtime: (p) => mtimes[path.relative(NPX, p).split(path.sep)[0]] ?? 0,
  };
}

test("candidate order: PLAYWRIGHT_DIR, require resolution, durable dir, then the npx scan", () => {
  const c = playwrightCandidates({
    home: HOME,
    env: { PLAYWRIGHT_DIR: "/opt/pw" },
    resolveLocal: (n) => `/repo/node_modules/${n}`,
    ...fakeFs({ npxDirs: ["abc"] }),
  });
  assert.deepEqual(c, [
    "/opt/pw/playwright-core",
    "/repo/node_modules/playwright-core",
    "/repo/node_modules/playwright",
    path.join(DURABLE, "playwright-core"),
    path.join(DURABLE, "playwright"),
    path.join(NPX, "abc", "node_modules", "playwright-core"),
  ]);
});

test("npx scan: only dirs with a playwright-core package.json, newest first", () => {
  const c = playwrightCandidates({
    home: HOME, env: {}, resolveLocal: noLocal,
    ...fakeFs({ npxDirs: ["old", "new"], noPw: ["nopw"], mtimes: { old: 100, new: 900 } }),
  });
  const npx = c.filter((p) => p.startsWith(NPX));
  assert.deepEqual(npx, [path.join(NPX, "new", "node_modules", "playwright-core"), path.join(NPX, "old", "node_modules", "playwright-core")]);
});

test("npx scan is bounded: at most 50 cache entries are considered", () => {
  const dirs = Array.from({ length: 120 }, (_, i) => `h${String(i).padStart(3, "0")}`);
  const c = playwrightCandidates({ home: HOME, env: {}, resolveLocal: noLocal, ...fakeFs({ npxDirs: dirs }) });
  assert.equal(c.filter((p) => p.startsWith(NPX)).length, 50);
});

test("a missing ~/.npm/_npx and a missing durable dir yield no candidates and no throw", () => {
  const c = playwrightCandidates({ home: HOME, env: {}, resolveLocal: noLocal, readdir: () => { throw new Error("ENOENT"); }, exists: () => false, mtime: () => 0 });
  assert.ok(c.every((p) => !p.startsWith(NPX)));
  assert.deepEqual(c, [path.join(DURABLE, "playwright-core"), path.join(DURABLE, "playwright")]);
});

test("resolvePlaywrightInfo tries candidates in order and returns the first that loads", () => {
  const tried = [];
  const load = (c) => {
    tried.push(c);
    if (c === path.join(DURABLE, "playwright-core")) return { chromium: "durable" };
    throw new Error("cannot load");
  };
  const info = resolvePlaywrightInfo({
    home: HOME, env: { PLAYWRIGHT_DIR: "/opt/pw" }, resolveLocal: noLocal, load,
    ...fakeFs({ npxDirs: ["abc"] }),
  });
  assert.deepEqual(info, { mod: { chromium: "durable" }, from: path.join(DURABLE, "playwright-core") });
  assert.deepEqual(tried, ["/opt/pw/playwright-core", path.join(DURABLE, "playwright-core")], "stops at the first success");
});

test("PLAYWRIGHT_DIR beats the durable dir when both load", () => {
  const info = resolvePlaywrightInfo({
    home: HOME, env: { PLAYWRIGHT_DIR: "/opt/pw" }, resolveLocal: noLocal,
    load: (c) => ({ from: c }), ...fakeFs(),
  });
  assert.equal(info.from, "/opt/pw/playwright-core");
});

test("falls through to the npx scan when the durable dir is absent", () => {
  const npxCore = path.join(NPX, "abc", "node_modules", "playwright-core");
  const info = resolvePlaywrightInfo({
    home: HOME, env: {}, resolveLocal: noLocal,
    load: (c) => { if (c === npxCore) return { chromium: "npx" }; throw new Error("missing"); },
    ...fakeFs({ npxDirs: ["abc"] }),
  });
  assert.equal(info.from, npxCore);
});

test("nothing resolves: null, and the missing-Playwright message names the exact durable install command", () => {
  assert.equal(resolvePlaywrightInfo({ home: HOME, env: {}, resolveLocal: noLocal, load: () => { throw new Error("x"); }, ...fakeFs() }), null);
  assert.equal(PLAYWRIGHT_INSTALL_CMD, `npm i --prefix ${path.join(os.homedir(), ".vibesquad", "tools", "playwright")} playwright-core`);
  assert.equal(DURABLE_TOOLS_DIR, path.join(os.homedir(), ".vibesquad", "tools", "playwright"));
  assert.ok(PLAYWRIGHT_MISSING.includes(PLAYWRIGHT_INSTALL_CMD));
  assert.match(browserSkipReason({ pw: null, exe: "/usr/bin/chromium" }), /no Playwright found.*npm i --prefix .*\.vibesquad[\\/]tools[\\/]playwright playwright-core/);
});

test("the durable dir is never under /tmp or the npx cache", () => {
  assert.ok(!DURABLE_TOOLS_DIR.startsWith("/tmp"));
  assert.ok(!DURABLE_TOOLS_DIR.includes(`${path.sep}_npx${path.sep}`));
});
