// "Unstick VibeSquad": snapshot every node process, kill the strays, restart the runner if it is unhealthy.
// The kill set is the explicit complement of a spare set: the serving VS server and its ancestors and descendants, the runner and
// its whole tree (every agent), the runner's child ledger, VS MCP servers, Playwright MCP, Paseo, and everything below those.
// When unsure (no parent info, unrecognised cmdline of a tree member) a process is spared, never killed.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readChildren } from "../runner/children.mjs";
import { readDiscovery, runnerHome } from "./backend/runner-client.mjs";
import { sharedRunnerBackend } from "./backend/index.mjs";
import { killTree } from "./proc-tree.mjs";

const NODE_IMAGE = /^node(\.exe)?$/i;
// Command lines that are VS infrastructure or tools an agent depends on, never strays.
const PROTECTED_CMD = [/server[\/]mcp[\/]/i, /vibesquad[\/]+server[\/]/i, /runner[\/]server\.mjs/i, /playwright/i, /@playwright[\/]mcp/i, /paseo/i, /vs-mcp/i];

/** All processes as [{ pid, ppid, name, cmd, startedMs }]. Windows: Win32_Process via PowerShell; elsewhere: ps. */
export function listProcesses({ platform = process.platform, run = spawnSync } = {}) {
  if (platform === "win32") {
    // One line per process, "|"-delimited with the command line last (it may contain "|"); control chars in it are flattened.
    const script =
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { $c = if ($_.CommandLine) { [regex]::Replace($_.CommandLine, '[\\x00-\\x1f]', ' ') } else { '' }; $ms = if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }; [string]$_.ProcessId + '|' + [string]$_.ParentProcessId + '|' + $ms + '|' + $_.Name + '|' + $c }";
    const r = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
    const out = [];
    for (const line of String(r.stdout ?? "").split(/\r?\n/)) {
      const m = /^(\d+)\|(\d+)\|(\d+)\|([^|]*)\|(.*)$/.exec(line);
      if (m) out.push({ pid: +m[1], ppid: +m[2], name: m[4], cmd: m[5], startedMs: +m[3] || null });
    }
    return out;
  }
  const r = run("ps", ["-eo", "pid=,ppid=,etimes=,comm=,args="], { encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
  const out = [];
  for (const line of String(r.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (m) out.push({ pid: +m[1], ppid: +m[2], name: m[4].split("/").pop(), cmd: m[5], startedMs: Date.now() - +m[3] * 1000 });
  }
  return out;
}

/**
 * Pure. `procs` from listProcesses; `roots` = pids that anchor a spare tree (serving server, runner, ledger children).
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
  // Ancestors of the serving server (the launcher/terminal chain) and its own tree.
  for (let cur = byPid.get(selfPid), hops = 0; cur && hops < 64; cur = byPid.get(cur.ppid), hops++) spare(cur.pid, cur.pid === selfPid ? "this VS server" : "ancestor of this VS server");
  spareTree(selfPid, "this VS server tree");
  for (const r of roots) if (Number.isInteger(r) && r > 0) spareTree(r, "runner / agent tree");
  for (const p of procs) if (p.cmd && PROTECTED_CMD.some((re) => re.test(p.cmd))) spareTree(p.pid, "VS / MCP / Playwright / Paseo");
  // Unknown parent (ppid 0 or missing command line for a node): cannot judge, spare.
  const kill = procs.filter((p) => NODE_IMAGE.test(p.name) && !why.has(p.pid) && p.pid !== selfPid && p.pid !== 4 && p.cmd);
  return { kill, spared: [...why].map(([pid, reason]) => ({ pid, why: reason })) };
}

/**
 * Runs the whole thing. Everything environmental is injectable: `list`, `killPid`, `runnerHealthy`, `restartRunner`, `now`.
 * Returns { ok, killed: [{pid, cmd}], snapshot, runner: { healthy, restarted, ... } }.
 */
export async function unstick({
  home = process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad"),
  selfPid = process.pid,
  list = () => listProcesses(),
  killPid = (pid) => killTree(pid, { sync: true }),
  backend,
  runnerHealthy,
  restartRunner,
  now = () => new Date(),
} = {}) {
  const rHome = runnerHome({ VIBESQUAD_HOME: home });
  const be = backend ?? sharedRunnerBackend();
  const healthy = runnerHealthy ?? (() => be.rc.healthy());
  const restart = restartRunner ?? (() => be.startOwned());
  const procs = list();
  const disc = readDiscovery(rHome);
  const runnerPid = disc?.pid;
  const ledger = readChildren(rHome).map((r) => r.pid);
  const wasHealthy = await Promise.resolve(healthy()).catch(() => false);

  const roots = [runnerPid, ...ledger].filter(Number.isInteger);
  const { kill, spared } = computeKillSet(procs, { selfPid, roots });
  const ts = now().toISOString().replace(/[:.]/g, "-");
  const dir = join(home, "logs");
  mkdirSync(dir, { recursive: true });
  const snapshot = join(dir, `unstick-${ts}.json`);
  const nodes = procs.filter((p) => NODE_IMAGE.test(p.name));
  writeFileSync(snapshot, JSON.stringify({ at: now().toISOString(), selfPid, runnerPid: runnerPid ?? null, runnerHealthy: wasHealthy, node: nodes, wouldKill: kill.map((p) => p.pid), spared }, null, 2));

  const killed = [];
  for (const p of kill) {
    try { killPid(p.pid); killed.push({ pid: p.pid, cmd: String(p.cmd).slice(0, 200) }); } catch { /* already gone */ }
  }
  let restarted = false;
  let healthyNow = wasHealthy;
  if (!wasHealthy) {
    restarted = await Promise.resolve(restart()).then((v) => v !== false, () => false);
    healthyNow = await Promise.resolve(healthy()).catch(() => false);
  }
  return { ok: true, killed, snapshot, runner: { healthy: healthyNow, wasHealthy, restarted, pid: runnerPid ?? null } };
}
