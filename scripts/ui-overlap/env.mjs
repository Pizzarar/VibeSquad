// Shared harness for the overlap guard: Playwright/Edge resolution, dist build, static server, API mocks.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require2 = createRequire(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Screenshot output for e2e tests: a fresh temp dir by default, the tracked docs/shots/<name> only with UPDATE_SHOTS=1.
// Call cleanupShotsDir(dir) in after(); it is a no-op for the tracked dir.
export function shotsDir(name) {
  if (process.env.UPDATE_SHOTS === "1") return path.join(REPO_ROOT, "docs", "shots", name);
  return fs.mkdtempSync(path.join(os.tmpdir(), `vs-shots-${name}-`));
}
export function cleanupShotsDir(dir) {
  if (dir && !dir.startsWith(path.join(REPO_ROOT, "docs"))) fs.rmSync(dir, { recursive: true, force: true });
}

export const TEAMS_REGISTRY = {
  revision: "ui-overlap-guard",
  teams: [
    {
      id: "vibesquad", name: "VibeSquad", color: "#b07cf5",
      leadFlagTokens: 150000, leadAutoHandoffTokens: 250000, leadHardCapTokens: 300000,
      brainstormWarnTokens: 80000, brainstormRestartTokens: 150000,
      lanes: [
        { id: "riffbot", name: "RiffBot", hub: true, paths: ["VibeSquad"] },
        { id: "vibesquad", name: "VibeSquad", paths: ["VibeSquad"] },
      ],
      paths: ["VibeSquad"],
    },
  ],
};

// Playwright lookup order (idea-1147). The durable dir is under ~/.vibesquad because that is per-user state that
// survives /tmp clears and reboots; the npx cache is only a last resort because npm may prune it at any time.
export const DURABLE_TOOLS_DIR = path.join(os.homedir(), ".vibesquad", "tools", "playwright");
/** Quote for the install hint: cmd.exe takes double quotes as-is; POSIX sh needs backslash, dollar, backtick and quote escaped. */
export function shellQuote(s, platform = process.platform) {
  if (platform === "win32") return `"${s}"`;
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}
export const PLAYWRIGHT_INSTALL_CMD = `npm i --prefix ${shellQuote(DURABLE_TOOLS_DIR)} playwright-core`;
export const PLAYWRIGHT_MISSING = `Playwright not found (set PLAYWRIGHT_DIR, or install it: ${PLAYWRIGHT_INSTALL_CMD})`;
const NPX_SCAN_LIMIT = 50; // bounded: at most this many ~/.npm/_npx entries are stat'ed

/**
 * Ordered candidate paths for Playwright's playwright-core/playwright entry (no loading here, so tests can inject
 * env/home/fs): PLAYWRIGHT_DIR; normal require resolution (+ Windows APPDATA mcp copy); the durable per-user dir;
 * then the newest `~/.npm/_npx/<hash>/node_modules/playwright-core` found by a bounded scan.
 */
export function playwrightCandidates({
  env = process.env, home = os.homedir(), resolveLocal = (n) => require2.resolve(n),
  readdir = fs.readdirSync, exists = fs.existsSync, mtime = (p) => fs.statSync(p).mtimeMs,
  npx = false, // true: also scan the npx caches (scripts/agents opt in, see resolvePlaywright)
} = {}) {
  const out = [];
  if (env.PLAYWRIGHT_DIR) out.push(path.join(env.PLAYWRIGHT_DIR, "playwright-core"));
  for (const n of ["playwright-core", "playwright"]) {
    try { out.push(resolveLocal(n)); } catch {}
  }
  if (env.APPDATA) {
    out.push(path.join(env.APPDATA, "npm/node_modules/@playwright/mcp/node_modules/playwright-core"));
    out.push(path.join(env.APPDATA, "npm/node_modules/@playwright/mcp/node_modules/playwright"));
  }
  const durable = path.join(home, ".vibesquad", "tools", "playwright", "node_modules");
  out.push(path.join(durable, "playwright-core"), path.join(durable, "playwright"));
  // npx caches: ~/.npm/_npx, plus %LOCALAPPDATA%/npm-cache/_npx when LOCALAPPDATA is set (Windows npm).
  const roots = npx ? [path.join(home, ".npm", "_npx")] : [];
  if (npx && env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, "npm-cache", "_npx"));
  const hits = [];
  for (const root of roots) {
    let dirs = [];
    try { dirs = readdir(root).slice(0, NPX_SCAN_LIMIT); } catch {}
    for (const d of dirs) {
      const p = path.join(root, d, "node_modules", "playwright-core");
      let has = false;
      try { has = exists(path.join(p, "package.json")); } catch {}
      if (!has) continue;
      let t = 0;
      try { t = mtime(p); } catch {}
      hits.push({ p, t });
    }
  }
  hits.sort((a, b) => b.t - a.t);
  for (const h of hits) out.push(h.p);
  return out;
}

