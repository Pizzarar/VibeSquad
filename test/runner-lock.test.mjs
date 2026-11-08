// tryCreateLock retry budget: a Windows delete-pending EPERM/EACCES (the directory entry is gone but the
// name is not yet reclaimable) is retried for ~LOCK_CREATE_RETRY_BUDGET_MS (100ms), not the old ~30ms, then
// gives up (rethrows) instead of hanging. The fs ops are injected so the failure mode is deterministic.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tryCreateLock } from "../runner/lock.mjs";

function tmp(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "vs-lock-retry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const EPERM = () => Object.assign(new Error("EPERM"), { code: "EPERM" });

test("tryCreateLock retries a transient EPERM/delete-pending until it clears within the budget", (t) => {
  const file = path.join(tmp(t), "runner.lock");
  const t0 = Date.now();
  let calls = 0;
  const open = (f, flags) => {
    calls++;
    // fails for the first ~60ms, then the delete-pending entry is reclaimable and the real create succeeds
    if (Date.now() - t0 < 60) throw EPERM();
    return openSync(f, flags);
  };
  assert.equal(tryCreateLock(file, process.pid, { open, exists: () => false }), true);
  assert.ok(calls >= 3, `retried before succeeding (calls=${calls})`);
  assert.ok(Date.now() - t0 >= 50, `retried past the old ~30ms budget (${Date.now() - t0}ms)`);
  assert.ok(existsSync(file), "lock file written once open succeeded");
});

test("tryCreateLock gives up near the ~100ms budget on a persistent EPERM instead of hanging", { timeout: 5000 }, (t) => {
  const file = path.join(tmp(t), "runner.lock");
  const t0 = Date.now();
  assert.throws(() => tryCreateLock(file, process.pid, { open: () => { throw EPERM(); }, exists: () => false }), (e) => e.code === "EPERM");
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 80, `gave up after ${elapsed}ms, expected ~100ms`);
  assert.ok(elapsed < 2000, `did not hang (${elapsed}ms)`);
  assert.equal(existsSync(file), false, "no lock file left behind");
});
