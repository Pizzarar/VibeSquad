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
import { syncBuiltinESMExports } from "node:module";
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

// R2 (Tier A review H1/M2): same-size rewrites, same-mtime same-size rewrites, and a created-meta rewrite that keeps the bytes the
// old 64-byte probes looked at. Each of these returned the stale pre-rewrite state on 2f11bd85.
const midRewrite = (s, from, to) => { assert.ok(s.includes(from) && from.length === to.length); return s.replace(from, to); };
const statOf = (f) => fs.statSync(f);
const rewriteBody = (id) => created(id) + line(1, "status", { status: "running" }) + line(2, "usage", { contextTokens: 11111 }) + line(3, "session", { sessionId: "s-1" });

test("index parity: same-size rewrite (mtime changed) re-folds", () => {
  const h = mkHome("vs-rnr-same-");
  const f = path.join(h.dir, "rn-s.jsonl");
  const body = rewriteBody("rn-s");
  fs.writeFileSync(f, body);
  parity(h, "cold");
  const before = statOf(f);
  fs.writeFileSync(f, midRewrite(body, "\"running\"", "\"parked\" "));
  fs.utimesSync(f, before.atime, new Date(before.mtimeMs + 5000));
  assert.equal(statOf(f).size, before.size);
  parity(h, "same-size rewrite of a middle line");
});

test("index parity: same-mtime same-size rewrite inside the racy window re-folds", () => {
  const h = mkHome("vs-rnr-racy-");
  const f = path.join(h.dir, "rn-r.jsonl");
  const body = rewriteBody("rn-r");
  fs.writeFileSync(f, body);
  const sec = Math.floor(Date.now() / 1000); // whole seconds: utimes round-trips them exactly
  fs.utimesSync(f, sec, sec);
  parity(h, "cold");
  const before = statOf(f);
  fs.writeFileSync(f, midRewrite(body, "\"running\"", "\"parked\" "));
  fs.utimesSync(f, sec, sec); // same size AND same mtime as the index entry
  assert.equal(statOf(f).size, before.size);
  assert.equal(statOf(f).mtimeMs, before.mtimeMs);
  parity(h, "same-stat rewrite");
});

test("index parity: created.meta rewrite with unchanged tail lines (and an append) re-folds", () => {
  const h = mkHome("vs-rnr-meta-");
  const f = path.join(h.dir, "rn-m.jsonl");
  const body = created("rn-m", "l1", "worker", { profile: "aaaa" }) + line(1, "status", { status: "running" }) + line(2, "status", { status: "idle" });
  fs.writeFileSync(f, body);
  parity(h, "cold");
  const old = statOf(f);
  // Same length, changed only past byte 64 inside the created line; the bytes before the old offset are unchanged; then an append.
  const next = midRewrite(body, "\"aaaa\"", "\"bbbb\"");
  assert.equal(next.slice(0, 64), body.slice(0, 64));
  assert.equal(next.slice(-64), body.slice(-64));
  fs.writeFileSync(f, next + line(3, "session", { sessionId: "s-9" }));
  assert.ok(statOf(f).size > old.size);
  parity(h, "created.meta rewrite + append");
  assert.equal(listRunnerAgentsSync({ env: h.env })[0].labels.profile, "bbbb");
});

test("readIndex retries a transient EBUSY/EPERM instead of dropping the warm index", (t) => {
  const h = mkHome("vs-rnr-ridx-");
  const past = new Date(Date.now() - 60_000);
  for (let i = 0; i < 5; i++) {
    const f = path.join(h.dir, `rn-${i}.jsonl`);
    fs.writeFileSync(f, created(`rn-${i}`) + line(1, "status", { status: "idle" }));
    fs.utimesSync(f, past, past); // outside the racy window: a warm read opens no log
  }
  parity(h, "cold");
  const idx = path.join(h.rhome, INDEX_FILE);
  let fails = 2;
  const realRead = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function (p, ...rest) {
    if (p === idx && fails > 0) { fails--; const e = new Error("busy"); e.code = fails ? "EBUSY" : "EPERM"; throw e; }
    return realRead.call(this, p, ...rest);
  });
  let logOpens = 0;
  const realOpen = fs.openSync;
  t.mock.method(fs, "openSync", function (p, ...rest) {
    if (String(p).endsWith(".jsonl")) logOpens++;
    return realOpen.call(this, p, ...rest);
  });
  let got;
  try { got = listRunnerAgentsSync({ env: h.env }); } finally { t.mock.restoreAll(); }
  assert.equal(fails, 0, "the index read failed twice");
  assert.equal(logOpens, 0, "warm index kept: no log re-folded");
  assert.deepEqual(byId(got), byId(foldAllRunnerAgentsSync({ env: h.env })));
});

