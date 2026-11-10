import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { withFileLockSync } from "./file-lock.mjs";

const rootDir = resolve(import.meta.dirname, "..");

/** Tracked files the build itself rewrites (`npm run build` runs generate-licenses first): never "dirty" for the guard. */
const GENERATED = new Set(["public/THIRD-PARTY-LICENSES.txt"]);

/** Paths changed vs HEAD (staged or not, renames as delete+add), plus untracked non-ignored files when asked. */
function statusPaths(repoRoot, git, untracked) {
  const split = (out) => out.split("\0").map((p) => p.trim()).filter(Boolean);
  const paths = split(git(repoRoot, "diff", "--name-only", "--no-renames", "-z", "HEAD"));
  if (untracked === "all") paths.push(...split(git(repoRoot, "ls-files", "-z", "--others", "--exclude-standard")));
  return paths;
}

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
    if (statusPaths(repoRoot, git, "no").some((p) => !GENERATED.has(p))) return "working tree not clean";
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
const firstLine = (err) => String(err?.message ?? err).split("\n")[0];

const RUNTIME_ENTRIES = ["dist", "public", "server", "cli", "runner"];

/** Every file under `dir`, as `/`-separated paths relative to it. */
function listFiles(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, out);
    else out.push(relative(base, p).replace(/\\/g, "/"));
  }
  return out;
}

/**
 * Copy the repo's runtime entries into the live runtime without ever leaving it half-updated: stage the copy beside it,
 * verify the staged sizes, then swap file by file with rename (each replaced file kept in a backup dir). Any failure rolls
 * the swapped files back, leaves build-stamp.json at the old commit and returns `{synced: false, error}`.
 * `ops.rename` is injectable for tests.
 */
