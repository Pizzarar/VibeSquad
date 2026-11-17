// unit-runner-fold-incr (idea-261): the runner's boot fold resumes from <runner home>/fold-index.json. Every case compares a
// runner booted WITH the index against one booted without it (the full fold from byte 0): same fold state, same status record
// (incl. openTool / resumable / labels), same LogStore line index. Temp homes only.
import "./helpers/clean-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Runner } from "../runner/runner.mjs";
import { FOLD_INDEX_FILE, FOLD_VERSION, readFoldIndex, saveFold } from "../runner/fold-index.mjs";

const adapters = { claude: { canPark: true, lazyResume: true } }; // resumable needs an adapter that can park; nothing is spawned
function home() {
  const h = mkdtempSync(path.join(os.tmpdir(), "vs-foldidx-"));
  return { dir: path.join(h, "agents"), file: path.join(h, FOLD_INDEX_FILE) };
}
const boot = (h, { index = true } = {}) => {
  const r = new Runner({ dir: h.dir, adapters, maxLive: 4, foldIndexFile: index ? h.file : null });
  r.recoverQueued();
  return r;
};
const logFile = (h, id) => path.join(h.dir, `${id}.jsonl`);
const ev = (seq, type, data = {}, ts = 1_700_000_000_000 + seq) => JSON.stringify({ seq, ts, type, ...data }) + "\n";
const age = (h, id, s = 60) => { const t = Date.now() / 1000 - s; utimesSync(logFile(h, id), t, t); }; // out of the racy window

// One agent's log: created (with a system prompt), session, a turn with tools, permission, usage, meta label patches.
function agentLog(id, { closed = null, openCall = false, queued = false, n = 40 } = {}) {
  let s = 0;
  let out = ev(s++, "created", { provider: "claude", model: "m", cwd: "/w", meta: { title: id, labels: { team: "t", lane: "l", role: "worker" } }, systemPrompt: "You are " + id + " ".repeat(300) });
  out += ev(s++, "session", { sessionId: `sess-${id}`, modes: ["default", "plan"], models: ["m"] });
  out += ev(s++, "input", { text: "go" });
  out += ev(s++, "status", { status: "running" });
  for (let i = 0; i < n; i++) {
    out += ev(s++, "tool", { id: `c${i}`, phase: "call", name: "Bash", input: { command: "ls", timeout: 60_000 } });
    out += ev(s++, "text", { text: "x".repeat(50 + (i % 7)) });
    out += ev(s++, "tool", { id: `c${i}`, phase: "result" });
  }
  out += ev(s++, "permission", { phase: "request", id: "p1", toolName: "Write" });
  out += ev(s++, "usage", { contextTokens: 10, contextMax: 100, inputTokens: 5, outputTokens: 2, costUsd: 0.1 });
  out += ev(s++, "meta", { patch: { labels: { role: "lead" }, title: `${id}!` } });
  if (openCall) out += ev(s++, "tool", { id: "open-1", phase: "call", kind: "execute", name: "npm test --queue" });
  else { out += ev(s++, "turn_done"); out += ev(s++, "status", { status: queued ? "queued" : "idle", ...(queued ? { ahead: 2 } : {}) }); }
  if (closed === "archive") out += ev(s++, "archive");
  if (closed === "exit") out += ev(s++, "exit", { code: 0 });
  return { text: out, seq: s };
}

function writeAgents(h, n = 6) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = `rn-${String(i).padStart(4, "0")}`;
    const { text } = agentLog(id, { closed: i % 3 === 1 ? "archive" : i % 3 === 2 ? "exit" : null, openCall: i === 3, queued: false });
    writeFileSync(logFile(h, id), text, { flag: "w" });
    ids.push(id);
  }
  return ids;
}

// What a runner knows about each agent: fold state, status record, line index (count + offsets).
function snapshot(r) {
  const out = {};
  for (const id of r.store.ids().sort()) {
    const s = r.status(id);
    const f = r.folds.get(id);
    r.store.count(id); // builds the line index if the fold did not
    const ix = r.store.idx.get(id);
    out[id] = { state: f ? JSON.stringify(saveFold(f)) : null, status: JSON.stringify(s), ix: ix ? JSON.stringify(ix) : null };
  }
  return out;
}
const parity = (h, r, msg) => assert.deepEqual(snapshot(r), snapshot(boot(h, { index: false })), msg);

