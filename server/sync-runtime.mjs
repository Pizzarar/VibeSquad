import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "..");

export function syncRuntimeDir(repoRoot = rootDir) {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const runtimeDir = join(localAppData, "VibeSquad", "runtime");
  if (!existsSync(runtimeDir)) return { synced: false, runtimeDir };

  for (const entry of ["dist", "public", "server", "cli", "plugin"]) {
    const src = join(repoRoot, entry);
    if (!existsSync(src)) continue;
    try {
      cpSync(src, join(runtimeDir, entry), { recursive: true, force: true });
    } catch {
      // ignore locked files
    }
  }

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
  const res = syncRuntimeDir();
  if (res.synced) {
    console.log(`[sync-runtime] synced ${res.runtimeDir} (${res.commit ? res.commit.slice(0, 7) : "no-git"})`);
  }
}
