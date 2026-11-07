// Test isolation at the source: under a test runner, nothing may read or write the developer's REAL ~/.vibesquad
// (teams.json, the runner). A test that wants state points VIBESQUAD_HOME at a temp dir; forgetting to must fail closed,
// not reach live agents. VS_ALLOW_REAL_HOME=1 opts out (deliberate live checks only).
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const underTestRunner = (env = process.env) => Boolean(env.NODE_TEST_CONTEXT || env.VITEST || env.NODE_ENV === "test");

// userInfo(), not homedir(): tests override HOME/USERPROFILE to a temp dir, which must not count as the real home.
const osHome = () => { try { return os.userInfo().homedir || os.homedir(); } catch { return os.homedir(); } };
export const realVibesquadHome = () => path.resolve(osHome(), ".vibesquad");

/** True when `dir` is (inside) the real ~/.vibesquad and we are under a test runner without the opt-out. */
export function isForbiddenRealHome(dir, env = process.env) {
  if (!underTestRunner(env) || env.VS_ALLOW_REAL_HOME === "1") return false;
  const rel = path.relative(realVibesquadHome(), path.resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const repoRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * True when `file` is the checkout's own <repo>/teams.json and we are under a test runner without an explicit
 * VIBESQUAD_TEAMS_FILE. That file is developer state (e.g. lanes marked backend:"runner") and must not steer test routing;
 * tests that need a registry set VIBESQUAD_TEAMS_FILE or pass their own rootDir.
 */
export function isForbiddenRepoTeams(file, env = process.env) {
  if (!underTestRunner(env) || env.VS_ALLOW_REAL_HOME === "1" || env.VIBESQUAD_TEAMS_FILE) return false;
  return path.resolve(file) === path.join(repoRoot(), "teams.json");
}
