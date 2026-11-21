// Runner boot-fold timing on a SYNTHETIC runner home (never ~/.vibesquad): unit-runner-fold-incr (idea-261).
//   node scripts/bench-runner-boot.mjs [--repo <checkout>] [--home <dir>] [--mb 450] [--agents 5000] [--runs 1] [--keep]
// Boots runner/server.mjs of --repo (default: this checkout) against the same home and reads its {boot:{...}} line:
//   cold   = no runner fold index (fold-index.json removed): every log folded from byte 0
//   warm   = the index the previous boot wrote, logs unchanged
//   --live N  mtimes of the N largest logs sit inside the racy window (live agents were writing when the cold boot saved: prod 11-17,
//             idea-316); warm then reports how many of them the index could still trust (full=0 after the fix)
//   append = warm, after appending a few events to 50 logs (the live agents' growth between two restarts)
// --repo <master checkout> times the "before" code; it has no index, so its three numbers are all full folds.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, utimesSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const repo = path.resolve(arg("repo", path.join(path.dirname(fileURLToPath(import.meta.url)), "..")));
const MB = Number(arg("mb", 450));
const N = Number(arg("agents", 5000));
const RUNS = Number(arg("runs", 1));
const LIVE = Number(arg("live", 0));
const root = arg("home") ? path.resolve(arg("home")) : mkdtempSync(path.join(os.tmpdir(), "vs-boot-bench-"));
const real = path.resolve(os.homedir(), ".vibesquad");
const rhome = path.join(root, ".vibesquad", "runner");
if (path.resolve(rhome).toLowerCase().startsWith(real.toLowerCase())) throw new Error("refusing to bench inside the real ~/.vibesquad");
const agentsDir = path.join(rhome, "agents");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VS_|VIBESQUAD_|PASEO_)/i.test(k)));
env.VIBESQUAD_HOME = path.join(root, ".vibesquad");
env.VS_BENCH = "1";
const idOf = (i) => `rn-${i.toString(16).padStart(12, "0")}`;

// Same shape as scripts/bench-roster-fold.mjs: Pareto-ish sizes (a few huge long-lived leads, a long tail of small workers),
// three quarters closed (archived / exited), the rest idle with a session.
function generate() {
  mkdirSync(agentsDir, { recursive: true });
  const target = MB * 1024 * 1024;
  const w = Array.from({ length: N }, (_, i) => 1 / Math.pow(i + 1, 0.9));
  const sum = w.reduce((a, b) => a + b, 0);
  const pad = "x".repeat(380);
  let t = Date.parse("2026-11-01T00:00:00Z");
  for (let i = 0; i < N; i++) {
    const bytes = Math.max(2000, Math.round((w[i] / sum) * target));
    const fd = openSync(path.join(agentsDir, `${idOf(i)}.jsonl`), "w");
    let seq = 0;
    let size = 0;
    const lane = ["bug-chaser", "desk", "usage", "wiki", "ui-bois"][i % 5];
    const role = i % 17 === 0 ? "lead" : i % 11 === 0 ? "brainstorm" : "worker";
    const ev = (type, data) => { const l = JSON.stringify({ seq: seq++, ts: (t += 37), type, ...data }) + "\n"; size += Buffer.byteLength(l); return l; };
    let chunk = ev("created", { provider: i % 3 ? "claude" : "gemini", model: "m", cwd: path.join(root, "wt", lane), meta: { title: `agent ${i}`, team: "vibesquad", lane, role, labels: { team: "vibesquad", lane, role } }, systemPrompt: "You are an agent. " + pad.repeat(8) });
    chunk += ev("session", { sessionId: `s-${i}`, modes: ["default"], models: [] });
    let k = 0;
    while (size < bytes) {
      k++;
      if (k % 40 === 1) chunk += ev("input", { text: "do the thing " + pad.slice(0, 80) });
      if (k % 40 === 1) chunk += ev("status", { status: "running" });
      chunk += ev("text", { text: pad });
      if (k % 3 === 0) { chunk += ev("tool", { id: `c${k}`, phase: "call", name: "Bash", input: { command: "ls " + pad.slice(0, 120), timeout: 120000 } }); chunk += ev("tool", { id: `c${k}`, phase: "result", output: pad.slice(0, 200) }); }
      if (k % 20 === 0) chunk += ev("usage", { contextTokens: 1000 + k, contextMax: 200000, inputTokens: 900 + k, outputTokens: k, costUsd: 0.01 });
      if (k % 40 === 39) { chunk += ev("turn_done", {}); chunk += ev("status", { status: "idle" }); }
      if (chunk.length > 1 << 20) { writeSync(fd, chunk); chunk = ""; }
    }
    chunk += ev("status", { status: "idle" });
    if (i % 4 === 0) chunk += ev("archive", {});
    else if (i % 4 === 1) chunk += ev("exit", { code: 0 });
    writeSync(fd, chunk);
    closeSync(fd);
  }
}

