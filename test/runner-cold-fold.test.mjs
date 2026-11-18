// unit-cold-fold-reg: a cold boot (no fold-index entry: first boot, a FOLD_VERSION bump) folds the logs on worker threads
// (runner/fold-cold.mjs) and the boot pass serves them as index entries. Every case compares that boot against the serial
// full fold from byte 0: same fold state, status record, line index, and the same park / resume / lost / cut / unstarted
// decisions and requeued ids. The cost guard counts the main thread's log opens (deterministic, no wall clock): a cold boot
// pass opens a log at most twice serially (line count + fold read: 720398b7's shape) and not at all once prefolded.
import "./helpers/clean-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Runner } from "../runner/runner.mjs";
import { FOLD_INDEX_FILE, saveFold } from "../runner/fold-index.mjs";
import { coldEntry, coldFoldEntries, coldFoldWorkersFromEnv } from "../runner/fold-cold.mjs";
import { LogStore } from "../runner/log.mjs";

const adapters = { claude: { canPark: true, lazyResume: true }, gemini: { canPark: false } }; // nothing is spawned (_admit stubbed)
const now = Date.now();
const ev = (seq, type, data = {}, ts = now - 600_000 + seq) => JSON.stringify({ seq, ts, type, ...data }) + "\n";
const logFile = (h, id) => path.join(h.dir, `${id}.jsonl`);
const age = (h, id, s = 60) => { const t = Date.now() / 1000 - s; utimesSync(logFile(h, id), t, t); };

function home() {
  const h = mkdtempSync(path.join(os.tmpdir(), "vs-coldfold-"));
  const dir = path.join(h, "agents");
  mkdirSync(dir, { recursive: true });
  return { dir, file: path.join(h, FOLD_INDEX_FILE) };
}

// Every shape the resume paths decide on. kind -> log text.
const KINDS = ["parked", "parkedNoPrompt", "queued", "queuedSteer", "cut", "lost", "lostGemini", "archived", "exited", "unarchived", "refused", "openTool", "partial", "noCreated"];
function agentLog(id, kind, n) {
  let s = 0;
  let out = ev(s++, "created", { provider: kind === "lostGemini" ? "gemini" : "claude", model: "m", cwd: "/w", meta: { title: id, labels: { team: "t", lane: "l", role: "worker" } }, systemPrompt: `You are ${id}` + " p".repeat(200) });
  if (kind === "noCreated") return '{"seq":0,"ts":1,"type":"created","provider":"cl'; // no complete line yet: no fold, no entry
  out += ev(s++, "session", { sessionId: `sess-${id}`, modes: ["default"], models: ["m"] });
  for (let t = 0; t < n; t++) {
    out += ev(s++, "input", { text: `turn ${t}`, owner: t % 2 === 0 });
    out += ev(s++, "status", { status: "running" });
    out += ev(s++, "tool", { id: `c${t}`, phase: "call", name: "Bash", input: { command: "ls", timeout: 60_000 } });
    out += ev(s++, "text", { text: "x".repeat(40 + (t % 9)) });
    out += ev(s++, "tool", { id: `c${t}`, phase: "result" });
    if (t % 3 === 0) out += ev(s++, "usage", { contextTokens: 10 + t, contextMax: 100, inputTokens: 5, outputTokens: 2, costUsd: 0.1 });
    out += ev(s++, "turn_done");
    out += ev(s++, "status", { status: "idle" });
  }
  out += ev(s++, "meta", { patch: { labels: { role: "lead" }, title: `${id}!` } });
  switch (kind) {
    case "parked": out += ev(s++, "parked", { sessionId: `sess-${id}`, systemPrompt: "role prompt " + id }) + ev(s++, "status", { status: "parked" }); break;
    case "parkedNoPrompt": out += ev(s++, "bg-stopped", { work: [{ pid: 1, name: "bash", cmd: "sleep" }] }) + ev(s++, "parked", { sessionId: `sess-${id}`, systemPrompt: null }) + ev(s++, "status", { status: "parked" }); break;
    case "queued": out += ev(s++, "status", { status: "queued", ahead: 1 }) + ev(s++, "input", { text: "please", owner: true }) + ev(s++, "input", { text: "and this" }); break;
    case "queuedSteer": out += ev(s++, "status", { status: "queued" }) + ev(s++, "input", { text: "steer", steerOnly: true }); break;
    case "cut": out += ev(s++, "input", { text: "go" }) + ev(s++, "status", { status: "running" }) + ev(s++, "text", { text: "half" }); break;
    case "archived": out += ev(s++, "archive"); break;
    case "exited": out += ev(s++, "exit", { code: 0 }); break;
    case "unarchived": out += ev(s++, "archive") + ev(s++, "unarchive"); break;
    case "refused": out += ev(s++, "park-drain-refused", { drain: { reason: "restart" }, work: [{ pid: 2 }] }) + ev(s++, "parked", { sessionId: `sess-${id}`, systemPrompt: "p" }) + ev(s++, "status", { status: "parked" }); break;
    case "openTool": out += ev(s++, "input", { text: "go" }) + ev(s++, "status", { status: "running" }) + ev(s++, "tool", { id: "open-1", phase: "call", kind: "execute", name: "npm test" }); break;
    case "partial": out += '{"seq":' + s + ',"ts":1,"type":"text","text":"no newline'; break;
    default: break; // lost / lostGemini: idle with a session
  }
  return out;
}