export function syncRuntimeDir(repoRoot = rootDir, { env = process.env, ops = {} } = {}) {
  const rename = ops.rename ?? renameSync;
  const runtimeDir = runtimeDirFor(env);
  if (!existsSync(runtimeDir)) return { synced: false, runtimeDir };

  const stage = join(runtimeDir, `.sync-stage-${process.pid}`);
  const backup = join(runtimeDir, `.sync-backup-${process.pid}`);
  const clean = () => { for (const d of [stage, backup]) rmSync(d, { recursive: true, force: true }); };
  clean();
  try {
    for (const entry of RUNTIME_ENTRIES) {
      const src = join(repoRoot, entry);
      if (existsSync(src)) cpSync(src, join(stage, entry), { recursive: true });
    }
    // `vs restart` launches this self-contained script; the runtime copy of cli/ needs it beside it.
    const restartScript = join(repoRoot, "scripts", "restart-runtime.mjs");
    if (existsSync(restartScript)) {
      mkdirSync(join(stage, "scripts"), { recursive: true });
      copyFileSync(restartScript, join(stage, "scripts", "restart-runtime.mjs"));
    }
    const files = existsSync(stage) ? listFiles(stage).sort() : [];
    for (const rel of files) {
      if (statSync(join(stage, rel)).size !== statSync(join(repoRoot, rel)).size) throw new Error(`staged ${rel} does not match the repo copy`);
    }
    const done = [];
    try {
      for (const rel of files) {
        const dest = join(runtimeDir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        const had = existsSync(dest);
        if (had) {
          mkdirSync(dirname(join(backup, rel)), { recursive: true });
          rename(dest, join(backup, rel));
        }
        const step = { rel, had, placed: false };
        done.push(step);
        rename(join(stage, rel), dest);
        step.placed = true;
      }
    } catch (err) {
      for (const { rel, had, placed } of done.reverse()) {
        try {
          if (placed) rmSync(join(runtimeDir, rel), { force: true });
          if (had) renameSync(join(backup, rel), join(runtimeDir, rel));
        } catch {}
      }
      throw err;
    }
  } catch (err) {
    clean();
    return { synced: false, runtimeDir, error: `copy failed, the live runtime was kept: ${firstLine(err)}` };
  }
  clean();

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
/** Commit + UI working-tree fingerprint the repo dist/ was built from, written by this script after vite ran. */
export const DIST_STAMP = ".vs-build.json";
const LIVE_NEEDS_FILE = "live-needs.json"; // in the runtime dir: restart debt carried until a successful `vs restart`
const UNKNOWN_BASELINE = "unknown-baseline";

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
const CODE_RE = /\.[cm]?[jt]sx?$/;
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.\.?\/[^"']+)["']/g;

/**
 * Seed files under `dirs` (code, not tests, not `skip`) plus everything they reach by relative import, as repo paths.
 * Static and literal dynamic imports only; the directory prefixes in inferLiveNeeds still cover a seed dir wholesale.
 */
function importClosure(repoRoot, dirs, skip = new Set()) {
  const found = new Set();
  const queue = [];
  const add = (rel) => {
    if (found.has(rel)) return;
    found.add(rel);
    queue.push(rel);
  };
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(join(repoRoot, dir), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(rel); }
      else if (CODE_RE.test(e.name) && !isTestFile(rel) && !skip.has(rel)) add(rel);
    }
  };
  for (const d of dirs) walk(d);
  while (queue.length) {
    const rel = queue.shift();
    let text;
    try { text = readFileSync(join(repoRoot, rel), "utf8"); } catch { continue; }
    for (const m of text.matchAll(IMPORT_RE)) {
      const to = relative(repoRoot, resolve(repoRoot, dirname(rel), m[1])).replace(/\\/g, "/");
      if (!to.startsWith("..")) add(to);
    }
  }
  return found;
}

/** What each long-lived piece loads: the UI bundle (src/), the server process (server/), the runner process (runner/). */
export function importGraph(repoRoot) {
  return {
    ui: importClosure(repoRoot, ["src"]),
    server: importClosure(repoRoot, ["server"], SERVER_SCRIPTS),
    runner: importClosure(repoRoot, ["runner"]),
  };
}

const isUiInput = (p, graph) => !isTestFile(p) && (p.startsWith("src/") || p.startsWith("public/") || UI_FILES.has(p) || !!graph?.ui?.has(p));

/** Fallback for an undeclared merge: what its changed paths need, by directory and by the import graph (importGraph). */
export function inferLiveNeeds(paths, graph = {}) {
  const out = new Set();
  for (const p of paths) {
    if (isTestFile(p)) continue;
    if (isUiInput(p, graph)) out.add("build").add("frontend-reload");
    if (p === "package.json" || p === "package-lock.json" || (p.startsWith("server/") && !SERVER_SCRIPTS.has(p)) || graph.server?.has(p)) out.add("server-restart");
    if (p.startsWith("runner/") || graph.runner?.has(p)) out.add("runner-restart");
  }
  return [...out].sort();
}

/**
 * The live needs of every first-parent commit in from..to (the merges, plus any direct commit to master), oldest first.
 * A valid trailer is authoritative for that merge. An undeclared merge is inferred from its diff against the first parent;
 * a trailer with an unknown token gets its valid tokens plus the inference. `needs[need]` lists the short commits that
 * need it; `buildCommits` lists every commit whose paths touch a UI input or that declares build (a rebuild is cheap
 * and safe, so the paths count even when the declaration says none). `{ok: false}` when from is not an ancestor of to.
 */
export function readLiveNeeds(repoRoot, from, to = "HEAD", { git = defaultGit, graph = importGraph(repoRoot) } = {}) {
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
    const inferred = inferLiveNeeds(paths, graph);
    const declared = trailer.trim() ? parseLiveNeeds(trailer) : null;
    for (const value of declared?.unknown ?? []) unknown.push({ commit, value });
    const valid = declared && !declared.unknown.length;
    const got = valid ? declared.needs : [...new Set([...(declared?.needs ?? []), ...inferred])].sort();
    if (!valid) undeclared.push({ commit, inferred });
    for (const n of got) (needs[n] ??= []).push(commit);
    if (got.includes("build") || inferred.includes("build")) buildCommits.push(commit);
  }
  return { ok: true, commits: chunks.length, needs, undeclared, unknown, buildCommits };
}

