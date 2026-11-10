import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

export function syncRuntimeDir(repoRoot = rootDir) {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const runtimeDir = join(localAppData, "VibeSquad", "runtime");
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
    const vsHome = process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
    mkdirSync(vsHome, { recursive: true });
    writeFileSync(join(vsHome, "stale.json"), JSON.stringify({ stale: null }), "utf8");
  } catch {}

  return { synced: true, runtimeDir, commit: stamp?.commit ?? null };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const force = process.argv.includes("--force") || process.env.VIBESQUAD_SYNC_FORCE === "1";
  const skip = syncSkipReason(rootDir, { force });
  const res = skip ? { synced: false } : syncRuntimeDir();
  if (skip) console.log(`[sync-runtime] skipped: ${skip} (use --force or VIBESQUAD_SYNC_FORCE=1)`);
  if (res.synced) {
    console.log(`[sync-runtime] synced ${res.runtimeDir} (${res.commit ? res.commit.slice(0, 7) : "no-git"})`);
  }
}
