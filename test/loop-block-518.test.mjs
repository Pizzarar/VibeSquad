// idea-518 (P0, part A): no synchronous child-process / adapter-enumeration calls on the server's request and timer
// paths. Covers providers-catalog pooled merged units (fs HEAD read, cache, single-flight, spawn:false never spawns),
// auth netConfig (interface snapshot read once, refreshed off-loop single-flight, fail closed), host-id path memo, and
// file-search listFilesAsync. Fixtures live in temp dirs; VIBESQUAD_HOME points at a temp home before any server import.
import test from "node:test";
import assert from "node:assert/strict";
import cp, { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const tmpDirs = [];
const tmp = (p = "vs-518-") => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };
const HOME = tmp("vs-518-home-");
process.env.VIBESQUAD_HOME = HOME;
process.env.PASEO_HOME = path.join(HOME, "paseo");
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

const catalog = await import("../server/providers-catalog.mjs");
const { gitSpawnStats } = await import("../server/git-spawn.mjs");
const auth = await import("../server/auth.mjs");
const hostId = await import("../server/host-id.mjs");
const fileSearch = await import("../server/file-search.mjs");
const { clearUsageCache, pooledMergedTestHooks: hooks, readHeadShaFs } = catalog;

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const g = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, stdio: "pipe", encoding: "utf8" }).trim();
let mergeN = 0;
function addMerge(dir) {
  const unit = `unit-${++mergeN}`;
  g(dir, "checkout", "-q", "-b", unit);
  fs.writeFileSync(path.join(dir, `${unit}.txt`), `${unit}\n`);
  g(dir, "add", ".");
  g(dir, "commit", "-q", "-m", `feat: ${unit} (@usa) review r1`);
  g(dir, "checkout", "-q", "main");
  g(dir, "merge", "-q", "--no-ff", "-m", `Merge branch '${unit}' (@usa)`, unit);
}
function mkRepo() {
  const dir = path.join(tmp(), "proj");
  fs.mkdirSync(dir);
  g(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "f.txt"), "a\n");
  g(dir, "add", ".");
  g(dir, "commit", "-q", "-m", "init");
  addMerge(dir);
  return dir;
}

/** Counts git spawns through the named child_process imports the server modules hold (builtin ESM bindings follow
 * the CJS object after syncBuiltinESMExports). */
function spyChildProcess() {
  const calls = { sync: 0, async: 0, spawnSync: 0 };
  const real = { execFileSync: cp.execFileSync, execFile: cp.execFile, spawnSync: cp.spawnSync };
  cp.execFileSync = function (file, ...rest) { if (file === "git") calls.sync += 1; return real.execFileSync.call(this, file, ...rest); };
  cp.execFile = function (file, ...rest) { if (file === "git") calls.async += 1; return real.execFile.call(this, file, ...rest); };
  cp.spawnSync = function (file, ...rest) { if (file === "git") calls.spawnSync += 1; return real.spawnSync.call(this, file, ...rest); };
  syncBuiltinESMExports();
  // idea-572: providers-catalog's async git runs in the off-loop worker (server/git-spawn.mjs): count its dispatches too.
  let offBase = gitSpawnStats.dispatches;
  Object.defineProperty(calls, "off", { get: () => gitSpawnStats.dispatches - offBase });
  calls.reset = () => { calls.sync = 0; calls.async = 0; calls.spawnSync = 0; offBase = gitSpawnStats.dispatches; };
  calls.restore = () => { Object.assign(cp, real); syncBuiltinESMExports(); };
  return calls;
}

async function withRoot(root, fn) {
  const prev = process.env.VIBESQUAD_ROOT;
  process.env.VIBESQUAD_ROOT = root;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.VIBESQUAD_ROOT; else process.env.VIBESQUAD_ROOT = prev; }
}

// ---------------------------------------------------------------- providers-catalog: HEAD without a spawn