/**
 * Live needs since the last synced commit, never silently empty. prev..head when prev is an ancestor; after a rebase or
 * force-push, the merge-base..head merges plus whatever the prev..head diff implies (code rolled back is a change too);
 * with no usable baseline (missing/corrupt stamp, prev not in this repo), assume server-restart + runner-restart.
 */
export function liveNeedsSince(repoRoot, prev, head, { git = defaultGit, graph = importGraph(repoRoot) } = {}) {
  const conservative = (why) => ({
    ok: true, commits: 0, undeclared: [], unknown: [], buildCommits: [],
    needs: { "runner-restart": [UNKNOWN_BASELINE], "server-restart": [UNKNOWN_BASELINE] },
    note: `${why}: assuming server-restart + runner-restart`,
  });
  if (!prev || !head) return conservative("no readable previous sync stamp");
  const direct = readLiveNeeds(repoRoot, prev, head, { git, graph });
  if (direct.ok) return direct;
  let base;
  let paths;
  try {
    base = git(repoRoot, "merge-base", prev, head);
    paths = git(repoRoot, "diff", "--name-only", prev, head).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return conservative(`previous sync ${short(prev)} is not in this repo's history`);
  }
  const r = readLiveNeeds(repoRoot, base, head, { git, graph });
  if (!r.ok) return conservative(`previous sync ${short(prev)} has no merge-base with HEAD`);
  const label = `${short(prev)}..${short(head)}`;
  const diffNeeds = inferLiveNeeds(paths, graph);
  for (const n of diffNeeds) (r.needs[n] ??= []).push(label);
  if (diffNeeds.includes("build")) r.buildCommits.push(label);
  return { ...r, note: `previous sync ${short(prev)} is not an ancestor of HEAD (rebase/force-push): read from merge-base ${short(base)} plus the ${label} diff` };
}