function setup(n) {
  const h = home();
  rmSync(h.dir, { recursive: true, force: true });
  new Runner({ dir: h.dir, adapters, maxLive: 4 }); // creates the dir
  const ids = writeAgents(h, n);
  for (const id of ids) age(h, id);
  const r = boot(h);
  assert.equal(r.foldIndexStats.entries, 0, "no index yet");
  assert.equal(r.foldIndexStats.full, ids.length);
  assert.equal(r.saveFoldIndexSync().result, "written");
  return { h, ids, r };
}

test("cold boot folds from 0 and saves; a warm boot of unchanged logs reads nothing and matches the full fold", () => {
  const { h, ids, r: cold } = setup(6);
  parity(h, cold, "cold boot = full fold");
  const idx = readFoldIndex(h.file);
  assert.equal(idx.size, ids.length);
  assert.ok(!JSON.stringify([...idx.values()]).includes("You are "), "system prompts are not saved");
  const warm = boot(h);
  assert.deepEqual({ ...warm.foldIndexStats, loadMs: 0 }, { entries: ids.length, trusted: ids.length, resumed: 0, full: 0, bytes: 0, loadMs: 0 });
  parity(h, warm, "warm boot = full fold");
  const s3 = warm.status("rn-0003");
  assert.equal(s3.openTool, null, "a lost agent publishes no open tool");
  assert.equal(warm.folds.get("rn-0003").rec.openTool.id, "open-1", "the fold keeps the open call");
  assert.equal(warm.folds.get("rn-0003").rec.openTool.name, "execute");
  assert.equal(warm.status("rn-0000").resumable, true);
  assert.equal(warm.status("rn-0000").meta.labels.role, "lead");
  assert.equal(warm.status("rn-0001").resumable, false, "archived");
  assert.equal(warm.status("rn-0002").status, "exited");
});

test("append: only the new bytes are folded (incl. a tool result closing the open call, labels, queued); parity", () => {
  const { h } = setup(6);
  const add = ev(900, "tool", { id: "open-1", phase: "result" }) + ev(901, "turn_done") + ev(902, "status", { status: "idle" });
  appendFileSync(logFile(h, "rn-0003"), add);
  const add0 = ev(900, "meta", { patch: { labels: { lane: "l2" } } }) + ev(901, "permission", { phase: "resolve", id: "p1" }) + ev(902, "input", { text: "more" }) + ev(903, "status", { status: "queued", ahead: 1 });
  appendFileSync(logFile(h, "rn-0000"), add0);
  const add1 = ev(900, "unarchive");
  appendFileSync(logFile(h, "rn-0001"), add1);
  const r = boot(h);
  assert.equal(r.foldIndexStats.resumed, 3);
  assert.equal(r.foldIndexStats.full, 0);
  assert.equal(r.foldIndexStats.bytes, Buffer.byteLength(add + add0 + add1));
  parity(h, r);
  assert.equal(r.folds.get("rn-0003").rec.openTool, null);
  assert.equal(r.status("rn-0000").meta.labels.lane, "l2");
  assert.deepEqual(r.status("rn-0000").pendingPermissions, []);
  assert.equal(r.status("rn-0001").archivedAt, null);
  // an append through the store after a resumed boot gets the right seq (line index seeded, not recounted)
  const before = r.store.count("rn-0000");
  const e = r.store.append("rn-0000", "text", { text: "after" });
  assert.equal(e.seq, before);
  parity(h, r, "after a store append");
});

