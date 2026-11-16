// Roster-fold timing on a SYNTHETIC large runner home (never ~/.vibesquad): `vs who`, the server's refreshRunnerRoster, and the
// runner's boot fold with N concurrent `vs who` calls. unit-roster-no-refold (idea-261 / idea-148).
//   node scripts/bench-roster-fold.mjs [--repo <checkout>] [--home <dir>] [--mb 200] [--agents 500] [--concurrent 8] [--keep]
// --repo times another checkout's code (e.g. master for "before") against the same synthetic home.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync, closeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const repo = path.resolve(arg("repo", path.join(path.dirname(fileURLToPath(import.meta.url)), "..")));
const MB = Number(arg("mb", 200));
const N = Number(arg("agents", 500));
const CONC = Number(arg("concurrent", 8));
const root = arg("home") ? path.resolve(arg("home")) : mkdtempSync(path.join(os.tmpdir(), "vs-fold-bench-"));
const real = path.resolve(os.homedir(), ".vibesquad");
const vsHome = path.join(root, ".vibesquad");
if (path.resolve(vsHome).toLowerCase().startsWith(real.toLowerCase())) throw new Error("refusing to bench inside the real ~/.vibesquad");
const rhome = path.join(vsHome, "runner");
const agentsDir = path.join(rhome, "agents");

// Clean child env: no VS_/VIBESQUAD_/PASEO_ from this shell, the synthetic home only.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VS_|VIBESQUAD_|PASEO_)/i.test(k)));
env.VIBESQUAD_HOME = vsHome;
env.VS_BENCH = "1";

function generate() {
  mkdirSync(agentsDir, { recursive: true });
  const target = MB * 1024 * 1024;
  // Pareto-ish sizes: a few huge long-lived leads, a long tail of small workers (the live home's shape).
  const w = Array.from({ length: N }, (_, i) => 1 / Math.pow(i + 1, 0.9));
  const sum = w.reduce((a, b) => a + b, 0);
  const pad = "x".repeat(380);
  let t = Date.parse("2026-11-01T00:00:00Z");
  for (let i = 0; i < N; i++) {
    const id = `rn-${i.toString(16).padStart(12, "0")}`;
    const bytes = Math.max(2000, Math.round((w[i] / sum) * target));
    const fd = openSync(path.join(agentsDir, `${id}.jsonl`), "w");
    let seq = 0;
    let size = 0;
    const lane = ["bug-chaser", "desk", "usage", "wiki", "ui-bois"][i % 5];
    const role = i % 17 === 0 ? "lead" : i % 11 === 0 ? "brainstorm" : "worker";
    const ev = (type, data) => { const l = JSON.stringify({ seq: seq++, ts: (t += 37), type, ...data }) + "\n"; size += Buffer.byteLength(l); return l; };
    let chunk = ev("created", { provider: i % 3 ? "claude" : "gemini", model: "m", cwd: path.join(root, "wt", lane), meta: { title: `agent ${i}`, team: "vibesquad", lane, role, labels: { team: "vibesquad", lane, role } } });
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
function run(cmd, args, { capture = false } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const c = spawn(cmd, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { err += d; });
    c.on("exit", (code) => resolve({ code, ms: ms(t0), out: capture ? out : out.length, err }));
  });
}
const vsWho = () => run(process.execPath, [path.join(repo, "cli", "vs.mjs"), "who", "all", "--team", "vibesquad"], { capture: true });

async function refreshTiming() {
  // Fresh process = fresh module state: the server's first roster scan, the one boot runs at vibesquad-api.mjs:1796.
  const code = `const t0=performance.now();const m=await import(${JSON.stringify(pathToFileURL(path.join(repo, "server", "vibesquad-api.mjs")).href)});const t1=performance.now();await m._runnerRosterReady();const t2=performance.now();const n=m._liveRunnerAgentsForTest?.(Date.now())?.length;console.log(JSON.stringify({importMs:Math.round(t1-t0),refreshMs:Math.round(t2-t1),agents:n}));process.exit(0);`;
  const r = await run(process.execPath, ["--input-type=module", "-e", code], { capture: true });
  try { return JSON.parse(r.out.trim().split("\n").pop()); } catch { return { error: r.err.slice(0, 400) }; }
}