/** Hash of the uncommitted UI inputs (tracked edits and untracked files); "" when the UI part of the tree is clean. */
function uiTreeFingerprint(repoRoot, git, graph) {
  const paths = statusPaths(repoRoot, git, "all").filter((p) => isUiInput(p, graph)).sort();
  if (!paths.length) return "";
  const h = createHash("sha256");
  for (const p of paths) {
    h.update(`${p}\0`);
    try { h.update(readFileSync(join(repoRoot, p))); } catch { h.update("<deleted>"); }
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * Is the repo dist/ the build of the current tree? Stale when there is no stamp, UI inputs changed in commits since the
 * stamp, or the uncommitted UI inputs differ from the ones the stamped build saw (so a dirty build is rebuilt only once).
 */
export function distStatus(repoRoot, head, { git = defaultGit, graph = importGraph(repoRoot) } = {}) {
  if (!existsSync(join(repoRoot, "src"))) return { stale: false, reason: "no frontend sources" };
  if (!head) return { stale: false, reason: "no git HEAD to compare (forced)" };
  if (!existsSync(join(repoRoot, "dist"))) return { stale: true, reason: "dist/ is missing" };
  const stamp = readJson(join(repoRoot, "dist", DIST_STAMP));
  if (typeof stamp?.commit !== "string") return { stale: true, reason: `dist/ has no ${DIST_STAMP} (built outside npm run build / sync)` };
  let ui;
  try { ui = uiTreeFingerprint(repoRoot, git, graph); } catch (err) { return { stale: true, reason: `cannot read the working tree (${firstLine(err)})` }; }
  if ((stamp.ui ?? "") !== ui) return { stale: true, reason: `uncommitted UI inputs differ from the ones dist/ was built with` };
  if (stamp.commit === head) return { stale: false, reason: `dist/ built at HEAD ${short(head)}` };
  const r = readLiveNeeds(repoRoot, stamp.commit, head, { git, graph });
  if (!r.ok) return { stale: true, reason: `dist/ stamp ${short(stamp.commit)} is not in HEAD's history` };
  if (r.buildCommits.length) return { stale: true, reason: `dist/ built at ${short(stamp.commit)}, UI inputs changed in ${r.buildCommits.join(" ")}` };
  return { stale: false, reason: `no UI input changed since dist/ was built at ${short(stamp.commit)}` };
}

function writeDistStamp(repoRoot, head, git, graph) {
  const dirty = statusPaths(repoRoot, git, "no").some((p) => !GENERATED.has(p));
  const ui = uiTreeFingerprint(repoRoot, git, graph);
  writeFileSync(join(repoRoot, "dist", DIST_STAMP), JSON.stringify({ commit: head, dirty, ui, builtAt: new Date().toISOString() }), "utf8");
}

/** The frontend half of `npm run build` (vite only: no tsc, no licenses). Never calls sync. `exec`/`exists` for tests. */
export function viteBuild(repoRoot, { exec = execFileSync, exists = existsSync } = {}) {
  const vite = join(repoRoot, "node_modules", "vite", "bin", "vite.js");
  if (!exists(vite)) return { ok: false, error: `vite is not installed (${vite}); run npm install, then npm run build` };
  try {
    exec(process.execPath, [vite, "build"], { cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 10 * 60_000, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true };
  } catch (err) {
    const lines = [err?.stderr, err?.stdout].flatMap((s) => String(s ?? "").split("\n")).map((l) => l.trim()).filter(Boolean);
    const line = lines.findLast((l) => /error/i.test(l)) ?? lines.at(-1) ?? firstLine(err);
    return { ok: false, error: `vite build failed: ${line}` };
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

/** Server-restart debt: earlier entries not yet covered by a successful restart, plus this range's. */
function restartDebt(runtimeDir, env, live, at) {
  const clearedAt = lastRestartOkAt(vsHomeFor(env));
  const owed = (readJson(join(runtimeDir, LIVE_NEEDS_FILE))?.pending?.["server-restart"] ?? []).filter((e) => Date.parse(e.at) > clearedAt);
  for (const commit of live.needs["server-restart"] ?? []) owed.push({ commit, at });
  return owed.length ? { "server-restart": owed } : {};
}

const ACTION = {
  "server-restart": "not restarted by sync; the Overlord picks the window: vs restart --dry-run, then vs restart",
  "runner-restart": "the runner supervisor (RR1) restarts it once idle; vs restart also covers it",
  "frontend-reload": "reload open VibeSquad windows (Ctrl+R)",
};

/**
 * The sync entry point: git guard, runtime lock, dist freshness (rebuild or refuse, idea-100), staged copy, then the
 * live-needs report since the last synced commit. It never restarts the server or runner.
 * Returns `{synced, refused?, skipped?, live, dist, pending}`.
 */
export function runSync({
  repoRoot = rootDir, env = process.env, force = false, noBuild = false, dryRun = false, lockTimeoutMs = 5000,
  git = defaultGit, build = viteBuild, log = (line) => console.log(line), now = Date.now,
} = {}) {
  let head = null;
  try { head = git(repoRoot, "rev-parse", "HEAD"); } catch {}
  const graph = importGraph(repoRoot);
  // `npm run build` runs vite and then this script: the dist it just wrote is the build of the current tree.
  if (!dryRun && head && env.npm_lifecycle_event === "build" && existsSync(join(repoRoot, "dist"))) {
    try { writeDistStamp(repoRoot, head, git, graph); } catch {}
  }
  const skip = syncSkipReason(repoRoot, { force, git });
  if (skip) {
    log(`[sync-runtime] skipped: ${skip} (use --force or VIBESQUAD_SYNC_FORCE=1)`);
    return { synced: false, skipped: skip };
  }
  const runtimeDir = runtimeDirFor(env);
  if (!existsSync(runtimeDir)) return { synced: false, runtimeDir };
  const refuse = (why, extra = {}) => {
    log(`[sync-runtime] refused: ${why}; the live runtime is unchanged`);
    return { synced: false, refused: why, ...extra };
  };

  const body = () => {
    const prev = readJson(join(runtimeDir, "build-stamp.json"))?.commit ?? null;
    const live = liveNeedsSince(repoRoot, typeof prev === "string" ? prev : null, head, { git, graph });
    const dist = distStatus(repoRoot, head, { git, graph });
    const range = `${typeof prev === "string" ? short(prev) : "?"}..${short(head) || "?"}`;
    const at = new Date(now()).toISOString();

    if (dryRun) {
      log("[sync-runtime] dry run: nothing copied or built");
      const pending = restartDebt(runtimeDir, env, live, at);
      report({ log, range, live, built: false, dist, pending, dryRun: true });
      return { synced: false, dryRun: true, live, dist, pending };
    }

    let built = false;
    if (dist.stale) {
      if (noBuild) return refuse(`dist is stale (${dist.reason}) and --no-build was given`, { live, dist });
      log(`[sync-runtime] building: ${dist.reason}`);
      const b = build(repoRoot);
      if (!b?.ok) return refuse(`dist is stale (${dist.reason}) and the build failed: ${b?.error ?? "unknown error"}`, { live, dist });
      try { writeDistStamp(repoRoot, head, git, graph); } catch {}
      built = true;
    }

    const res = syncRuntimeDir(repoRoot, { env });
    if (!res.synced) return refuse(`${res.error ?? "copy failed"}; build-stamp.json not advanced`, { live, dist });
    log(`[sync-runtime] synced ${res.runtimeDir} (${res.commit ? short(res.commit) : "no-git"})`);

    // Restart debt survives later syncs (a docs merge after a server merge) until a `vs restart` that started after it.
    const pending = restartDebt(runtimeDir, env, live, at);
    try {
      writeFileSync(join(runtimeDir, LIVE_NEEDS_FILE), JSON.stringify({ at, from: prev, to: head, live, pending }, null, 2), "utf8");
    } catch {}
    report({ log, range, live, built, dist, pending });
    return { ...res, built, live, dist, pending };
  };

  if (dryRun) return body();
  let entered = false;
  try {
    // staleMs outlasts a vite build; a dead holder is still taken over at once (pid liveness).
    return withFileLockSync(join(runtimeDir, "sync"), () => { entered = true; return body(); }, { timeoutMs: lockTimeoutMs, staleMs: 20 * 60_000 });
  } catch (err) {
    if (entered) throw err;
    return refuse(`another sync holds the runtime lock (${firstLine(err)})`);
  }
}

function report({ log, range, live, built, dist, pending, dryRun = false }) {
  const needs = new Set(Object.keys(live.needs));
  if (built || (dryRun && dist.stale)) needs.add("build").add("frontend-reload");
  if (pending["server-restart"]?.length) needs.add("server-restart");
  const parts = [...needs].sort().map((n) => {
    if (n === "build") return dryRun && dist.stale ? `build (would build: ${dist.reason})` : built ? "build (applied)" : `build (${dist.reason})`;
    if (n === "server-restart" && pending[n]?.length) return `server-restart (pending since ${pending[n][0].commit}: ${ACTION[n]})`;
    return `${n} (${ACTION[n]})`;
  });
  log(`[sync-runtime] live-needs ${range}: ${parts.length ? parts.join(", ") : "none"}`);
  if (live.note) log(`[sync-runtime] note: ${live.note}`);
  if (live.undeclared.length) {
    const shown = live.undeclared.slice(0, 10).map((u) => `${u.commit}=${u.inferred.join("+") || "none"}`).join(" ");
    log(`[sync-runtime] undeclared (no valid ${LIVE_NEEDS_TRAILER} trailer, inferred from paths): ${shown}${live.undeclared.length > 10 ? ` +${live.undeclared.length - 10} more` : ""}`);
  }
  for (const u of live.unknown) log(`[sync-runtime] unknown ${LIVE_NEEDS_TRAILER} value "${u.value}" in ${u.commit} (valid: none, ${LIVE_NEEDS.join(", ")})`);
}

const FLAGS = ["--force", "--no-build", "--dry-run"];

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const argv = process.argv.slice(2);
  const bad = argv.find((a) => !FLAGS.includes(a));
  if (bad !== undefined) {
    console.error(`[sync-runtime] unknown flag ${bad} (known: ${FLAGS.join(" ")})`);
    process.exitCode = 2;
  } else {
    const res = runSync({
      force: argv.includes("--force") || process.env.VIBESQUAD_SYNC_FORCE === "1",
      noBuild: argv.includes("--no-build"),
      dryRun: argv.includes("--dry-run"),
    });
    if (res.refused) process.exitCode = 1;
  }
}
