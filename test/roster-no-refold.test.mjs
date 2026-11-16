// unit-roster-no-refold: `vs who` and the server's roster scan stopped re-folding every agent log from byte 0 (444MB live,
// 7-11s of CPU per call, which made the runner's own boot fold take 120s on 11-16). This file pins:
//   - the byte-offset index (roster-index.mjs) answers exactly like the full fold after appends, rewrites, shrinks and a
//     trailing line without its newline;
//   - concurrent `vs who` processes never corrupt the index (atomic tmp + rename, no tmp/lock files left behind);
//   - `vs who` prints the same thing whether its agents come from the live runner over HTTP or from the logs;
//   - refreshRunnerRoster runs one scan at a time (fresh callers share one follow-up) and folds nothing while the runner boots.
import "./helpers/clean-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { foldAllRunnerAgentsSync, listRunnerAgentsSync, listRunnerAgents } from "../server/backend/runner-backend.mjs";
import { INDEX_FILE, INDEX_LOCK, BUILD_LOCK_BYTES, writeIndexAtomic } from "../server/backend/roster-index.mjs";
import { createServer } from "../runner/server.mjs";
import { Runner } from "../runner/runner.mjs";
import { _resetLaneAgentsCache, _rosterDepsForTest, _rosterScansForTest, _runnerRosterReady, _liveRunnerAgentsForTest } from "../server/vibesquad-api.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "cli", "vs.mjs");
const OLD = 1_700_000_000_000; // event clock well before any runner.json startedAt in this file

function mkHome(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const vsHome = path.join(root, "vs");
  const rhome = path.join(vsHome, "runner");
  const dir = path.join(rhome, "agents");
  fs.mkdirSync(dir, { recursive: true });
  return { root, vsHome, rhome, dir, env: { VIBESQUAD_HOME: vsHome } };
}
const line = (seq, type, o = {}) => JSON.stringify({ seq, ts: OLD + seq, type, ...o }) + "\n";
const created = (id, lane = "l1", role = "worker", extra = {}) =>
  line(0, "created", { provider: "claude", model: "m", cwd: `/w/${id}`, meta: { title: `T ${id}`, labels: { team: "t", lane, role, ...extra } } });
const byId = (xs) => [...xs].sort((a, b) => (a.id < b.id ? -1 : 1));
const parity = (h, msg) => assert.deepEqual(byId(listRunnerAgentsSync({ env: h.env })), byId(foldAllRunnerAgentsSync({ env: h.env })), msg);
const indexOf = (h) => JSON.parse(fs.readFileSync(path.join(h.rhome, INDEX_FILE), "utf8"));