test("same-size rewrite with a new mtime, and one inside the racy window with the same mtime, fold from 0", () => {
  const { h } = setup(4);
  const f = logFile(h, "rn-0000");
  const text = readFileSync(f, "utf8");
  writeFileSync(f, text.replace('"title":"rn-0000!"', '"title":"rn-XXXX!"')); // same size, new mtime
  assert.equal(statSync(f).size, Buffer.byteLength(text));
  let r = boot(h);
  assert.equal(r.foldIndexStats.full, 1);
  parity(h, r);
  assert.equal(r.status("rn-0000").meta.title, "rn-XXXX!");
  // Racy: the entry is saved within RACY_MS of the log's mtime; a rewrite keeping size AND mtime is not trusted.
  const r2 = boot(h);
  assert.equal(r2.saveFoldIndexSync().result, "written");
  const f1 = logFile(h, "rn-0001");
  const st = statSync(f1);
  const t1 = readFileSync(f1, "utf8");
  const m = Math.floor(Date.now() / 1000); // whole seconds: restored exactly below
  utimesSync(f1, m, m); // fresh mtime -> the next save records it racy
  const r3 = boot(h);
  r3.saveFoldIndexSync();
  writeFileSync(f1, t1.replace('"title":"rn-0001!"', '"title":"rn-YYYY!"'));
  utimesSync(f1, m, m);
  assert.equal(readFoldIndex(h.file).get("rn-0001").mtimeMs, statSync(f1).mtimeMs, "same size AND same mtime as the entry");
  assert.equal(statSync(f1).size, st.size);
  const r4 = boot(h);
  assert.equal(r4.foldIndexStats.full, 1, "racy entry refolded");
  parity(h, r4);
  assert.equal(r4.status("rn-0001").meta.title, "rn-YYYY!");
});

test("shrink and removed log: refolded from 0 / dropped; parity", () => {
  const { h, ids } = setup(4);
  const f = logFile(h, "rn-0000");
  const text = readFileSync(f, "utf8");
  const lines = text.split("\n");
  truncateSync(f, Buffer.byteLength(lines.slice(0, 10).join("\n") + "\n"));
  rmSync(logFile(h, "rn-0002"));
  const r = boot(h);
  assert.equal(r.foldIndexStats.full, 1);
  assert.equal(r.foldIndexStats.trusted, ids.length - 2);
  parity(h, r);
  assert.equal(r.status("rn-0002"), null);
  assert.equal(r.status("rn-0000").status, "running");
  r.saveFoldIndexSync();
  assert.ok(!readFoldIndex(h.file).has("rn-0002"), "a removed log's entry is not saved again");
});

test("partial last line: not folded, not saved; once completed it is folded exactly once", () => {
  const h = home();
  new Runner({ dir: h.dir, adapters, maxLive: 4 });
  writeFileSync(logFile(h, "rn-p"), agentLog("rn-p").text);
  const half = ev(500, "tool", { id: "late", phase: "call", name: "Grep" });
  appendFileSync(logFile(h, "rn-p"), ev(499, "status", { status: "running" }) + half.slice(0, 20));
  age(h, "rn-p");
  const r = boot(h);
  r.saveFoldIndexSync();
  const e = readFoldIndex(h.file).get("rn-p");
  assert.ok(e.offset < e.size, "the entry stops at the last complete line");
  const warm = boot(h);
  assert.equal(warm.foldIndexStats.trusted, 1);
  parity(h, warm, "partial line unchanged");
  appendFileSync(logFile(h, "rn-p"), half.slice(20));
  const r2 = boot(h);
  assert.equal(r2.foldIndexStats.resumed, 1);
  parity(h, r2, "completed line folded once");
  assert.equal(r2.folds.get("rn-p").rec.openTool.id, "late");
});

test("an index from an older fold version, a corrupt index and a corrupt entry: full refold, same answer", () => {
  const { h, ids } = setup(4);
  const good = readFileSync(h.file, "utf8");
  writeFileSync(h.file, good.replace(FOLD_VERSION, "older-version"));
  let r = boot(h);
  assert.deepEqual([r.foldIndexStats.entries, r.foldIndexStats.full], [0, ids.length]);
  parity(h, r);
  writeFileSync(h.file, good.slice(0, Math.floor(good.length / 2))); // torn
  r = boot(h);
  assert.deepEqual([r.foldIndexStats.entries, r.foldIndexStats.full], [0, ids.length]);
  parity(h, r);
  writeFileSync(h.file, "\u0000garbage");
  r = boot(h);
  assert.equal(r.foldIndexStats.full, ids.length);
  // one entry with a broken state: only that log is refolded
  const o = JSON.parse(good);
  o.entries["rn-0001"].state.perms = "nope";
  o.entries["rn-0002"].state = null;
  writeFileSync(h.file, JSON.stringify(o));
  r = boot(h);
  assert.deepEqual([r.foldIndexStats.full, r.foldIndexStats.trusted], [2, ids.length - 2]);
  parity(h, r);
});