async function bootWithConcurrentWho(n) {
  rmSync(path.join(rhome, "runner.json"), { force: true });
  const runner = spawn(process.execPath, [path.join(repo, "runner", "server.mjs"), "--home", rhome], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  runner.stdout.on("data", (d) => { log += d; });
  runner.stderr.on("data", (d) => { log += d; });
  const t0 = performance.now();
  const whos = Array.from({ length: n }, () => vsWho());
  let boot = null;
  while (!boot && performance.now() - t0 < 15 * 60_000) {
    const m = log.match(/\{"boot":\{[^}]*\}\}/);
    if (m) boot = JSON.parse(m[0]).boot;
    else await new Promise((r) => setTimeout(r, 100));
  }
  const bootWall = ms(t0);
  const who = await Promise.all(whos);
  // While it is up: one vs who against the live runner.
  const live = await vsWho();
  try {
    const { port } = JSON.parse(readFileSync(path.join(rhome, "runner.json"), "utf8"));
    const token = readFileSync(path.join(rhome, "token"), "utf8").trim();
    await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  } catch { runner.kill(); }
  await new Promise((r) => { runner.on("exit", r); setTimeout(r, 5000); });
  return { n, boot, bootWall, whoMs: who.map((w) => w.ms), whoFailed: who.filter((w) => w.code !== 0).length, liveWhoMs: live.ms, liveWhoCode: live.code };
}

// The CLI resolves teams from the home's registry: without one, which Squad `--team vibesquad` means depends on the checkout path.
const teamsFile = path.join(vsHome, "teams.json");
if (!existsSync(teamsFile)) {
  mkdirSync(vsHome, { recursive: true });
  writeFileSync(teamsFile, JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", paths: [], lanes: ["vibesquad", "bug-chaser", "desk", "usage", "wiki", "ui-bois"].map((id) => ({ id, name: id })) }] }) + "
");
}
if (!existsSync(agentsDir)) {
  const t0 = performance.now();
  generate();
  console.error(`generated ${N} agents, ~${MB}MB in ${root} (${ms(t0)}ms)`);
}
const idx = path.join(rhome, "roster-index.json");
rmSync(idx, { force: true });
const results = { repo, home: root, mb: MB, agents: N };
const cold = await vsWho();
results.vsWhoCold = { ms: cold.ms, code: cold.code, lines: String(cold.out).split("\n").length };
if (cold.code !== 0) results.vsWhoErr = cold.err.slice(0, 400);
const warm = await vsWho();
results.vsWhoWarm = { ms: warm.ms, same: warm.out === cold.out };
// Appended bytes since the last call: the index folds only the new tail.
{
  const fd = openSync(path.join(agentsDir, `rn-${(0).toString(16).padStart(12, "0")}.jsonl`), "a");
  writeSync(fd, JSON.stringify({ seq: 1e9, ts: Date.now(), type: "text", text: "tail" }) + "\n");
  closeSync(fd);
  const r = await vsWho();
  results.vsWhoAfterAppend = { ms: r.ms };
}
results.refreshRunnerRoster = await refreshTiming();
results.refreshRunnerRosterWarm = await refreshTiming();
results.bootAlone = await bootWithConcurrentWho(0);
rmSync(idx, { force: true });
results.bootConcurrentColdIndex = await bootWithConcurrentWho(CONC);
results.bootConcurrentWarmIndex = await bootWithConcurrentWho(CONC);
console.log(JSON.stringify(results, null, 2));
if (!flag("keep") && !arg("home")) rmSync(root, { recursive: true, force: true });
