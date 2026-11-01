import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

export function computeNextBetaVersion(currentVersion) {
  const clean = String(currentVersion || "0.1.1").trim().replace(/^v/, "");
  const m = clean.match(/^(\d+\.\d+\.\d+)(?:-beta\.(\d+))?$/);
  if (!m) {
    return `${clean.split("-")[0]}-beta.1`;
  }
  const base = m[1];
  const n = m[2] ? Number(m[2]) + 1 : 1;
  return `${base}-beta.${n}`;
}

export function computeStableVersion(currentVersion, explicitVersion) {
  if (explicitVersion) {
    return String(explicitVersion).trim().replace(/^v/, "").split("-")[0];
  }
  return String(currentVersion || "0.1.1").trim().replace(/^v/, "").split("-")[0];
}

export function syncVersionFiles(dir, newVersion) {
  const pkgPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  const tauriConfPath = join(dir, "src-tauri", "tauri.conf.json");
  const tauriConf = JSON.parse(readFileSync(tauriConfPath, "utf8"));
  tauriConf.version = newVersion;
  writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n");

  const cargoPath = join(dir, "src-tauri", "Cargo.toml");
  const cargoRaw = readFileSync(cargoPath, "utf8");
  const updatedCargo = cargoRaw.replace(/^(version\s*=\s*")[^"]+(")/m, `$1${newVersion}$2`);
  writeFileSync(cargoPath, updatedCargo);
}

export function buildLatestJson({ version, channel, signature, repo = "Pizzarar/VibeSquad", pubDate = new Date().toISOString(), notes }) {
  const cleanVer = String(version).trim().replace(/^v/, "");
  const tag = channel === "beta" ? "beta" : `v${cleanVer}`;
  const downloadUrl = `https://github.com/${repo}/releases/download/${tag}/VibeSquad-setup.exe`;
  return {
    version: cleanVer,
    notes: notes || `VibeSquad v${cleanVer} (${channel})`,
    pub_date: pubDate,
    platforms: {
      "windows-x86_64": {
        signature: String(signature || "").trim(),
        url: downloadUrl,
      },
    },
  };
}

function parseArgs(argv) {
  const out = { channel: "beta", version: "", stageOnly: false, skipBuild: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--channel" && argv[i + 1]) out.channel = argv[++i];
    else if (a.startsWith("--channel=")) out.channel = a.slice("--channel=".length);
    else if (a === "--version" && argv[i + 1]) out.version = argv[++i];
    else if (a.startsWith("--version=")) out.version = a.slice("--version=".length);
    else if (a === "--stage-only") out.stageOnly = true;
    else if (a === "--skip-build") out.skipBuild = true;
  }
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const channel = opts.channel === "stable" ? "stable" : "beta";
  const tauriConf = JSON.parse(readFileSync(join(rootDir, "src-tauri", "tauri.conf.json"), "utf8"));
  const currentVersion = tauriConf.version || "0.1.1";

  const targetVersion = opts.version
    ? opts.version.replace(/^v/, "")
    : channel === "beta"
      ? computeNextBetaVersion(currentVersion)
      : computeStableVersion(currentVersion);

  console.log(`[release:${channel}] Setting version ${currentVersion} -> ${targetVersion}`);
  syncVersionFiles(rootDir, targetVersion);

  const defaultKeyPath = join(homedir(), ".tauri", "vibesquad-updater.key");
  const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || defaultKeyPath;
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !existsSync(keyPath)) {
    throw new Error(`Signing key not found at ${keyPath}. Run 'npx tauri signer generate -w ~/.tauri/vibesquad-updater.key' first.`);
  }
  const env = {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: keyPath,
    TAURI_SIGNING_PRIVATE_KEY_PATH: keyPath,
  };

  if (!opts.skipBuild) {
    execFileSync(process.execPath, [join(rootDir, "server", "build-desktop.mjs")], {
      cwd: rootDir,
      env,
      stdio: "inherit",
    });
  }

  const distDesktopDir = join(rootDir, "dist-desktop");
  mkdirSync(distDesktopDir, { recursive: true });
  const installerPath = join(distDesktopDir, "VibeSquad-setup.exe");
  const sigPath = `${installerPath}.sig`;
  if (!existsSync(sigPath) && existsSync(installerPath)) {
    const tauriCliJs = require.resolve("@tauri-apps/cli/tauri.js");
    const signEnv = { ...env, TAURI_SIGNING_PRIVATE_KEY_PATH: keyPath };
    delete signEnv.TAURI_SIGNING_PRIVATE_KEY;
    execFileSync(process.execPath, [tauriCliJs, "signer", "sign", installerPath], {
      cwd: rootDir,
      env: signEnv,
      stdio: "inherit",
    });
  }
  if (!existsSync(sigPath)) {
    throw new Error(`Signature file missing at ${sigPath}`);
  }
  const signature = readFileSync(sigPath, "utf8").trim();
  const latestManifest = buildLatestJson({ version: targetVersion, channel, signature });
  const latestJsonPath = join(distDesktopDir, "latest.json");
  writeFileSync(latestJsonPath, JSON.stringify(latestManifest, null, 2) + "\n");
  console.log(`[release:${channel}] Wrote signed ${latestJsonPath} for v${targetVersion}`);

  if (!opts.stageOnly) {
    const tag = channel === "beta" ? "beta" : `v${targetVersion}`;
    const releaseTitle = channel === "beta" ? `VibeSquad Beta (${targetVersion})` : `VibeSquad v${targetVersion}`;
    const assets = [installerPath, sigPath, latestJsonPath, join(distDesktopDir, "THIRD-PARTY-LICENSES.txt")].filter((p) => existsSync(p));
    let tagExists = false;
    try {
      execFileSync("gh", ["release", "view", tag], { cwd: rootDir, stdio: "ignore" });
      tagExists = true;
    } catch {
      const createArgs = ["release", "create", tag, "--title", releaseTitle, "--notes", latestManifest.notes];
      if (channel === "beta") createArgs.push("--prerelease");
      execFileSync("gh", createArgs, { cwd: rootDir, stdio: "inherit" });
    }
    if (tagExists) {
      execFileSync("gh", ["release", "edit", tag, "--title", releaseTitle, "--notes", latestManifest.notes], { cwd: rootDir, stdio: "inherit" });
    }
    execFileSync("gh", ["release", "upload", tag, ...assets, "--clobber"], { cwd: rootDir, stdio: "inherit" });
    console.log(`[release:${channel}] Published ${tag} with ${assets.length} asset(s).`);
  }
}
