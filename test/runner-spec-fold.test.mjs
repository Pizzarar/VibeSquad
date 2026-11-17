// idea-307: the runner's resume paths (_parkedSpec / _lostSpec / _unstartedPlan / _cutTurn) read the incremental fold instead
// of parsing the whole log synchronously on every send/resume. Invariant: every answer (spec, cut point, plan, thrown error) is
// exactly what the full-read code returned (test/helpers/legacy-spec.mjs, verbatim from 720398b7): same JSON, same key order.
// Real-shaped random logs checked at every growth step (incremental fold), from a cold runner and from a fold-index boot; a
// >1MB log; a partial last line; hand-edited seqs (the parked-prompt fallback). Temp dirs only; nothing is spawned.
import "./helpers/clean-env.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Runner } from "../runner/runner.mjs";
import { answers } from "./helpers/legacy-spec.mjs";

const homes = [];
after(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
function home() {
  const h = mkdtempSync(path.join(os.tmpdir(), "vs-specfold-"));
  homes.push(h);
  return { dir: path.join(h, "agents"), file: path.join(h, "fold-index.json") };
}
const adapters = { claude: { canPark: true, lazyResume: true }, gem: { canPark: false }, codex: { canPark: true } };
const DAY = 24 * 3600_000;
const runner = (h, { index = false } = {}) => new Runner({ dir: h.dir, adapters, maxLive: 4, queueMaxAgeMs: DAY, foldIndexFile: index ? h.file : null });
const logFile = (h, id) => path.join(h.dir, `${id}.jsonl`);

// mulberry32: a seeded generator, so a failure names a reproducible seed.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// One agent's lines, as LogStore.append writes them (seq = line ordinal), plus the odd malformed / blank line.
function genLog(rand, id, n) {
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const now = Date.now();
  const ts = () => (rand() < 0.1 ? now - 3 * DAY : now - Math.floor(rand() * 3600_000));
  const lines = [];
  let seq = 0;
  const push = (type, data) => { lines.push(JSON.stringify({ seq: seq++, ts: ts(), type, ...data }) + "\n"); };
  const role = () => pick(["worker", "lead", "brainstorm", "former-lead", "retired", undefined]);
  const sid = () => pick([`s-${id}-${seq}`, `s-${id}`, "", "-bad", null, 42, undefined]);
  push("created", {
    provider: pick(["claude", "claude", "gem", "codex", "nope"]), model: pick(["m1", null, undefined]), cwd: "/w",
    meta: pick([{ title: id, labels: { team: "t", lane: pick(["l1", "l2"]), role: role(), topic: pick(["a", "b"]) } }, { title: id, role: role(), lane: "l1", team: "t" }, undefined]),
    ...(rand() < 0.8 ? { systemPrompt: `You are ${id}. ` + "r".repeat(Math.floor(rand() * 400)) } : {}),
  });
  const mayExit = rand() < 0.3; // most real logs are not exited: keep the parked/lost answers reachable
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < 0.01) { lines.push("{not json\n"); seq++; continue; } // counted by the line index, skipped by every parse
    if (r < 0.02) { lines.push("\n"); continue; } // blank: neither counted nor parsed
    const type = pick(["session", "input", "input", "status", "status", "status", "parked", "park-drain-refused", "bg-stopped", "meta", "archive", "unarchive", "exit", "output", "output", "tool", "usage", "turn_done", "steer_dropped"]);
    if (type === "session") push(type, { sessionId: sid(), ...(rand() < 0.3 ? { modes: ["default"], models: ["m1"] } : {}) });
    else if (type === "input") push(type, { text: pick([`do ${i}`, "y".repeat(80), 7, undefined]), ...(rand() < 0.3 ? { owner: pick([true, false, "yes"]) } : {}), ...(rand() < 0.25 ? { steerOnly: true } : {}) });
    else if (type === "status") push(type, { status: pick(["running", "idle", "queued", "queued", "parked", "starting", "lost", "error"]), ...(rand() < 0.3 ? { resume: pick([true, false, 1]) } : {}), ...(rand() < 0.2 ? { ahead: 2 } : {}) });
    else if (type === "parked") push(type, { sessionId: sid(), systemPrompt: pick([null, `parked prompt ${i} ` + "p".repeat(Math.floor(rand() * 200)), undefined]) });
    else if (type === "park-drain-refused") push(type, { work: pick([[{ cmd: "npm test" }], [], "x", undefined]), drain: pick([{ reason: "vs restart" }, {}, undefined]) });
    else if (type === "bg-stopped") push(type, { work: pick([[{ cmd: "sleep 9", pid: 4 }], [], undefined]) });
    else if (type === "meta") push(type, { patch: pick([{ labels: { role: role(), topic: pick(["a", "b"]) } }, { title: `t${i}` }, { model: pick(["m2", null]) }, { labels: { lane: pick(["l1", "l2"]) } }, {}]) });
    else if (type === "exit") { if (mayExit) push(type, { code: pick([0, 1, null]) }); else push("output", { text: "e" }); }
    else if (type === "output") push(type, { text: "o".repeat(Math.floor(rand() * 120)) });
    else if (type === "tool") push(type, { id: `c${i}`, phase: pick(["call", "result"]), name: "Bash" });
    else if (type === "usage") push(type, { contextTokens: i, contextMax: 100 });
    else if (type === "steer_dropped") push(type, { input: Math.max(0, seq - 2) });
    else push(type, {});
  }
  if (rand() < 0.4) { // a park at the end: the usual shape of an idle agent (notices owed or not)
    if (rand() < 0.5) push("bg-stopped", { work: [{ cmd: `sleep ${seq}` }] });
    if (rand() < 0.3) push("park-drain-refused", { work: [{ cmd: "npm test" }], drain: { reason: "vs restart" } });
    push("parked", { sessionId: pick([`s-${id}`, `s-${id}`, "-bad"]), systemPrompt: pick([`parked prompt ${seq}`, null]) });
    push("status", { status: "parked" });
  }
  return lines;
}

