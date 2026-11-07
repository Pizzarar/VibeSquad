// The VS server is the runner's only owner (like Paseo's daemon): it starts the runner at boot and restarts it, with backoff,
// if it dies. Everyone else (MCP sidecars, the vs CLI, runner-api) only connects and gets RUNNER_DOWN when it is not up.
import { runnerLanes } from "./backend/index.mjs";

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
 * `owner`: { startOwned(): Promise<boolean>, rc: { healthy(): Promise<boolean> } } (a RunnerBackend).
 * Checks every `checkMs`; when the runner is down it starts it, and after a failed start waits longer (backoff, capped).
 */
export function superviseRunner(owner, { checkMs = 5000, minBackoffMs = 1000, maxBackoffMs = 60000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let stopped = false;
  let timer = null;
  let backoff = minBackoffMs;
  const tick = async () => {
    let delay = checkMs;
    try {
      if (!(await owner.rc.healthy())) {
        const up = await owner.startOwned();
        if (up) backoff = minBackoffMs;
        else {
          delay = backoff;
          backoff = Math.min(backoff * 2, maxBackoffMs);
        }
      } else backoff = minBackoffMs;
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
