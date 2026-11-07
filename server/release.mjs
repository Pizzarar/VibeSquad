import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSecret } from "./secrets.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

/**
 * Next beta version. `stableReleased(base)` says whether `v<base>` already shipped as stable: then the next
 * beta moves to the next patch (0.1.1 shipped → 0.1.2-beta.1), because semver ranks 0.1.1-beta.N *below*
 * 0.1.1 and nobody on 0.1.1 would ever be offered it (docs/PLAN_BUGS_BATCH1.md block 0d).
 */
export function computeNextBetaVersion(currentVersion, { stableReleased = () => false } = {}) {
  const clean = String(currentVersion || "0.1.1").trim().replace(/^v/, "");
  const m = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/);
  if (!m) {
    return `${clean.split("-")[0]}-beta.1`;
  }
  const base = `${m[1]}.${m[2]}.${m[3]}`;
  if (stableReleased(base)) return `${m[1]}.${m[2]}.${Number(m[3]) + 1}-beta.1`;
  const n = m[4] ? Number(m[4]) + 1 : 1;
  return `${base}-beta.${n}`;
}

/** True when tag v<base> exists on origin (a shipped stable). */
export function stableTagExists(base, cwd = rootDir) {
  try {
    return execFileSync("git", ["ls-remote", "--tags", "origin", `refs/tags/v${base}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
  } catch {
    return false;
  }
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

  const tauriAndroidConfPath = join(dir, "src-tauri", "tauri.android.conf.json");
  if (existsSync(tauriAndroidConfPath)) {
    const tauriAndroidConf = JSON.parse(readFileSync(tauriAndroidConfPath, "utf8"));
    tauriAndroidConf.version = newVersion;
    writeFileSync(tauriAndroidConfPath, JSON.stringify(tauriAndroidConf, null, 2) + "\n");
  }

  const cargoPath = join(dir, "src-tauri", "Cargo.toml");
  const cargoRaw = readFileSync(cargoPath, "utf8");
  const updatedCargo = cargoRaw.replace(/^(version\s*=\s*")[^"]+(")/m, `$1${newVersion}$2`);
  writeFileSync(cargoPath, updatedCargo);

  const crateName = cargoRaw.match(/^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms)?.[1];
  const lockPath = join(dir, "src-tauri", "Cargo.lock");
  if (crateName && existsSync(lockPath)) {
    const lockRaw = readFileSync(lockPath, "utf8");
    const escaped = crateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const entry = new RegExp(String.raw`(\[\[package\]\]\r?\nname = "${escaped}"\r?\nversion = ")[^"]+(")`);
    writeFileSync(lockPath, lockRaw.replace(entry, `$1${newVersion}$2`));
  }
}

export const COMMUNITY_ACCOLADES_020 = [
  "Implemented ability to render Mermaid diagrams in Chat & Briefs — Thanks to Mermaid by dutchakdev",
  "Implemented ability to preview images, PDFs, HTML, audio, and video in Briefs & Files — Thanks to File preview by gil-pingping, PDF viewer (PDF.js) by bendavid, and PDF and Office viewer by nkwib",
  "Implemented Sealed Secret Input (0600 temp file injection without logging secrets in chat) — Thanks to Secure Input by dutchakdev",
  "Implemented Workspace Listening Ports auto-detection & clickable pills — Thanks to Ports by zedobaia and Server Browser by zhjiang22",
  "Implemented Provider Quota Failover & 1-Click Provider Switch (Claude ↔ Gemini) — Thanks to Continuity by Chechulin Serhii, Switch provider by anh-chu, Usage Auto Resume by babo-jeonguk, and Zerosub by Kapybara",
  "Implemented CLAUDE_CODE_ENTRYPOINT=Paseo spawn environment tag — Thanks to Claude Code entrypoint by getpaseo",
  "Implemented Session Janitor to auto-archive closed worker sessions — Thanks to session-janitor by sm1ee",
  "Implemented Keep Host Awake while agents are running — Thanks to Keep Awake by Hicham Boushaba",
  "Implemented Per-hunk Diff Review, Line Quote & Code Annotations — Thanks to Annotations by neunzig-zehn, Quote by Chechulin Serhii, and Codex Style Annotations by xzthemeofsss",
  "Implemented Turn Recap & Digest Summaries — Thanks to Recap by Kingsley",
  "Built on the Paseo Daemon, CLI, and ACP Plugin Runtime — Thanks to Paseo (`@getpaseo`) by the Paseo team (getpaseo)",
];

export function defaultReleaseNotes(version, channel = "stable") {
  const cleanVer = String(version || "0.2.0").trim().replace(/^v/, "");
  return [
    `VibeSquad v${cleanVer} (${channel})`,
    "",
    "### Community Accolades & Credits",
    ...COMMUNITY_ACCOLADES_020.map((line) => `- ${line}`),
  ].join("\n");
}

export const DEFAULT_RELEASE_REPO = process.env.VIBESQUAD_RELEASE_REPO || "Pizzarar/VibeSquad";

export function buildSigningEnv(baseEnv = process.env, keyPath = "") {
  const password = baseEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "";
  return {
    ...baseEnv,
    ...(keyPath ? { TAURI_SIGNING_PRIVATE_KEY: keyPath, TAURI_SIGNING_PRIVATE_KEY_PATH: keyPath } : {}),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
  };
}

/**
 * Child env for `tauri signer sign`. The key password travels ONLY as TAURI_SIGNING_PRIVATE_KEY_PASSWORD
 * (never argv, where it would show in process listings). Single seam: a later secrets resolver swaps the
 * `password` source here.
 */
export function updaterSigningEnv(
  baseEnv = process.env,
  keyPath = "",
  deps = {},
  password = resolveSecret({ envVar: "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", target: "vibesquad/updater-key", required: false }, { env: baseEnv, ...deps }) ?? "",
) {
  const env = buildSigningEnv({ ...baseEnv, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password }, keyPath);
  delete env.TAURI_SIGNING_PRIVATE_KEY;
  return env;
}

/** argv for `tauri signer sign` (no password, see updaterSigningEnv). */
export function signerSignArgs(tauriCliJs, keyPath, installerPath) {
  return [tauriCliJs, "signer", "sign", "-f", keyPath, installerPath];
}

export function ghReleaseArgs(subcommandArgs, repo = DEFAULT_RELEASE_REPO) {
  return ["release", ...subcommandArgs, "--repo", repo];
}

export function buildLatestJson({ version, channel, signature, repo = DEFAULT_RELEASE_REPO, pubDate = new Date().toISOString(), notes }) {
  const cleanVer = String(version).trim().replace(/^v/, "");
  const tag = channel === "beta" ? "beta" : `v${cleanVer}`;
  const downloadUrl = `https://github.com/${repo}/releases/download/${tag}/VibeSquad-setup.exe`;
  return {
    version: cleanVer,
    notes: notes || defaultReleaseNotes(cleanVer, channel),
    pub_date: pubDate,
    platforms: {
      "windows-x86_64": {
        signature: String(signature || "").trim(),
        url: downloadUrl,
      },
      "android-aarch64": {
        url: `https://github.com/${repo}/releases/download/${tag}/VibeSquad.apk`,
      },
    },
  };
}

function resolveHeadCommit(exec, cwd) {
  return String(exec("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) || "").trim();
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

/** Resolve any rev to the full commit sha (`git rev-parse --verify <c>^{commit}`). */
export function canonicalizeCommit(commit, exec = execFileSync, cwd = rootDir) {
  const c = String(commit || "").trim();
  if (FULL_SHA.test(c)) return c.toLowerCase();
  let out = "";
  try {
    out = String(exec("git", ["rev-parse", "--verify", `${c}^{commit}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) || "").trim();
  } catch {
    // handled below
  }
  if (!out) throw new Error(`Cannot resolve commit "${c}" to a full sha.`);
  return out.toLowerCase();
}

function ghApiJson(path, exec, cwd) {
  return JSON.parse(String(exec("gh", ["api", path], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) || "null"));
}

/**
 * Commit the remote `repo` tag points at (annotated tags peeled), or "" when the tag does not exist (404).
 * Any other failure throws: the tag guard fails closed.
 */
export function resolveTagCommit(tag, exec, cwd, repo = DEFAULT_RELEASE_REPO) {
  let ref;
  try {
    ref = ghApiJson(`repos/${repo}/git/ref/tags/${tag}`, exec, cwd);
  } catch (err) {
    const text = `${err?.message ?? ""} ${err?.stderr ?? ""}`;
    if (/404|not found/i.test(text)) return "";
    throw new Error(`Could not look up tag ${tag} on ${repo}: ${err?.message ?? err}`);
  }
  let obj = ref?.object;
  for (let depth = 0; obj && obj.type === "tag" && depth < 5; depth++) {
    obj = ghApiJson(`repos/${repo}/git/tags/${obj.sha}`, exec, cwd)?.object;
  }
  return String(obj?.sha || "").trim();
}

function repointBetaTag(exec, cwd, sha) {
  exec("git", ["tag", "-f", "beta", sha], { cwd, stdio: "inherit" });
  exec("git", ["push", "-f", "origin", "refs/tags/beta"], { cwd, stdio: "inherit" });
}

export function publishRelease({
  channel,
  targetVersion,
  assets = [],
  latestJsonPath,
  latestManifest,
  signature,
  cwd = rootDir,
  exec = execFileSync,
  targetCommit = "",
  repo = DEFAULT_RELEASE_REPO,
  writeManifest = (filePath, manifest) => writeFileSync(filePath, JSON.stringify(manifest, null, 2) + "\n"),
}) {
  const cleanVer = String(targetVersion).trim().replace(/^v/, "");
  const effectiveManifest = latestManifest || buildLatestJson({ version: cleanVer, channel, signature });
  const tag = channel === "beta" ? "beta" : `v${cleanVer}`;
  const releaseTitle = channel === "beta" ? `VibeSquad Beta (${cleanVer})` : `VibeSquad v${cleanVer}`;

  const gh = (sub) => ghReleaseArgs(sub, repo);
  const headSha = resolveHeadCommit(exec, cwd);
  const expectedSha = targetCommit ? canonicalizeCommit(targetCommit, exec, cwd) : headSha;
  const versioned = /^v\d+\.\d+\.\d+/.test(tag);

  let tagExists = false;
  try {
    exec("gh", gh(["view", tag]), { cwd, stdio: "ignore" });
    tagExists = true;
  } catch {
    // no release yet
  }

  if (versioned) {
    // R7: never move or overwrite an existing version tag, whether or not a release object exists.
    const tagSha = resolveTagCommit(tag, exec, cwd, repo);
    if ((tagExists || tagSha) && (!expectedSha || !tagSha || tagSha !== expectedSha)) {
      throw new Error(
        `Refusing to overwrite existing versioned release tag ${tag}: tag points at ${tagSha || "<unresolved>"}, which does not match HEAD (${expectedSha || "<unresolved>"}). Bump the version or re-tag deliberately.`,
      );
    }
  }

  if (!tagExists) {
    const createArgs = gh(["create", tag, "--title", releaseTitle, "--notes", effectiveManifest.notes]);
    if (channel === "beta") createArgs.push("--prerelease");
    if (expectedSha) createArgs.push("--target", expectedSha);
    exec("gh", createArgs, { cwd, stdio: "inherit" });
  }

  if (tagExists) {
    if (tag === "beta") {
      repointBetaTag(exec, cwd, expectedSha);
    }
    exec("gh", gh(["edit", tag, "--title", releaseTitle, "--notes", effectiveManifest.notes]), { cwd, stdio: "inherit" });
  }

  exec("gh", gh(["upload", tag, ...assets, "--clobber"]), { cwd, stdio: "inherit" });
  console.log(`[release:${channel}] Published ${tag} with ${assets.length} asset(s).`);

  if (channel === "stable") {
    const betaManifest = buildLatestJson({ version: cleanVer, channel: "beta", signature });
    if (latestJsonPath) {
      writeManifest(latestJsonPath, betaManifest);
    }
    const betaTitle = `VibeSquad Beta (${cleanVer})`;
    let betaTagExists = false;
    try {
      exec("gh", gh(["view", "beta"]), { cwd, stdio: "ignore" });
      betaTagExists = true;
    } catch {
      exec("gh", [...gh(["create", "beta", "--prerelease", "--title", betaTitle, "--notes", betaManifest.notes]), ...(expectedSha ? ["--target", expectedSha] : [])], {
        cwd,
        stdio: "inherit",
      });
    }
    if (betaTagExists) {
      repointBetaTag(exec, cwd, expectedSha);
      exec("gh", gh(["edit", "beta", "--title", betaTitle, "--notes", betaManifest.notes]), {
        cwd,
        stdio: "inherit",
      });
    }
    exec("gh", gh(["upload", "beta", ...assets, "--clobber"]), { cwd, stdio: "inherit" });
    if (latestJsonPath) {
      writeManifest(latestJsonPath, effectiveManifest);
    }
    console.log(`[release:stable] Also synced rolling beta tag to v${cleanVer}.`);
  }
}


export const RELEASE_STAGES = ["stage", "build", "sign", "publish"];

export function parseArgs(argv) {
  const out = {
    stage: "",
    channel: "beta",
    version: "",
    commit: "",
    project: "VibeSquad",
    repo: "",
    requester: "",
    approval: "",
    changelog: "",
    stageOnly: false,
    unsigned: false,
    skipBuild: false,
    withAndroid: false,
  };
  const valued = { "--channel": "channel", "--version": "version", "--commit": "commit", "--project": "project", "--repo": "repo", "--requester": "requester", "--approval": "approval", "--changelog": "changelog" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (i === 0 && RELEASE_STAGES.includes(a)) out.stage = a;
    else if (valued[flag]) out[valued[flag]] = eq > 0 ? a.slice(eq + 1) : (argv[++i] ?? "");
    else if (a === "--stage-only") out.stageOnly = true;
    else if (a === "--unsigned") out.unsigned = true;
    else if (a === "--skip-build") out.skipBuild = true;
    else if (a === "--with-android") out.withAndroid = true;
  }
  out.version = out.version.replace(/^v/, "");
  return out;
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Refuse unless HEAD is the frozen commit and (optionally) no tracked file is modified. */
export function assertFrozenCommit({ commit, requireClean, exec = execFileSync, cwd = rootDir }) {
  if (!commit) throw new Error("--commit <sha> is required for this stage.");
  const want = canonicalizeCommit(commit, exec, cwd);
  const head = resolveHeadCommit(exec, cwd).toLowerCase();
  if (!head || head !== want) {
    throw new Error(`Refusing to release: HEAD is ${head || "<unresolved>"} but --commit is ${want}. Check out the frozen commit first.`);
  }
  if (requireClean) {
    // Untracked files count too (the desk builds from clean worktrees); .gitignore'd outputs such as dist-desktop do not show up.
    const dirty = String(exec("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) || "").trim();
    if (dirty) throw new Error(`Refusing to release from a dirty tree:\n${dirty}`);
  }
  return head;
}

const ANDROID_MARKER = "android-build.json";
// Written by `build --unsigned`; the sign and publish stages refuse while it exists.
export const UNSIGNED_MARKER = "UNSIGNED";
const assertSigned = (distDir, stage) => {
  if (existsSync(join(distDir, UNSIGNED_MARKER))) throw new Error(`Refusing to ${stage}: dist-desktop/${UNSIGNED_MARKER} marks an --unsigned test build. Rebuild without --unsigned.`);
};

/** The APK ships only when this version+commit built it (marker written by the build stage). */
export function selectApk({ distDir, version, commit, exists = existsSync, read = (p) => readFileSync(p, "utf8") }) {
  const apk = join(distDir, "VibeSquad.apk");
  const markerPath = join(distDir, ANDROID_MARKER);
  if (!exists(apk) || !exists(markerPath)) return null;
  try {
    const marker = JSON.parse(read(markerPath));
    return marker.version === version && marker.commit === commit ? apk : null;
  } catch {
    return null;
  }
}

export function renderReleaseRecord(template, fields) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(fields[key] ?? "_pending_"));
}

const TABLE_ROWS = { version: "Version", channel: "Channel", commit: "Commit", requester: "Requester", approval: "Approval", releaseUrl: "Release URL" };
export const SECTIONS = { changelog: "## Changelog", audit: "## Audit", artifacts: "## Artifacts (SHA-256)", signature: "## Signature verification" };

export function setSection(source, heading, body) {
  const text = source.replace(/\r\n/g, "\n");
  const start = text.indexOf(`${heading}\n`);
  if (start < 0) return source;
  const bodyStart = start + heading.length + 1;
  const next = text.indexOf("\n## ", bodyStart);
  const tail = next < 0 ? "" : `\n${text.slice(next + 1)}`;
  return `${text.slice(0, bodyStart)}\n${body}\n${tail}`;
}

/**
 * Create docs/releases/<project>-<version>.md from the template, or, when it already exists, update only the
 * fields the caller passed. Requester/Approval/Changelog and the Audit table survive later stages.
 */
export function writeReleaseRecord({ dir = rootDir, project, repo, version, channel, commit, requester, approval, changelog, releaseUrl, artifacts, signature, templatePath, outDir }) {
  const target = join(outDir || join(dir, "docs", "releases"), `${project}-${version}.md`);
  const artifactLines = artifacts?.length ? artifacts.map((a) => `- \`${a.name}\`: \`${a.sha256}\``).join("\n") : "";
  mkdirSync(resolve(target, ".."), { recursive: true });

  if (existsSync(target)) {
    let text = readFileSync(target, "utf8");
    const passed = { version, channel, commit, requester, approval, releaseUrl };
    for (const [key, value] of Object.entries(passed)) {
      if (!value) continue;
      text = text.replace(new RegExp(`^\\| ${TABLE_ROWS[key]} \\| .* \\|$`, "m"), () => `| ${TABLE_ROWS[key]} | ${value} |`);
    }
    if (changelog) text = setSection(text, SECTIONS.changelog, changelog);
    if (artifactLines) text = setSection(text, SECTIONS.artifacts, artifactLines);
    if (signature) text = setSection(text, SECTIONS.signature, signature);
    writeFileSync(target, text);
    return target;
  }

  const template = readFileSync(templatePath || join(dir, "docs", "releases", "TEMPLATE.md"), "utf8");
  writeFileSync(
    target,
    renderReleaseRecord(template, {
      project,
      repo,
      version,
      channel,
      commit,
      requester: requester || "_unknown_",
      approval: approval || "_pending_",
      changelog: changelog || "_none provided_",
      releaseUrl: releaseUrl || "_pending_",
      artifacts: artifactLines || "_pending (filled at publish)_",
      signature: signature || "_pending_",
    }),
  );
  return target;
}

export function runRelease(argv, { rootDir: root = rootDir, exec = execFileSync, env = process.env, log = console.log, resolveTauriCli = () => require.resolve("@tauri-apps/cli/tauri.js") } = {}) {
  const opts = parseArgs(argv);
  if (opts.commit) opts.commit = canonicalizeCommit(opts.commit, exec, root);
  const channel = opts.channel === "stable" ? "stable" : "beta";
  const repo = opts.repo || DEFAULT_RELEASE_REPO;
  const subcommand = Boolean(opts.stage);
  const stages = subcommand ? [opts.stage] : opts.stageOnly ? ["stage", "build", "sign"] : [...RELEASE_STAGES];
  const readConf = () => JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const distDir = join(root, "dist-desktop");
  const installerPath = join(distDir, "VibeSquad-setup.exe");
  const sigPath = `${installerPath}.sig`;
  const latestJsonPath = join(distDir, "latest.json");
  let commit = opts.commit;

  if (stages.includes("stage")) {
    const currentVersion = readConf().version || "0.1.1";
    const target = opts.version
      ? opts.version
      : channel === "beta"
        ? computeNextBetaVersion(currentVersion, { stableReleased: (base) => stableTagExists(base, root) })
        : computeStableVersion(currentVersion);
    log(`[release:${channel}] Setting version ${currentVersion} -> ${target}`);
    syncVersionFiles(root, target);
    opts.version = target;
    if (subcommand) {
      const recordCommit = commit || canonicalizeCommit(resolveHeadCommit(exec, root), exec, root);
      const record = writeReleaseRecord({ dir: root, project: opts.project, repo, version: target, channel, commit: recordCommit, requester: opts.requester, approval: opts.approval, changelog: opts.changelog });
      log(`[release:${channel}] Wrote release record ${record}`);
    }
  }

  if (!stages.some((s) => s !== "stage")) return { version: opts.version, channel };
  // Explicit build/sign/publish demand a frozen, clean commit. The legacy all-in-one run just bumped
  // version files itself, so its tree is dirty by design; it still pins to HEAD (or --commit if given).
  if (subcommand || commit) {
    commit = assertFrozenCommit({ commit, requireClean: subcommand, exec, cwd: root });
  } else {
    commit = canonicalizeCommit(resolveHeadCommit(exec, root), exec, root);
  }
  const targetVersion = readConf().version;
  if (opts.version && opts.version !== targetVersion) {
    throw new Error(`--version ${opts.version} does not match the staged version ${targetVersion}.`);
  }

  const defaultKeyPath = join(homedir(), ".tauri", "vibesquad-updater.key");
  const keyPath = env.TAURI_SIGNING_PRIVATE_KEY_PATH || defaultKeyPath;

  if (stages.includes("build") && !opts.skipBuild) {
    rmSync(join(distDir, ANDROID_MARKER), { force: true });
    const buildEnv = buildSigningEnv(env, keyPath);
    const signArgs = [];
    if (!opts.unsigned) {
      // Authenticode (tauri signCommand overlay) runs inside the build, before the minisign updater .sig below.
      try {
        exec(process.execPath, [join(root, "scripts", "sign-windows.mjs"), "--check"], { cwd: root, env, stdio: "inherit" });
      } catch {
        throw new Error("Windows signing is not set up (see the sign-windows --check output above). Fix it, or pass --unsigned for a test build.");
      }
      signArgs.push("--config", join(root, "src-tauri", "tauri.release-sign.conf.json"));
    }
    exec(process.execPath, [join(root, "server", "build-desktop.mjs"), ...signArgs], { cwd: root, env: buildEnv, stdio: "inherit" });
    // Only a successful signed build clears the marker; a failed one leaves any earlier --unsigned artifacts marked.
    if (opts.unsigned) {
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, UNSIGNED_MARKER), "build --unsigned: not Authenticode-signed; never publish\n");
    } else {
      rmSync(join(distDir, UNSIGNED_MARKER), { force: true });
    }
    if (opts.withAndroid) {
      exec(process.execPath, [join(root, "server", "build-android.mjs")], { cwd: root, env: buildEnv, stdio: "inherit" });
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, ANDROID_MARKER), JSON.stringify({ version: targetVersion, commit }, null, 2) + "\n");
    }
  }

  if (stages.includes("sign")) {
    assertSigned(distDir, "sign");
    if (!env.TAURI_SIGNING_PRIVATE_KEY && !existsSync(keyPath)) {
      throw new Error(`Signing key not found at ${keyPath}. Run 'npx tauri signer generate -w ~/.tauri/vibesquad-updater.key' first.`);
    }
    mkdirSync(distDir, { recursive: true });
    if (!existsSync(sigPath) && existsSync(installerPath)) {
      const tauriCliJs = resolveTauriCli();
      exec(process.execPath, signerSignArgs(tauriCliJs, keyPath, installerPath), { cwd: root, env: updaterSigningEnv(env, keyPath), stdio: "inherit" });
    }
    if (!existsSync(sigPath)) throw new Error(`Signature file missing at ${sigPath}`);
    const manifest = buildLatestJson({ version: targetVersion, channel, signature: readFileSync(sigPath, "utf8").trim() });
    writeFileSync(latestJsonPath, JSON.stringify(manifest, null, 2) + "\n");
    log(`[release:${channel}] Wrote signed ${latestJsonPath} for v${targetVersion}`);
  }

  if (stages.includes("publish")) {
    assertSigned(distDir, "publish");
    if (!existsSync(sigPath) || !existsSync(latestJsonPath)) throw new Error("Nothing to publish: run the sign stage first.");
    const signature = readFileSync(sigPath, "utf8").trim();
    const latestManifest = buildLatestJson({ version: targetVersion, channel, signature });
    const apk = selectApk({ distDir, version: targetVersion, commit });
    if (!apk && existsSync(join(distDir, "VibeSquad.apk"))) log(`[release:${channel}] Skipping VibeSquad.apk: not built for ${targetVersion}@${commit.slice(0, 7)}.`);
    const licenses = join(distDir, "THIRD-PARTY-LICENSES.txt");
    const assets = [installerPath, sigPath, latestJsonPath, apk, licenses].filter((p) => p && existsSync(p));
    publishRelease({ channel, targetVersion, assets, latestJsonPath, latestManifest, signature, cwd: root, exec, targetCommit: commit, repo });
    const tag = channel === "beta" ? "beta" : `v${targetVersion}`;
    if (subcommand) {
    const record = writeReleaseRecord({
      dir: root,
      project: opts.project,
      repo,
      version: targetVersion,
      channel,
      commit,
      requester: opts.requester,
      approval: opts.approval,
      changelog: opts.changelog,
      releaseUrl: `https://github.com/${repo}/releases/tag/${tag}`,
      artifacts: assets.filter((p) => !p.endsWith("latest.json")).map((p) => ({ name: p.split(/[\\/]/).pop(), sha256: sha256(p) })),
      signature: "Signature file `VibeSquad-setup.exe.sig` present and embedded in latest.json (not cryptographically re-verified by this script).",
    });
    log(`[release:${channel}] Updated release record ${record}`);
    }
  }
  return { version: targetVersion, channel, commit };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  runRelease(process.argv.slice(2));
}