/** True when `exe` is a snap Chromium: it lives under /snap, or it is the /usr/bin wrapper script that execs /snap/bin/chromium. */
function readFileHead(p, n = 4096) {
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got).toString("latin1");
  } finally { fs.closeSync(fd); }
}

export function isSnapBrowser(exe, { readHead = readFileHead } = {}) {
  if (!exe) return false;
  if (exe.startsWith("/snap/")) return true;
  try { return readHead(exe).includes("/snap/bin/"); } catch { return false; }
}

/**
 * Snap Chromium is confined and cannot create its profile (SingletonLock) under a hidden dir in $HOME, which is where the
 * forge service puts TMPDIR (~/.cache/vibesquad-tmp). Playwright makes its temp profile under os.tmpdir() at launch, so for
 * a snap browser with such a tmpdir return a snap-visible dir to use instead; null means leave TMPDIR alone.
 */
export function snapSafeTmpdir({ exe, tmpdir = os.tmpdir(), home = os.homedir(), platform = process.platform, snap, readHead, fallback = "/tmp" } = {}) {
  if (platform !== "linux") return null; // never touch the browser file off Linux
  if (!(snap ?? isSnapBrowser(exe, readHead ? { readHead } : undefined))) return null;
  const rel = path.relative(home, tmpdir);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null; // not under $HOME
  if (!rel.split(path.sep).some((seg) => seg.startsWith("."))) return null; // no hidden segment: snap can write it
  return fallback;
}

/** Point TMPDIR at a snap-visible dir when the browser we will launch needs it (every launch path resolves Playwright through here). */
function applySnapSafeTmpdir() {
  try {
    const dir = snapSafeTmpdir({ exe: findBrowser() });
    if (dir) process.env.TMPDIR = dir;
  } catch {}
}

/** { mod, from } for the first candidate that loads, or null. `load` is injectable for tests (and skips the TMPDIR hook). */
export function resolvePlaywrightInfo({ load, ...opts } = {}) {
  const real = !load;
  load ??= (c) => require2(c);
  for (const c of playwrightCandidates(opts)) {
    let mod;
    try { mod = load(c); } catch { continue; }
    if (real) applySnapSafeTmpdir();
    return { mod, from: c };
  }
  return null;
}

/**
 * The npx-cache scan is opt-in (`{ npx: true }`): scripts (ui-clicks, ui-overlap) and agents pass it. The default, used
 * by the test suite, excludes it so a stray npx cache cannot flip browser-gated tests from skip to run (a snap Chromium
 * cannot launch in our tmp profile dirs and fails them). Tests still run when PLAYWRIGHT_DIR, repo node_modules or the
 * durable dir has Playwright.
 */
export function resolvePlaywright(opts) {
  return resolvePlaywrightInfo(opts)?.mod ?? null;
}

// Linux browser names, looked up on PATH and in the standard install dirs (forge audit R8).
const LINUX_BROWSER_NAMES = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "microsoft-edge"];
const LINUX_BROWSER_DIRS = ["/usr/bin", "/snap/bin", "/usr/local/bin", "/opt/google/chrome", "/opt/microsoft/msedge"];

/** First existing browser executable. Windows candidates are unchanged; off win32 the Linux list is tried instead. */
export function findBrowser({ platform = process.platform, env = process.env, exists } = {}) {
  const has = exists ?? ((p) => { try { return fs.existsSync(p); } catch { return false; } });
  const override = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (platform === "win32") {
    const l = env.LOCALAPPDATA;
    return [
      override,
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      l && `${l}/Microsoft/Edge/Application/msedge.exe`,
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      l && `${l}/Google/Chrome/Application/chrome.exe`,
    ].filter(Boolean).find(has) ?? null;
  }
  const pathDirs = (env.PATH || "").split(":").filter(Boolean);
  const dirs = [...pathDirs, ...LINUX_BROWSER_DIRS.filter((d) => !pathDirs.includes(d))];
  const names = platform === "darwin" ? ["Google Chrome", "chromium", "microsoft-edge"] : LINUX_BROWSER_NAMES;
  const found = [];
  for (const d of dirs) for (const n of names) found.push(`${d}/${n}`);
  if (platform === "darwin") found.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  return [override, ...found].filter(Boolean).find(has) ?? null;
}

