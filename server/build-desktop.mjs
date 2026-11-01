import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ensureTls, tlsDir } from "./auth.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const cargoBin = join(homedir(), ".cargo", "bin");
const env = {
  ...process.env,
  PATH: `${process.env.PATH || ""};${cargoBin}`,
};

const pinLocalCa = process.argv.includes("--pin-local-ca");
const certsDir = join(rootDir, "src-tauri", "certs");
mkdirSync(certsDir, { recursive: true });
const destCa = join(certsDir, "vibesquad-ca.crt");
if (pinLocalCa) {
  ensureTls();
  const srcCa = join(tlsDir(), "ca.crt");
  copyFileSync(srcCa, destCa);
  console.log(`[build:desktop] 0/3 Synced pinned Root CA ${srcCa} -> ${destCa}`);
} else {
  writeFileSync(destCa, "");
  console.log("[build:desktop] 0/3 Using runtime ~/.vibesquad/tls/ca.crt (generic public installer build; pass --pin-local-ca to embed host CA)");
}

if (process.platform === "win32") {
  try {
    execFileSync("taskkill", ["/F", "/IM", "VibeSquad.exe"], { stdio: "ignore", windowsHide: true });
  } catch {}
}

console.log("[build:desktop] 1/3 Building web frontend (dist/)...");
execFileSync(process.platform === "win32" ? "cmd.exe" : "npm", process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd run build"] : ["run", "build"], {
  cwd: rootDir,
  env,
  stdio: "inherit",
});

const licenseFile = join(rootDir, "public", "THIRD-PARTY-LICENSES.txt");
console.log("[build:desktop] 2/3 Building Tauri 2 NSIS installer...");
execFileSync(process.platform === "win32" ? "cmd.exe" : "npx", process.platform === "win32" ? ["/d", "/s", "/c", "npx.cmd tauri build --bundles nsis"] : ["tauri", "build", "--bundles", "nsis"], {
  cwd: rootDir,
  env,
  stdio: "inherit",
});

const nsisDir = join(rootDir, "src-tauri", "target", "release", "bundle", "nsis");
if (!existsSync(nsisDir)) {
  throw new Error(`NSIS bundle directory not found: ${nsisDir}`);
}
const setupExe = readdirSync(nsisDir).find((f) => f.endsWith("-setup.exe") || f.endsWith(".exe"));
if (!setupExe) {
  throw new Error(`No NSIS installer .exe found in ${nsisDir}`);
}

const srcInstaller = join(nsisDir, setupExe);
const distDesktopDir = join(rootDir, "dist-desktop");
mkdirSync(distDesktopDir, { recursive: true });
const destInstaller = join(distDesktopDir, "VibeSquad-setup.exe");
copyFileSync(srcInstaller, destInstaller);
const sizeMb = (statSync(destInstaller).size / (1024 * 1024)).toFixed(2);
if (existsSync(licenseFile)) copyFileSync(licenseFile, join(distDesktopDir, "THIRD-PARTY-LICENSES.txt"));
console.log(`[build:desktop] 3/3 Copied ${srcInstaller} -> ${destInstaller} (${sizeMb} MB)`);
