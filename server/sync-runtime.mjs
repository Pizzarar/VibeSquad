import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "..");

// Only the main checkout, on master and clean, may overwrite the live runtime. A linked worktree or a
// unit branch would copy unmerged code into it (11-06 crash). --force / VIBESQUAD_SYNC_FORCE=1 overrides.
export function syncSkipReason(repoRoot = rootDir, { force = false, git = defaultGit } = {}) {
  if (force) return null;
  try {
    const abs = (p) => resolve(repoRoot, p);
    const gitDir = abs(git(repoRoot, "rev-parse", "--git-dir"));
    const common = abs(git(repoRoot, "rev-parse", "--git-common-dir"));
    if (gitDir.toLowerCase() !== common.toLowerCase()) return "linked worktree, not the main checkout";
    const branch = git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== "master") return `on branch ${branch}, not master`;
    if (git(repoRoot, "status", "--porcelain", "--untracked-files=no")) return "working tree not clean";
  } catch (err) {
    return `cannot verify git state (${String(err?.message ?? err).split("\n")[0]})`;
  }
  return null;
}

function defaultGit(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

const runtimeDirFor = (env) => join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "VibeSquad", "runtime");
const vsHomeFor = (env) => env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const short = (sha) => String(sha ?? "").slice(0, 7);

export function syncRuntimeDir(repoRoot = rootDir, { env = process.env } = {}) {
  const runtimeDir = runtimeDirFor(env);
  if (!existsSync(runtimeDir)) return { synced: false, runtimeDir };

  for (const entry of ["dist", "public", "server", "cli", "runner"]) {
    const src = join(repoRoot, entry);
    if (!existsSync(src)) continue;
    try {
      cpSync(src, join(runtimeDir, entry), { recursive: true, force: true });
    } catch {
      // ignore locked files
    }
  }

  // `vs restart` launches this self-contained script; the runtime copy of cli/ needs it beside it.
  try {
    mkdirSync(join(runtimeDir, "scripts"), { recursive: true });
    copyFileSync(join(repoRoot, "scripts", "restart-runtime.mjs"), join(runtimeDir, "scripts", "restart-runtime.mjs"));
  } catch {}

  // The live server serves runtime/dist-desktop/VibeSquad.apk. Ship the staged build only as a verified pair
  // (sidecar present and equal to the apk's hash), via temp file + rename, apk first and sidecar last.
  try {
    const dist = join(repoRoot, "dist-desktop");
    const apk = join(dist, "VibeSquad.apk");
    const side = `${apk}.sha256`;
    if (existsSync(apk) && existsSync(side)) {
      const want = readFileSync(side, "utf8").trim().toLowerCase();
      const got = createHash("sha256").update(readFileSync(apk)).digest("hex");
      if (want === got) {
        const destDir = join(runtimeDir, "dist-desktop");
        mkdirSync(destDir, { recursive: true });
        for (const [src, name] of [[apk, "VibeSquad.apk"], [side, "VibeSquad.apk.sha256"]]) {
          const tmp = join(destDir, `${name}.tmp-${process.pid}`);
          try {
            copyFileSync(src, tmp);
            renameSync(tmp, join(destDir, name));
          } catch {
            rmSync(tmp, { force: true }); // locked live file: leave the old pair
            break;
          }
        }
      }
    }
  } catch {}

  let stamp = null;
  try {
    const gitOut = (...args) => execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", windowsHide: true }).trim();
    stamp = {
      commit: gitOut("rev-parse", "HEAD"),
      repo: gitOut("rev-parse", "--path-format=absolute", "--git-common-dir"),
      builtAt: new Date().toISOString(),
    };
    writeFileSync(join(runtimeDir, "build-stamp.json"), JSON.stringify(stamp), "utf8");
    const tauriRuntime = join(repoRoot, "src-tauri", "runtime");
    if (existsSync(tauriRuntime)) {
      writeFileSync(join(tauriRuntime, "build-stamp.json"), JSON.stringify(stamp), "utf8");
    }
  } catch {}

  try {
    const vsHome = vsHomeFor(env);
    mkdirSync(vsHome, { recursive: true });
    writeFileSync(join(vsHome, "stale.json"), JSON.stringify({ stale: null }), "utf8");
  } catch {}

  return { synced: true, runtimeDir, commit: stamp?.commit ?? null };
}

// --- What a merge needs to go live (PLAN_V03_STABILIZE R1) ----------------------------------------------------------
// Each merge to master declares it in a git trailer on the merge commit: `Live-Needs: server-restart, build` (or `none`).
// Sync applies what it safely can (build) and only reports restarts: the Overlord picks the window for `vs restart`.