test("index parity: appends, rewrite, shrink, and a last line without its newline", () => {
  const h = mkHome("vs-rnr-par-");
  const p = (id) => path.join(h.dir, `${id}.jsonl`);
  fs.writeFileSync(p("rn-a"), created("rn-a") + line(1, "status", { status: "running" }) + line(2, "tool", { id: "c1", phase: "call", name: "Bash" }));
  fs.writeFileSync(p("rn-b"), created("rn-b", "l2", "lead") + line(1, "usage", { contextTokens: 5000, contextMax: 200000, extra: "dropped" }) + line(2, "status", { status: "idle" }));
  fs.writeFileSync(p("rn-c"), created("rn-c") + line(1, "permission", { phase: "request", id: "p1", toolName: "Edit" }) + line(2, "archive"));
  fs.writeFileSync(path.join(h.dir, "not-runner.jsonl"), created("x")); // not an rn- id: never listed
  parity(h, "cold index");
  assert.equal(Object.keys(indexOf(h).entries).length, 3);
  parity(h, "warm index (no change)");

  // Appends: only the tail is folded, and the answer still matches.
  fs.appendFileSync(p("rn-a"), line(3, "tool", { id: "c1", phase: "result" }) + line(4, "status", { status: "idle" }) + line(5, "meta", { patch: { labels: { lane: "l9" } } }));
  fs.appendFileSync(p("rn-c"), line(3, "permission", { phase: "resolve", id: "p1" }) + line(4, "unarchive"));
  parity(h, "after appends");
  assert.equal(indexOf(h).entries["rn-a"].offset, fs.statSync(p("rn-a")).size, "offset at the end of the last complete line");

  // A last line without its newline: folded into the answer like a full read, not into the saved state.
  const tail = line(6, "status", { status: "running" });
  fs.appendFileSync(p("rn-a"), tail.slice(0, -1));
  parity(h, "trailing line without newline");
  assert.equal(indexOf(h).entries["rn-a"].offset, fs.statSync(p("rn-a")).size - (tail.length - 1), "the partial line is not in the saved offset");
  fs.appendFileSync(p("rn-a"), "\n" + line(7, "exit"));
  parity(h, "partial line completed");
  // A half-written line (cut mid multi-byte char) is skipped by both, then folded once complete.
  const uni = line(8, "meta", { patch: { title: "zé 🙂 done" } });
  const ubuf = Buffer.from(uni);
  const cut = ubuf.indexOf(Buffer.from("🙂")) + 2;
  fs.appendFileSync(p("rn-a"), ubuf.subarray(0, cut));
  parity(h, "mid-codepoint partial line");
  fs.appendFileSync(p("rn-a"), ubuf.subarray(cut));
  parity(h, "mid-codepoint line completed");
  assert.equal(listRunnerAgentsSync({ env: h.env }).find((a) => a.id === "rn-a").title, "zé 🙂 done");

  // Rewritten (longer, different content from byte 0): the stale offset must not be trusted.
  fs.writeFileSync(p("rn-b"), created("rn-b", "l3", "brainstorm") + line(1, "status", { status: "running" }) + line(2, "status", { status: "parked" }) + line(3, "session", { sessionId: "s-1" }));
  parity(h, "after rewrite");
  assert.equal(listRunnerAgentsSync({ env: h.env }).find((a) => a.id === "rn-b").labels.lane, "l3", "the rewritten created event");

  // Rewritten with the same first bytes and a longer body: the bytes before the old offset differ, so it re-folds.
  const bOld = fs.readFileSync(p("rn-b"), "utf8");
  const bNew = created("rn-b", "l3", "brainstorm") + line(1, "status", { status: "running" }) + line(2, "usage", { contextTokens: 77 }) + line(3, "status", { status: "idle" }) + line(4, "exit");
  assert.ok(bNew.length > bOld.length && bNew.slice(0, 64) === bOld.slice(0, 64));
  fs.writeFileSync(p("rn-b"), bNew);
  parity(h, "rewrite sharing the head");
  assert.equal(listRunnerAgentsSync({ env: h.env }).find((a) => a.id === "rn-b").status, "closed");

  // Shrunk below the saved offset: folded from 0 again.
  fs.writeFileSync(p("rn-c"), created("rn-c"));
  parity(h, "after shrink");
  assert.equal(listRunnerAgentsSync({ env: h.env }).find((a) => a.id === "rn-c").pendingPermissions.length, 0);

  // A log removed, one added; and a live runner.json turns pre-start agents lost in both folds.
  fs.rmSync(p("rn-c"));
  fs.writeFileSync(p("rn-d"), created("rn-d") + line(1, "session", { sessionId: "s-d" }) + line(2, "status", { status: "idle" }));
  fs.writeFileSync(path.join(h.rhome, "runner.json"), JSON.stringify({ port: 1, pid: process.pid, startedAt: Date.now() }));
  parity(h, "remove + add + liveness");
  assert.deepEqual(Object.keys(indexOf(h).entries).sort(), ["rn-a", "rn-b", "rn-d"]);
  const d = listRunnerAgentsSync({ env: h.env }).find((a) => a.id === "rn-d");
  assert.equal(d.lost, true);
  assert.equal(d.resumable, true);

  // A torn / foreign index file is ignored, not trusted.
  fs.writeFileSync(path.join(h.rhome, INDEX_FILE), "{\"v\":1,\"fold\":\"x\",\"entr");
  parity(h, "torn index");
  fs.writeFileSync(path.join(h.rhome, INDEX_FILE), JSON.stringify({ v: 1, fold: "other-version", entries: { "rn-a": { size: 1, offset: 1, state: {} } } }));
  parity(h, "index from another fold version");
});

