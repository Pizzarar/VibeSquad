// Test isolation at the source: under a test runner, nothing may read or write the developer's REAL ~/.vibesquad
// (teams.json, the runner). A test that wants state points VIBESQUAD_HOME at a temp dir; forgetting to must fail closed,
// not reach live agents. VS_ALLOW_REAL_HOME=1 opts out (deliberate live checks only).
import os from "node:os";
import path from "node:path";

export const underTestRunner = (env = process.env) => Boolean(env.NODE_TEST_CONTEXT || env.VITEST || env.NODE_ENV === "test");

export const realVibesquadHome = () => path.resolve(os.homedir(), ".vibesquad");

/** True when `dir` is (inside) the real ~/.vibesquad and we are under a test runner without the opt-out. */
export function isForbiddenRealHome(dir, env = process.env) {
  if (!underTestRunner(env) || env.VS_ALLOW_REAL_HOME === "1") return false;
  const rel = path.relative(realVibesquadHome(), path.resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