const seen = { parked: 0, parkedPrompt: 0, drainNotice: 0, bgStopNotice: 0, lost: 0, unstarted: 0, cut: 0, threw: 0 };
function check(r, ids, msg) {
  for (const id of ids) {
    const want = answers(r, id, { legacy: true });
    const got = answers(r, id, { legacy: false });
    const p = want.parked.v;
    seen.parked += !!p; seen.parkedPrompt += !!p?.systemPrompt; seen.drainNotice += !!p?.drainNotice; seen.bgStopNotice += !!p?.bgStopNotice;
    seen.lost += !!want.lost.v; seen.unstarted += !!want.unstarted.v;
    seen.cut += want.cut.some((c) => c.v === true); seen.threw += [want.parked, want.lost, want.unstarted].some((a) => a.err);
    assert.equal(JSON.stringify(got), JSON.stringify(want), `${msg}: ${id} (same JSON, same key order)`);
    assert.deepEqual(got, want, `${msg}: ${id}`);
  }
}

test("random real-shaped logs: fold answers == full-read answers at every growth step, cold, and from a fold-index boot", () => {
  for (const seed of [1, 307, 4242]) {
    const rand = rng(seed);
    const h = home();
    const r = runner(h, { index: true });
    const ids = Array.from({ length: 16 }, (_, i) => `rn-${seed}-${String(i).padStart(2, "0")}`);
    const logs = new Map(ids.map((id) => [id, genLog(rand, id, 10 + Math.floor(rand() * 140))]));
    const at = new Map(ids.map((id) => [id, 0]));
    for (let step = 0; step < 10; step++) {
      for (const id of ids) {
        const lines = logs.get(id);
        const to = step === 9 ? lines.length : Math.min(lines.length, at.get(id) + 1 + Math.floor(rand() * 20));
        if (to > at.get(id)) appendFileSync(logFile(h, id), lines.slice(at.get(id), to).join(""));
        at.set(id, to);
      }
      check(r, ids, `seed ${seed} step ${step} (incremental)`);
    }
    check(runner(h), ids, `seed ${seed} cold`);
    // Fold-index boot: save, age the logs out of the racy window, grow half of them, boot from the index.
    assert.equal(r.saveFoldIndexSync().result, "written");
    const old = Date.now() / 1000 - 60;
    for (const id of ids) utimesSync(logFile(h, id), old, old);
    for (const id of ids.slice(0, 8)) appendFileSync(logFile(h, id), genLog(rand, id, 30).slice(1).map((l) => { try { const e = JSON.parse(l); e.seq += logs.get(id).length; return JSON.stringify(e) + "\n"; } catch { return l; } }).join(""));
    const b = runner(h, { index: true });
    b.recoverQueued({ shouldAdmit: () => false }); // the boot fold pass only: nothing is spawned
    assert.ok(b.foldIndexStats.trusted + b.foldIndexStats.resumed > 0, "the boot resumed from the index");
    check(b, ids, `seed ${seed} index boot`);
  }
  for (const [k, n] of Object.entries(seen)) assert.ok(n > 0, `the random logs reach a ${k} answer (coverage: ${JSON.stringify(seen)})`);
});

