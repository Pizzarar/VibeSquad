// One place for the env every test process gets: `npm test` passes childEnv() to its node --test child, and the
// test/setup/hermetic.mjs preload calls hermeticizeEnv() in each test process, so a direct `node --test --import` run gets it too.
//
// Forge, 11-23: a suite started from an agent or runner shell inherited that shell's live env, so the results depended on who ran it:
//  - TMPDIR=~/.vibesquad/tmp (the runner's own temp). Every os.tmpdir() fixture home, including hermetic's VIBESQUAD_HOME, landed
//    INSIDE the real ~/.vibesquad, and server/test-guard.mjs isForbiddenRealHome() failed those tests closed (RUNNER_DOWN, ENOENT,
//    catch-up state never written, empty runner-log lookups). The TMPDIR also split the "machine-wide" suite lock by caller.
//  - VIBESQUAD_MESHNET_HOST/IP, VIBESQUAD_LAN, VIBESQUAD_PORT, VIBESQUAD_START_RUNNER, VS_LANE/TEAM/ROLE...: the live server's
//    network and identity config leaked into URLs and routing under test.
import os from "node:os";
import path from "node:path";

// Live/identity namespaces a test must never inherit. Tests set what they need themselves, after the preload.
const LIVE_ENV = /^(VS_|VIBESQUAD_|PASEO_)/i;
// Opt-in test knobs a developer passes on purpose (audit 11-23: every VS_* a test reads without setting it itself):
// VS_TEST_* (FILE_TIMEOUT_MS, STRICT_TIMING, LOAD_FACTOR, DUMP, REAL_HOME), VS_BENCH (timing asserts), VS_SMOKE (live provider
// smokes, test/runner-adapters.test.mjs), and the documented VS_ALLOW_REAL_HOME opt-out (server/test-guard.mjs).
const KEEP_ENV = /^(VS_TEST_|VS_BENCH$|VS_SMOKE$|VS_ALLOW_REAL_HOME$)/i;

const realHomeDir = () => { try { return os.userInfo().homedir || os.homedir(); } catch { return os.homedir(); } };

/** True when `dir` is the real ~/.vibesquad or inside it (the server/test-guard.mjs rule, without its test-runner gate). */
export function insideRealVibesquad(dir, home = realHomeDir()) {
  const rel = path.relative(path.resolve(home, ".vibesquad"), path.resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The temp dir a process with `env` would get from os.tmpdir() (same var order as node), so childEnv(otherEnv) judges otherEnv. */
export function tmpdirOf(env, platform = process.platform) {
  if (platform === "win32") return env.TEMP || env.TMP || path.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "temp");
  return env.TMPDIR || env.TMP || env.TEMP || "/tmp";
}

/**
 * Temp-dir vars for tests: {} when the env's temp dir is already outside the real ~/.vibesquad, else the platform default temp
 * (POSIX /tmp; Windows %LOCALAPPDATA%\Temp, which node reads from TEMP/TMP).
 */
export function testTmpdirEnv(env = process.env, { platform = process.platform, home = realHomeDir(), current = tmpdirOf(env, platform) } = {}) {
  if (!insideRealVibesquad(current, home)) return {};
  if (platform === "win32") {
    const t = path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "Temp");
    return { TMP: t, TEMP: t };
  }
  return { TMPDIR: "/tmp" };
}

/** In place: drops inherited live/identity env and points the temp dir outside ~/.vibesquad. Returns `env`. */
export function hermeticizeEnv(env = process.env, opts = {}) {
  const tmp = testTmpdirEnv(env, opts);
  for (const k of Object.keys(env)) if (LIVE_ENV.test(k) && !KEEP_ENV.test(k)) delete env[k];
  Object.assign(env, tmp);
  return env;
}

// The env `npm test` gives its test children: the caller's env, hermeticized (this drops VIBESQUAD_RUNTIME_DIR, the LIVE runtime
// that agent and runner shells export; a test must never sync into it, and hermetic.mjs then sets a per-process temp one).
export function childEnv(env) {
  return hermeticizeEnv({ ...env });
}