export const LIVE_NEEDS_TRAILER = "Live-Needs";
export const LIVE_NEEDS = ["build", "frontend-reload", "runner-restart", "server-restart"];
/** Commit the repo dist/ was built from, written by this script after vite ran (vite's emptyOutDir wipes it on a rebuild). */
export const DIST_STAMP = ".vs-build.json";
const LIVE_NEEDS_FILE = "live-needs.json"; // in the runtime dir: restart debt carried until a successful `vs restart`

/** `"server-restart, build"` -> `{needs: ["build", "server-restart"], unknown: []}`. `none` adds nothing. */
export function parseLiveNeeds(value) {
  const needs = new Set();
  const unknown = [];
  for (const raw of String(value ?? "").split(/[\s,]+/)) {
    const t = raw.toLowerCase();
    if (!t || t === "none") continue;
    if (LIVE_NEEDS.includes(t)) needs.add(t);
    else unknown.push(raw);
  }
  return { needs: [...needs].sort(), unknown };
}

const UI_FILES = new Set(["index.html", "vite.config.ts", "package.json", "package-lock.json", "tsconfig.json"]);
// server/ scripts run on their own (build, sync), never inside the live server process.
const SERVER_SCRIPTS = new Set(["server/sync-runtime.mjs", "server/build-desktop.mjs", "server/build-android.mjs", "server/generate-licenses.mjs"]);
const isTestFile = (p) => /\.test\.[cm]?[jt]sx?$/.test(p);

/** Fallback for an undeclared merge: what its changed paths need. `uiModules` = non-src files the frontend bundles. */
export function inferLiveNeeds(paths, uiModules = new Set()) {
  const out = new Set();
  for (const p of paths) {
    if (isTestFile(p)) continue;
    if (p.startsWith("src/") || p.startsWith("public/") || UI_FILES.has(p) || uiModules.has(p)) out.add("build").add("frontend-reload");
    if (p === "package.json" || p === "package-lock.json" || (p.startsWith("server/") && !SERVER_SCRIPTS.has(p))) out.add("server-restart");
    if (p.startsWith("runner/")) out.add("runner-restart");
  }
  return [...out].sort();
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.\.?\/[^"']+)["']/g;

/** Files outside src/ that the frontend bundle pulls in (src imports `../server/lane-pure.mjs`, and what that imports). */
export function frontendModules(repoRoot) {
  const found = new Set();
  const queue = [];
  const scan = (file) => {
    let text;
    try { text = readFileSync(file, "utf8"); } catch { return; }
    for (const m of text.matchAll(IMPORT_RE)) {
      const rel = relative(repoRoot, resolve(dirname(file), m[1])).replace(/\\/g, "/");
      if (rel.startsWith("..") || rel.startsWith("src/") || found.has(rel)) continue;
      found.add(rel);
      queue.push(join(repoRoot, rel));
    }
  };
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (/\.[cm]?[jt]sx?$/.test(e.name)) scan(join(dir, e.name));
    }
  };
  walk(join(repoRoot, "src"));
  while (queue.length) scan(queue.shift());
  return found;
}

/**
 * The live needs of every first-parent commit in from..to (the merges, plus any direct commit to master), oldest first.
 * A declared trailer is authoritative for that merge; an undeclared (or unparseable) one is inferred from its diff against
 * the first parent. `needs[need]` lists the short commits that need it; `buildCommits` lists every commit whose paths touch
 * a UI input or that declares build (a rebuild is cheap and safe, so the paths count even when the declaration says none).
 */
export function readLiveNeeds(repoRoot, from, to = "HEAD", { git = defaultGit, uiModules = frontendModules(repoRoot) } = {}) {
  let raw;
  try {
    git(repoRoot, "merge-base", "--is-ancestor", from, to);
    raw = git(repoRoot, "log", "--first-parent", "--diff-merges=first-parent", "--name-only",
      `--format=%x1e%H%x1f%(trailers:key=${LIVE_NEEDS_TRAILER},valueonly,separator=%x2C,unfold)%x1f`, `${from}..${to}`);
  } catch {
    return { ok: false, reason: `${short(from)} is not an ancestor of ${to}` };
  }
  const needs = {};
  const undeclared = [];
  const unknown = [];
  const buildCommits = [];
  const chunks = raw.split("\x1e").slice(1).reverse();
  for (const chunk of chunks) {
    const [sha, trailer = "", rest = ""] = chunk.split("\x1f");
    const commit = short(sha);
    const paths = rest.split("\n").map((l) => l.trim()).filter(Boolean);
    const inferred = inferLiveNeeds(paths, uiModules);
    const declared = trailer.trim() ? parseLiveNeeds(trailer) : null;
    for (const value of declared?.unknown ?? []) unknown.push({ commit, value });
    const valid = declared && (declared.needs.length || !declared.unknown.length);
    const got = valid ? declared.needs : inferred;
    if (!valid) undeclared.push({ commit, inferred });
    for (const n of got) (needs[n] ??= []).push(commit);
    if (got.includes("build") || inferred.includes("build")) buildCommits.push(commit);
  }
  return { ok: true, commits: chunks.length, needs, undeclared, unknown, buildCommits };
}

