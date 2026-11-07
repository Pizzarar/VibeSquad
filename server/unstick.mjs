// "Unstick VibeSquad": snapshot every node process, kill the strays, restart the runner if it is unhealthy.
// The kill set is the explicit complement of a spare set: the serving VS server and its ancestors and descendants, the runner and
// its whole tree (every agent), the runner's child ledger, VS MCP servers, Playwright MCP, Paseo, everything below those, and every
// ancestor of any of them (taskkill /T on a wrapper parent would take a spared child down with it).
// When unsure (no/partial process list, unrecognised tree member) a process is spared, never killed.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readChildren } from "../runner/children.mjs";
import { pidAlive, readLock } from "../runner/lock.mjs";
import { readDiscovery, runnerHome } from "./backend/runner-client.mjs";
import { sharedRunnerBackend } from "./backend/index.mjs";
import { killTree } from "./proc-tree.mjs";
import { restartRunner as ownerRestart, restartRunnerNow } from "./runner-supervisor.mjs";

const NODE_IMAGE = /^node(\.exe)?$/i;
// Command lines that are VS infrastructure or tools an agent depends on, never strays.
const PROTECTED_CMD = [/server[\\/]mcp[\\/]/i, /vibesquad[\\/]+server[\\/]/i, /runner[\\/]server\.mjs/i, /playwright/i, /@playwright[\\/]mcp/i, /paseo/i, /vs-mcp/i];
const RUNNER_CMD = /runner[\\/]server\.mjs/i;

// A partial / timed-out listing has missing parent links, so it must fail the whole run, never be used.
function checkRun(r, what) {
  if (r?.error) throw new Error(`${what}: ${r.error.message ?? r.error}`);
  if (r?.status !== 0) throw new Error(`${what} exited ${r?.status ?? r?.signal}`);
}

/** All processes as [{ pid, ppid, name, cmd, startedMs }]. Windows: Win32_Process via PowerShell; elsewhere: ps. Throws on any failure. */
export function listProcesses({ platform = process.platform, run = spawnSync } = {}) {
  const out = [];
  if (platform === "win32") {
    // One line per process, "|"-delimited with the command line last (it may contain "|"); control chars in it are flattened.
    const script =
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { $c = if ($_.CommandLine) { [regex]::Replace($_.CommandLine, '[\\x00-\\x1f]', ' ') } else { '' }; $ms = if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }; [string]$_.ProcessId + '|' + [string]$_.ParentProcessId + '|' + $ms + '|' + $_.Name + '|' + $c }";
    const r = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
    checkRun(r, "powershell");
    for (const line of String(r.stdout ?? "").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = /^(\d+)\|(\d+)\|(\d+)\|([^|]*)\|(.*)$/.exec(line);
      if (!m) throw new Error(`unparseable process line: ${line.slice(0, 80)}`);
      out.push({ pid: +m[1], ppid: +m[2], name: m[4], cmd: m[5], startedMs: +m[3] || null });
    }
  } else {
    const r = run("ps", ["-eo", "pid=,ppid=,etimes=,comm=,args="], { encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
    checkRun(r, "ps");
    for (const line of String(r.stdout ?? "").split("\n")) {
      if (!line.trim()) continue;
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
      if (!m) throw new Error(`unparseable process line: ${line.slice(0, 80)}`);
      out.push({ pid: +m[1], ppid: +m[2], name: m[4].split("/").pop(), cmd: m[5], startedMs: Date.now() - +m[3] * 1000 });
    }
  }
  if (!out.length) throw new Error("empty process list");
  return out;
}

/**
 * Pure. `procs` from listProcesses; `roots` = pids that anchor a spare tree (runner, ledger children).
 * Returns { kill: [proc], spared: [{ pid, why }] }, node processes only.
 */
export function computeKillSet(procs, { selfPid = process.pid, roots = [] } = {}) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const kids = new Map();
  for (const p of procs) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)).push(p.pid);
  const why = new Map();
  const spare = (pid, reason) => { if (!why.has(pid)) why.set(pid, reason); };
  const spareTree = (pid, reason) => {
    const stack = [pid];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      spare(cur, reason);
      for (const k of kids.get(cur) ?? []) stack.push(k);
    }
  };
  spare(selfPid, "this VS server");
  spareTree(selfPid, "this VS server tree");
  for (const r of roots) if (Number.isInteger(r) && r > 0) spareTree(r, "runner / agent tree");
  for (const p of procs) if (p.cmd && PROTECTED_CMD.some((re) => re.test(p.cmd))) spareTree(p.pid, "VS / MCP / Playwright / Paseo");
  // killTree is taskkill /T: killing a non-protected wrapper parent would take its spared child with it, so spare every ancestor too.
  for (const pid of [...why.keys()]) {
    for (let cur = byPid.get(byPid.get(pid)?.ppid), hops = 0; cur && hops < 64; cur = byPid.get(cur.ppid), hops++) spare(cur.pid, "ancestor of a spared process");
  }
  // A node without a command line cannot be judged: spare.
  const kill = procs.filter((p) => NODE_IMAGE.test(p.name) && !why.has(p.pid) && p.pid !== selfPid && p.pid !== 4 && p.cmd);
  return { kill, spared: [...why].map(([pid, reason]) => ({ pid, why: reason })) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDead(pid, alive, ms) {
  const end = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() >= end) return false;
    await sleep(50);
  }
  return true;
}

/**
 * Runs the whole thing. Everything environmental is injectable: `list`, `killPid`, `runnerHealthy`, `restartRunner`, `alive`, `now`.
 * Returns { ok, killed: [{pid, cmd}], snapshot, runner: { healthy, restarted, ... } }, or { ok: false, error } and nothing killed.
 */
