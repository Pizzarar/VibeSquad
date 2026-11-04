// First-run checklist: detects Paseo / Claude Code / Gemini / git, reuses an existing Paseo (and its daemon),
// and otherwise installs the pinned @getpaseo/cli into a VibeSquad-managed prefix using the bundled node + npm.
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { readJsonFileWithBom } from "./user-settings.mjs";
import {
  checkStartedDaemonProviders,
  envWithWindowsHidePreload,
  getPaseoHome,
  markDaemonManagedByVibeSquad,
  readPaseoPid,
  readRawPaseoConfig,
  withWindowsHideNodeOptions,
} from "./paseo-control.mjs";
import { getDaemonAuthStatus } from "./daemon-password.mjs";

export const PINNED_PASEO_VERSION = "0.14.0";
const IS_WIN = process.platform === "win32";

export const vibesquadHome = () => process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");

export function managedPaseoPrefix() {
  if (process.env.VIBESQUAD_PASEO_PREFIX) return process.env.VIBESQUAD_PASEO_PREFIX;
  if (IS_WIN && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "com.vibesquad.desktop", "paseo");
  return join(vibesquadHome(), "paseo");
}

/** The node.exe that runs us when bundled; falls back to the current interpreter. */
export const bundledNode = () => process.env.VIBESQUAD_BUNDLED_NODE || process.execPath;

function bundledNpmCli() {
  const candidates = [];
  if (process.env.VIBESQUAD_RUNTIME_DIR) candidates.push(join(process.env.VIBESQUAD_RUNTIME_DIR, "node_modules", "npm", "bin", "npm-cli.js"));
  candidates.push(join(dirname(bundledNode()), "node_modules", "npm", "bin", "npm-cli.js"));
  return candidates.find((c) => existsSync(c)) ?? null;
}

const readJson = (file) => readJsonFileWithBom(file, { fallback: null, rewriteIfBom: false }).value;

function onPath(names, env = process.env) {
  const dirs = String(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) for (const n of names) if (existsSync(join(dir, n))) return join(dir, n);
  return null;
}

function resolvePaseoPackage(prefix) {
  // npm --prefix on Windows puts node_modules directly under the prefix; elsewhere it is the same for --prefix installs.
  const pkgDir = join(prefix, "node_modules", "@getpaseo", "cli");
  const pkg = readJson(join(pkgDir, "package.json"));
  if (!pkg) return null;
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.paseo;
  const candidates = [join(pkgDir, "bin", "paseo"), rel ? join(pkgDir, rel) : ""].filter(Boolean);
  const bin = candidates.find((c) => existsSync(c));
  return bin ? { bin, version: pkg.version ?? null } : null;
}

/** Locate an installed Paseo CLI: the user's own wins, then the VibeSquad-managed one. */
export function findPaseoCli(opts = {}) {
  const env = opts.env ?? process.env;
  const appData = env.APPDATA;
  const globalPrefixes = [];
  if (appData) globalPrefixes.push(join(appData, "npm"));
  if (!IS_WIN) globalPrefixes.push("/usr/local", "/usr");
  for (const prefix of globalPrefixes) {
    const pkgDir = IS_WIN ? join(prefix, "node_modules", "@getpaseo", "cli") : join(prefix, "lib", "node_modules", "@getpaseo", "cli");
    const pkg = readJson(join(pkgDir, "package.json"));
    const bin = join(pkgDir, "bin", "paseo");
    if (pkg && existsSync(bin)) return { source: "existing", kind: "node", bin, version: pkg.version ?? null };
    const cmd = join(prefix, "paseo.cmd");
    if (IS_WIN && existsSync(cmd)) return { source: "existing", kind: "cmd", bin: cmd, version: pkg?.version ?? null };
  }
  const pathHit = onPath(IS_WIN ? ["paseo.cmd", "paseo.exe"] : ["paseo"], env);
  if (pathHit) return { source: "existing", kind: IS_WIN && pathHit.endsWith(".cmd") ? "cmd" : "exe", bin: pathHit, version: null };
  const managed = resolvePaseoPackage(opts.prefix ?? managedPaseoPrefix());
  if (managed) return { source: "managed", kind: "node", ...managed };
  return null;
}

// npm cmd-shim line: `"%_prog%" [--node-flag ...] "%dp0%\node_modules\...\bin\paseo" %*`.
const CMD_SHIM_ENTRY_RE = /"%_prog%"((?:\s+--[A-Za-z0-9-]+(?:=[A-Za-z0-9,_-]+)?)*)\s+"%dp0%\\([^"%]+)"\s+%\*/;

