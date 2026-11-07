// The VS server is the runner's only owner (like Paseo's daemon): it starts the runner at boot and restarts it, with backoff,
// if it dies. Everyone else (MCP sidecars, the vs CLI, runner-api) only connects and gets RUNNER_DOWN when it is not up.
//
// It also keeps the runner's code live: the runner reports a content hash of its own runner/*.mjs files on /health, and this
// supervisor hashes the runtime runner/ dir on disk the same way each tick. When they differ (and there are no running turns)
// it restarts the runner, so a build -> sync-runtime actually goes live without quitting VibeSquad (RR1).
import { rmSync } from "node:fs";
import path from "node:path";
import { runnerLanes } from "./backend/index.mjs";
import { logRunnerMetric } from "./backend/runner-backend.mjs";
import { readDiscovery } from "./backend/runner-client.mjs";
import { pidAlive, readLock } from "../runner/lock.mjs";
import { killTree } from "./proc-tree.mjs";
import { hashRunnerFiles } from "../runner/server.mjs";

/** The runtime runner/ dir the live runner was started from (same repo root as this server). */
export const runtimeRunnerDir = () => path.resolve(import.meta.dirname, "..", "runner");

/** Start the runner at boot unless it is disabled: no runner lanes (Paseo rollback) or VIBESQUAD_START_RUNNER=0. */
export function shouldSuperviseRunner(env = process.env, lanes = () => runnerLanes({ env })) {
  const v = String(env?.VIBESQUAD_START_RUNNER ?? "").trim().toLowerCase();
  if (v === "0" || v === "false") return false;
  try {
    return lanes().size > 0;
  } catch {
    return false;
  }
}

/** Owner-confirmed forced restart (Unstick, after it killed the old runner tree and cleared runner.lock): the start still goes through the owner. */
export function restartRunner(owner, opts = {}) {
  return owner.startOwned(opts);
}

/**
 * Kill the runner process tree, clear whatever blocks a fresh start, and force a start through the owner. A hard kill skips
 * the runner's shutdown() (which would log an `exit` for every live agent), so a mid-turn agent keeps its session and stays
 * resumable as "lost" via the existing park/resume path. Used by the supervisor (hash change) and the owner's "Restart runner".
 */
export async function restartRunnerNow(owner, { alive = pidAlive, waitMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const home = owner.rc.home;
  const disc = readDiscovery(home);
  const pid = disc?.pid;
  if (Number.isInteger(pid) && pid > 0) {
    killTree(pid, { sync: true });
    const end = Date.now() + waitMs;
    while (alive(pid) && Date.now() < end) await sleep(50);
    // Only delete if they still name the pid we killed: superviseRunner may have started a new runner meanwhile.
    if (readLock(path.join(home, "runner.lock"))?.pid === pid) rmSync(path.join(home, "runner.lock"), { force: true });
    if (readDiscovery(home)?.pid === pid) rmSync(path.join(home, "runner.json"), { force: true });
  }
  await owner.startOwned({ force: true });
  return true;
}

/**
 * `owner`: { startOwned(): Promise<boolean>, rc: { healthy(): Promise<boolean>, home } } (a RunnerBackend).
 * Checks every `checkMs`; when the runner is down it starts it, and after a failed start waits longer (backoff, capped).
 * When it is up it also compares the runner's reported code hash against the runtime runner/ dir and restarts it once the
 * hash differs AND there are zero running turns. It restarts at most once per distinct disk hash (no restart loop), and it
 * never treats an unknown running count as zero (it waits, or derives it from the agent list).
 */
export function superviseRunner(owner, {
  checkMs = 5000,
  minBackoffMs = 1000,
  maxBackoffMs = 60000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  healthInfo = (o) => o.rc.request("GET", "/health").then((h) => ({ hash: h.hash, running: h.running })).catch(() => null),
  runningCount = (o) => o.listAgents().then((agents) => agents.filter((a) => a.status === "running").length).catch(() => null),
  diskHash = () => hashRunnerFiles(runtimeRunnerDir()),
  restart = (o) => restartRunnerNow(o),
  log = logRunnerMetric,
} = {}) {
  let stopped = false;
  let timer = null;
  let backoff = minBackoffMs;
  let pendingLogged = false;
  let restartedFor = null; // the disk hash we already restarted for (restart at most once per distinct hash)
  let gaveUpLogged = false; // "still stale after restart" logged once per stuck hash
  const tick = async () => {
    let delay = checkMs;
    try {
      if (!(await owner.rc.healthy())) {
        pendingLogged = false;
        const up = await owner.startOwned();
        if (up) backoff = minBackoffMs;
        else {
          delay = backoff;
          backoff = Math.min(backoff * 2, maxBackoffMs);
        }
      } else {
        backoff = minBackoffMs;
        const disk = diskHash();
        const health = await healthInfo(owner);
        const hash = health?.hash;
        // A runner whose /health has no hash field (old build) is stale; so is a hash that differs from the runtime files.
        const stale = typeof hash !== "string" || hash !== disk;
        if (!stale) {
          pendingLogged = false;
        } else {
          // Running turns: prefer /health's count. An old build lacks `running`, so derive it from the agent list;
          // if that also fails the count is unknown and we treat it as busy (never as zero).
          let running;
          if (typeof health?.running === "number" && Number.isFinite(health.running) && health.running >= 0) {
            running = health.running;
          } else {
            running = await runningCount(owner); // number | null
          }
          if (running === null || running > 0) {
            if (!pendingLogged) {
              pendingLogged = true;
              log(`runner restart pending: ${running === null ? "running turns unknown" : `${running} running turn(s)`}, waiting for them to finish`);
            }
          } else {
            pendingLogged = false;
            if (disk === restartedFor) {
              if (!gaveUpLogged) {
                gaveUpLogged = true;
                log("runner restart: restarted for this code but the runner still reports a different hash; giving up until the runtime changes");
              }
            } else {
              gaveUpLogged = false;
              log("runner restart: runtime runner code changed, restarting");
              await restart(owner);
              restartedFor = disk;
            }
          }
        }
      }
    } catch {
      delay = backoff;
      backoff = Math.min(backoff * 2, maxBackoffMs);
    }
    if (stopped) return;
    timer = setTimer(tick, delay);
    timer.unref?.();
  };
  const first = tick();
  return {
    ready: first,
    stop() {
      stopped = true;
      clearTimer(timer);
    },
  };
}