// A >1MB log: 40KB role prompts, ~3MB of output, the parked event deep past the first sparse-index block, notices owed.
function bigLog(id) {
  const lines = [];
  let seq = 0;
  const now = Date.now();
  const push = (type, data) => { lines.push(JSON.stringify({ seq: seq++, ts: now - 60_000 + seq, type, ...data }) + "\n"); };
  push("created", { provider: "claude", model: "m1", cwd: "/w", meta: { title: id, labels: { team: "t", lane: "l1", role: "lead" } }, systemPrompt: "created prompt " + "c".repeat(40_000) });
  push("session", { sessionId: `s-${id}` });
  for (let t = 0; t < 30; t++) {
    push("input", { text: `turn ${t}` });
    push("status", { status: "running" });
    for (let k = 0; k < 100; k++) push("output", { text: "z".repeat(1000) });
    push("status", { status: "idle" });
  }
  push("meta", { patch: { labels: { topic: "x" }, model: "m2" } });
  push("park-drain-refused", { drain: { reason: "vs restart" }, work: [{ cmd: "npm test --queue" }] });
  push("parked", { sessionId: `s-${id}`, systemPrompt: "parked prompt " + "p".repeat(40_000) });
  push("status", { status: "parked" });
  return lines;
}

test(">1MB log: parked spec (incl. the 40KB parked prompt) and lost spec match, with no full read on the hot path", () => {
  const h = home();
  const r = runner(h);
  const id = "rn-big";
  const lines = bigLog(id);
  writeFileSync(logFile(h, id), lines.join(""));
  assert.ok(lines.join("").length > 3_000_000);
  check(r, [id], "big log");
  const spec = r._parkedSpec(id);
  assert.match(spec.systemPrompt, /^parked prompt p{40000}$/);
  assert.match(spec.drainNotice, /npm test --queue/);
  assert.equal(spec.model, "m2");
  // Hot path: once folded, a send's spec lookups read no whole log (store.read with after=0 and no limit).
  const full = [];
  const read = r.store.read.bind(r.store);
  r.store.read = (rid, afterSeq = 0, limit = Infinity) => { if (afterSeq === 0 && limit === Infinity) full.push(rid); return read(rid, afterSeq, limit); };
  let bytes = 0; // and no near-whole read by readFrom either: only the created line (40KB), the parked line and its block
  const readFrom = r.store.readFrom.bind(r.store);
  r.store.readFrom = (rid, off = 0, ...rest) => { const x = readFrom(rid, off, ...rest); bytes += Math.max(0, x.end - off); return x; };
  for (let i = 0; i < 5; i++) { r._unstartedPlan(id); r._parkedSpec(id); r._lostSpec(id); r._cutTurn(id, spec.meta); }
  assert.deepEqual(full, [], "no full sync read on the park/resume/lost/cut paths");
  assert.ok(bytes < 5 * 4 * 200_000, `the hot path read ${bytes} bytes for 5 rounds (a 3MB log)`);
  r.store.readFrom = readFrom;
  // A send after more output: still only the new tail is folded.
  appendFileSync(logFile(h, id), JSON.stringify({ seq: lines.length, ts: Date.now(), type: "output", text: "late" }) + "\n");
  r._parkedSpec(id);
  assert.deepEqual(full, []);
  r.store.read = read;
  check(r, [id], "big log after a tail append");
});

test("a partial last line is in neither answer until its newline lands", () => {
  const h = home();
  const r = runner(h);
  const id = "rn-partial";
  const lines = bigLog(id);
  writeFileSync(logFile(h, id), lines.join(""));
  check(r, [id], "parked");
  const next = JSON.stringify({ seq: lines.length, ts: Date.now(), type: "status", status: "running" });
  appendFileSync(logFile(h, id), next.slice(0, 25)); // a writer mid-append
  check(r, [id], "partial status line");
  assert.ok(r._parkedSpec(id), "the half-written running status does not unpark it");
  appendFileSync(logFile(h, id), next.slice(25) + "\n");
  check(r, [id], "completed status line");
  assert.equal(r._parkedSpec(id), null, "the completed running status unparks it");
  assert.equal(r._cutTurn(id, {}), true, "and reads as a cut turn");
});

