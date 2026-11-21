// Load-scaled time budgets for tests that race real wall-clock under `npm test --queue` (idea-278 family).
// Widen only budgets; never weaken an assertion. Override with VS_TEST_LOAD_FACTOR (>=1).
import os from "node:os";

export function loadFactor() {
  const env = Number(process.env.VS_TEST_LOAD_FACTOR);
  if (Number.isFinite(env) && env >= 1) return env;
  const load = os.platform() === "win32" ? 0 : os.loadavg()[0] / Math.max(1, os.cpus().length);
  return Math.min(8, Math.max(3, 3 + Math.ceil(load * 2)));
}

/** Scale a solo-machine millisecond budget for a loaded machine. */
export function budget(ms) { return Math.round(ms * loadFactor()); }

/** Poll `cond()` until truthy or the (load-scaled) deadline passes; returns the last value. Replaces fixed sleeps that race load. */
export async function until(cond, ms = 2000, step = 15) {
  const deadline = Date.now() + budget(ms);
  let v = await cond();
  while (!v && Date.now() < deadline) { await new Promise((r) => setTimeout(r, step)); v = await cond(); }
  return v;
}
