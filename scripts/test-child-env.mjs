// The env `npm test` gives its test children: the caller's env minus VIBESQUAD_RUNTIME_DIR. Agent/runner shells export that as
// the LIVE runtime, which a test must never sync into (test/setup/hermetic.mjs then points it at a per-process temp dir).
export function childEnv(env) {
  const e = { ...env };
  delete e.VIBESQUAD_RUNTIME_DIR;
  return e;
}