test("hand-edited seqs: the parked prompt falls back to the full scan and still matches", () => {
  const h = home();
  const r = runner(h);
  const now = Date.now();
  const ln = (seq, type, data) => JSON.stringify({ seq, ts: now - 1000 + seq, type, ...data }) + "\n";
  const cases = {
    "rn-dup": [ln(0, "created", { provider: "claude", cwd: "/w", meta: {} }), ln(1, "session", { sessionId: "s1" }), ln(5, "parked", { sessionId: "s1", systemPrompt: "first" }), ln(2, "status", { status: "parked" }), ln(5, "parked", { sessionId: "s1", systemPrompt: "second" }), ln(3, "output", { text: "a" }), ln(4, "output", { text: "b" }), ln(6, "output", { text: "c" })],
    "rn-gap": [ln(0, "created", { provider: "claude", cwd: "/w", meta: {} }), ln(900, "parked", { sessionId: "s1", systemPrompt: "far" })],
    "rn-fracseq": [ln(0, "created", { provider: "claude", cwd: "/w", meta: {} }), ln(1.5, "parked", { sessionId: "s1", systemPrompt: "frac" })],
    "rn-noseq": [ln(0, "created", { provider: "claude", cwd: "/w", meta: {} }), JSON.stringify({ ts: now, type: "parked", sessionId: "s1", systemPrompt: "noseq" }) + "\n"],
  };
  for (const [id, ls] of Object.entries(cases)) writeFileSync(logFile(h, id), ls.join(""));
  check(r, Object.keys(cases), "hand-edited");
  assert.equal(r._parkedSpec("rn-gap").systemPrompt, "far");
  assert.equal(r._parkedSpec("rn-fracseq").systemPrompt, "frac");
  assert.equal(r._parkedSpec("rn-dup").systemPrompt, "second", "the last parked event wins, as in the full scan");
  assert.equal(r._parkedSpec("rn-noseq"), null);
});

test("a spec's meta never aliases the cached fold", () => {
  const h = home();
  const r = runner(h);
  const id = "rn-alias";
  writeFileSync(logFile(h, id), bigLog(id).join(""));
  const a = r._parkedSpec(id);
  a.meta.labels.role = "mutated";
  a.meta.extra = 1;
  assert.equal(r._parkedSpec(id).meta.labels.role, "lead");
  assert.equal(r.status(id).labels?.role ?? r.folds.get(id).meta.labels.role, "lead");
});

// The created prompt is read as one line in 64KB slices: a prompt far past one slice, and a hand-edited head (a malformed and
// a blank line before the created event, which a full read skips too) still give events[0]'s prompt.
test("created prompt: a line longer than a slice and a malformed head still read as the full read's events[0]", () => {
  const h = home();
  const r = runner(h);
  const now = Date.now();
  const ln = (seq, type, data) => JSON.stringify({ seq, ts: now - 1000 + seq, type, ...data }) + "\n";
  const big = "created prompt " + "c".repeat(150_000);
  const cases = {
    "rn-longcreated": [ln(0, "created", { provider: "claude", cwd: "/w", meta: {}, systemPrompt: big }), ln(1, "session", { sessionId: "s1" }), ln(2, "input", { text: "go" }), ln(3, "status", { status: "queued" })],
    "rn-badhead": ["{not json\n", "\n", JSON.stringify({ ts: now, type: "output", text: "no seq" }) + "\n", ln(1, "created", { provider: "claude", cwd: "/w", meta: {}, systemPrompt: big }), ln(2, "session", { sessionId: "s1" })],
  };
  for (const [id, ls] of Object.entries(cases)) writeFileSync(logFile(h, id), ls.join(""));
  check(r, Object.keys(cases), "created prompt");
  assert.equal(r._lostSpec("rn-longcreated").systemPrompt, big);
  assert.equal(r._unstartedPlan("rn-longcreated").spec.systemPrompt, big);
  assert.equal(r._lostSpec("rn-badhead").systemPrompt, big);
});