/** Why browser-gated tests cannot run, or false when they can. Used for a loud, counted skip. */
export function browserSkipReason({ pw, exe }) {
  if (pw && exe) return false;
  const parts = [];
  if (!pw) parts.push(`no Playwright found (set PLAYWRIGHT_DIR, or run: ${PLAYWRIGHT_INSTALL_CMD})`);
  if (!exe) parts.push("no Chromium/Chrome/Edge found (set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)");
  return parts.join("; ");
}

/** Newest mtime (ms) among the given files and, for directories, every file beneath them. 0 when none exist. */
export function newestMtime(paths) {
  let newest = 0;
  const stack = [...paths];
  while (stack.length) {
    const p = stack.pop();
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      let entries;
      try { entries = fs.readdirSync(p); } catch { continue; }
      for (const e of entries) stack.push(path.join(p, e));
    } else if (st.mtimeMs > newest) {
      newest = st.mtimeMs;
    }
  }
  return newest;
}

/** vite.config.* files at the repo root (vite.config.ts / .js / .mts / .mjs / .cjs). */
function viteConfigPaths(repoRoot) {
  let entries;
  try { entries = fs.readdirSync(repoRoot); } catch { return []; }
  return entries.filter((e) => /^vite\.config\./.test(e)).map((e) => path.join(repoRoot, e));
}

// ── dist build coordination ──────────────────────────────────────────────────
const PROCESS_START = Date.now();
const LOCK_POLL_MS = 250;
const LOCK_WAIT_MS = 5 * 60 * 1000;   // cap on waiting for a build to finish
const LOCK_STALE_MS = 10 * 60 * 1000; // a lock older than this (or a dead holder) is reclaimed

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lockPath = (repoRoot) => path.join(repoRoot, ".dist-build.lock");
const stampPath = (repoRoot) => path.join(repoRoot, "dist", ".build-stamp");

/** Newest mtime among the UI sources (src/ tree, index.html, vite.config.*). */
function sourceMtime(repoRoot) {
  return newestMtime([path.join(repoRoot, "index.html"), path.join(repoRoot, "src"), ...viteConfigPaths(repoRoot)]);
}

function readLock(repoRoot) {
  try { return JSON.parse(fs.readFileSync(lockPath(repoRoot), "utf8")); } catch { return null; }
}

function readStamp(repoRoot) {
  try { return JSON.parse(fs.readFileSync(stampPath(repoRoot), "utf8")); } catch { return null; }
}

function writeStamp(repoRoot, srcMtime) {
  fs.mkdirSync(path.dirname(stampPath(repoRoot)), { recursive: true });
  fs.writeFileSync(stampPath(repoRoot), JSON.stringify({ srcMtime, builtAt: Date.now(), pid: process.pid }));
}

function processAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function isLockStale(lock, now = Date.now()) {
  if (!lock) return false;
  if (Number.isInteger(lock.pid) && !processAlive(lock.pid)) return true;
  return now - (lock.startedAt ?? 0) > LOCK_STALE_MS;
}