/** Is the repo dist/ the build of HEAD? A missing stamp, a dirty build, or UI inputs changed since the stamp = stale. */
export function distStatus(repoRoot, head, { git = defaultGit } = {}) {
  if (!existsSync(join(repoRoot, "src"))) return { stale: false, reason: "no frontend sources" };
  if (!head) return { stale: false, reason: "no git HEAD to compare (forced)" };
  if (!existsSync(join(repoRoot, "dist"))) return { stale: true, reason: "dist/ is missing" };
  const stamp = readJson(join(repoRoot, "dist", DIST_STAMP));
  if (typeof stamp?.commit !== "string") return { stale: true, reason: `dist/ has no ${DIST_STAMP} (built outside npm run build / sync)` };
  if (stamp.dirty) return { stale: true, reason: `dist/ was built from a dirty tree at ${short(stamp.commit)}` };
  if (stamp.commit === head) return { stale: false, reason: `dist/ built at HEAD ${short(head)}` };
  const r = readLiveNeeds(repoRoot, stamp.commit, head, { git });
  if (!r.ok) return { stale: true, reason: `dist/ stamp ${short(stamp.commit)} is not in HEAD's history` };
  if (r.buildCommits.length) return { stale: true, reason: `dist/ built at ${short(stamp.commit)}, UI inputs changed in ${r.buildCommits.join(" ")}` };
  return { stale: false, reason: `no UI input changed since dist/ was built at ${short(stamp.commit)}` };
}

function writeDistStamp(repoRoot, head, git) {
  let dirty = true;
  try { dirty = git(repoRoot, "status", "--porcelain", "--untracked-files=no") !== ""; } catch {}
  writeFileSync(join(repoRoot, "dist", DIST_STAMP), JSON.stringify({ commit: head, dirty, builtAt: new Date().toISOString() }), "utf8");
}