function fixture(count = 3 * KINDS.length) {
  const h = home();
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = `rn-${String(i).padStart(6, "0")}`;
    writeFileSync(logFile(h, id), agentLog(id, KINDS[i % KINDS.length], 2 + (i * 7) % 40));
    age(h, id);
    ids.push(id);
  }
  return { h, ids };
}

// A booted runner: optional prefold, then the boot pass. _admit is stubbed (records the requeued jobs, starts nothing).
async function boot(h, { workers = 0, index = true, before = null } = {}) {
  const r = new Runner({ dir: h.dir, adapters, maxLive: 4, foldIndexFile: index ? h.file : null, bgProbe: null });
  r.admitted = [];
  r._admit = (job) => r.admitted.push({ id: job.id, text: job.text, owner: job.owner, spec: job.spec });
  if (workers > 0) await r.prefoldCold({ workers, min: 1 });
  before?.(r);
  r.back = r.recoverQueued({ shouldAdmit: () => true });
  return r;
}

// Everything the boot leaves behind that a decision reads.
function snapshot(r) {
  const out = { back: r.back, admitted: r.admitted };
  for (const id of r.store.ids().sort()) {
    const f = r.folds.get(id);
    r.store.count(id);
    const ix = r.store.idx.get(id);
    out[id] = {
      state: f ? JSON.stringify(saveFold(f)) : null, status: JSON.stringify(r.status(id)), ix: ix ? JSON.stringify(ix) : null,
      parked: r._parkedSpec(id), lost: r._lostSpec(id), cut: f?.meta ? r._cutTurn(id, f.meta) : null, unstarted: r._unstartedPlan(id),
    };
  }
  return out;
}

test("cold boot via worker threads: same folds, line index, decisions and requeued jobs as the serial full fold", async () => {
  const { h, ids } = fixture();
  const serial = await boot(h, { index: false });
  const want = snapshot(serial);
  assert.ok(want.back.length > 0 && Object.values(want).some((v) => v?.parked), "fixture has queued and parked agents");
  const r = await boot(h, { workers: 2 });
  const fi = r.foldIndexStats;
  const folded = ids.length - ids.filter((_, i) => KINDS[i % KINDS.length] === "noCreated").length;
  assert.deepEqual(fi.cold, { logs: ids.length, folded, workers: 2, ms: fi.cold.ms });
  assert.equal(fi.trusted, folded, "every worker entry trusted");
  assert.equal(fi.full, ids.length - folded, "only the logs with no created event fold on the main thread");
  assert.deepEqual(snapshot(r), want);
});

test("a log changed between the prefold and the boot pass is resumed or refolded: parity", async () => {
  const { h, ids } = fixture();
  const grow = ids[0]; // parked -> grows: resumed at the entry's offset (probes match)
  const rewrite = ids[2]; // queued -> same-size rewrite: size equal, mtime moved, folded from 0
  const truncated = ids[4]; // cut -> shrunk: folded from 0
  const change = () => {
    appendFileSync(logFile(h, grow), ev(900, "input", { text: "wake" }) + ev(901, "status", { status: "running" }));
    age(h, grow, 30);
    const t = readFileSync(logFile(h, rewrite), "utf8");
    writeFileSync(logFile(h, rewrite), t.replace("please", "PLEASE"));
    age(h, rewrite, 20);
    const lines = readFileSync(logFile(h, truncated), "utf8").split("\n");
    writeFileSync(logFile(h, truncated), lines.slice(0, 12).join("\n") + "\n");
    age(h, truncated, 20);
  };
  const r = await boot(h, { workers: 3, before: change });
  assert.equal(r.foldIndexStats.resumed, 1);
  assert.ok(r.foldIndexStats.full >= 2);
  assert.deepEqual(snapshot(r), snapshot(await boot(h, { index: false })));
  assert.ok(r.folds.get(grow).lastStatus.status === "running" && r.folds.get(rewrite).pending.some((p) => p.text === "PLEASE"));
});