test("index parity: the async server scan (listRunnerAgents) uses the same index", async () => {
  const h = mkHome("vs-rnr-async-");
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(h.dir, `rn-${i}.jsonl`), created(`rn-${i}`) + line(1, "status", { status: i % 2 ? "idle" : "running" }));
  process.env.VIBESQUAD_HOME = h.vsHome;
  try {
    assert.deepEqual(byId(await listRunnerAgents()), byId(foldAllRunnerAgentsSync({ env: h.env })));
    fs.appendFileSync(path.join(h.dir, "rn-3.jsonl"), line(2, "exit"));
    assert.deepEqual(byId(await listRunnerAgents()), byId(foldAllRunnerAgentsSync({ env: h.env })));
  } finally {
    delete process.env.VIBESQUAD_HOME;
  }
});

test("a test that forgot its temp home never writes the index into the real ~/.vibesquad (VS_TEST_REAL_HOME stand-in)", () => {
  const h = mkHome("vs-rnr-guard-");
  fs.writeFileSync(path.join(h.dir, "rn-g.jsonl"), created("rn-g") + line(1, "status", { status: "idle" }));
  process.env.VS_TEST_REAL_HOME = h.vsHome; // declares this temp home "the real home" for test-guard.mjs
  try {
    parity(h, "answers in memory");
    assert.deepEqual(fs.readdirSync(h.rhome).sort(), ["agents"], "no index, tmp or lock file written");
  } finally {
    delete process.env.VS_TEST_REAL_HOME;
  }
  parity(h, "a normal home persists");
  assert.ok(fs.existsSync(path.join(h.rhome, INDEX_FILE)));
});

test("writeIndexAtomic: tmp + rename, nothing left behind, never a partial file", () => {
  const h = mkHome("vs-rnr-atomic-");
  const file = path.join(h.rhome, INDEX_FILE);
  assert.equal(writeIndexAtomic(file, "{\"a\":1}"), true);
  assert.equal(writeIndexAtomic(file, "{\"a\":2}"), true);
  assert.equal(fs.readFileSync(file, "utf8"), "{\"a\":2}");
  assert.deepEqual(fs.readdirSync(h.rhome).filter((f) => f.endsWith(".tmp")), []);
  // A rename that keeps failing: the old index stays whole and the tmp file is removed.
  const real = fs.renameSync;
  fs.renameSync = () => { const e = new Error("busy"); e.code = "EBUSY"; throw e; };
  try {
    assert.equal(writeIndexAtomic(file, "{\"a\":3}", { sleep: () => {} }), false);
  } finally {
    fs.renameSync = real;
  }
  assert.equal(fs.readFileSync(file, "utf8"), "{\"a\":2}");
  assert.deepEqual(fs.readdirSync(h.rhome).filter((f) => f.endsWith(".tmp")), []);
});