// cmd.exe fallback only: every arg is double-quoted, but refuse anything that could still break out or expand,
// plus a trailing backslash (it would escape the closing quote for the CLI's own argv parser).
export const UNSAFE_CMD_ARG = /["&|<>^%!\r\n\0]|\\$/;

/** Resolves an npm `.cmd` shim to `{ script, nodeArgs }` so callers can run node directly instead of cmd.exe. Null when unrecognised. */
export function resolveCmdShimEntry(shimPath, readFile = (p) => readFileSync(p, "utf8")) {
  let text;
  try {
    text = String(readFile(shimPath));
  } catch {
    return null;
  }
  const m = text.match(CMD_SHIM_ENTRY_RE);
  if (!m) return null;
  const shimDir = resolve(dirname(shimPath));
  const script = resolve(shimDir, m[2]);
  const prefix = shimDir.endsWith(sep) ? shimDir : shimDir + sep;
  if (!(IS_WIN ? script.toLowerCase().startsWith(prefix.toLowerCase()) : script.startsWith(prefix))) return null;
  const nodeArgs = m[1].trim() ? m[1].trim().split(/\s+/) : [];
  return { script, nodeArgs };
}

export function parseListen(listen) {
  const [host, port] = String(listen || "127.0.0.1:6767").replace(/^wss?:\/\//, "").split(/:(?=\d+$)/);
  return { host: host || "127.0.0.1", port: Number(port) || 6767 };
}

export function readPaseoListen() {
  const { config } = readRawPaseoConfig();
  const listen = config?.daemon?.listen ?? "127.0.0.1:6767";
  return process.env.PASEO_DAEMON ?? listen;
}

/** True when something accepts TCP connections on the daemon address (1000ms budget). */
export function isDaemonListening(listen = readPaseoListen(), timeoutMs = 1000) {
  const { host, port } = parseListen(listen);
  return new Promise((ok) => {
    const sock = connect(port, host);
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      ok(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.once("timeout", () => done(false));
  });
}

/** Reuse a running daemon; otherwise start the installed Paseo's. Never launches a second daemon. */
export async function ensurePaseoDaemon(opts = {}) {
  const listening = opts.isListening ?? opts._probe ?? isDaemonListening;
  const listenAddr = opts.listen ?? readPaseoListen();
  if (await listening(listenAddr)) return { started: false, reason: "already-running" };
  const cli = opts.cli ?? findPaseoCli(opts);
  if (!cli) return { started: false, reason: "not-installed" };
  const spawnFn = opts._spawn ?? opts.spawn ?? spawn;
  const node = bundledNode();
  const paseoHome = getPaseoHome(opts);
  const baseEnv = opts.env || process.env;
  const env = envWithWindowsHidePreload({
    ...process.env,
    ...baseEnv,
    PASEO_HOME: paseoHome,
    PATH: `${dirname(node)}${delimiter}${baseEnv.PATH ?? baseEnv.Path ?? process.env.PATH ?? ""}`,
  });
  const spawnOpts = {
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
    env,
  };
  // Same rule as runPaseoCli: prefer the shim's node entry; on the cmd.exe fallback cli.bin must pass UNSAFE_CMD_ARG.
  const entry = cli.kind === "cmd" ? (opts.resolveCmdShim ?? resolveCmdShimEntry)(cli.bin) : null;
  if (cli.kind === "cmd" && !entry && UNSAFE_CMD_ARG.test(String(cli.bin))) {
    return { started: false, reason: "refusing a Paseo CLI path with shell metacharacters" };
  }
  const extraCliArgs = Array.isArray(cli.args) && cli.args.length > 0 ? cli.args : [];
  const startArgs = opts.resolveCmdShim
    ? [...extraCliArgs, "start"]
    : [...extraCliArgs, "--home", paseoHome, "daemon", "start"];
  try {
    const child =
      cli.kind === "node"
        ? spawnFn(node, [cli.bin, ...startArgs], spawnOpts)
        : entry
          ? spawnFn(node, [...entry.nodeArgs, entry.script, ...startArgs], spawnOpts)
          : cli.kind === "cmd"
            ? opts.resolveCmdShim
              ? spawnFn("cmd.exe", ["/d", "/s", "/c", `""${cli.bin}" start"`], { ...spawnOpts, windowsVerbatimArguments: true })
              : spawnFn(
                  "cmd.exe",
                  ["/d", "/s", "/c", `"${[cli.bin, ...startArgs].map((a) => `"${a}"`).join(" ")}"`],
                  { ...spawnOpts, windowsVerbatimArguments: true },
                )
            : spawnFn(cli.bin, startArgs, spawnOpts);
    child?.on?.("error", () => {});
    child?.unref?.();
    markDaemonManagedByVibeSquad(readPaseoPid(opts) || child?.pid || "managed", opts);

    const hasMockSpawnOrProbe = Boolean(opts._spawn || opts.spawn || opts._probe || opts.isListening);
    const waitMs = opts.waitMs ?? opts.timeoutMs ?? (hasMockSpawnOrProbe ? 20 : 8000);
    const pollMs = opts.pollMs ?? (hasMockSpawnOrProbe ? 5 : 200);
    const deadline = Date.now() + Math.max(0, waitMs);
    let socketReady = false;
    while (true) {
      if (await listening(listenAddr)) {
        socketReady = true;
        break;
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }

    const daemonPid = readPaseoPid(opts) || child?.pid;
    markDaemonManagedByVibeSquad(daemonPid || "managed", opts);

    const hasCliRunner =
      typeof opts._runCli === "function" ||
      typeof opts.runCli === "function" ||
      typeof opts.cliRunner === "function";
    const shouldCheckProviders =
      opts.checkProviders !== false && (hasCliRunner || (!hasMockSpawnOrProbe && socketReady));
    if (shouldCheckProviders) {
      const { providerWarning, erroredProviders } = await checkStartedDaemonProviders(opts);
      return {
        started: true,
        source: cli.source,
        providerWarning: providerWarning || null,
        erroredProviders: erroredProviders || [],
      };
    }
    return { started: true, source: cli.source };
  } catch (e) {
    return { started: false, reason: String(e?.message ?? e) };
  }
}

// ── install state (one install at a time per process) ─────────────────────────────────────────────
const state = { installing: false, progress: "", error: null, durationMs: null, installedOk: false };
export function resetFirstRunState() {
  Object.assign(state, { installing: false, progress: "", error: null, durationMs: null, installedOk: false });
}

function versionOf(cmd, args) {
  return new Promise((ok) => {
    try {
      execFile(cmd, args, { timeout: 2500, windowsHide: true, shell: IS_WIN && /\.(cmd|bat)$/i.test(cmd) }, (err, out) => {
        const m = !err && String(out).match(/\d+\.\d+\.\d+/);
        ok(m ? m[0] : null);
      });
    } catch {
      ok(null);
    }
  });
}

const home = () => process.env.USERPROFILE || homedir();

function findClaude(env) {
  const hits = [
    onPath(IS_WIN ? ["claude.exe", "claude.cmd"] : ["claude"], env),
    env.APPDATA && join(env.APPDATA, "npm", "claude.cmd"),
    join(home(), ".local", "bin", IS_WIN ? "claude.exe" : "claude"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "claude", "claude.exe"),
  ].filter(Boolean);
  return hits.find((h) => existsSync(h)) ?? null;
}

function findGemini(env) {
  const names = IS_WIN ? ["agy.exe", "agy.cmd", "antigravity.cmd", "antigravity.exe", "gemini.cmd", "gemini.exe"] : ["agy", "antigravity", "gemini"];
  const hit = onPath(names, env);
  if (hit) return hit;
  if (env.APPDATA) for (const n of ["agy.cmd", "antigravity.cmd", "gemini.cmd"]) if (existsSync(join(env.APPDATA, "npm", n))) return join(env.APPDATA, "npm", n);
  const dir = join(home(), ".gemini", "antigravity-cli");
  return existsSync(dir) ? dir : null;
}

export async function inspectFirstRunStatus(opts = {}) {
  const env = opts.env ?? process.env;
  const cli = opts.cli !== undefined ? opts.cli : findPaseoCli(opts);
  const running = await (opts.isListening ?? isDaemonListening)(opts.listen ?? readPaseoListen());
  const probe = opts.probeVersions !== false;
  const installedByUs = state.installedOk && !cli;
  const installed = Boolean(cli) || installedByUs;
  const source = cli ? cli.source : installedByUs ? "managed" : running ? "existing" : "none";

  const claudeBin = findClaude(env);
  const geminiBin = findGemini(env);
  const gitBin = onPath(IS_WIN ? ["git.exe", "git.cmd"] : ["git"], env);
  const [claudeV, geminiV, gitV] = await Promise.all([
    probe && claudeBin && !claudeBin.endsWith("antigravity-cli") ? versionOf(claudeBin, ["--version"]) : null,
    probe && geminiBin && !geminiBin.endsWith("antigravity-cli") ? versionOf(geminiBin, ["--version"]) : null,
    probe && gitBin ? versionOf(gitBin, ["--version"]) : null,
  ]);
  const claude = {
    installed: Boolean(claudeBin),
    loggedIn: existsSync(join(home(), ".claude", ".credentials.json")) || existsSync(join(home(), ".claude.json")),
    version: claudeV,
    installUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
  };
  const gemini = {
    installed: Boolean(geminiBin),
    loggedIn: ["oauth_creds.json", "google_accounts.json", "credentials.json"].some((f) => existsSync(join(home(), ".gemini", f))) || existsSync(join(home(), ".gemini", "antigravity-cli", "jetski_state.pbtxt")) || existsSync(join(home(), ".gemini", "antigravity-cli", "installation_id")),
    version: geminiV,
    installUrl: "https://github.com/google-gemini/gemini-cli",
  };
  const git = { installed: Boolean(gitBin), version: gitV, installUrl: "https://git-scm.com/downloads" };
  const authStatus = getDaemonAuthStatus(
    opts.daemonAuthOpts || {
      ...(opts.home ? { home: opts.home } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.paseoHome ? { paseoHome: opts.paseoHome } : {}),
      ...(opts.configPath ? { configPath: opts.configPath } : {}),
    },
  );
  const paseo = {
    installed: installed || running,
    running,
    source,
    version: cli?.version ?? (installedByUs ? PINNED_PASEO_VERSION : null),
    installing: state.installing,
    progress: state.progress,
    error: state.error,
    installDurationMs: state.durationMs,
    passwordRequired: authStatus.required,
    passwordConfigured: authStatus.configured,
    passwordSource: authStatus.source,
  };
  return {
    pinnedPaseoVersion: PINNED_PASEO_VERSION,
    paseo,
    claude,
    gemini,
    git,
    ready: Boolean(paseo.installed && (claude.installed || gemini.installed)),
  };
}

function defaultInstallRunner({ prefix, spec, onProgress }) {
  return new Promise((ok) => {
    const node = bundledNode();
    const npmCli = bundledNpmCli();
    const args = ["install", "--prefix", prefix, "--no-audit", "--no-fund", spec];
    let child;
    try {
      child = npmCli
        ? spawn(node, [npmCli, ...args], { windowsHide: true, env: { ...process.env, PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ""}` } })
        : IS_WIN
          ? spawn("cmd.exe", ["/d", "/s", "/c", `npm.cmd ${args.join(" ")}`], { windowsHide: true })
          : spawn("npm", args, { windowsHide: true });
    } catch (e) {
      return ok({ code: 1, error: String(e?.message ?? e) });
    }
    let tail = "";
    const feed = (buf) => {
      const text = String(buf);
      tail = (tail + text).slice(-2000);
      const line = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
      if (line) onProgress(line.slice(0, 200));
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    child.on("error", (e) => ok({ code: 1, error: `Could not run npm: ${e.message}` }));
    child.on("close", (code) => ok({ code: code ?? 1, output: tail }));
  });
}

/** Kick off (or report) the managed Paseo install. Returns immediately; poll inspectFirstRunStatus for progress. */
export async function startManagedPaseoInstall(opts = {}) {
  const existing = opts.cli !== undefined ? opts.cli : findPaseoCli(opts);
  if (existing || state.installedOk) {
    void ensurePaseoDaemon(opts);
    return { ok: true, alreadyInstalled: true, status: await inspectFirstRunStatus(opts) };
  }
  if (!existing && (await (opts.isListening ?? isDaemonListening)(opts.listen ?? readPaseoListen()))) {
    return { ok: true, alreadyInstalled: true, status: await inspectFirstRunStatus(opts) };
  }
  if (state.installing) return { ok: true, installing: true, status: await inspectFirstRunStatus(opts) };

  const prefix = resolve(opts.prefix ?? managedPaseoPrefix());
  state.installing = true;
  state.error = null;
  state.durationMs = null;
  state.progress = `Installing @getpaseo/cli@${PINNED_PASEO_VERSION} from npm...`;
  const started = Date.now();
  const runner = opts.installRunner ?? defaultInstallRunner;
  const run = (async () => {
    try {
      mkdirSync(prefix, { recursive: true });
      const result = await runner({
        prefix,
        spec: `@getpaseo/cli@${PINNED_PASEO_VERSION}`,
        onProgress: (line) => {
          state.progress = line;
        },
      });
      if (result?.code === 0) {
        state.durationMs = Date.now() - started;
        state.error = null;
        state.installedOk = true;
        state.progress = `Installed @getpaseo/cli@${PINNED_PASEO_VERSION}`;
        state.installing = false;
        await ensurePaseoDaemon(opts);
      } else {
        const detail = result?.error || String(result?.output ?? "").trim().split(/\r?\n/).slice(-3).join(" ") || `npm exited with code ${result?.code}`;
        state.error = `Could not install @getpaseo/cli@${PINNED_PASEO_VERSION}: ${detail}. Check your internet connection and retry.`;
      }
    } catch (e) {
      state.error = `Could not install @getpaseo/cli@${PINNED_PASEO_VERSION}: ${e?.message ?? e}`;
    } finally {
      state.installing = false;
    }
  })();
  if (opts.wait) await run;
  else run.catch(() => {});
  return { ok: true, installing: state.installing, status: await inspectFirstRunStatus(opts) };
}
