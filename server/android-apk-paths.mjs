import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Newest .apk in `dir`, or null. */
export function findApk(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".apk"));
  if (!files.length) return null;
  files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
  return join(dir, files[0]);
}

/** Gradle output APK (universal, then arm64, then aarch64 release): shared by the build script and the APK route. */
export function findBuiltApk(rootDir) {
  const out = join(rootDir, "src-tauri", "gen", "android", "app", "build", "outputs", "apk");
  for (const abi of ["universal", "arm64", "aarch64"]) {
    try {
      const apk = findApk(join(out, abi, "release"));
      if (apk) return apk;
    } catch {}
  }
  return null;
}
