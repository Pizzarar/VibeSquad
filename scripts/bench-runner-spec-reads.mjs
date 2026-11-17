// idea-307: what a send/resume to a parked agent costs on the runner loop, before (full sync read of the log per lookup:
// test/helpers/legacy-spec.mjs, the 720398b7 code) vs after (the incremental fold, Runner._parkedSpec & co). Synthetic temp log only.
//   node scripts/bench-runner-spec-reads.mjs [--mb 20] [--iters 20]
// Each (path, side) runs in its own child process (--expose-gc, its own temp log): one side's heap, caches and GC debt never
// land in the other's samples (a shared process put the old resume path at ~850ms against ~200ms measured alone).
// send   = _unstartedPlan + _parkedSpec + _lostSpec (Runner.send to a parked agent; _resume repeats the parked lookup)
// resume = _parkedSpec + _lostSpec + _cutTurn (Runner.resume)
// "after, first" folds the log once (a runner that never folded it: no boot pass, no fold index); "after, warm" is every later
// call; "after, +tail" is a call after 50 more events were appended (only those bytes are folded).
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { Runner } from "../runner/runner.mjs";
import { legacyCutTurn, legacyLostSpec, legacyParkedSpec, legacyUnstartedPlan } from "../test/helpers/legacy-spec.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const MB = Number(arg("mb", 20));
const ITERS = Number(arg("iters", 20));
const root = mkdtempSync(path.join(os.tmpdir(), "vs-spec-bench-"));
const dir = path.join(root, "agents");
const adapters = { claude: { canPark: true, lazyResume: true } };
const id = "rn-bench";

function writeLog() {
  const lines = [];
  let seq = 0;
  const now = Date.now();
  let bytes = 0;
  const push = (type, data) => { const l = JSON.stringify({ seq: seq++, ts: now - 3600_000 + seq, type, ...data }); lines.push(l); bytes += l.length + 1; };
  push("created", { provider: "claude", model: "m", cwd: "/w", meta: { title: id, labels: { team: "t", lane: "l", role: "lead" } }, systemPrompt: "p".repeat(40_000) });
  push("session", { sessionId: `s-${id}` });
  while (bytes < MB * 1e6) {
    push("input", { text: "next" });
    push("status", { status: "running" });
    for (let k = 0; k < 40; k++) { push(k % 3 ? "output" : "tool", k % 3 ? { text: "o".repeat(600) } : { id: `c${seq}`, phase: "call", name: "Bash", input: { command: "ls" } }); }
    push("status", { status: "idle" });
  }
  push("bg-stopped", { work: [{ cmd: "sleep 99", pid: 7 }] });
  push("parked", { sessionId: `s-${id}`, systemPrompt: "q".repeat(40_000) });
  push("status", { status: "parked" });
  writeFileSync(path.join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
  return { bytes, events: seq };
}

const gc = globalThis.gc ?? (() => {}); // run with --expose-gc: each sample starts from a collected heap
const ms = (f) => { gc(); const t = process.hrtime.bigint(); f(); return Number(process.hrtime.bigint() - t) / 1e6; };
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { median: +s[Math.floor(s.length / 2)].toFixed(2), max: +s.at(-1).toFixed(2) }; };
const paths = {
  send: { before: (r) => { legacyUnstartedPlan(r, id); legacyParkedSpec(r, id); legacyLostSpec(r, id); }, after: (r) => { r._unstartedPlan(id); r._parkedSpec(id); r._lostSpec(id); } },
  resume: { before: (r) => { const p = legacyParkedSpec(r, id); legacyLostSpec(r, id); legacyCutTurn(r, id, p?.meta ?? {}); }, after: (r) => { const p = r._parkedSpec(id); r._lostSpec(id); r._cutTurn(id, p?.meta ?? {}); } },
};

const PATH = arg("path", null);
const SIDE = arg("side", null);

if (!PATH) { // driver: one child per (path, side), then a table
  const self = fileURLToPath(import.meta.url);
  const run = (p, side) => JSON.parse(execFileSync(process.execPath, ["--expose-gc", self, "--mb", String(MB), "--iters", String(ITERS), "--path", p, "--side", side], { encoding: "utf8", maxBuffer: 1 << 24 }));
  const rows = [];
  let log = null;
  for (const p of Object.keys(paths)) {
    const b = run(p, "before");
    const a = run(p, "after");
    log = a.log;
    rows.push({ path: p, beforeMedian: b.before.median, beforeMax: b.before.max, afterFirst: a.afterFirst, afterWarmMedian: a.afterWarm.median, afterWarmMax: a.afterWarm.max, afterTail: a.afterTail });
  }
  console.log(`log ${log.mb}MB, ${log.events} events, ${ITERS} iters, each cell its own process (ms)`);
  console.log("| path | before median / max | after first | after warm median / max | after +50 events |");
  console.log("|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.path} | ${r.beforeMedian} / ${r.beforeMax} | ${r.afterFirst} | ${r.afterWarmMedian} / ${r.afterWarmMax} | ${r.afterTail} |`);
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
}

try {
  new Runner({ dir, adapters, maxLive: 2 });
  const { bytes, events } = writeLog();
  const out = { log: { mb: +(bytes / 1e6).toFixed(1), events }, iters: ITERS };
  const p = paths[PATH];
  if (!p || (SIDE !== "before" && SIDE !== "after")) throw new Error(`--path ${Object.keys(paths).join("|")} --side before|after`);
  const r = new Runner({ dir, adapters, maxLive: 2 });
  r.store.count(id); // line index built outside the timing, as on a live runner
  if (SIDE === "before") out.before = stats(Array.from({ length: ITERS }, () => ms(() => p.before(r))));
  else {
    out.afterFirst = +ms(() => p.after(r)).toFixed(2);
    out.afterWarm = stats(Array.from({ length: ITERS }, () => ms(() => p.after(r))));
    appendFileSync(path.join(dir, `${id}.jsonl`), Array.from({ length: 50 }, (_, i) => JSON.stringify({ seq: events + i, ts: Date.now(), type: "output", text: "late" })).join("\n") + "\n");
    out.afterTail = +ms(() => p.after(r)).toFixed(2);
  }
  console.log(JSON.stringify(out));
} finally { rmSync(root, { recursive: true, force: true }); }
