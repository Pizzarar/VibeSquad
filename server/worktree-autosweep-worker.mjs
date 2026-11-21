// Worker thread for the auto-sweep (server/worktree-autosweep.mjs runHeavyInWorker): runs one AUTOSWEEP_HEAVY step, whose
// git calls are synchronous, off the server's event loop, and posts { ok, value } or { ok: false, error } back.
import { parentPort, workerData } from "node:worker_threads";
import { AUTOSWEEP_HEAVY } from "./worktree-autosweep.mjs";

const { name, args } = workerData ?? {};
try {
  const fn = Object.hasOwn(AUTOSWEEP_HEAVY, name) ? AUTOSWEEP_HEAVY[name] : null;
  if (!fn) throw new Error(`unknown step ${name}`);
  parentPort.postMessage({ ok: true, value: fn(args ?? {}) });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e?.message ?? e) });
}