/** The frontend half of `npm run build` (vite only: no tsc, no licenses, which would dirty the tree). Never calls sync. */
function defaultBuild(repoRoot) {
  const vite = join(repoRoot, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(vite)) return { ok: false, error: `vite is not installed (${vite}); run npm install, then npm run build` };
  try {
    execFileSync(process.execPath, [vite, "build"], { cwd: repoRoot, windowsHide: true, timeout: 10 * 60_000, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true };
  } catch (err) {
    const tail = String(err?.stderr || err?.message || err).trim().split("\n").filter(Boolean).at(-1);
    return { ok: false, error: `vite build failed: ${tail}` };
  }
}

/** Start time of the newest successful (non-dry) `vs restart`, from ~/.vibesquad/restart-<ts>.json; 0 when none. */
function lastRestartOkAt(vsHome) {
  let best = 0;
  let names = [];
  try { names = readdirSync(vsHome); } catch {}
  for (const name of names) {
    if (!/^restart-.*\.json$/.test(name)) continue;
    const r = readJson(join(vsHome, name));
    const at = Date.parse(r?.startedAt ?? "");
    if (r?.ok === true && !r.dryRun && at > best) best = at;
  }
  return best;
}

const ACTION = {
  "server-restart": "not restarted by sync; the Overlord picks the window: vs restart --dry-run, then vs restart",
  "runner-restart": "the runner supervisor (RR1) restarts it once idle; vs restart also covers it",
  "frontend-reload": "reload open VibeSquad windows (Ctrl+R)",
};

/**
 * The sync entry point: git guard, dist freshness (rebuild or refuse, idea-100), copy, then the live-needs report since the
 * last synced commit. It never restarts the server or runner. Returns `{synced, refused?, skipped?, live, dist, pending}`.
 */
export function runSync({
  repoRoot = rootDir, env = process.env, force = false, noBuild = false, dryRun = false,
  git = defaultGit, build = defaultBuild, log = (line) => console.log(line), now = Date.now,
} = {}) {
  let head = null;
  try { head = git(repoRoot, "rev-parse", "HEAD"); } catch {}
  // `npm run build` runs vite and then this script: the dist it just wrote is the build of the current tree.
  if (!dryRun && head && env.npm_lifecycle_event === "build" && existsSync(join(repoRoot, "dist"))) {
    try { writeDistStamp(repoRoot, head, git); } catch {}
  }
  const skip = syncSkipReason(repoRoot, { force, git });
  if (skip) {
    log(`[sync-runtime] skipped: ${skip} (use --force or VIBESQUAD_SYNC_FORCE=1)`);
    return { synced: false, skipped: skip };
  }
  const runtimeDir = runtimeDirFor(env);
  if (!existsSync(runtimeDir)) return { synced: false, runtimeDir };

  const prev = readJson(join(runtimeDir, "build-stamp.json"))?.commit ?? null;
  const live = prev && head ? readLiveNeeds(repoRoot, prev, head, { git }) : { ok: false, reason: "no previous sync stamp" };
  const dist = distStatus(repoRoot, head, { git });
  const range = `${prev ? short(prev) : "?"}..${short(head) || "?"}`;

  if (dryRun) {
    log("[sync-runtime] dry run: nothing copied or built");
    report({ log, range, live, built: false, dist, pending: {}, dryRun: true });
    return { synced: false, dryRun: true, live, dist };
  }

  let built = false;
  if (dist.stale) {
    const refuse = (why) => {
      log(`[sync-runtime] refused: ${why}; the live runtime is unchanged`);
      return { synced: false, refused: why, live, dist };
    };
    if (noBuild) return refuse(`dist is stale (${dist.reason}) and --no-build was given`);
    log(`[sync-runtime] building: ${dist.reason}`);
    const b = build(repoRoot);
    if (!b?.ok) return refuse(`dist is stale (${dist.reason}) and the build failed: ${b?.error ?? "unknown error"}`);
    try { writeDistStamp(repoRoot, head, git); } catch {}
    built = true;
  }

  const res = syncRuntimeDir(repoRoot, { env });
  log(`[sync-runtime] synced ${res.runtimeDir} (${res.commit ? short(res.commit) : "no-git"})`);

  // Restart debt survives later syncs (a docs merge after a server merge) until a `vs restart` that started after it.
  const at = new Date(now()).toISOString();
  const prevFile = readJson(join(runtimeDir, LIVE_NEEDS_FILE));
  const clearedAt = lastRestartOkAt(vsHomeFor(env));
  const owed = (prevFile?.pending?.["server-restart"] ?? []).filter((e) => Date.parse(e.at) > clearedAt);
  for (const commit of live.ok ? (live.needs["server-restart"] ?? []) : []) owed.push({ commit, at });
  const pending = owed.length ? { "server-restart": owed } : {};
  try {
    writeFileSync(join(runtimeDir, LIVE_NEEDS_FILE), JSON.stringify({ at, from: prev, to: head, live, pending }, null, 2), "utf8");
  } catch {}
  report({ log, range, live, built, dist, pending });
  return { ...res, built, live, dist, pending };
}

function report({ log, range, live, built, dist, pending, dryRun = false }) {
  const needs = new Set(live.ok ? Object.keys(live.needs) : []);
  if (built || (dryRun && dist.stale)) needs.add("build").add("frontend-reload");
  if (pending["server-restart"]?.length) needs.add("server-restart");
  const parts = [...needs].sort().map((n) => {
    if (n === "build") return dryRun && dist.stale ? `build (would build: ${dist.reason})` : built ? "build (applied)" : `build (${dist.reason})`;
    if (n === "server-restart" && pending[n]?.length) return `server-restart (pending since ${pending[n][0].commit}: ${ACTION[n]})`;
    return `${n} (${ACTION[n]})`;
  });
  const head = live.ok ? `live-needs ${range}` : `live-needs ${range} (${live.reason}; only carried-over needs shown)`;
  log(`[sync-runtime] ${head}: ${parts.length ? parts.join(", ") : "none"}`);
  if (!live.ok) return;
  if (live.undeclared.length) {
    const shown = live.undeclared.slice(0, 10).map((u) => `${u.commit}=${u.inferred.join("+") || "none"}`).join(" ");
    log(`[sync-runtime] undeclared (no ${LIVE_NEEDS_TRAILER} trailer, inferred from paths): ${shown}${live.undeclared.length > 10 ? ` +${live.undeclared.length - 10} more` : ""}`);
  }
  for (const u of live.unknown) log(`[sync-runtime] unknown ${LIVE_NEEDS_TRAILER} value "${u.value}" in ${u.commit} (valid: none, ${LIVE_NEEDS.join(", ")})`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const argv = process.argv.slice(2);
  const res = runSync({
    force: argv.includes("--force") || process.env.VIBESQUAD_SYNC_FORCE === "1",
    noBuild: argv.includes("--no-build"),
    dryRun: argv.includes("--dry-run"),
  });
  if (res.refused) process.exitCode = 1;
}