const ms = (t0) => Math.round(performance.now() - t0);
let liveRunner = null;
async function boot() {
  rmSync(path.join(rhome, "runner.json"), { force: true });
  const runner = spawn(process.execPath, [path.join(repo, "runner", "server.mjs"), "--home", rhome], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  liveRunner = runner;
  let log = "";
  let exited = false;
  runner.on("exit", () => { exited = true; });
  runner.stdout.on("data", (d) => { log += d; });
  runner.stderr.on("data", (d) => { log += d; });
  const t0 = performance.now();
  let line = null;
  while (!line && !exited && performance.now() - t0 < 15 * 60_000) { // exited: e.g. {alreadyRunning} (the last runner had not exited yet)
    line = log.split("\n").find((l) => l.startsWith('{"boot":'));
    if (!line) await new Promise((r) => setTimeout(r, 50));
  }
  const bootWall = ms(t0);
  // Let the post-listen index save finish before the next boot reads it.
  for (const t1 = performance.now(); !/"foldIndexSave"/.test(log) && performance.now() - t1 < 30_000 && existsSync(path.join(repo, "runner", "fold-index.mjs")); ) await new Promise((r) => setTimeout(r, 50));
  try {
    const { port } = JSON.parse(readFileSync(path.join(rhome, "runner.json"), "utf8"));
    const token = readFileSync(path.join(rhome, "token"), "utf8").trim();
    await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  } catch { runner.kill(); }
  // Wait for the exit (its shutdown saves the index): the next boot would otherwise find the lock held and exit {alreadyRunning}.
  if (!exited) await new Promise((r) => { runner.on("exit", r); setTimeout(() => { runner.kill(); r(); }, 120_000); });
  const save = log.split("\n").find((l) => l.startsWith('{"foldIndexSave":'));
  const fi = line ? JSON.parse(line).foldIndex : null;
  return { ...(line ? JSON.parse(line).boot : { error: log.slice(-400) }), bootWall, ...(fi ? { trusted: fi.trusted, resumed: fi.resumed, full: fi.full, bytes: fi.bytes, loadMs: fi.loadMs } : {}), ...(save ? JSON.parse(save) : {}) };
}

function appendSome(n = 50) {
  for (let i = 0; i < n; i++) {
    const fd = openSync(path.join(agentsDir, `${idOf(i * 7 % N)}.jsonl`), "a");
    let s = "";
    for (let k = 0; k < 20; k++) s += JSON.stringify({ seq: 1e9 + k, ts: Date.now(), type: "text", text: "tail " + k }) + "\n";
    writeSync(fd, s);
    closeSync(fd);
  }
}

let cleaned = false;
const cleanup = async () => {
  if (cleaned) return;
  cleaned = true;
  if (flag("keep") || arg("home")) return;
  if (liveRunner && liveRunner.exitCode === null) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 3000);
      liveRunner.once("exit", () => { clearTimeout(t); resolve(); });
      try { liveRunner.kill(); } catch { clearTimeout(t); resolve(); }
    });
  }
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) { console.error(`cleanup failed: ${e.message}`); }
};

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { cleanup().then(() => process.exit(sig === "SIGINT" ? 130 : 143)); });
}

try {
  if (!existsSync(agentsDir)) {
    const t0 = performance.now();
    generate();
    console.error(`generated ${N} agents, ~${MB}MB in ${root} (${ms(t0)}ms)`);
  }
  if (LIVE) { const t = new Date(Date.now() + 4_000); for (let i = 0; i < LIVE; i++) utimesSync(path.join(agentsDir, `${idOf(i)}.jsonl`), t, t); } // mtime just ahead of the cold boot's stats: racy, settled by the post-listen save
  const results = { repo, home: root, mb: MB, agents: N, cold: [], warm: [], append: [] };
  for (let r = 0; r < RUNS; r++) {
    rmSync(path.join(rhome, "fold-index.json"), { force: true });
    results.cold.push(await boot());
    await new Promise((res) => setTimeout(res, 3500)); // past the racy window of the entries the cold boot wrote
    results.warm.push(await boot());
    appendSome();
    results.append.push(await boot());
  }
  console.log(JSON.stringify(results, null, 1));
} finally {
  await cleanup();
}