export async function unstick({
  home = process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad"),
  selfPid = process.pid,
  list = () => listProcesses(),
  killPid = (pid) => killTree(pid, { sync: true }),
  backend,
  runnerHealthy,
  restartRunner,
  confirmRestart = false,
  alive = pidAlive,
  healthTimeoutMs = 3000,
  deadTimeoutMs = 5000,
  now = () => new Date(),
} = {}) {
  const rHome = runnerHome({ VIBESQUAD_HOME: home });
  const be = backend ?? sharedRunnerBackend();
  const healthy = runnerHealthy ?? (() => be.rc.healthy());
  const restart = restartRunner ?? ((opts) => ownerRestart(be, opts));
  let procs;
  try {
    procs = list();
    if (!Array.isArray(procs) || !procs.some((p) => p.pid === selfPid)) throw new Error("listing does not contain this server");
  } catch (e) {
    return { ok: false, error: `process list failed: ${String(e?.message ?? e)}`, killed: [] };
  }
  const disc = readDiscovery(rHome);
  const runnerPid = disc?.pid;
  const ledger = readChildren(rHome).map((r) => r.pid);
  const check = () => Promise.race([Promise.resolve(healthy()).catch(() => false), new Promise((r) => setTimeout(() => r(false), healthTimeoutMs).unref?.())]);
  const wasHealthy = await check();
  const hung = !wasHealthy && Number.isInteger(runnerPid) && alive(runnerPid); // alive pid that does not answer: a start would wait on its lock forever

  const roots = [runnerPid, ...ledger].filter(Number.isInteger);
  const { kill, spared } = computeKillSet(procs, { selfPid, roots });
  const ts = now().toISOString().replace(/[:.]/g, "-");
  const dir = join(home, "logs");
  mkdirSync(dir, { recursive: true });
  const snapshot = join(dir, `unstick-${ts}.json`);
  const nodes = procs.filter((p) => NODE_IMAGE.test(p.name));
  writeFileSync(snapshot, JSON.stringify({ at: now().toISOString(), selfPid, runnerPid: runnerPid ?? null, runnerHealthy: wasHealthy, runnerHung: hung, confirmRestart, node: nodes, wouldKill: kill.map((p) => p.pid), spared }, null, 2));

  const killed = [];
  for (const p of kill) {
    try { killPid(p.pid); killed.push({ pid: p.pid, cmd: String(p.cmd).slice(0, 200) }); } catch { /* already gone */ }
  }
  let restarted = false;
  let healthyNow = wasHealthy;
  let needsRestart = false;
  let note;
  if (hung && !confirmRestart) {
    needsRestart = true; // never kill the runner (and the agents under it) without an explicit yes
  } else if (!wasHealthy) {
    let forced = false;
    let dead = true;
    if (hung) {
      // Kill the runner tree only if the pid still looks like the runner (pids get reused), then clear what blocks a fresh start.
      const rp = procs.find((p) => p.pid === runnerPid);
      if (rp && RUNNER_CMD.test(rp.cmd ?? "")) {
        try { killPid(runnerPid); killed.push({ pid: runnerPid, cmd: String(rp.cmd).slice(0, 200) }); } catch { /* gone */ }
        dead = await waitDead(runnerPid, alive, deadTimeoutMs);
      } else {
        dead = !alive(runnerPid) ? true : false;
        if (!dead) note = "runner pid no longer looks like the runner; left alone";
      }
      if (!dead) note ??= "runner process did not exit";
      // superviseRunner may have started a new runner during the health check: delete lock/discovery only if they still name the pid we killed.
      if (dead) {
        if (readLock(join(rHome, "runner.lock"))?.pid === runnerPid) rmSync(join(rHome, "runner.lock"), { force: true });
        if (readDiscovery(rHome)?.pid === runnerPid) rmSync(join(rHome, "runner.json"), { force: true });
        forced = true;
      }
    }
    if (dead) {
      // A fresh owner-confirmed restart must not no-op on the failure cooldown or join a doomed in-flight start: force it.
      await Promise.resolve(restart({ force: forced })).catch(() => false);
    }
    healthyNow = await check();
    restarted = dead && healthyNow;
    if (!restarted && !note) note = "runner did not come back healthy";
  }
  return { ok: true, killed, snapshot, runner: { healthy: healthyNow, wasHealthy, hung, needsRestart, restarted, pid: runnerPid ?? null, ...(note ? { note } : {}) } };
}

/**
 * Owner-confirmed "Restart runner" (Unstick's new action): cancel every running turn cleanly (cancelAgent keeps the session,
 * the agent stays unarchived), then kill the runner tree and start a fresh one. Unlike `unstick`, this restarts a HEALTHY
 * runner — the exact gap that left runner code changes not live after build + sync. Cancelled agents come back parked/lost
 * and resume on their next send through the existing park/resume path. Never archives anything.
 * Everything environmental is injectable for tests: `listAgents`, `cancelAgent`, `restartRunner`.
 */
export async function forceRestartRunner({
  backend,
  listAgents,
  cancelAgent,
  restartRunner = (be) => restartRunnerNow(be),
} = {}) {
  const be = backend ?? sharedRunnerBackend();
  let agents = [];
  try {
    agents = await (listAgents ?? (() => be.listAgents()))();
  } catch {
    // Runner down or unreachable: nothing to cancel; restartRunnerNow still starts a fresh runner.
  }
  const cancelled = [];
  for (const a of agents ?? []) {
    if (!a || a.archivedAt || a.status !== "running") continue; // only stop turns that are actually running
    try {
      await (cancelAgent ?? ((id) => be.cancelAgent(id)))(a.id);
      cancelled.push(a.id);
    } catch {
      // Already finished mid-loop: nothing to cancel.
    }
  }
  await restartRunner(be);
  return { ok: true, cancelled, restarted: true };
}
