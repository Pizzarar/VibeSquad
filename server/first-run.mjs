// First-run checklist: detects Paseo / Claude Code / Gemini / git, reuses an existing Paseo (and its daemon),
// and otherwise installs the pinned @getpaseo/cli into a VibeSquad-managed prefix using the bundled node + npm.
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

export const PINNED_PASEO_VERSION = "0.13.2";
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

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

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

export function parseListen(listen) {
  const [host, port] = String(listen || "127.0.0.1:6767").replace(/^wss?:\/\//, "").split(/:(?=\d+$)/);
  return { host: host || "127.0.0.1", port: Number(port) || 6767 };
}

export function readPaseoListen() {
  let listen = "127.0.0.1:6767";
  try {
    listen = JSON.parse(readFileSync(join(homedir(), ".paseo", "config.json"), "utf8")).daemon?.listen ?? listen;
  } catch {}
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
  const listening = opts.isListening ?? isDaemonListening;
  if (await listening(opts.listen ?? readPaseoListen())) return { started: false, reason: "already-running" };
  const cli = opts.cli ?? findPaseoCli(opts);
  if (!cli) return { started: false, reason: "not-installed" };
  const spawnFn = opts.spawn ?? spawn;
  const node = bundledNode();
  const env = { ...process.env, PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ""}` };
  const spawnOpts = { detached: true, stdio: "ignore", windowsHide: true, env };
  try {
    const child =
      cli.kind === "node"
        ? spawnFn(node, [cli.bin, "start"], spawnOpts)
        : cli.kind === "cmd"
          ? spawnFn("cmd.exe", ["/d", "/s", "/c", `"${cli.bin}" start`], { ...spawnOpts, windowsVerbatimArguments: true })
          : spawnFn(cli.bin, ["start"], spawnOpts);
    child?.on?.("error", () => {});
    child?.unref?.();
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
    loggedIn: ["oauth_creds.json", "google_accounts.json", "credentials.json"].some((f) => existsSync(join(home(), ".gemini", f))),
    version: geminiV,
    installUrl: "https://github.com/google-gemini/gemini-cli",
  };
  const git = { installed: Boolean(gitBin), version: gitV, installUrl: "https://git-scm.com/downloads" };
  const paseo = {
    installed: installed || running,
    running,
    source,
    version: cli?.version ?? (installedByUs ? PINNED_PASEO_VERSION : null),
    installing: state.installing,
    progress: state.progress,
    error: state.error,
    installDurationMs: state.durationMs,
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
