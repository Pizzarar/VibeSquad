// Worker thread for off-loop git (server/git-spawn.mjs): runs one `git --no-optional-locks <args>` child with
// execFile. On Windows every child_process spawn does a synchronous CreateProcess on the calling thread, so running
// it here keeps that cost off the server's event loop (idea-560). Posts { ok, out, code } back: ok:false on any
// failure, `out` is the raw stdout (untrimmed), `code` is the numeric exit code (0 on ok) or null when it isn't one
// (timeout, spawn error, signal). Caller contract is identical to the execFile it replaces.
import { parentPort, workerData } from "node:worker_threads";
import { execFile } from "node:child_process";

const { cwd, args, timeoutMs } = workerData ?? {};
try {
  execFile(
    "git",
    ["--no-optional-locks", ...(args ?? [])],
    { cwd, encoding: "utf8", timeout: timeoutMs ?? 5000, windowsHide: true },
    (err, stdout) => {
      const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
      parentPort.postMessage({ ok: !err, out: String(stdout ?? ""), code });
    },
  );
} catch {
  parentPort.postMessage({ ok: false, out: "", code: null });
}