// ---- build lock recovery (Tier A review H2) ----

function bigBacklog(h) {
  const pad = "x".repeat(900);
  const big = [created("rn-big")];
  for (let s = 1, n = 0; n < BUILD_LOCK_BYTES + (1 << 20); s++) { const l = line(s, "output", { text: pad }); big.push(l); n += l.length; }
  fs.writeFileSync(path.join(h.dir, "rn-big.jsonl"), big.join(""));
}
const DEAD_PID = 0x7ffffff0;
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: still waiting after ${ms}ms`)), ms).unref())]);

test("build lock: a dead holder's lock is taken over and removed", () => {
  const h = mkHome("vs-rnr-lkdead-");
  bigBacklog(h);
  const lock = path.join(h.rhome, INDEX_LOCK);
  fs.writeFileSync(lock, JSON.stringify({ pid: DEAD_PID, startedAt: Date.now() }));
  const t0 = Date.now();
  parity(h, "built past a dead holder");
  assert.ok(Date.now() - t0 < 30_000);
  assert.equal(fs.existsSync(lock), false, "our lock released, the dead one gone");
});

for (const [name, content, ageMs] of [["an empty (past the grace)", "", 5000], ["a corrupt JSON (past the grace)", "{\"pid\":12", 5000], ["an empty and fresh (its holder is mid-write)", "", 0]]) {
  test(`build lock: ${name} lock is not busy forever`, async () => {
    const h = mkHome("vs-rnr-lkbad-");
    bigBacklog(h);
    process.env.VIBESQUAD_HOME = h.vsHome;
    const lock = path.join(h.rhome, INDEX_LOCK);
    fs.writeFileSync(lock, content);
    if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(lock, t, t); }
    try {
      const got = await withTimeout(listRunnerAgents(), 15_000, "scan behind a bad lock");
      assert.deepEqual(byId(got), byId(foldAllRunnerAgentsSync({ env: h.env })));
    } finally {
      delete process.env.VIBESQUAD_HOME;
    }
    assert.equal(fs.existsSync(lock), false);
  });
}

test("build lock: EPERM on create (Windows delete-pending) never steals or deletes a live holder's lock", async (t) => {
  const h = mkHome("vs-rnr-lkeperm-");
  bigBacklog(h);
  const lock = path.join(h.rhome, INDEX_LOCK);
  const holder = JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: "someone-else" });
  fs.writeFileSync(lock, holder);
  const realOpen = fs.openSync;
  t.mock.method(fs, "openSync", function (p, flags, ...rest) {
    if (String(p) === lock && String(flags).includes("x")) { const e = new Error("delete pending"); e.code = "EPERM"; throw e; }
    return realOpen.call(this, p, flags, ...rest);
  });
  syncBuiltinESMExports(); // runner/lock.mjs imports openSync by name
  process.env.VIBESQUAD_HOME = h.vsHome;
  let done = false;
  const p = listRunnerAgents().finally(() => { done = true; });
  try {
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(done, false, "waits for the live holder instead of building beside it");
    assert.equal(fs.readFileSync(lock, "utf8"), holder, "the holder's lock is untouched");
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(lock); // the holder finishes
    const got = await withTimeout(p, 30_000, "scan after the holder released");
    assert.deepEqual(byId(got), byId(foldAllRunnerAgentsSync({ env: h.env })));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    delete process.env.VIBESQUAD_HOME;
    await p.catch(() => {});
  }
  assert.equal(fs.existsSync(lock), false);
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
  if (idx.v !== 2 || typeof idx.fold !== "string" || !idx.entries || typeof idx.entries !== "object") { console.error("BAD INDEX"); process.exit(3); }
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
