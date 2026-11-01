import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

console.log("[build:desktop] 1/4 Building web frontend (dist/)...");
execFileSync(process.platform === "win32" ? "cmd.exe" : "npm", process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd run build"] : ["run", "build"], {
  cwd: rootDir,
  env,
  stdio: "inherit",
});

/** Same closure as collectNpm() in generate-licenses.mjs: production dependencies + transitive deps/optionalDependencies. */
function productionClosure() {
  const root = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
  const find = (name, from) => {
    for (let dir = from; ; dir = dirname(dir)) {
      const candidate = join(dir, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) return candidate;
      if (dirname(dir) === dir) return null;
    }
  };
  const seen = new Map();
  const queue = Object.keys(root.dependencies ?? {}).map((name) => ({ name, from: rootDir, optional: false }));
  while (queue.length) {
    const { name, from, optional } = queue.shift();
    const dir = find(name, from);
    if (!dir) {
      if (optional) continue;
      throw new Error(`build-desktop: ${name} is not installed (run npm install)`);
    }
    if (seen.has(dir)) continue;
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    seen.set(dir, name);
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: dir, optional: false });
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) queue.push({ name: dep, from: dir, optional: true });
  }
  return [...seen.entries()].map(([dir, name]) => ({ dir, name }));
}

// Stage the self-contained runtime the installer ships: node.exe + npm, the built app, the server/CLI, and prod node_modules.
console.log("[build:desktop] 2/4 Staging runtime (src-tauri/runtime/)...");
const runtimeDir = join(rootDir, "src-tauri", "runtime");
rmSync(runtimeDir, { recursive: true, force: true });
mkdirSync(join(runtimeDir, "node_modules"), { recursive: true });
copyFileSync(process.execPath, join(runtimeDir, process.platform === "win32" ? "node.exe" : "node"));
const npmSrc = join(dirname(process.execPath), "node_modules", "npm");
if (!existsSync(join(npmSrc, "bin", "npm-cli.js"))) throw new Error(`Node's bundled npm not found at ${npmSrc}`);
cpSync(npmSrc, join(runtimeDir, "node_modules", "npm"), { recursive: true });
for (const entry of ["dist", "public", "server", "cli", "plugin"]) cpSync(join(rootDir, entry), join(runtimeDir, entry), { recursive: true });
mkdirSync(join(runtimeDir, "docs", "profiles"), { recursive: true });
copyFileSync(join(rootDir, "docs", "profiles", "DEFAULT_PACK.md"), join(runtimeDir, "docs", "profiles", "DEFAULT_PACK.md"));
copyFileSync(join(rootDir, "package.json"), join(runtimeDir, "package.json"));
copyFileSync(join(rootDir, "teams.example.json"), join(runtimeDir, "teams.example.json"));
const closure = productionClosure();
for (const { dir, name } of closure) cpSync(dir, join(runtimeDir, "node_modules", ...name.split("/")), { recursive: true });
console.log(`[build:desktop] staged runtime with ${closure.length} production packages`);

const licenseFile = join(rootDir, "public", "THIRD-PARTY-LICENSES.txt");
console.log("[build:desktop] 3/4 Building Tauri 2 NSIS installer...");
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
console.log(`[build:desktop] 4/4 Copied ${srcInstaller} -> ${destInstaller} (${sizeMb} MB)`);