test("a racy log (written within the racy window of the worker's stat) is folded by the boot pass, never trusted", async () => {
  const { h, ids } = fixture();
  const fresh = ids[1];
  const t = Date.now() / 1000; utimesSync(logFile(h, fresh), t, t);
  const r = await boot(h, { workers: 2 });
  assert.equal(r.foldIndexStats.full, 1 + ids.filter((_, i) => KINDS[i % KINDS.length] === "noCreated").length);
  assert.deepEqual(snapshot(r), snapshot(await boot(h, { index: false })));
});

test("coldEntry is exactly the entry a serial boot saves for the log", async () => {
  const { h, ids } = fixture(KINDS.length);
  const serial = await boot(h);
  const store = new LogStore(h.dir);
  for (const id of ids) {
    const e = coldEntry(store, id);
    const s = serial._foldEntry(id, serial.folds.get(id));
    if (!s) { assert.equal(e, null, id); continue; }
    const strip = ({ statAt, ...o }) => o; // the stat time differs, nothing else may
    assert.deepEqual(strip(e), strip(s), id);
  }
});

test("no workers, too few logs, the index off, or a dead worker: the boot pass folds serially; same answer", async () => {
  const { h } = fixture();
  const want = snapshot(await boot(h, { index: false }));
  const r0 = new Runner({ dir: h.dir, adapters, foldIndexFile: h.file, bgProbe: null });
  assert.equal(await r0.prefoldCold({ workers: 0 }), null);
  assert.deepEqual(await r0.prefoldCold({ workers: 2, min: 10_000 }), { logs: 3 * KINDS.length, folded: 0, ms: r0._coldSeed.ms });
  const off = new Runner({ dir: h.dir, adapters, foldIndexFile: null, bgProbe: null });
  assert.equal(await off.prefoldCold({ workers: 2, min: 1 }), null);
  const missing = await coldFoldEntries(path.join(h.dir, "nope"), ["rn-x", "rn-y"], { workers: 2 });
  assert.equal(missing.size, 0, "unreadable logs: no entries, no throw");
  const r = await boot(h, { workers: 2, before: (rr) => { rr._coldSeed.entries.clear(); } });
  assert.equal(r.foldIndexStats.cold.folded, 0);
  assert.deepEqual(snapshot(r), want);
  assert.equal(coldFoldWorkersFromEnv({ VS_RUNNER_COLD_FOLD_WORKERS: "0" }), 0);
  assert.equal(coldFoldWorkersFromEnv({ VS_RUNNER_COLD_FOLD_WORKERS: "3" }), 3);
  assert.equal(coldFoldWorkersFromEnv({ VS_RUNNER_COLD_FOLD_WORKERS: "x" }), 0);
});

// Cost guard (the 11-18 cold boot: 157.5s live for 5457 logs). Per-log main-thread opens, counted through the LogStore fs:
// the serial cold pass must stay at 720398b7's two (line count + fold read; a per-entry extra read such as the created-prompt
// slices or a by-seq parked read on every log would show here), and a prefolded pass must open no log at all.
test("cost guard: a cold boot pass opens each log at most twice serially, never once prefolded", async () => {
  const { h, ids } = fixture();
  const counting = () => {
    const opens = new Map();
    const fsImpl = { ...nodeFs, openSync: (p, ...a) => { opens.set(p, (opens.get(p) ?? 0) + 1); return nodeFs.openSync(p, ...a); } };
    return { opens, fsImpl };
  };
  for (const workers of [0, 2]) {
    const { opens, fsImpl } = counting();
    const r = await boot(h, { workers, before: (rr) => { rr.store.fs = fsImpl; } });
    const queued = new Set(r.back);
    for (const id of ids) {
      if (queued.has(id)) continue; // a requeued plan reads its created prompt: one agent per queued input, not per log
      const n = opens.get(logFile(h, id)) ?? 0;
      const noCreated = KINDS[ids.indexOf(id) % KINDS.length] === "noCreated";
      // A log with no complete line folds to nothing and is never cached: the boot pass, mintBootTokens and _unstartedPlan
      // each count its lines again (as on 720398b7). Every other log: two opens serially, none prefolded.
      assert.ok(n <= (noCreated ? 3 : workers ? 0 : 2), `${workers} workers: ${id} opened ${n}x`);
    }
    nodeFs.rmSync(h.file, { force: true }); // each pass is a cold boot
  }
});
