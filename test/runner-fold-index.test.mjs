// unit-runner-fold-incr (idea-261): the runner's boot fold resumes from <runner home>/fold-index.json. Every case compares a
// runner booted WITH the index against one booted without it (the full fold from byte 0): same fold state, same status record
// (incl. openTool / resumable / labels), same LogStore line index. Temp homes only.
import "./helpers/clean-env.mjs";
import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { until } from "./helpers/load-budget.mjs";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Runner } from "../runner/runner.mjs";
import { FOLD_INDEX_FILE, FOLD_VERSION, probe, racy as racyEntry, readFoldIndex, saveFold, serializeFoldIndex } from "../runner/fold-index.mjs";

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
function agentLog(id, { closed = null, openCall = false, queued = false, n = 40, prompt = 300 } = {}) {
  let s = 0;
  let out = ev(s++, "created", { provider: "claude", model: "m", cwd: "/w", meta: { title: id, labels: { team: "t", lane: "l", role: "worker" } }, systemPrompt: "You are " + id + " ".repeat(prompt) });
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
  assert.equal(r.foldIndexStats.discardReason, "missing", "a first boot says why it folded everything");
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
  assert.deepEqual({ ...warm.foldIndexStats, loadMs: 0 }, { entries: ids.length, saved: ids.length, trusted: ids.length, resumed: 0, full: 0, bytes: 0, loadMs: 0 }, "a kept index has no discardReason");
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
  age(h, "rn-0000"); // rn-0000's rewrite above is racy too (r2 saved it within RACY_MS): age it so r3 saves it trusted
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
  assert.equal(r.status("rn-0000").status, "lost", "a running log with no child in this process reads lost");
  assert.equal(r.folds.get("rn-0000").status, "running", "the fold keeps the truncated log's last status");
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

test("idea-337: bootFoldMs accounts for the fold phase (load, pass with stat/seed/read, tokens, plans, admit, rest)", () => {
  const { h, ids } = setup(5);
  appendFileSync(logFile(h, ids[0]), ev(900, "text", { text: "grown" })); // one resumed log: some read time
  const r = boot(h);
  const m = r.bootFoldMs;
  for (const k of ["prefold", "load", "pass", "stat", "seed", "read", "tokens", "plans", "admit"]) assert.ok(Number.isFinite(m[k]) && m[k] >= 0, k);
  assert.ok(m.stat + m.seed + m.read <= m.pass + 1, "stat/seed/read are parts of pass");
  assert.ok(m.seed > 0 && m.stat > 0, "every log was statted and seeded from its entry");
  const rep = r.bootFoldReport(1_000_000);
  const named = rep.prefold + rep.load + rep.pass + rep.tokens + rep.plans + rep.admit;
  assert.ok(Math.abs(named + rep.rest - 1_000_000) <= 6, "named parts + rest = the whole phase (rounding only)");
  assert.equal(r.bootFoldReport().rest, undefined, "no phase given: no rest");
  assert.equal(new Runner({ dir: h.dir, adapters }).bootFoldReport(5), null, "before recoverQueued: nothing to report");
  r._fold(ids[1]); // after the pass: _fold no longer adds to the boot timing
  assert.deepEqual(r.bootFoldMs, m);
});

test("an index from an older fold version, a corrupt index and a corrupt entry: full refold, same answer", () => {
  const { h, ids } = setup(4);
  const good = readFileSync(h.file, "utf8");
  writeFileSync(h.file, good.replace(FOLD_VERSION, "older-version"));
  let r = boot(h);
  assert.deepEqual([r.foldIndexStats.entries, r.foldIndexStats.full], [0, ids.length]);
  // idea-328: the line names the cause (the 83f29842 boot dropped a 15MB index with no word why)
  assert.deepEqual([r.foldIndexStats.discardReason, r.foldIndexStats.foldWas, r.foldIndexStats.foldNow], ["fold-version", "older-version", FOLD_VERSION]);
  parity(h, r);
  writeFileSync(h.file, good.slice(0, Math.floor(good.length / 2))); // torn
  r = boot(h);
  assert.deepEqual([r.foldIndexStats.entries, r.foldIndexStats.full, r.foldIndexStats.discardReason], [0, ids.length, "malformed"]);
  parity(h, r);
  writeFileSync(h.file, "\u0000garbage");
  r = boot(h);
  assert.deepEqual([r.foldIndexStats.full, r.foldIndexStats.discardReason], [ids.length, "malformed"]);
  writeFileSync(h.file, good.replace('{"v":1,', '{"v":99,'));
  r = boot(h);
  assert.deepEqual([r.foldIndexStats.full, r.foldIndexStats.discardReason, r.foldIndexStats.foldWas], [ids.length, "index-version", undefined]);
  writeFileSync(h.file, JSON.stringify({ v: 1, fold: FOLD_VERSION, entries: [] }));
  r = boot(h);
  assert.deepEqual([r.foldIndexStats.full, r.foldIndexStats.discardReason], [ids.length, "shape"]);
  writeFileSync(h.file, JSON.stringify({ v: 1, fold: FOLD_VERSION, entries: {} }));
  r = boot(h);
  assert.deepEqual([r.foldIndexStats.full, "discardReason" in r.foldIndexStats], [ids.length, false], "a valid empty index is kept, not discarded");
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
  // Every log was just written, so a save now would record racy entries (refolded from 0 by design). Age them first: the
  // folds that already cover their bytes restat (rn-0000, rn-0001); rn-0002 stays ahead of its fold for the save to catch up.
  for (const id of ["rn-0000", "rn-0001", "rn-0002"]) age(h, id);
  r.status("rn-0000");
  r.status("rn-0001");
  r.shutdown();
  assert.equal(r.foldIndexSave.result, "written");
  const e = readFoldIndex(h.file).get("rn-0002");
  assert.equal(e.offset, statSync(logFile(h, "rn-0002")).size, "the shutdown save covers what this runner appended");
  const r2 = boot(h);
  assert.deepEqual([r2.foldIndexStats.full, r2.foldIndexStats.trusted], [0, 3]);
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

// unit-fold-hash-4k: the head probe hashes only the first line, capped at 4KB (one small read per log on a cold save).
const firstLineLen = (file) => readFileSync(file).indexOf(10) + 1;
// One agent with its own log text; saved by a cold boot (aged first, so the entry is not racy), then the log is replaced.
function oneAgent(opts) {
  const h = home();
  rmSync(h.dir, { recursive: true, force: true });
  new Runner({ dir: h.dir, adapters, maxLive: 4 });
  const id = "rn-0000";
  writeFileSync(logFile(h, id), agentLog(id, opts).text);
  age(h, id);
  assert.equal(boot(h).saveFoldIndexSync().result, "written");
  return { h, id, f: logFile(h, id), entry: readFoldIndex(h.file).get(id) };
}

test("head probe: the first line only, capped at 4KB", () => {
  const short = oneAgent({});
  assert.ok(firstLineLen(short.f) < 4096);
  assert.equal(short.entry.headLen, firstLineLen(short.f), "a short first line: exactly that line");
  const long = oneAgent({ prompt: 20_000 });
  assert.ok(firstLineLen(long.f) > 20_000);
  assert.equal(long.entry.headLen, 4096, "a long first line: its first 4KB");
  assert.deepEqual(probe(long.f, long.entry.offset), { headLen: long.entry.headLen, head: long.entry.head, tail: long.entry.tail });
});

test("same first line but truncated: shorter folds from 0; truncated then regrown past the old size folds from 0", () => {
  const { h, id, f, entry } = oneAgent({ n: 40 });
  const text = readFileSync(f, "utf8");
  const cut = text.indexOf("\n", Math.floor(text.length / 2)) + 1;
  truncateSync(f, cut); // a whole-line truncation: the first line (the head) is unchanged
  let r = boot(h);
  assert.deepEqual([r.foldIndexStats.full, r.foldIndexStats.resumed], [1, 0], "shrunk");
  parity(h, r);
  // Regrown with other events to past the saved size: head identical, size grew, only the tail probe can tell.
  let more = "";
  for (let i = 0; statSync(f).size + Buffer.byteLength(more) <= entry.size + 200; i++) more += ev(900 + i, "text", { text: "regrown " + i });
  appendFileSync(f, more);
  assert.ok(statSync(f).size > entry.size);
  assert.equal(readFileSync(f, "utf8").split("\n")[0], text.split("\n")[0], "same first line");
  r = boot(h);
  assert.deepEqual([r.foldIndexStats.full, r.foldIndexStats.resumed], [1, 0], "regrown");
  parity(h, r);
  assert.equal(r.status(id).meta.labels.role, "worker", "the truncated meta patch is gone");
});

test("rotated log: a new log (another created line) in its place folds from 0, larger or smaller", () => {
  for (const bigger of [true, false]) {
    const { h, id, f, entry } = oneAgent({ n: 20 });
    // Rotation: the old file moved away, a fresh log for the same id written in its place (a new created event: other ts/seq).
    let s = 0;
    let text = ev(s++, "created", { provider: "claude", model: "m2", cwd: "/w2", meta: { title: "rotated", labels: { team: "t", lane: "l", role: "worker" } } }, 1_800_000_000_000);
    const target = bigger ? entry.size + 1000 : Math.floor(entry.size / 2);
    while (Buffer.byteLength(text) < target) text += ev(s++, "text", { text: "rotated " + s }, 1_800_000_000_000 + s);
    writeFileSync(f, text);
    const r = boot(h);
    assert.deepEqual([r.foldIndexStats.full, r.foldIndexStats.resumed, r.foldIndexStats.trusted], [1, 0, 0], bigger ? "bigger" : "smaller");
    parity(h, r);
    assert.equal(r.status(id).meta.title, "rotated");
  }
});

test("log shorter than 4KB: resumes on append; a rewritten first line folds from 0", () => {
  const { h, id, f, entry } = oneAgent({ n: 2, prompt: 50 });
  assert.ok(entry.size < 4096, `log is ${entry.size} bytes`);
  assert.equal(entry.headLen, firstLineLen(f));
  appendFileSync(f, ev(900, "text", { text: "more" }));
  let r = boot(h);
  assert.deepEqual([r.foldIndexStats.full, r.foldIndexStats.resumed], [0, 1]);
  parity(h, r);
  // Back to the saved index (the boot above did not save): first line rewritten, same length, plus an append.
  const t = readFileSync(f, "utf8");
  writeFileSync(f, t.replace('"model":"m"', '"model":"z"'));
  r = boot(h);
  assert.deepEqual([r.foldIndexStats.full, r.foldIndexStats.resumed], [1, 0]);
  parity(h, r);
  assert.equal(r.folds.get(id).created.model, "z");
});

test("first line over 4KB: resumes on append; a change inside its first 4KB folds from 0", () => {
  const { h, id, f, entry } = oneAgent({ prompt: 12_000 });
  assert.equal(entry.headLen, 4096);
  appendFileSync(f, ev(900, "text", { text: "more" }));
  let r = boot(h);
  assert.deepEqual([r.foldIndexStats.full, r.foldIndexStats.resumed], [0, 1]);
  parity(h, r);
  const t = readFileSync(f, "utf8");
  assert.ok(t.indexOf('"cwd":"/w"') < 4096);
  writeFileSync(f, t.replace('"cwd":"/w"', '"cwd":"/x"'));
  r = boot(h);
  assert.deepEqual([r.foldIndexStats.full, r.foldIndexStats.resumed], [1, 0]);
  parity(h, r);
  assert.equal(r.folds.get(id).created.cwd, "/x");
});

test("an index saved before the 4KB head (headLen = the whole long first line) still resumes; an absurd headLen folds from 0", () => {
  const { h, id, f, entry } = oneAgent({ prompt: 12_000 });
  const len = firstLineLen(f);
  const legacy = { ...entry, headLen: len, head: createHash("sha256").update(readFileSync(f).subarray(0, len)).digest("base64") };
  writeFileSync(h.file, serializeFoldIndex(new Map([[id, legacy]])));
  appendFileSync(f, ev(900, "text", { text: "more" }));
  let r = boot(h);
  assert.deepEqual([r.foldIndexStats.full, r.foldIndexStats.resumed], [0, 1], "legacy entry resumed");
  parity(h, r);
  // Its save re-pins with the 4KB head once the offset moves.
  age(h, id);
  r.status(id);
  assert.equal(r.saveFoldIndexSync().result, "written");
  assert.equal(readFoldIndex(h.file).get(id).headLen, 4096);
  writeFileSync(h.file, serializeFoldIndex(new Map([[id, { ...legacy, headLen: 2 ** 21 }]])));
  appendFileSync(f, ev(901, "text", { text: "more" }));
  r = boot(h);
  assert.equal(r.foldIndexStats.full, 1);
  parity(h, r);
});

test("a cold boot's save opens no log (probes taken by the fold); shutdown save is bounded: past its budget unpinned logs are left out", () => {
  const { h, ids } = setup(6);
  // A runner whose boot found no index: its fold read every log and took the probes on the way, so even a save with no
  // budget left (a restart before its first async save) writes every entry, opening no log.
  rmSync(h.file);
  const cold = boot(h);
  assert.equal(cold._foldPins.size, ids.length, "the boot fold pinned every log");
  const s00 = cold.saveFoldIndexSync({ budgetMs: -1 });
  assert.deepEqual([s00.entries, s00.skipped, s00.result], [ids.length, undefined, "written"]);
  assert.equal(readFoldIndex(h.file).size, ids.length);
  // Folds with no probe taken (none pinned): past the budget they are left out, not probed.
  cold._foldPins.clear();
  rmSync(h.file);
  const s0 = cold.saveFoldIndexSync({ budgetMs: -1 });
  assert.deepEqual([s0.entries, s0.skipped, s0.result], [0, ids.length, "written"]);
  assert.equal(readFoldIndex(h.file).size, 0);
  // Unbounded, the same runner probes and saves all (and pins them).
  assert.equal(cold.saveFoldIndexSync().entries, ids.length);
  // A runner booted from that index has every fold pinned: a zero budget still saves all, without reading a log.
  const warm = boot(h);
  appendFileSync(logFile(h, ids[0]), ev(900, "text", { text: "more" }));
  warm.store.append(ids[1], "text", { text: "ahead" }); // ahead of its fold: past the budget it is not caught up, its old entry stays
  const before = readFoldIndex(h.file);
  const s1 = warm.saveFoldIndexSync({ budgetMs: -1 });
  assert.deepEqual([s1.entries, s1.skipped, s1.result], [ids.length, undefined, "written"]);
  const after = readFoldIndex(h.file);
  const pick = (e) => ({ offset: e.offset, size: e.size, head: e.head, tail: e.tail, state: e.state });
  assert.deepEqual(pick(after.get(ids[1])), pick(before.get(ids[1])), "not caught up past the budget: the fold it had");
  assert.ok(after.get(ids[1]).offset < statSync(logFile(h, ids[1])).size);
  const r = boot(h);
  assert.equal(r.foldIndexStats.full, 0);
  assert.equal(r.foldIndexStats.trusted, ids.length - 2);
  assert.equal(r.foldIndexStats.resumed, 2, "the appended and the ahead log resume from their saved entries");
  parity(h, r);
});

test("probes pin the bytes the fold read: a log replaced (and grown) after its fold, before the save, is refolded next boot", () => {
  const { h, id, f } = oneAgent({ n: 20 });
  rmSync(h.file);
  const r = boot(h); // folds (and pins) the original log
  // Replaced by another log for the same id, larger, before the save runs.
  let s = 0;
  let text = ev(s++, "created", { provider: "claude", model: "m2", cwd: "/w2", meta: { title: "swapped", labels: { team: "t", lane: "l", role: "worker" } } }, 1_800_000_000_000);
  while (Buffer.byteLength(text) < statSync(f).size + 1000) text += ev(s++, "text", { text: "swapped " + s }, 1_800_000_000_000 + s);
  writeFileSync(f, text);
  assert.equal(r.saveFoldIndexSync().result, "written");
  const r2 = boot(h);
  assert.deepEqual([r2.foldIndexStats.full, r2.foldIndexStats.resumed, r2.foldIndexStats.trusted], [1, 0, 0]);
  parity(h, r2);
  assert.equal(r2.status(id).meta.title, "swapped");
});

// idea-316: logs written right up to the cold boot are recorded racy; once they settle, the (async) save refolds them off the
// boot path so the next boot trusts them. Every refold must equal the full fold (parity), whatever happened to the log.
const savedEntry = (h, id) => readFoldIndex(h.file).get(id);
const racyOnDisk = (h, ids) => ids.filter((id) => racyEntry(savedEntry(h, id)));
const freshCold = (n = 6) => { // fresh mtimes: every entry the cold boot records is racy
  const h = home();
  new Runner({ dir: h.dir, adapters, maxLive: 4 });
  const ids = writeAgents(h, n);
  const r = boot(h);
  assert.equal(r.foldIndexStats.full, ids.length);
  return { h, ids, r };
};
const settle = (h, ids) => { for (const id of ids) age(h, id); };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

test("racy entries settled by the async save are refolded there; the warm boot trusts them, parity", async () => {
  const { h, ids, r } = freshCold();
  settle(h, ids);
  assert.equal((await r.saveFoldIndex()).result, "written");
  assert.deepEqual(racyOnDisk(h, ids), []);
  const warm = boot(h);
  assert.equal(warm.foldIndexStats.trusted, ids.length);
  assert.equal(warm.foldIndexStats.full, 0);
  parity(h, warm, "racy entries refolded at the save");
});

test("the shutdown (sync) save never refolds: racy entries stay racy, the next boot folds them", () => {
  const { h, ids, r } = freshCold(3);
  settle(h, ids);
  assert.equal(r.saveFoldIndexSync().result, "written");
  assert.equal(racyOnDisk(h, ids).length, ids.length);
  const warm = boot(h);
  assert.equal(warm.foldIndexStats.full, ids.length);
  parity(h, warm);
});

test("a save that finds racy logs still fresh schedules another once the window has passed (deferred re-save)", async () => {
  const { h, ids, r } = freshCold(4);
  r.resaveDelayMs = 30;
  assert.equal((await r.saveFoldIndex()).result, "written"); // logs written just now: all racy, nothing settled
  assert.equal(racyOnDisk(h, ids).length, ids.length);
  settle(h, ids); // the window passes
  for (let i = 0; i < 100 && racyOnDisk(h, ids).length; i++) await sleep(20);
  assert.deepEqual(racyOnDisk(h, ids), [], "the deferred save refolded and saved them trusted");
  const warm = boot(h);
  assert.equal(warm.foldIndexStats.full, 0);
  parity(h, warm);
  r.shutdown();
});

test("the deferred re-save is bounded and shutdown cancels it", async () => {
  const { h, ids, r } = freshCold(2);
  r.resaveDelayMs = 20;
  let saves = 0;
  const orig = r.saveFoldIndex.bind(r);
  r.saveFoldIndex = (...a) => { saves++; return orig(...a); };
  await r.saveFoldIndex(); // logs never settle: 1 + 3 rounds, then it stops
  // Wait for the bounded chain to finish (condition), not a fixed wall-clock: under load the 20ms-round timers can be
  // delayed past the old 400ms window, leaving the final round pending (3 !== 4). Quiescence = the count reached the
  // bound, no further round is scheduled (timer cleared) AND the last save finished (the timer callback clears _resaveTimer
  // before the async save sets _foldSave). The code stops at 1 + RESAVE_ROUNDS by construction.
  const quiesced = await until(() => saves >= 4 && r._foldSave === null && r._resaveTimer === null, 5000);
  assert.ok(quiesced, `deferred re-save never quiesced at the bounded total (saves=${saves})`);
  assert.equal(saves, 4);
  assert.equal(racyOnDisk(h, ids).length, ids.length);
  const r2 = freshCold(2);
  r2.r.resaveDelayMs = 20;
  await r2.r.saveFoldIndex();
  r2.r.shutdown();
  assert.equal(r2.r._resaveTimer, null, "shutdown cleared the re-save timer");
  await sleep(100);
});

test("a same-size rewrite of a racy log (mtime set back) is refolded from its current bytes: parity", async () => {
  const { h, ids, r } = freshCold(4);
  const f = logFile(h, "rn-0001");
  const text = readFileSync(f, "utf8");
  writeFileSync(f, text.replace('"title":"rn-0001!"', '"title":"rn-ZZZZ!"')); // same size
  settle(h, ids);
  await r.saveFoldIndex();
  const warm = boot(h);
  assert.equal(warm.foldIndexStats.full, 0);
  assert.equal(warm.status("rn-0001").meta.title, "rn-ZZZZ!");
  parity(h, warm);
});

test("a racy log truncated (and one grown) after its fold is refolded; parity incl. the line index", async () => {
  const { h, ids, r } = freshCold(4);
  const f = logFile(h, "rn-0000");
  const lines = readFileSync(f, "utf8").split("\n").slice(0, 30).join("\n") + "\n";
  writeFileSync(f, lines);
  appendFileSync(logFile(h, "rn-0002"), ev(9000, "text", { text: "more" }));
  settle(h, ids);
  await r.saveFoldIndex();
  const warm = boot(h);
  assert.equal(warm.foldIndexStats.full, 0);
  assert.equal(warm.store.count("rn-0000"), 30);
  parity(h, warm);
});

test("refold reads in bounded slices (yielding between), and an append during a slice drops the refold, never a wrong state", async () => {
  const { h, ids, r } = freshCold(2);
  settle(h, ids);
  r.refoldSliceBytes = 512;
  const id = "rn-0000";
  const st = r.folds.get(id);
  const g = r._refoldSettled(id, st);
  let yields = 0;
  let step = g.next();
  while (!step.done && yields < 3) { yields++; step = g.next(); }
  assert.ok(yields >= 3, "yielded between slices of a log bigger than one slice");
  appendFileSync(logFile(h, id), ev(9001, "text", { text: "late" })); // while the refold is mid-way
  while (!step.done) step = g.next();
  assert.equal(step.value, st, "changed during the refold: old fold kept");
  assert.equal(r.folds.get(id), st);
  // then a normal save + boot still match the full fold
  settle(h, ids);
  r.refoldSliceBytes = 1 << 20;
  await r.saveFoldIndex();
  parity(h, boot(h));
});

test("an append between the save's visits and a concurrent store.append during the async save: parity", async () => {
  const { h, ids, r } = freshCold(6);
  settle(h, ids);
  const p = r.saveFoldIndex(1); // 1ms slices: yields often
  r.store.append("rn-0004", "text", { text: "during the save" });
  r.store.append("rn-0000", "text", { text: "during the save" });
  await p;
  settle(h, ids);
  await r.saveFoldIndex();
  parity(h, boot(h));
});

test("idea-340: a log with no created event is read once at boot; the token / plan scans reuse that fold, a change re-reads it", () => {
  const { h, ids } = setup(3);
  writeFileSync(logFile(h, "rn-odd"), ""); // an empty log: no created, _fold returns null and keeps no fold
  const r = new Runner({ dir: h.dir, adapters, maxLive: 4, foldIndexFile: h.file });
  let reads = 0;
  const rf = r.store.readFrom.bind(r.store);
  r.store.readFrom = (id, ...a) => { if (id === "rn-odd") reads++; return rf(id, ...a); };
  r.recoverQueued();
  assert.equal(reads, 1, "the pass reads it once; mintBootTokens and the plan scan do not re-read it");
  assert.equal(r._fold("rn-odd"), null);
  assert.equal(reads, 1, "later folds at the same stamp are served");
  appendFileSync(logFile(h, "rn-odd"), "\n");
  assert.equal(r._fold("rn-odd"), null);
  assert.equal(reads, 2, "a changed log is read again");
  assert.ok(ids.length);
});
