// Kill a child process and everything it spawned. Windows has no process groups for plain spawn(), so use taskkill /T.
import { spawn, spawnSync } from "node:child_process";

/** Best-effort; synchronous when `sync` (needed inside a process "exit" handler). */
export function killTree(pid, { sync = false } = {}) {
  if (!pid || pid < 2) return;
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T", "/F"];
    if (sync) {
      // taskkill is a separate process: under heavy CPU load its startup alone can pass a few seconds, and a spawnSync timeout kills it
      // mid-job and leaves the tree alive. Allow a generous ceiling, and if it still didn't finish, at least take down the root.
      let r;
      try { r = spawnSync("taskkill", args, { windowsHide: true, stdio: "ignore", timeout: 30000 }); } catch {}
      if (!r || r.error || r.signal) { try { process.kill(pid, "SIGKILL"); } catch {} }
    } else {
      try { spawn("taskkill", args, { windowsHide: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch {}
    }
    return;
  }
  // POSIX: children are started detached (own process group), so signal the group, then the pid itself.
  for (const target of [-pid, pid]) {
    try { process.kill(target, "SIGKILL"); } catch {}
  }
}

const exitHooks = new Set();
let hooked = false;

/** Runs `fn` when the server process exits, including on SIGINT/SIGTERM/SIGHUP (which skip "exit" handlers by default). */
export function onServerExit(fn) {
  exitHooks.add(fn);
  if (!hooked) {
    hooked = true;
    const run = () => { for (const f of exitHooks) { try { f(); } catch {} } };
    process.on("exit", run);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      // Only finish the default behaviour (exit) when nobody else is listening for the signal.
      process.on(sig, () => { run(); if (process.listenerCount(sig) <= 1) process.exit(128); });
    }
  }
  return () => exitHooks.delete(fn);
}
