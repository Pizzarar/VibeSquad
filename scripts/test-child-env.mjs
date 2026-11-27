// One place for the env every test process gets: `npm test` passes childEnv() to its node --test child, and the
// test/setup/hermetic.mjs preload calls hermeticizeEnv() in each test process, so a direct `node --test --import` run gets it too.
//
// Forge, 11-23: a suite started from an agent or runner shell inherited that shell's live env, so the results depended on who ran it:
//  - TMPDIR=~/.vibesquad/tmp (the runner's own temp). Every os.tmpdir() fixture home, including hermetic's VIBESQUAD_HOME, landed
//    INSIDE the real ~/.vibesquad, and server/test-guard.mjs isForbiddenRealHome() failed those tests closed (RUNNER_DOWN, ENOENT,
//    catch-up state never written, empty runner-log lookups). The TMPDIR also split the "machine-wide" suite lock by caller.
//  - VIBESQUAD_MESHNET_HOST/IP, VIBESQUAD_LAN, VIBESQUAD_PORT, VIBESQUAD_START_RUNNER, VS_LANE/TEAM/ROLE...: the live server's
//    network and identity config leaked into URLs and routing under test.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Live/identity namespaces a test must never inherit. Tests set what they need themselves, after the preload.
const LIVE_ENV = /^(VS_|VIBESQUAD_|PASEO_)/i;
// Opt-in test knobs a developer passes on purpose (audit 11-23: every VS_* a test reads without setting it itself):
// VS_TEST_* (FILE_TIMEOUT_MS, STRICT_TIMING, LOAD_FACTOR, DUMP, REAL_HOME), VS_BENCH (timing asserts), VS_SMOKE (live provider
// smokes, test/runner-adapters.test.mjs), and the documented VS_ALLOW_REAL_HOME opt-out (server/test-guard.mjs).
const KEEP_ENV = /^(VS_TEST_|VS_BENCH$|VS_SMOKE$|VS_ALLOW_REAL_HOME$)/i;

const realHomeDir = () => { try { return os.userInfo().homedir || os.homedir(); } catch { return os.homedir(); } };

/** realpath of `p`, or for a path that does not exist yet: realpath of its deepest existing ancestor plus the missing tail. */
export function realpathDeep(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail.reverse()); } catch {}
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    tail.push(path.basename(cur));
    cur = up;
  }
}

const within = (base, dir) => {
  const rel = path.relative(base, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** True when `dir` is the real ~/.vibesquad or inside it (the server/test-guard.mjs rule, without its test-runner gate). Judged
 *  lexically and after resolving symlinks (also through a not-yet-existing tail), so a link into ~/.vibesquad does not slip by. */
export function insideRealVibesquad(dir, home = realHomeDir()) {
  const base = path.resolve(home, ".vibesquad");
  return within(base, path.resolve(dir)) || within(realpathDeep(base), realpathDeep(dir));
}

/** The temp dir a process with `env` would get from os.tmpdir() (same var order as node), so childEnv(otherEnv) judges otherEnv. */
export function tmpdirOf(env, platform = process.platform) {
  if (platform === "win32") return env.TEMP || env.TMP || path.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "temp");
  return env.TMPDIR || env.TMP || env.TEMP || "/tmp";
}

/**
 * idea-1209: VS_TEST_TMPDIR=<dir> moves the suite's temp (e.g. ~/.cache/vs-test-tmp) when /tmp is full or quota-limited (11-27: stale
 * worker scratch filled the /tmp tmpfs quota and every `npm test` died with EDQUOT). Returns {dir} (absolute), {} when unset, or
 * {error} when the dir is inside the real ~/.vibesquad (Forge 11-23: temp homes there trip the real-home guard).
 */
export function testTmpdirOverride(env = process.env, { home = realHomeDir() } = {}) {
  const raw = env.VS_TEST_TMPDIR;
  if (!raw || !String(raw).trim()) return {};
  const dir = path.resolve(String(raw).trim());
  if (insideRealVibesquad(dir, home)) return { error: `VS_TEST_TMPDIR=${dir} is inside the real ~/.vibesquad; temp homes there trip the real-home guard (Forge 11-23). Pick a dir outside it, e.g. ~/.cache/vs-test-tmp.` };
  return { dir };
}

/**
 * Temp-dir vars for tests: VS_TEST_TMPDIR when set (and valid); else {} when the env's temp dir is already outside the real
 * ~/.vibesquad, else the platform default temp (POSIX /tmp; Windows %LOCALAPPDATA%\Temp, which node reads from TEMP/TMP).
 */
export function testTmpdirEnv(env = process.env, { platform = process.platform, home = realHomeDir(), current = tmpdirOf(env, platform) } = {}) {
  // An inherited per-run scratch (TMPDIR=<dir>/vs-t-XXXX, idea-977) wins: a child must not reset it back to the override dir.
  const inheritedScratch = path.basename(current).startsWith(TEST_SCRATCH_PREFIX);
  const ov = inheritedScratch ? {} : testTmpdirOverride(env, { home });
  if (ov.dir) return platform === "win32" ? { TMP: ov.dir, TEMP: ov.dir } : { TMPDIR: ov.dir };
  if (!insideRealVibesquad(current, home)) return {};
  if (platform === "win32") {
    const t = path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "Temp");
    return { TMP: t, TEMP: t };
  }
  return { TMPDIR: "/tmp" };
}

