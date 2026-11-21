// Cold boot fold cost guard (unit-cold-fold-reg): the 11-18 cold boot folded 5457 logs / 487MB in 157.5s live (13s offline).
//   node scripts/bench-runner-cold-fold.mjs [--repo <checkout>] [--agents-dir <dir>] [--agents 5400] [--mb 480] [--workers N] [--check] [--keep]
// In-process, on a SYNTHETIC home (prod-shaped: ~90KB a log, a few MB at most) or a COPY of logs given by --agents-dir (read only):
//   floor   = read every log and JSON.parse every line (no fold): the cost any cold fold pays, measured on this box, this run
//   serial  = Runner.recoverQueued with no fold index (the main-thread cold pass; 720398b7's only path)
//   prefold = Runner.prefoldCold (worker threads) + recoverQueued: the boot's cold path now
// --check fails (exit 1) when serial > SERIAL_MAX x floor (a per-log / per-line overhead creeping into the cold pass: 720398b7
// measured 2.3-2.6x here) or, with >= 3 workers, prefold > PREFOLD_MAX x serial. Ratios, so the machine's speed cancels out.
// --repo <checkout> times another runner tree's serial pass against the same floor (e.g. a `git archive 720398b7 runner` dir).
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, utimesSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERIAL_MAX = 3.5;
const PREFOLD_MAX = 0.5;
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const repo = path.resolve(arg("repo", path.join(path.dirname(fileURLToPath(import.meta.url)), "..")));
const N = Number(arg("agents", 5400));
const MB = Number(arg("mb", 480));
const root = mkdtempSync(path.join(os.tmpdir(), "vs-coldfold-bench-"));
const dir = path.join(root, "agents");
const ms = (t0) => Math.round(performance.now() - t0);

// Prod's shape on 11-17: 5464 logs, 478MB, the largest 2.8MB: a lognormal-ish spread around ~90KB, capped.
function generate() {
  mkdirSync(dir, { recursive: true });
  const target = MB * 1024 * 1024;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const w = Array.from({ length: N }, () => Math.exp(rnd() * 3.4));
  const sum = w.reduce((a, b) => a + b, 0);
  const pad = "x".repeat(300);
  for (let i = 0; i < N; i++) {
    const bytes = Math.min(3 << 20, Math.max(1500, Math.round((w[i] / sum) * target)));
    const fd = openSync(path.join(dir, `rn-${i.toString(16).padStart(12, "0")}.jsonl`), "w");
    let seq = 0;
    let size = 0;
    let t = Date.parse("2026-11-01T00:00:00Z") + i * 1000;
    const ev = (type, data) => { const l = JSON.stringify({ seq: seq++, ts: (t += 37), type, ...data }) + "\n"; size += l.length; return l; };
    let chunk = ev("created", { provider: "claude", model: "m", cwd: "/w", meta: { title: `a${i}`, labels: { team: "t", lane: "l", role: "worker" } }, systemPrompt: "You are an agent. " + pad.repeat(6) });
    chunk += ev("session", { sessionId: `s-${i}`, modes: ["default"], models: [] });
    for (let k = 0; size < bytes; k++) {
      if (k % 30 === 0) chunk += ev("input", { text: "do it " + pad.slice(0, 60) }) + ev("status", { status: "running" });
      chunk += ev("text", { text: pad.slice(0, 120 + (k % 150)) });
      if (k % 3 === 0) chunk += ev("tool", { id: `c${k}`, phase: "call", name: "Bash", input: { command: "ls " + pad.slice(0, 80) } }) + ev("tool", { id: `c${k}`, phase: "result", output: pad.slice(0, 160) });
      if (k % 30 === 29) chunk += ev("turn_done", {}) + ev("status", { status: "idle" });
      if (chunk.length > 1 << 20) { writeSync(fd, chunk); chunk = ""; }
    }
    chunk += i % 3 === 0 ? ev("parked", { sessionId: `s-${i}`, systemPrompt: null }) + ev("status", { status: "parked" }) : i % 3 === 1 ? ev("archive", {}) : ev("exit", { code: 0 });
    writeSync(fd, chunk);
    closeSync(fd);
  }
}

let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  if (flag("keep")) return;
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) { console.error(`cleanup failed: ${e.message}`); }
};

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { cleanup(); process.exit(sig === "SIGINT" ? 130 : 143); });
}

let res;
try {
if (arg("agents-dir")) cpSync(path.resolve(arg("agents-dir")), dir, { recursive: true }); // a copy: the bench never touches the source
else generate();
const old = Date.now() / 1000 - 600;
for (const f of readdirSync(dir)) utimesSync(path.join(dir, f), old, old); // out of the racy window
const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));

function floor() {
  const t0 = performance.now();
  let n = 0;
  for (const f of files) for (const l of readFileSync(path.join(dir, f), "utf8").split("\n")) if (l) { JSON.parse(l); n++; }
  return { ms: ms(t0), lines: n };
}

const { Runner } = await import(pathToFileURL(path.join(repo, "runner", "runner.mjs")).href);
const adapters = { claude: { canPark: true } };
async function pass(workers) {
  const file = path.join(root, `fold-index-${workers}.json`);
  rmSync(file, { force: true });
  const r = new Runner({ dir, adapters, foldIndexFile: file, bgProbe: null });
  r._admit = () => {}; // never start anything
  const t0 = performance.now();
  if (workers > 0) await r.prefoldCold({ workers });
  r.recoverQueued({ shouldAdmit: () => true });
  const out = { ms: ms(t0), stats: r.foldIndexStats };
  r.shutdown?.();
  return out;
}

res = { repo, logs: files.length, mb: Math.round(files.reduce((a, f) => a + readFileSync(path.join(dir, f)).length, 0) / 2 ** 20) };
res.floor = floor();
res.serial = await pass(0);
const canPrefold = typeof Runner.prototype.prefoldCold === "function";
if (canPrefold) {
  const { coldFoldWorkersFromEnv } = await import(pathToFileURL(path.join(repo, "runner", "fold-cold.mjs")).href);
  res.workers = Number(arg("workers", coldFoldWorkersFromEnv()));
  res.prefold = await pass(res.workers);
}
res.serialPerFloor = +(res.serial.ms / res.floor.ms).toFixed(2);
if (res.prefold) res.prefoldPerSerial = +(res.prefold.ms / res.serial.ms).toFixed(2);
console.log(JSON.stringify(res, null, 1));
} finally {
  cleanup();
}
if (flag("check")) {
  const bad = [];
  if (res.serialPerFloor > SERIAL_MAX) bad.push(`serial cold pass ${res.serialPerFloor}x the read+parse floor (max ${SERIAL_MAX}x)`);
  if (res.prefold && res.workers >= 3 && res.prefoldPerSerial > PREFOLD_MAX) bad.push(`prefold ${res.prefoldPerSerial}x the serial pass (max ${PREFOLD_MAX}x)`);
  if (res.prefold && res.prefold.stats?.full > 0) bad.push(`prefold left ${res.prefold.stats.full} logs to the serial pass`);
  if (bad.length) { console.error(`FAIL: ${bad.join("; ")}`); process.exit(1); }
  console.error("PASS");
}
process.exit(0);