test("518: readHeadShaFs matches git rev-parse HEAD (loose, packed, detached, linked worktree) and returns null when unsure", () => {
  const repo = mkRepo();
  assert.equal(readHeadShaFs(repo), g(repo, "rev-parse", "HEAD"), "loose ref");
  g(repo, "pack-refs", "--all");
  assert.ok(!fs.existsSync(path.join(repo, ".git", "refs", "heads", "main")), "fixture: main is packed now");
  assert.equal(readHeadShaFs(repo), g(repo, "rev-parse", "HEAD"), "packed-refs");
  addMerge(repo); // a new loose ref shadows the stale packed one, as in git
  assert.equal(readHeadShaFs(repo), g(repo, "rev-parse", "HEAD"), "loose wins over packed");
  const wt = path.join(path.dirname(repo), "wt");
  g(repo, "worktree", "add", "-q", "-b", "side", wt);
  fs.writeFileSync(path.join(wt, "s.txt"), "s\n");
  g(wt, "add", ".");
  g(wt, "commit", "-q", "-m", "side");
  assert.equal(readHeadShaFs(wt), g(wt, "rev-parse", "HEAD"), "linked worktree (gitdir file + commondir)");
  assert.notEqual(readHeadShaFs(wt), readHeadShaFs(repo));
  g(repo, "checkout", "-q", "--detach");
  assert.equal(readHeadShaFs(repo), g(repo, "rev-parse", "HEAD"), "detached HEAD");
  g(repo, "checkout", "-q", "main");

  assert.equal(readHeadShaFs(tmp()), null, "not a repo");
  const odd = mkRepo();
  fs.writeFileSync(path.join(odd, ".git", "HEAD"), "ref: refs/heads/../../config\n");
  assert.equal(readHeadShaFs(odd), null, "a ref path escaping refs/ is refused");
  fs.writeFileSync(path.join(odd, ".git", "HEAD"), "ref: refs/heads/.invalid\n"); // reftable layout: no loose/packed ref
  assert.equal(readHeadShaFs(odd), null, "unresolvable ref: null (caller falls back to rev-parse)");
  fs.writeFileSync(path.join(odd, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(odd, ".git", "refs", "heads", "main"), "ref: refs/heads/other\n");
  assert.equal(readHeadShaFs(odd), null, "a symref in a loose ref is left to git");
});

// ---------------------------------------------------------------- providers-catalog: pooled cache, no sync git

test("518: pooled merged units warm with async git only, then serve the cache (stale too) without spawning", async () => {
  const repo = mkRepo();
  const home = tmp();
  const calls = spyChildProcess();
  try {
    await withRoot(repo, async () => {
      let t = 1_000_000;
      const now = () => t;
      clearUsageCache();
      await hooks.warm(home, now);
      assert.equal(calls.sync, 0, "cold warm: no execFileSync");
      assert.equal(calls.async, 0, "cold warm: no git child created on the server loop (idea-572)");
      assert.equal(calls.off, 2, `cold warm: log + numstat only, off-loop, HEAD read from .git (${calls.off})`);
      assert.equal(hooks.read(home, now, { spawn: false }).length, 1);

      calls.reset();
      t += 60_000; // the 15 s HEAD-check TTL lapsed
      assert.equal(hooks.read(home, now, { spawn: false }).length, 1, "spawn:false serves the stale entry");
      assert.equal(calls.sync + calls.async + calls.off, 0, "spawn:false never runs git, even past the TTL (the old ~9 s execFileSync)");
      await hooks.warm(home, now);
      assert.equal(calls.sync + calls.async + calls.off, 0, "TTL lapsed, HEAD unchanged: re-stamped from the .git files, no spawn");

      addMerge(repo);
      calls.reset();
      t += 1_000; // inside the TTL: the fs HEAD check still sees the new merge
      await hooks.warm(home, now);
      assert.equal(calls.sync, 0);
      assert.equal(calls.async, 0);
      assert.equal(calls.off, 2, "new HEAD: log + numstat, off-loop");
      assert.equal(hooks.read(home, now, { spawn: false }).length, 2, "new merge picked up");

      calls.reset();
      assert.equal(hooks.read(home, () => t + 120_000, { spawn: true }).length, 2);
      assert.ok(calls.sync >= 1, "control: the sync getUsage() contract (spawn:true, test-only) still spawns past the TTL");
    });
  } finally {
    calls.restore();
  }
});

test("518: concurrent warms share one refresh per repo (single-flight); a HEAD the fs can't read falls back to async rev-parse", async () => {
  const repo = mkRepo();
  const home = tmp();
  const calls = spyChildProcess();
  try {
    await withRoot(repo, async () => {
      clearUsageCache();
      const now = () => 5_000_000;
      const a = hooks.warm(home, now);
      const b = hooks.warm(home, now);
      assert.equal(hooks.inflight(), 1, "one refresh in flight for the repo");
      await Promise.all([a, b]);
      assert.equal(hooks.inflight(), 0);
      assert.equal(calls.async, 0);
      assert.equal(calls.off, 2, `two warms, one log + numstat (${calls.off})`);
      assert.equal(hooks.read(home, now, { spawn: false }).length, 1);

      clearUsageCache();
      calls.reset();
      await hooks.warm(home, now, { readHead: () => null });
      assert.equal(calls.sync, 0);
      assert.equal(calls.async, 0);
      assert.equal(calls.off, 1, "cached units reused: only the rev-parse fallback ran (off-loop)");
      assert.equal(hooks.read(home, now, { spawn: false }).length, 1);
    });
  } finally {
    calls.restore();
  }
});

// ---------------------------------------------------------------- auth: interface snapshot, off-loop refresh, fail closed

const IFACES_A = {
  Ethernet: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
  NordLynx: [{ address: "100.70.1.2", family: "IPv4", internal: false }],
};

function withNoNetEnv(fn) {
  const keep = { lan: process.env.VIBESQUAD_LAN_IP, mesh: process.env.VIBESQUAD_MESHNET_IP, host: process.env.VIBESQUAD_MESHNET_HOST };
  delete process.env.VIBESQUAD_LAN_IP;
  delete process.env.VIBESQUAD_MESHNET_IP;
  delete process.env.VIBESQUAD_MESHNET_HOST;
  const restore = () => {
    for (const [k, v] of [["VIBESQUAD_LAN_IP", keep.lan], ["VIBESQUAD_MESHNET_IP", keep.mesh], ["VIBESQUAD_MESHNET_HOST", keep.host]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  return Promise.resolve().then(fn).finally(restore);
}

test("518: netConfig reads os.networkInterfaces once, then serves the snapshot (no per-request adapter enumeration)", async () => {
  await withNoNetEnv(async () => {
    const real = os.networkInterfaces;
    let n = 0;
    os.networkInterfaces = () => { n += 1; return IFACES_A; };
    syncBuiltinESMExports();
    try {
      auth.setNetInterfacesForTest(null);
      const first = auth.netConfig();
      assert.equal(n, 1, "first read is synchronous (boot binds its listeners from it)");
      assert.equal(first.lanIp, "192.168.1.20");
      assert.equal(first.meshnetIp, "100.70.1.2");
      for (let i = 0; i < 200; i++) auth.netConfig();
      for (let i = 0; i < 50; i++) auth.isAllowedHostHeader("192.168.1.20:4180");
      assert.equal(n, 1, "200 netConfig() + 50 host checks: zero more os.networkInterfaces() on the loop");

      // A stale snapshot is served as-is while the refresh runs in the worker thread (never on the loop).
      auth.setNetInterfacesForTest(IFACES_A, Date.now() - 10 * auth.NET_REFRESH_MS);
      n = 0;
      assert.equal(auth.netConfig().lanIp, "192.168.1.20", "stale-while-revalidate");
      assert.equal(n, 0, "the stale path did not enumerate adapters on the loop");
      await auth.refreshNetInterfaces(); // joins the in-flight worker refresh
      assert.equal(n, 0, "the worker refresh never called the loop's os.networkInterfaces");
      assert.deepEqual(Object.keys(auth.netInterfaces()).sort(), Object.keys(real()).sort(), "snapshot replaced by the worker's real read");
    } finally {
      os.networkInterfaces = real;
      syncBuiltinESMExports();
      auth.setNetInterfacesForTest(null);
    }
  });
});

test("518: refreshNetInterfaces is single-flight; a failed refresh keeps the last snapshot", async () => {
  await withNoNetEnv(async () => {
    try {
      auth.setNetInterfacesForTest(IFACES_A, 0);
      let reads = 0;
      let release;
      const gate = new Promise((r) => { release = r; });
      const read = async () => { reads += 1; await gate; return { Ethernet: [{ address: "10.0.0.5", family: "IPv4", internal: false }] }; };
      const p1 = auth.refreshNetInterfaces({ read });
      const p2 = auth.refreshNetInterfaces({ read });
      auth.netInterfaces({ read }); // a stale read during the refresh joins it too
      assert.equal(p1, p2, "same in-flight promise");
      assert.equal(auth.netConfig().lanIp, "192.168.1.20", "old snapshot until the refresh lands");
      release();
      await p1;
      assert.equal(reads, 1, "one adapter read for three callers");
      assert.equal(auth.netConfig().lanIp, "10.0.0.5");
      assert.equal(auth.netConfig().meshnetIp, null, "NordLynx gone in the new snapshot: meshnet address dropped, not kept");

      auth.setNetInterfacesForTest(IFACES_A, 0);
      await auth.refreshNetInterfaces({ read: async () => { throw new Error("worker died"); } });
      assert.equal(auth.netConfig().lanIp, "192.168.1.20", "failed refresh: last snapshot kept");
      await auth.refreshNetInterfaces({ read: async () => null });
      assert.equal(auth.netConfig().lanIp, "192.168.1.20", "empty answer: last snapshot kept");
    } finally {
      auth.setNetInterfacesForTest(null);
    }
  });
});

test("518: fail closed: with no LAN/Meshnet address known, nothing is widened", async () => {
  await withNoNetEnv(async () => {
    try {
      auth.setNetInterfacesForTest({ Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }], "vEthernet (WSL)": [{ address: "fe80::1", family: "IPv6", internal: false }] });
      const cfg = auth.netConfig();
      assert.equal(cfg.lanIp, null);
      assert.equal(cfg.meshnetIp, null, "pair/start answers 503 on !meshnetIp && !lanIp");
      assert.equal(auth.isAllowedHostHeader("192.168.1.20:4180"), false, "a once-seen LAN IP is not accepted");
      assert.equal(auth.isAllowedHostHeader("100.70.1.2"), false);
      assert.equal(auth.isAllowedHostHeader("localhost:4180"), true, "loopback names unaffected");
      const st = auth.getAuthStatus();
      assert.equal(st.lanHttpsUrl, null);
      assert.equal(st.caHttpUrl, null);
      assert.equal(st.desktopSetupHttpUrl, null);

      // A refresh that finds the LAN back restores it; one that loses it drops it again (no sticky widening).
      await auth.refreshNetInterfaces({ read: async () => IFACES_A });
      assert.equal(auth.isAllowedHostHeader("192.168.1.20"), true);
      await auth.refreshNetInterfaces({ read: async () => ({}) });
      assert.equal(auth.isAllowedHostHeader("192.168.1.20"), false, "address gone after refresh: refused again");

      // The sync first read failing (adapter API error) also yields no addresses.
      const real = os.networkInterfaces;
      os.networkInterfaces = () => { throw new Error("GetAdaptersAddresses failed"); };
      syncBuiltinESMExports();
      try {
        auth.setNetInterfacesForTest(null);
        assert.deepEqual([auth.netConfig().lanIp, auth.netConfig().meshnetIp], [null, null]);
      } finally {
        os.networkInterfaces = real;
        syncBuiltinESMExports();
      }
    } finally {
      auth.setNetInterfacesForTest(null);
    }
  });
});

// ---------------------------------------------------------------- host-id: computed once

test("518: getHostId resolves its default path once per home (no homedir()/disk read per /api/auth/status)", () => {
  const real = os.homedir;
  let n = 0;
  const realRead = fs.readFileSync;
  let reads = 0;
  os.homedir = () => { n += 1; return real(); };
  fs.readFileSync = function (file, ...rest) { if (String(file).endsWith(hostId.HOST_ID_FILE)) reads += 1; return realRead.call(this, file, ...rest); };
  syncBuiltinESMExports();
  const prevHome = process.env.VIBESQUAD_HOME;
  try {
    hostId.resetHostIdForTest();
    const id = hostId.getHostId();
    for (let i = 0; i < 100; i++) assert.equal(hostId.getHostId(), id);
    assert.equal(reads <= 1, true, `host-id file read at most once (${reads})`);
    assert.equal(n, 0, "VIBESQUAD_HOME set: os.homedir() never called");
    const other = tmp();
    process.env.VIBESQUAD_HOME = other;
    assert.equal(hostId.hostIdPath(), path.join(other, hostId.HOST_ID_FILE), "a moved VIBESQUAD_HOME is followed");
    assert.notEqual(hostId.getHostId(), id, "the other home gets its own id");
    delete process.env.VIBESQUAD_HOME;
    hostId.hostIdPath();
    hostId.hostIdPath();
    assert.equal(n, 1, "unset VIBESQUAD_HOME: os.homedir() once, then memoized");
  } finally {
    process.env.VIBESQUAD_HOME = prevHome;
    os.homedir = real;
    fs.readFileSync = realRead;
    syncBuiltinESMExports();
    hostId.resetHostIdForTest();
  }
});

// ---------------------------------------------------------------- file-search: async ls-files for the handlers

test("518: listFilesAsync == listFiles, async git only, one spawn for concurrent cold calls; handlers use it", async () => {
  const repo = mkRepo();
  const sync = fileSearch.listFiles(repo, { refresh: true });
  const calls = spyChildProcess();
  try {
    const [a, b] = await Promise.all([fileSearch.listFilesAsync(repo, { refresh: true }), fileSearch.listFilesAsync(repo, { refresh: true })]);
    assert.deepEqual(a, sync);
    assert.equal(a, b, "shared result");
    assert.equal(calls.async, 1, "one async ls-files for two concurrent cold calls");
    assert.equal(calls.spawnSync, 0, "no spawnSync");
    calls.reset();
    assert.deepEqual(await fileSearch.listFilesAsync(repo), sync, "cached");
    assert.equal(calls.async + calls.spawnSync, 0);

    const out = {};
    const sendJson = (res, status, body) => { out.status = status; out.body = body; };
    calls.reset();
    await fileSearch.handleFileList({ method: "GET", url: `/__vibesquad/files?cwd=${encodeURIComponent(repo)}&refresh=1` }, {}, [fs.realpathSync(path.dirname(repo))], sendJson);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.files, sync.files);
    assert.equal(calls.spawnSync, 0, "GET /__vibesquad/files: no spawnSync on the loop");
    assert.equal(calls.async, 1);

    calls.reset();
    const found = await fileSearch.runSearch(repo, { q: "unit-", regex: false, caseSensitive: false }, { rg: null });
    assert.ok(found.matches.length >= 1, "git grep path still finds matches");
    assert.equal(calls.spawnSync, 0, "runSearch without ripgrep: the is-inside-work-tree check is async now");
    assert.equal(calls.async, 1, "one async rev-parse");
    const notRepo = tmp();
    fs.writeFileSync(path.join(notRepo, "x.txt"), "unit-zz\n");
    const plain = await fileSearch.runSearch(notRepo, { q: "unit-zz", regex: false, caseSensitive: false }, { rg: null });
    assert.equal(plain.matches.length, 1, "a non-repo dir still searches via git grep --no-index");
  } finally {
    calls.restore();
  }
});