export const TEST_TMP_MIN_FREE_BYTES = 256 * 1024 * 1024;

/**
 * idea-1209: fail-fast check that the test temp dir is writable and has room. Returns {ok:true, freeBytes} or {ok:false, error}
 * (one line: dir, free space, fix). Writes and removes a small probe file (catches EDQUOT/ENOSPC/EACCES, which statfs cannot
 * see on a quota'd tmpfs). `statfs`/`minFreeBytes` are injectable for tests.
 */
export function checkTestTmp(dir = os.tmpdir(), { minFreeBytes = TEST_TMP_MIN_FREE_BYTES, statfs = fs.statfsSync } = {}) {
  const fix = "clear stale scratch there (rm -rf the old vs-t-* / worker dirs) or set VS_TEST_TMPDIR=~/.cache/vs-test-tmp";
  const probe = path.join(dir, `.vs-tmp-probe-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, "x".repeat(4096));
  } catch (e) {
    return { ok: false, error: `npm test: test temp dir ${dir} is not writable (${e.code || e.message}); ${fix}` };
  } finally {
    try { fs.rmSync(probe, { force: true }); } catch {}
  }
  let freeBytes = null;
  try { const st = statfs(dir); freeBytes = Number(st.bavail) * Number(st.bsize); } catch {}
  if (freeBytes !== null && freeBytes < minFreeBytes) {
    return { ok: false, freeBytes, error: `npm test: test temp dir ${dir} has only ${Math.floor(freeBytes / 1048576)} MB free (need ${Math.floor(minFreeBytes / 1048576)} MB); ${fix}` };
  }
  return { ok: true, freeBytes };
}

/** In place: drops inherited live/identity env and points the temp dir outside ~/.vibesquad. Returns `env`. */
export function hermeticizeEnv(env = process.env, opts = {}) {
  const tmp = testTmpdirEnv(env, opts);
  for (const k of Object.keys(env)) if (LIVE_ENV.test(k) && !KEEP_ENV.test(k)) delete env[k];
  Object.assign(env, tmp);
  // The override is resolved into TMPDIR/TMP/TEMP above; keeping it would let every child re-apply it (and re-resolve a relative
  // value against its own cwd), undoing the shared vs-t-* scratch.
  delete env.VS_TEST_TMPDIR;
  return env;
}

// The env `npm test` gives its test children: the caller's env, hermeticized (this drops VIBESQUAD_RUNTIME_DIR, the LIVE runtime
// that agent and runner shells export; a test must never sync into it, and hermetic.mjs then sets a per-process temp one).
export function childEnv(env) {
  return hermeticizeEnv({ ...env });
}

// idea-977: every test process (test/setup/hermetic.mjs) works inside ONE scratch dir "vs-t-XXXXXX" under the OS temp, so each
// mkdtemp in a test file lands there and one rm on exit removes it all. A killed process (watchdog, SIGKILL) leaves its dir;
// the suite runner ages those out at start.
export const TEST_SCRATCH_PREFIX = "vs-t-";
export const TEST_SCRATCH_MAX_AGE_MS = 3 * 3_600_000;

/** Removes stale "vs-t-*" scratch dirs (real directories, mtime older than maxAgeMs) directly under `base`. Returns the count removed. */
export function sweepTestScratch(base = os.tmpdir(), { now = Date.now(), maxAgeMs = TEST_SCRATCH_MAX_AGE_MS } = {}) {
  let removed = 0;
  let names;
  try { names = fs.readdirSync(base); } catch { return 0; }
  for (const name of names) {
    if (!name.startsWith(TEST_SCRATCH_PREFIX)) continue;
    const p = path.join(base, name);
    try {
      const st = fs.lstatSync(p);
      if (!st.isDirectory() || now - st.mtimeMs < maxAgeMs) continue;
      fs.rmSync(p, { recursive: true, force: true });
      removed++;
    } catch {}
  }
  return removed;
}