// The fold-index file format grew the spec fields (seqMono, archived, park, refused, stopped, lastStatus, lastState, pending).
// An index written by the code before them is dropped whole (FOLD_VERSION); an entry that still lacks one or carries a
// mangled one (a damaged file under the current version) is never defaulted: that log is folded from byte 0.
test("fold index: an entry without the spec fields, or with a mangled one, is refolded from 0, never trusted", async () => {
  const { readFileSync } = await import("node:fs");
  const h = home();
  const r = runner(h, { index: true });
  const now = Date.now();
  const ln = (seq, type, data) => JSON.stringify({ seq, ts: now - 5000 + seq, type, ...data }) + "\n";
  const created = (id) => ln(0, "created", { provider: "claude", cwd: "/w", meta: { title: id, labels: { role: "worker" } }, systemPrompt: `p ${id}` });
  const parked = (id) => [created(id), ln(1, "session", { sessionId: `s-${id}` }), ln(2, "bg-stopped", { work: [{ cmd: "sleep 9" }] }), ln(3, "parked", { sessionId: `s-${id}`, systemPrompt: `parked ${id}` }), ln(4, "status", { status: "parked" })];
  const queued = (id) => [created(id), ln(1, "session", { sessionId: `s-${id}` }), ln(2, "status", { status: "idle" }), ln(3, "input", { text: `owed ${id}`, owner: true }), ln(4, "status", { status: "queued" })];
  const running = (id) => [created(id), ln(1, "session", { sessionId: `s-${id}` }), ln(2, "input", { text: "x" }), ln(3, "status", { status: "running" })];
  // Each mangle, applied to a saved state, would flip a decision if it were defaulted instead of refolded.
  const mangles = {
    "rn-nopark": [parked, (st) => { delete st.park; }],
    "rn-parkbad": [parked, (st) => { st.park = { ...st.park, prompt: undefined }; }],
    "rn-nopending": [queued, (st) => { delete st.pending; }],
    "rn-pendingbad": [queued, (st) => { st.pending = [{ owner: true }]; }],
    "rn-nolaststate": [queued, (st) => { delete st.lastState; }],
    "rn-laststatebad": [queued, (st) => { st.lastState = 7; }],
    "rn-nolaststatus": [running, (st) => { delete st.lastStatus; }],
    "rn-noarchived": [parked, (st) => { delete st.archived; }],
    "rn-noseqmono": [parked, (st) => { delete st.seqMono; }],
    "rn-nostopped": [parked, (st) => { delete st.stopped; }],
    "rn-norefused": [parked, (st) => { delete st.refused; }],
  };
  const ok = ["rn-ok-parked", "rn-ok-queued", "rn-ok-running"];
  const make = { "rn-ok-parked": parked, "rn-ok-queued": queued, "rn-ok-running": running };
  const ids = [...Object.keys(mangles), ...ok];
  const old = Date.now() / 1000 - 60; // out of the racy window, so an untouched entry is trusted as is
  for (const id of ids) { writeFileSync(logFile(h, id), (mangles[id]?.[0] ?? make[id])(id).join("")); utimesSync(logFile(h, id), old, old); }
  check(r, ids, "before the save");
  assert.equal(r.saveFoldIndexSync().result, "written");
  const saved = JSON.parse(readFileSync(h.file, "utf8"));
  for (const id of ids) assert.ok(saved.entries[id]?.state, `${id} was saved`);
  const SPEC = ["seqMono", "archived", "park", "refused", "stopped", "lastStatus", "lastState", "pending"];

  // 1. A pre-idea-307 index: no spec fields anywhere, and the old code's FOLD_VERSION in the header. Dropped whole.
  const pre = structuredClone(saved);
  pre.fold = "pre-idea-307-version";
  for (const id of ids) for (const k of SPEC) delete pre.entries[id].state[k];
  writeFileSync(h.file, JSON.stringify(pre));
  const a = runner(h, { index: true });
  a.recoverQueued({ shouldAdmit: () => false });
  assert.equal(a.foldIndexStats.entries, 0, "an index from older fold code seeds nothing");
  check(a, ids, "pre-307 index boot");

  // 2. The current version, one field missing or mangled per entry: those logs fold from 0, the untouched ones are trusted.
  const cur = structuredClone(saved);
  for (const [id, [, mangle]] of Object.entries(mangles)) mangle(cur.entries[id].state);
  writeFileSync(h.file, JSON.stringify(cur));
  const b = runner(h, { index: true });
  b.recoverQueued({ shouldAdmit: () => false });
  assert.equal(b.foldIndexStats.entries, ids.length);
  assert.equal(b.foldIndexStats.full, Object.keys(mangles).length, `every mangled entry refolds (${JSON.stringify(b.foldIndexStats)})`);
  assert.equal(b.foldIndexStats.trusted, ok.length, "the untouched entries are trusted");
  check(b, ids, "mangled index boot");
  assert.equal(b._parkedSpec("rn-nopark").systemPrompt, "parked rn-nopark");
  assert.equal(b._unstartedPlan("rn-nopending").text, "owed rn-nopending");
  assert.equal(b._unstartedPlan("rn-nolaststate").text, "owed rn-nolaststate");
  assert.equal(b._cutTurn("rn-nolaststatus", {}), true);
});