test("probes: a rewritten created line or last folded line with an append folds from 0", () => {
  const { h } = setup(3);
  const f0 = logFile(h, "rn-0000");
  writeFileSync(f0, readFileSync(f0, "utf8").replace('"title":"rn-0000"', '"title":"rn-HEAD"') + ev(800, "text", { text: "more" }));
  const f1 = logFile(h, "rn-0001");
  const t1 = readFileSync(f1, "utf8");
  const k = t1.lastIndexOf('"archive"');
  writeFileSync(f1, t1.slice(0, k) + '"archivx"' + t1.slice(k + 9) + ev(800, "text", { text: "more" }));
  const r = boot(h);
  assert.equal(r.foldIndexStats.full, 2);
  parity(h, r);
  assert.equal(r.status("rn-0000").meta.labels.role, "lead");
  assert.equal(r.status("rn-0000").meta.title, "rn-0000!");
  assert.equal(r.status("rn-0001").archivedAt, null, "the rewritten archive line is gone");
});

test("save never waits on another process's lock; a dead holder's lock is taken over; shutdown saves", () => {
  const { h } = setup(3);
  const lock = `${h.file}.lock`;
  const before = readFileSync(h.file, "utf8");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: "other" })); // a live writer
  appendFileSync(logFile(h, "rn-0000"), ev(800, "text", { text: "more" }));
  const t0 = performance.now();
  const r = boot(h);
  const save = r.saveFoldIndexSync();
  const ms = performance.now() - t0;
  assert.equal(save.result, "busy");
  assert.ok(ms < 2000, `boot + save took ${Math.round(ms)}ms with the lock held`);
  assert.equal(readFileSync(h.file, "utf8"), before, "the held lock's index is left alone");
  assert.ok(existsSync(lock), "another writer's lock is never removed");
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: Date.now() - 1000, token: "dead" })); // dead pid
  const t = Date.now() / 1000 - 5; utimesSync(lock, t, t);
  assert.equal(r.saveFoldIndexSync().result, "written");
  assert.ok(!existsSync(lock), "our lock is released");
  appendFileSync(logFile(h, "rn-0001"), ev(801, "text", { text: "x" }));
  r.status("rn-0001");
  r.store.append("rn-0002", "text", { text: "y" }); // ahead of its fold: the save folds it first
  r.shutdown();
  assert.equal(r.foldIndexSave.result, "written");
  const e = readFoldIndex(h.file).get("rn-0002");
  assert.equal(e.offset, statSync(logFile(h, "rn-0002")).size, "the shutdown save covers what this runner appended");
  const r2 = boot(h);
  assert.equal(r2.foldIndexStats.full, 0);
  parity(h, r2);
});

test("async save after boot yields and writes the same index as the sync save; VS_RUNNER_FOLD_INDEX=0 turns it off", async () => {
  const { h } = setup(5);
  const r = boot(h);
  rmSync(h.file);
  const a = await r.saveFoldIndex(0);
  assert.equal(a.result, "written");
  const asyncText = readFileSync(h.file, "utf8");
  r.saveFoldIndexSync();
  assert.equal(readFileSync(h.file, "utf8"), asyncText);
  process.env.VS_RUNNER_FOLD_INDEX = "0";
  try {
    const off = boot(h);
    assert.equal(off.foldIndexStats, null);
    assert.equal(off.saveFoldIndexSync(), null);
  } finally { delete process.env.VS_RUNNER_FOLD_INDEX; }
});