// Child process: one `vs who`-like reader. Appends to its own log before every read (so every read rewrites the index while the
// others do too), checks its answer against the full fold for every log no other child writes, and checks the index on disk.
const CHILD = `
import fs from "node:fs";
import path from "node:path";
const [modUrl, vsHome, me, rounds] = process.argv.slice(2);
const m = await import(modUrl);
const env = { VIBESQUAD_HOME: vsHome };
const rhome = path.join(vsHome, "runner");
const own = path.join(rhome, "agents", me + ".jsonl");
const mine = (a) => !a.id.startsWith("rn-w") || a.id === me;
const sort = (xs) => xs.filter(mine).sort((a, b) => (a.id < b.id ? -1 : 1));
function readIndex() {
  for (let i = 0; ; i++) {
    try { return JSON.parse(fs.readFileSync(path.join(rhome, "roster-index.json"), "utf8")); } catch (e) {
      if (i > 50 || !["EPERM", "EBUSY", "EACCES", "ENOENT"].includes(e?.code)) throw new Error("index unreadable: " + e.message);
    }
  }
}
for (let r = 0; r < Number(rounds); r++) {
  fs.appendFileSync(own, JSON.stringify({ seq: 100 + r, ts: 1_700_000_100_000 + r, type: "status", status: r % 2 ? "idle" : "running" }) + "\\n");
  const got = JSON.stringify(sort(m.listRunnerAgentsSync({ env })));
  const want = JSON.stringify(sort(m.foldAllRunnerAgentsSync({ env })));
  if (got !== want) { console.error("MISMATCH round " + r); process.exit(2); }
  const idx = readIndex();
  if (idx.v !== 1 || typeof idx.fold !== "string" || !idx.entries || typeof idx.entries !== "object") { console.error("BAD INDEX"); process.exit(3); }
}
console.log("ok");
`;

test("concurrent vs who readers never corrupt the index (and a big cold backlog builds under the lock)", async () => {
  const h = mkHome("vs-rnr-conc-");
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(h.dir, `rn-s${i}.jsonl`), created(`rn-s${i}`, `l${i % 3}`) + line(1, "status", { status: "idle" }));
  // One log over BUILD_LOCK_BYTES: the first cold reads take the build lock; the others wait for it.
  const pad = "x".repeat(900);
  const big = [created("rn-big")];
  for (let s = 1, n = 0; n < BUILD_LOCK_BYTES + (1 << 20); s++) { const l = line(s, "output", { text: pad }); big.push(l); n += l.length; }
  fs.writeFileSync(path.join(h.dir, "rn-big.jsonl"), big.join(""));
  const K = 4;
  for (let k = 0; k < K; k++) fs.writeFileSync(path.join(h.dir, `rn-w${k}.jsonl`), created(`rn-w${k}`));
  const childFile = path.join(h.root, "child.mjs");
  fs.writeFileSync(childFile, CHILD);
  const modUrl = pathToFileURL(path.join(REPO, "server", "backend", "runner-backend.mjs")).href;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VS_|VIBESQUAD_|PASEO_)/i.test(k)));
  const runs = await Promise.all(Array.from({ length: K }, (_, k) => new Promise((resolve) => {
    const c = spawn(process.execPath, [childFile, modUrl, h.vsHome, `rn-w${k}`, "8"], { env, windowsHide: true });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("exit", (code) => resolve({ code, out }));
  })));
  for (const r of runs) assert.equal(r.code, 0, r.out);
  assert.deepEqual(fs.readdirSync(h.rhome).filter((f) => f.endsWith(".tmp") || f === INDEX_LOCK), [], "no tmp or lock file left");
  parity(h, "after the concurrent run");
  assert.equal(Object.keys(indexOf(h).entries).length, 60 + 1 + K);
});

// ---- vs who: runner over HTTP vs logs ----