/** Atomically create the lock (wx = fail if it exists). Returns false when another process holds it. */
function acquireLock(repoRoot) {
  let fd;
  try {
    fd = fs.openSync(lockPath(repoRoot), "wx");
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** Re-read before deleting: only remove a lock this process still owns, never a successor's. */
function releaseLock(repoRoot) {
  const lock = readLock(repoRoot);
  if (lock && lock.pid === process.pid) {
    try { fs.rmSync(lockPath(repoRoot), { force: true }); } catch {}
  }
}

/** Wait until the lock is gone (or reclaim a stale one). Throws after the shared deadline. */
async function waitForLock(repoRoot, { deadline, pollMs = LOCK_POLL_MS }) {
  for (;;) {
    const lock = readLock(repoRoot);
    if (!lock) return;
    if (isLockStale(lock)) {
      // Re-read before reclaiming: a live holder may have replaced the lock we just saw.
      const re = readLock(repoRoot);
      if (re && re.pid === lock.pid && re.startedAt === lock.startedAt && isLockStale(re)) {
        try { fs.rmSync(lockPath(repoRoot), { force: true }); } catch {}
        return;
      }
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for dist build lock: ${lockPath(repoRoot)}`);
    await sleep(pollMs);
  }
}

/**
 * Whether dist/ needs a (re)build: missing dist/index.html or stamp, a forced rebuild honoured only
 * when the last build predates this run (runStart), or any source newer than the stamped source mtime.
 */
export function distNeedsBuild({ repoRoot = REPO_ROOT, override = process.env.UI_OVERLAP_REBUILD, runStart = PROCESS_START } = {}) {
  const distIndex = path.join(repoRoot, "dist", "index.html");
  const stamp = readStamp(repoRoot);
  if (!fs.existsSync(distIndex) || !stamp) return true;
  if (override === "1" && (stamp.builtAt ?? 0) < runStart) return true;
  return sourceMtime(repoRoot) > (stamp.srcMtime ?? 0);
}

const VITE_BUILD_MS = 150 * 1000; // under the click tests' 180s timeout, so the build and its lock die before the test gives up; // a hung build would hold .dist-build.lock and its own caller forever
async function runViteBuild(repoRoot) {
  const viteBin = path.join(repoRoot, "node_modules", "vite", "bin", "vite.js");
  await new Promise((res, rej) => {
    const child = spawn(process.execPath, [viteBin, "build"], { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (d) => (err += String(d)));
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} child.stderr?.destroy(); rej(new Error(`vite build timed out after ${VITE_BUILD_MS}ms`)); }, VITE_BUILD_MS);
    killer.unref?.();
    child.on("error", (e) => { clearTimeout(killer); rej(e); });
    child.on("exit", (code) => { clearTimeout(killer); if (code === 0) res(); else rej(new Error(`vite build failed:\n${err.slice(0, 3000)}`)); });
  });
}

/**
 * Ensure dist/ is built and current, coordinating across processes with a lock file:
 *  1. wait for any in-flight build (or reclaim a stale lock: dead pid / older than 10 min);
 *  2. re-check freshness, then build under the lock only if still needed;
 *  3. write dist/.build-stamp (the source mtime it built from) so waiters see a completed build.
 * UI_OVERLAP_REBUILD=1 forces at most one rebuild per run: it is honoured only when the existing
 * stamp is older than this process's start (PROCESS_START), so parallel test processes share one rebuild.
 */
export async function ensureDist({ repoRoot = REPO_ROOT, override = process.env.UI_OVERLAP_REBUILD, build = runViteBuild, runStart = PROCESS_START, lockWaitMs = LOCK_WAIT_MS, pollMs = LOCK_POLL_MS } = {}) {
  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    await waitForLock(repoRoot, { deadline, pollMs });
    if (!distNeedsBuild({ repoRoot, override, runStart })) return;
    if (!acquireLock(repoRoot)) continue; // lost the race: wait for the winner, then re-check
    try {
      if (!distNeedsBuild({ repoRoot, override, runStart })) return; // another process built while we waited
      const builtSrcMtime = sourceMtime(repoRoot);
      await build(repoRoot);
      writeStamp(repoRoot, builtSrcMtime);
      return;
    } finally {
      releaseLock(repoRoot);
    }
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
  ".txt": "text/plain", ".woff": "font/woff", ".woff2": "font/woff2",
};

export async function serveDist() {
  const distDir = path.join(REPO_ROOT, "dist");
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    let filePath = path.join(distDir, pathname === "/" ? "index.html" : pathname);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(distDir, "index.html");
    res.setHeader("content-type", MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream");
    fs.createReadStream(filePath).on("error", () => { res.statusCode = 404; res.end("Not found"); }).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

/** Route mocks: teams registry, /health with exposed LAN IPs (EXPOSED banner), everything else {ok:true}. */
export async function installRoutes(context) {
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(p)) return route.fulfill({ status: 200, contentType: "font/woff2", body: "" });
    if (p === "/api/teams" && req.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(TEAMS_REGISTRY) });
    if (p === "/__vibesquad/health") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, lanEnabled: true, exposedIps: ["192.168.1.20", "100.64.0.5"], configWarnings: [] }) });
    }
    if (p.startsWith("/__vibesquad/")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    return route.continue();
  });
}
