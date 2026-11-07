// Test isolation at the source: under a test runner, nothing may read or write the developer's REAL ~/.vibesquad
// (teams.json, the runner). A test that wants state points VIBESQUAD_HOME at a temp dir; forgetting to must fail closed,
// not reach live agents. VS_ALLOW_REAL_HOME=1 opts out (deliberate live checks only).
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const underTestRunner = (env = process.env) => Boolean(env.NODE_TEST_CONTEXT || env.VITEST || env.NODE_ENV === "test");

export const realVibesquadHome = () => path.resolve(os.homedir(), ".vibesquad");

/** True when `dir` is (inside) the real ~/.vibesquad and we are under a test runner without the opt-out. */
export function isForbiddenRealHome(dir, env = process.env) {
  if (!underTestRunner(env) || env.VS_ALLOW_REAL_HOME === "1") return false;
  const rel = path.relative(realVibesquadHome(), path.resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The checkout's own (gitignored) teams.json is developer state too: it pins lanes to the runner, which turns every mock-daemon
 * test into a RoutingBackend that probes the real Paseo. Under a test runner, resolving against the real repo root skips it
 * (teams.example.json is used); a test that passes its own temp root, or sets VIBESQUAD_TEAMS_FILE, is unaffected.
 */
export function isForbiddenRepoLocalTeams(rootDir, env = process.env) {
  if (!underTestRunner(env) || env.VS_ALLOW_REAL_HOME === "1") return false;
  return path.resolve(rootDir) === REPO_ROOT;
}