function runVs(args, h) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VS_|VIBESQUAD_|PASEO_)/i.test(k)));
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { cwd: h.root, env: { ...env, VIBESQUAD_HOME: h.vsHome, PASEO_HOME: path.join(h.root, ".paseo"), VIBESQUAD_PORT: "1" }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => { stdout += d; });
    c.stderr.on("data", (d) => { stderr += d; });
    c.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("vs who prints the same roster from the live runner (HTTP) as from the logs", async () => {
  const h = mkHome("vs-rnr-who-");
  fs.writeFileSync(path.join(h.vsHome, "teams.json"), JSON.stringify({ teams: [{ id: "t", name: "T", paths: [], lanes: ["l1", "l2", "l3"].map((id) => ({ id, name: id })) }] }) + "\n");
  const w = (id, body) => fs.writeFileSync(path.join(h.dir, `${id}.jsonl`), body);
  w("rn-lead1", created("rn-lead1", "l1", "lead", { ord: "1" }) + line(1, "session", { sessionId: "s1" }) + line(2, "usage", { contextTokens: 64000, contextMax: 200000 }) + line(3, "status", { status: "idle" }));
  w("rn-bud1", created("rn-bud1", "l1", "brainstorm") + line(1, "usage", { contextTokens: 12000 }) + line(2, "status", { status: "parked" }));
  w("rn-wk1", created("rn-wk1", "l1") + line(1, "status", { status: "running" }) + line(2, "tool", { id: "c", phase: "call", name: "Bash" }));
  w("rn-wk2", created("rn-wk2", "l2") + line(1, "status", { status: "idle" }) + line(2, "exit", { code: 0 }));
  w("rn-old", created("rn-old", "l2", "lead") + line(1, "status", { status: "idle" }) + line(2, "archive"));
  w("rn-lead3", created("rn-lead3", "l3", "lead") + line(1, "session", { sessionId: "s3" }) + line(2, "status", { status: "idle" }));

  const runner = new Runner({ dir: h.dir, adapters: { claude: { canPark: true } }, // every real adapter canPark (the resumable predicate)
    limitsFile: path.join(h.rhome, "limits.jsonl") });
  const token = "tok-" + process.pid;
  let hits = 0;
  const srv = createServer(runner, { token, hash: "h" });
  srv.on("request", (req) => { if (req.url.startsWith("/agents")) hits++; });
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  fs.writeFileSync(path.join(h.rhome, "token"), token);
  fs.writeFileSync(path.join(h.rhome, "runner.json"), JSON.stringify({ port, pid: process.pid, startedAt: Date.now() }));
  const cases = [["who", "all", "--team", "t"], ["who", "lead", "--team", "t", "--lane", "l1"], ["who", "brainstorm", "--team", "t", "--lane", "l1"]];
  const live = [];
  try {
    for (const args of cases) live.push(await runVs(args, h));
  } finally {
    await new Promise((r) => srv.close(r));
    runner.shutdown({ keepResumable: true });
  }
  assert.equal(hits, cases.length, "every vs who asked the runner");
  assert.ok(!fs.existsSync(path.join(h.rhome, INDEX_FILE)), "no log fold while the runner answered");
  // Runner gone (connection refused; runner.json still names this live pid, so liveness is the same): the logs answer.
  const logs = [];
  for (const args of cases) logs.push(await runVs(args, h));
  assert.ok(fs.existsSync(path.join(h.rhome, INDEX_FILE)), "the fallback folded the logs");
  for (let i = 0; i < cases.length; i++) {
    assert.equal(live[i].code, 0, live[i].stderr);
    assert.equal(logs[i].code, 0, logs[i].stderr);
    assert.ok(live[i].stdout.trim(), `non-empty output for ${cases[i].join(" ")}`);
    assert.equal(logs[i].stdout, live[i].stdout, `same output for vs ${cases[i].join(" ")}`);
  }
  assert.match(live[0].stdout, /rn-lead1/);
  assert.match(live[0].stdout, /rn-lead3/);
});

// ---- refreshRunnerRoster ----

const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
const agent = (id) => ({ id, cwd: `/w/${id}`, archivedAt: null });

test("refreshRunnerRoster: concurrent callers share one scan; fresh callers get one shared follow-up", async () => {
  _resetLaneAgentsCache();
  const gates = [];
  let roster = [agent("rn-1")];
  const restore = _rosterDepsForTest({
    home: () => "unused",
    discovery: () => null,
    booting: () => null,
    fold: async () => { const d = deferred(); gates.push(d); const snap = roster; await d.p; return snap; },
  });
  try {
    const a = [_runnerRosterReady(), _runnerRosterReady(), _runnerRosterReady()];
    await new Promise((r) => setImmediate(r));
    assert.equal(_rosterScansForTest().fold, 1, "one scan for three callers");
    roster = [agent("rn-1"), agent("rn-2")]; // a worktree created after the scan listed the dir
    const f = [_runnerRosterReady(true), _runnerRosterReady(true), _runnerRosterReady(true)];
    await new Promise((r) => setImmediate(r));
    assert.equal(_rosterScansForTest().fold, 1, "fresh callers wait for the running scan, they do not start a parallel one");
    gates[0].resolve();
    await Promise.all(a);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(_rosterScansForTest().fold, 2, "exactly one follow-up for all fresh callers");
    assert.deepEqual(_liveRunnerAgentsForTest(Date.now()).map((x) => x.id), ["rn-1"]);
    gates[1].resolve();
    await Promise.all(f);
    assert.deepEqual(_liveRunnerAgentsForTest(Date.now()).map((x) => x.id), ["rn-1", "rn-2"], "fresh callers see the follow-up's roster");
    assert.equal(_rosterScansForTest().fold, 2);
    // A fresh caller with nothing in flight just scans once.
    const g = _runnerRosterReady(true);
    await new Promise((r) => setImmediate(r));
    assert.equal(_rosterScansForTest().fold, 3);
    gates[2].resolve();
    await g;
  } finally {
    restore();
    _resetLaneAgentsCache();
  }
});

test("refreshRunnerRoster: no log fold while the runner boots; the last roster stands", async () => {
  _resetLaneAgentsCache();
  let booting = null;
  let up = false;
  let runnerCalls = 0;
  const restore = _rosterDepsForTest({
    home: () => "unused",
    discovery: () => (up ? { port: 1, token: "t" } : null),
    booting: () => booting,
    runner: () => ({ listAgents: async () => { runnerCalls++; if (!up) throw new Error("refused"); return [agent("rn-a"), agent("rn-b")]; } }),
    fold: async () => [agent("rn-a")],
  });
  try {
    await _runnerRosterReady(); // runner down, not booting: the index fold
    assert.deepEqual(_rosterScansForTest(), { runner: 0, fold: 1, skippedBooting: 0 });
    assert.deepEqual(_liveRunnerAgentsForTest(Date.now()).map((x) => x.id), ["rn-a"]);

    booting = { pid: 4242, startedAt: Date.now() }; // a runner holds runner.lock and has not published runner.json yet
    await _runnerRosterReady();
    await _runnerRosterReady(true);
    assert.deepEqual(_rosterScansForTest(), { runner: 0, fold: 1, skippedBooting: 2 }, "booting: no fold");
    assert.deepEqual(_liveRunnerAgentsForTest(Date.now()).map((x) => x.id), ["rn-a"], "the last roster stands");

    // A stale runner.json from the old runner while the new one boots: the request is refused, and still no fold.
    const restore2 = _rosterDepsForTest({ discovery: () => ({ port: 1, token: "t" }) });
    await _runnerRosterReady();
    restore2();
    assert.equal(runnerCalls, 1, "it asked the (stale) runner first");
    assert.deepEqual(_rosterScansForTest(), { runner: 0, fold: 1, skippedBooting: 3 }, "stale runner.json while booting: no fold");

    up = true;
    booting = null; // published: the runner's own roster
    await _runnerRosterReady();
    assert.deepEqual(_rosterScansForTest(), { runner: 1, fold: 1, skippedBooting: 3 });
    assert.deepEqual(_liveRunnerAgentsForTest(Date.now()).map((x) => x.id), ["rn-a", "rn-b"]);
  } finally {
    restore();
    _resetLaneAgentsCache();
  }
});
