// Paseo settings & daemon control surface (host mode only).
// Edits ~/.paseo/config.json directly (backup first, no UTF-8 BOM) + calls Paseo CLI (`paseo reload` / `paseo daemon ...`).
// Never displays secrets: masks any key matching token/secret/key/password/cred/auth and all provider `env` values.

import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bundledNode, findPaseoCli, isDaemonListening, parseListen, resolveCmdShimEntry, UNSAFE_CMD_ARG } from "./first-run.mjs";
import { clearConfigWarning, loadUserSettings, parseJsonWithBom, readJsonFileWithBom, recordConfigWarning, stripBom } from "./user-settings.mjs";

const IS_WIN = process.platform === "win32";
export const SECRET_MASK = "••••••••";
export const SECRET_KEY_RE = /token|secret|key|password|cred|auth/i;
export const MAX_BACKUPS = 5;

export function withWindowsHideNodeOptions(env = process.env, platform = process.platform) {
  const out = { ...(env || {}) };
  if (platform !== "win32") return out;
  const preloadPath = resolve(import.meta.dirname, "windows-hide-preload.mjs");
  const preloadUrl = pathToFileURL(preloadPath).href;
  if (/[\s"']/.test(preloadUrl)) return out;
  const existing = String(out.NODE_OPTIONS ?? "").trim();
  if (existing.includes(preloadUrl)) return out;
  if (existing.includes("windows-hide-preload.mjs")) {
    out.NODE_OPTIONS = existing.replace(/--import\s+\S*windows-hide-preload\.mjs/g, `--import ${preloadUrl}`);
    return out;
  }
  out.NODE_OPTIONS = existing ? `${existing} --import ${preloadUrl}` : `--import ${preloadUrl}`;
  return out;
}

export const envWithWindowsHidePreload = withWindowsHideNodeOptions;

export function getPaseoHome(opts = {}) {
  if (opts.paseoHome) return resolve(String(opts.paseoHome));
  if (process.env.PASEO_HOME) return resolve(process.env.PASEO_HOME);
  return join(homedir(), ".paseo");
}

export function getPaseoConfigPathForHome(opts = {}) {
  return join(getPaseoHome(opts), "config.json");
}

export function getManagedPaseoPidPath(opts = {}) {
  return join(getPaseoHome(opts), "vibesquad-managed.pid");
}

export function readPaseoPid(opts = {}) {
  const home = getPaseoHome(opts);
  for (const name of ["daemon.pid", "paseo.pid"]) {
    const p = join(home, name);
    if (!existsSync(p)) continue;
    try {
      const n = Number(readFileSync(p, "utf8").trim());
      if (Number.isFinite(n) && n > 0) return n;
    } catch {}
  }
  return null;
}

export function isSecretKeyName(key) {
  return SECRET_KEY_RE.test(String(key ?? ""));
}

/**
 * Recursively masks secret values in any object before sending to the UI:
 * - Any key matching token/secret/key/password/cred/auth
 * - All entries inside `agents.providers.<id>.env` (or any `env` object under a provider)
 */
export function maskSecrets(value, parentKey = "", inProviderEnv = false) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => maskSecrets(item, parentKey, inProviderEnv));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const nextInEnv = inProviderEnv || k === "env";
      if ((nextInEnv && typeof v !== "object") || (isSecretKeyName(k) && typeof v !== "object")) {
        out[k] = v === "" || v === null || v === undefined ? "" : SECRET_MASK;
      } else {
        out[k] = maskSecrets(v, k, nextInEnv);
      }
    }
    return out;
  }
  if (inProviderEnv || isSecretKeyName(parentKey)) {
    return value === "" ? "" : SECRET_MASK;
  }
  return value;
}

/**
 * Masks any inline secret-like substrings (`key=...`, `"email": ...` stays, `token`, `secret`, `password`, `apiKey`) in free-text CLI outputs.
 */
export function maskSecretsInText(text) {
  if (typeof text !== "string" || !text) return "";
  return text
    .replace(/((?:token|secret|key|password|cred|auth)[A-Za-z0-9_-]*\s*[:=]\s*)(["']?)[^\s"',;]+(\2)/gi, `$1$2${SECRET_MASK}$3`)
    .replace(/([?&](?:key|token|secret|password|auth)=)[^&\s]+/gi, `$1${SECRET_MASK}`);
}

/**
 * Lists backup files `config.json.bak-<ts>` sorted newest first.
 */
export function listPaseoConfigBackups(opts = {}) {
  const home = getPaseoHome(opts);
  if (!existsSync(home)) return [];
  try {
    return readdirSync(home)
      .filter((f) => /^config\.json\.bak-\d+/.test(f))
      .map((f) => {
        const full = join(home, f);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(full).mtimeMs;
        } catch {}
        const tsMatch = f.match(/^config\.json\.bak-(\d+)/);
        const tsNum = tsMatch ? Number(tsMatch[1]) : mtimeMs;
        return { name: f, path: full, ts: tsNum || mtimeMs };
      })
      .sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}

/**
 * Creates a timestamped backup `config.json.bak-<ts>` and prunes older backups beyond `MAX_BACKUPS` (5).
 */
export function createPaseoConfigBackup(opts = {}) {
  const cfgPath = getPaseoConfigPathForHome(opts);
  if (!existsSync(cfgPath)) return null;
  const home = dirname(cfgPath);
  mkdirSync(home, { recursive: true });
  const now = Date.now();
  let backupPath = join(home, `config.json.bak-${now}`);
  let suffix = 1;
  while (existsSync(backupPath)) {
    backupPath = join(home, `config.json.bak-${now}-${suffix++}`);
  }
  copyFileSync(cfgPath, backupPath);

  const backups = listPaseoConfigBackups(opts);
  for (const old of backups.slice(MAX_BACKUPS)) {
    try {
      rmSync(old.path, { force: true });
    } catch {}
  }
  return backupPath;
}

const BACKUP_NAME_RE = /^config\.json\.bak-\d+(?:-\d+)?$/;

/** A caller-supplied backup must be one of our own `config.json.bak-<ts>[-n]` files directly in the Paseo home. Throws otherwise. */
function confinedBackupPath(backupPath, opts = {}) {
  const home = resolve(getPaseoHome(opts));
  const target = resolve(home, String(backupPath));
  const sameDir = IS_WIN ? dirname(target).toLowerCase() === home.toLowerCase() : dirname(target) === home;
  if (!sameDir || !BACKUP_NAME_RE.test(basename(target))) {
    throw new Error("backupPath must be a config.json backup in the Paseo home");
  }
  return target;
}

/**
 * Restores the most recent `config.json.bak-<ts>` (or a specific backup path) to `config.json` without BOM.
 */
export function restoreLastPaseoConfigBackup(opts = {}) {
  const cfgPath = getPaseoConfigPathForHome(opts);
  const targetBackup = opts.backupPath ? confinedBackupPath(opts.backupPath, opts) : listPaseoConfigBackups(opts)[0]?.path;
  if (!targetBackup || !existsSync(targetBackup)) {
    throw new Error("No config.json backup available to restore");
  }
  const raw = stripBom(readFileSync(targetBackup, "utf8"));
  const parsed = JSON.parse(raw);
  writeFileSync(cfgPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  clearConfigWarning(cfgPath);
  return { restoredFrom: targetBackup, config: parsed };
}

/**
 * Reads `~/.paseo/config.json` (stripping any UTF-8 BOM).
 */
export function readRawPaseoConfig(opts = {}) {
  const cfgPath = getPaseoConfigPathForHome(opts);
  const res = readJsonFileWithBom(cfgPath, {
    label: "~/.paseo/config.json",
    fallback: { version: 1, daemon: { listen: "127.0.0.1:6767" } },
    recordWarning: true,
  });
  return {
    ok: res.ok,
    exists: res.exists,
    path: cfgPath,
    config: res.data && typeof res.data === "object" ? res.data : { version: 1, daemon: { listen: "127.0.0.1:6767" } },
    error: res.error,
  };
}

// `paseo plugin install <source>`: a directory, Git URL or npm package spec. No leading `-` (option injection).
const PLUGIN_SOURCE_RE = /^(?!-)[A-Za-z0-9@._\/\\:+~# -]{1,512}$/;
// Provider / plugin ids go into `paseo provider|plugin <cmd> <id>` argv: no leading `-` either.
export const PASEO_ID_RE = /^(?!-)[A-Za-z0-9_.-]+$/;

/** Validates a plugin install source; throws on anything outside the allowlist. */
export function validatePluginSource(raw) {
  const source = String(raw ?? "").trim();
  if (!source) throw new Error("Plugin source (directory, Git URL, or npm package) is required");
  if (!PLUGIN_SOURCE_RE.test(source)) throw new Error("Plugin source contains characters that aren't allowed");
  return source;
}

/** Validates a Paseo hub origin and returns its normalized `scheme://host[:port]`; throws otherwise. */
export function validateHubOrigin(raw) {
  const value = String(raw ?? "").trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Hub origin must be an http(s) URL");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || (!/^[A-Za-z0-9.-]+$/.test(url.hostname) && !/^\[[0-9a-fA-F:.]+\]$/.test(url.hostname))) {
    throw new Error("Hub origin must be an http(s) URL");
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new Error("Hub origin must not have a path, query or fragment");
  return url.origin;
}

/**
 * Runs a Paseo CLI command with `--home <paseoHome>` and optional `--json`, returning `{ ok, code, stdout, stderr, data }`.
 */
export function runPaseoCli(args = [], opts = {}) {
  const customRunner = opts.cliRunner ?? opts.runCli ?? opts._runCli;
  if (typeof customRunner === "function") {
    return Promise.resolve(customRunner(args, opts)).then((res) => {
      if (res && typeof res === "object" && !Array.isArray(res)) {
        if (res.data === undefined && args.includes("--json") && typeof res.stdout === "string" && res.stdout.trim()) {
          try {
            return {
              ok: res.ok ?? (res.code === undefined || res.code === 0),
              code: res.code ?? 0,
              stderr: "",
              ...res,
              data: parseJsonWithBom(res.stdout.trim()),
            };
          } catch {}
        }
        return {
          ok: res.ok ?? (res.code === undefined || res.code === 0),
          code: res.code ?? 0,
          stdout: res.stdout ?? "",
          stderr: res.stderr ?? "",
          data: res.data ?? null,
          ...res,
        };
      }
      if (typeof res === "string" && args.includes("--json") && res.trim()) {
        try {
          return { ok: true, code: 0, stdout: res, stderr: "", data: parseJsonWithBom(res.trim()) };
        } catch {}
      }
      if (Array.isArray(res)) {
        return { ok: true, code: 0, stdout: JSON.stringify(res), stderr: "", data: res };
      }
      return res;
    });
  }
  const paseoHome = getPaseoHome(opts);
  const cli = opts.cli ?? findPaseoCli(opts);
  if (!cli) {
    return Promise.resolve({
      ok: false,
      code: 127,
      stdout: "",
      stderr: "Paseo CLI is not installed",
      data: null,
    });
  }
  const node = bundledNode();
  const env = withWindowsHideNodeOptions({
    ...process.env,
    ...(opts.env ?? {}),
    PASEO_HOME: paseoHome,
    PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ""}`,
  });
  const fullArgs = ["--home", paseoHome, ...args];
  const timeout = opts.timeoutMs ?? 12_000;

  return new Promise((resolvePromise) => {
    const cb = (err, stdout, stderr) => {
      const outStr = stripBom(String(stdout ?? ""));
      const errStr = stripBom(String(stderr ?? ""));
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      let data = null;
      if (args.includes("--json") && outStr.trim()) {
        try {
          data = parseJsonWithBom(outStr.trim());
        } catch {}
      }
      resolvePromise({
        ok: !err && code === 0,
        code,
        stdout: outStr,
        stderr: errStr || (err ? String(err.message ?? err) : ""),
        data,
      });
    };

    const run = opts.execFile ?? execFile;
    try {
      if (cli.kind === "node") {
        run(node, [cli.bin, ...fullArgs], { timeout, windowsHide: true, env, maxBuffer: 8 * 1024 * 1024 }, cb);
      } else if (cli.kind === "cmd") {
        // Prefer the shim's node entry so request-derived args never pass through cmd.exe.
        const entry = (opts.resolveCmdShim ?? resolveCmdShimEntry)(cli.bin);
        if (entry) {
          run(node, [...entry.nodeArgs, entry.script, ...fullArgs], { timeout, windowsHide: true, env, maxBuffer: 8 * 1024 * 1024 }, cb);
        } else {
          // cli.bin is spliced into the same command line, so it gets the same check as the args.
          if ([cli.bin, ...fullArgs].some((a) => UNSAFE_CMD_ARG.test(String(a)))) {
            return resolvePromise({ ok: false, code: 1, stdout: "", stderr: "refusing argument with shell metacharacters", data: null });
          }
          // `/s /c "<line>"`: cmd strips only the outer quotes, so every arg stays quoted.
          run(
            "cmd.exe",
            ["/d", "/s", "/c", `"${[cli.bin, ...fullArgs].map((a) => `"${a}"`).join(" ")}"`],
            { timeout, windowsHide: true, env, windowsVerbatimArguments: true, maxBuffer: 8 * 1024 * 1024 },
            cb,
          );
        }
      } else {
        run(cli.bin, fullArgs, { timeout, windowsHide: true, env, maxBuffer: 8 * 1024 * 1024 }, cb);
      }
    } catch (e) {
      resolvePromise({
        ok: false,
        code: 1,
        stdout: "",
        stderr: String(e?.message ?? e),
        data: null,
      });
    }
  });
}

/**
 * Writes updated config to `~/.paseo/config.json` (validating JSON, backing up first, no BOM),
 * and runs `paseo reload` unless `skipReload: true`.
 * If `paseo reload` fails and the daemon is running, automatically restores the backup and returns `{ ok: false, restored: true, error }`.
 */
export async function writePaseoConfigAndReload(mutatorOrObject, opts = {}) {
  const cfgPath = getPaseoConfigPathForHome(opts);
  const currentRes = readRawPaseoConfig(opts);
  if (!currentRes.ok && currentRes.exists) {
    throw new Error(`Cannot modify ~/.paseo/config.json while it has a JSON parse error: ${currentRes.error}`);
  }
  const current = JSON.parse(JSON.stringify(currentRes.config));
  const next =
    typeof mutatorOrObject === "function"
      ? await mutatorOrObject(current)
      : mutatorOrObject && typeof mutatorOrObject === "object"
        ? mutatorOrObject
        : current;

  if (!next || typeof next !== "object" || Array.isArray(next)) {
    throw new Error("Updated Paseo config must be a JSON object");
  }
  const serialized = JSON.stringify(next, null, 2) + "\n";
  // Validate JSON round-trip before touching disk
  JSON.parse(serialized);

  mkdirSync(dirname(cfgPath), { recursive: true });
  const backupPath = createPaseoConfigBackup(opts);
  writeFileSync(cfgPath, serialized, "utf8");
  clearConfigWarning(cfgPath);

  if (opts.skipReload) {
    return { ok: true, reloaded: false, backupPath, config: next };
  }

  const listen = next?.daemon?.listen || current?.daemon?.listen || "127.0.0.1:6767";
  const running = await (opts.isListening ?? isDaemonListening)(listen, 800);
  if (!running) {
    return { ok: true, reloaded: false, daemonRunning: false, backupPath, config: next };
  }

  const reloadRes = await runPaseoCli(["reload"], opts);
  if (!reloadRes.ok) {
    if (backupPath && existsSync(backupPath)) {
      restoreLastPaseoConfigBackup({ ...opts, backupPath });
    }
    const errMsg = (reloadRes.stderr || reloadRes.stdout || "paseo reload failed").trim();
    return {
      ok: false,
      reloaded: false,
      restored: Boolean(backupPath),
      backupPath,
      error: `paseo reload failed (restored backup): ${errMsg}`,
    };
  }

  return { ok: true, reloaded: true, backupPath, config: next };
}

/**
 * Counts live and busy (running) agents in `<paseoHome>/agents` or via `paseo ls --json`.
 */
export async function inspectDaemonAgents(opts = {}) {
  const lsRes = await runPaseoCli(["ls", "--json"], { ...opts, timeoutMs: 4000 });
  if (lsRes.ok && Array.isArray(lsRes.data)) {
    const live = lsRes.data.filter((a) => a && a.status !== "closed" && !a.archivedAt);
    const busy = live.filter((a) => a.status === "running");
    return {
      liveCount: live.length,
      busyCount: busy.length,
      busyAgents: busy.map((a) => ({ id: a.id, name: a.name || a.title || a.shortId || a.id })),
    };
  }
  // Fallback to reading agent state files in <paseoHome>/agents if CLI timed out
  const agentsDir = join(getPaseoHome(opts), "agents");
  let liveCount = 0;
  let busyCount = 0;
  const busyAgents = [];
  if (existsSync(agentsDir)) {
    try {
      for (const dir of readdirSync(agentsDir, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        for (const f of readdirSync(join(agentsDir, dir.name))) {
          if (!f.endsWith(".json")) continue;
          const rec = readJsonFileWithBom(join(agentsDir, dir.name, f), { recordWarning: false, rewriteBom: false }).data;
          if (!rec || rec.archivedAt || rec.status === "closed") continue;
          liveCount++;
          if (rec.status === "running") {
            busyCount++;
            busyAgents.push({ id: rec.id || f.replace(/\.json$/, ""), name: rec.title || rec.name || rec.id });
          }
        }
      }
    } catch {}
  }
  return { liveCount, busyCount, busyAgents };
}

/**
 * Determines whether the currently running daemon was started/managed by VibeSquad or is external.
 */
export function isVibeSquadManagedDaemon(statusData, opts = {}) {
  const pidFile = getManagedPaseoPidPath(opts);
  if (!existsSync(pidFile)) return false;
  try {
    const recordedPid = Number(readFileSync(pidFile, "utf8").trim());
    if (!recordedPid) return false;
    if (statusData?.pid && Number(statusData.pid) === recordedPid) return true;
    return true;
  } catch {
    return false;
  }
}

export function markDaemonManagedByVibeSquad(pid, opts = {}) {
  const pidFile = getManagedPaseoPidPath(opts);
  try {
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, String(pid || "managed"), "utf8");
  } catch {}
}

export function clearManagedDaemonMarker(opts = {}) {
  const pidFile = getManagedPaseoPidPath(opts);
  try {
    if (existsSync(pidFile)) rmSync(pidFile, { force: true });
  } catch {}
}

/**
 * Inspects full Daemon status for Tab 1 (Daemon).
 * When `cliRunner` / `runCli` is not supplied and `probeCli !== true`, uses fast non-blocking
 * disk + socket reads (`daemon.pid`, `server-id`, CLI package.json) instead of spawning subprocesses.
 */
export async function getPaseoDaemonStatus(opts = {}) {
  const pHome = getPaseoHome(opts);
  const rawCfg = readRawPaseoConfig(opts);
  const configuredListen = rawCfg.config?.daemon?.listen || "127.0.0.1:6767";
  const useCli =
    typeof opts.cliRunner === "function" ||
    typeof opts.runCli === "function" ||
    typeof opts._runCli === "function" ||
    opts.probeCli === true;

  let statusObj = {};
  if (useCli) {
    const statusRes = await runPaseoCli(["status", "--json"], { ...opts, timeoutMs: 5000 });
    statusObj = statusRes.data && typeof statusRes.data === "object" ? statusRes.data : {};
  } else {
    const pid = readPaseoPid(opts);
    const serverIdPath = join(pHome, "server-id");
    let serverId = null;
    if (existsSync(serverIdPath)) {
      try {
        serverId = readFileSync(serverIdPath, "utf8").trim() || null;
      } catch {}
    }
    const cli = opts.cli !== undefined ? opts.cli : findPaseoCli(opts);
    statusObj = {
      pid,
      serverId,
      daemonVersion: cli?.version ?? null,
    };
  }

  const listen = statusObj.listen || configuredListen;
  const listening = await (opts.isListening ?? opts._probe ?? isDaemonListening)(listen, 800);
  const running = statusObj.localDaemon === "running" || listening;
  const { liveCount, busyCount, busyAgents } =
    running && (useCli || opts.inspectAgents === true)
      ? await inspectDaemonAgents(opts)
      : { liveCount: 0, busyCount: 0, busyAgents: [] };
  const managedByVibeSquad = isVibeSquadManagedDaemon(statusObj, opts);
  const startedAt = statusObj.startedAt || null;
  const uptimeMs = startedAt ? Math.max(0, Date.now() - new Date(startedAt).getTime()) : null;
  const userSettings = loadUserSettings(opts.baseHome);

  return {
    ok: true,
    home: pHome,
    running,
    version: statusObj.daemonVersion || null,
    pid: statusObj.pid || readPaseoPid(opts) || null,
    startedAt,
    uptimeMs,
    listen,
    configuredListen,
    restartRequired: Boolean(running && statusObj.listen && statusObj.listen !== configuredListen),
    serverId: statusObj.serverId || null,
    hostname: statusObj.hostname || null,
    ownership: running ? (managedByVibeSquad ? "vibesquad-managed" : "external") : "stopped",
    managedByVibeSquad,
    liveAgentCount: liveCount,
    busyAgentCount: busyCount,
    busyAgents,
    keepPaseoRunningOnQuit: userSettings.keepPaseoRunningOnQuit !== false,
    startPaseoWithVibeSquad: userSettings.startPaseoWithVibeSquad !== false,
    backupsCount: listPaseoConfigBackups(opts).length,
  };
}

export const getPaseoStatus = getPaseoDaemonStatus;

/**
 * Inspects provider health after daemon start/restart.
 * Polls briefly if any enabled provider is still `refreshing` or `initializing`.
 */
export async function checkStartedDaemonProviders(opts = {}) {
  if (opts.checkProviders === false) {
    return { providerWarning: null, erroredProviders: [] };
  }
  const waitMs = opts.providerWaitMs ?? 5000;
  const pollMs = opts.providerPollMs ?? 500;
  const deadline = Date.now() + Math.max(0, waitMs);
  let providers = [];

  while (true) {
    const res = await getPaseoProviders(opts);
    providers = Array.isArray(res?.providers) ? res.providers : [];
    const pending = providers.some(
      (p) => p && p.enabled !== false && (p.status === "refreshing" || p.status === "initializing"),
    );
    if (!pending || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }

  const errored = providers.filter(
    (p) => p && p.enabled !== false && String(p.status || "").toLowerCase() === "error",
  );
  if (errored.length === 0) {
    return { providerWarning: null, erroredProviders: [] };
  }
  const providerWarning =
    "Daemon started but providers failed: " +
    errored
      .map((p) => `${p.id || p.label}${p.error || p.detail ? ` (${p.error || p.detail})` : ""}`)
      .join(", ");
  return { providerWarning, erroredProviders: errored };
}

/**
 * Performs Daemon lifecycle actions: `start` | `stop` | `restart` | `reload`.
 * Stop and Restart require `confirmBusy: true` when `busyAgentCount > 0`.
 * On app quit (`reason === "app-quit"`), an external daemon is NEVER stopped, and if `keepPaseoRunningOnQuit` is true, it is never stopped.
 */
export async function controlPaseoDaemon(action, opts = {}) {
  const status = await getPaseoDaemonStatus(
    action === "stop" || action === "restart" ? { ...opts, inspectAgents: true } : opts,
  );

  if (action === "reload") {
    const res = await runPaseoCli(["reload"], opts);
    if (!res.ok) {
      return { ok: false, error: (res.stderr || res.stdout || "paseo reload failed").trim() };
    }
    return { ok: true, action: "reload", status: await getPaseoDaemonStatus(opts) };
  }

  if (action === "start") {
    if (status.running) {
      const health =
        opts.checkProviders === false
          ? { providerWarning: null, erroredProviders: [] }
          : await checkStartedDaemonProviders(opts);
      status.providerWarning = health.providerWarning || null;
      status.erroredProviders = health.erroredProviders || [];
      return {
        ok: true,
        action: "start",
        alreadyRunning: true,
        providerWarning: health.providerWarning || null,
        erroredProviders: health.erroredProviders || [],
        status,
      };
    }
    if (
      typeof opts.runCli === "function" ||
      typeof opts.cliRunner === "function" ||
      typeof opts._runCli === "function"
    ) {
      const res = await runPaseoCli(["daemon", "start"], { ...opts, timeoutMs: 15_000 });
      const after = await getPaseoDaemonStatus(opts);
      if (after.running || res.ok) {
        markDaemonManagedByVibeSquad(after.pid || readPaseoPid(opts) || "managed", opts);
        after.managedByVibeSquad = true;
        after.ownership = "vibesquad-managed";
      }
      const health =
        (after.running || res.ok) && opts.checkProviders !== false
          ? await checkStartedDaemonProviders(opts)
          : { providerWarning: null, erroredProviders: [] };
      after.providerWarning = health.providerWarning || null;
      after.erroredProviders = health.erroredProviders || [];
      return {
        ok: after.running || res.ok,
        action: "start",
        error: !after.running && !res.ok ? (res.stderr || res.stdout || "Failed to start Paseo daemon").trim() : undefined,
        providerWarning: health.providerWarning || null,
        erroredProviders: health.erroredProviders || [],
        status: after,
      };
    }
    const { ensurePaseoDaemon } = await import("./first-run.mjs");
    const launched = await ensurePaseoDaemon(opts);
    const checkListening = opts.isListening ?? opts._probe ?? isDaemonListening;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await checkListening(status.configuredListen)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const after = await getPaseoDaemonStatus(opts);
    if (after.running || launched?.started) {
      markDaemonManagedByVibeSquad(after.pid || readPaseoPid(opts) || "managed", opts);
      after.managedByVibeSquad = true;
      after.ownership = "vibesquad-managed";
    }
    const health =
      launched?.providerWarning !== undefined
        ? { providerWarning: launched.providerWarning || null, erroredProviders: launched.erroredProviders || [] }
        : (after.running || launched?.started) && opts.checkProviders !== false
          ? await checkStartedDaemonProviders(opts)
          : { providerWarning: null, erroredProviders: [] };
    after.providerWarning = health.providerWarning || null;
    after.erroredProviders = health.erroredProviders || [];
    return {
      ok: after.running || Boolean(launched?.started),
      action: "start",
      error: !after.running && !launched?.started ? (launched?.reason || "Failed to start Paseo daemon") : undefined,
      providerWarning: health.providerWarning || null,
      erroredProviders: health.erroredProviders || [],
      status: after,
    };
  }

  if (action === "stop" || action === "restart") {
    if (opts.reason === "app-quit") {
      if (status.keepPaseoRunningOnQuit) {
        return { ok: true, action: "noop", skipped: "keep-running-on-quit", status };
      }
      if (!status.managedByVibeSquad) {
        return { ok: true, action: "noop", skipped: "external-daemon-never-stopped", status };
      }
      if (status.busyAgentCount > 0 && !opts.confirmBusy) {
        return { ok: false, needsConfirmation: true, busyAgentCount: status.busyAgentCount, busyAgents: status.busyAgents, status };
      }
    } else if (status.busyAgentCount > 0 && !opts.confirmBusy) {
      return {
        ok: false,
        needsConfirmation: true,
        busyAgentCount: status.busyAgentCount,
        busyAgents: status.busyAgents,
        error: `${status.busyAgentCount} agent(s) are currently running. Confirm to ${action} the daemon.`,
        status,
      };
    }

    const cliArgs = action === "stop" ? ["daemon", "stop"] : ["daemon", "restart"];
    const res = await runPaseoCli(cliArgs, { ...opts, timeoutMs: 20_000 });
    if (action === "stop") {
      clearManagedDaemonMarker(opts);
    }
    const after = await getPaseoDaemonStatus(opts);
    if (action === "restart" && after.running && status.managedByVibeSquad) {
      markDaemonManagedByVibeSquad(after.pid || "managed", opts);
      after.managedByVibeSquad = true;
      after.ownership = "vibesquad-managed";
    }
    if (action === "restart") {
      const health =
        (after.running || res.ok) && opts.checkProviders !== false
          ? await checkStartedDaemonProviders(opts)
          : { providerWarning: null, erroredProviders: [] };
      after.providerWarning = health.providerWarning || null;
      after.erroredProviders = health.erroredProviders || [];
      return {
        ok: res.ok,
        action,
        error: !res.ok ? (res.stderr || res.stdout || `paseo daemon ${action} failed`).trim() : undefined,
        providerWarning: health.providerWarning || null,
        erroredProviders: health.erroredProviders || [],
        status: after,
      };
    }
    return {
      ok: res.ok,
      action,
      error: !res.ok ? (res.stderr || res.stdout || `paseo daemon ${action} failed`).trim() : undefined,
      status: after,
    };
  }

  throw new Error(`Unknown daemon action: ${action}`);
}

/**
 * Tab 6: Usage (`paseo usage ls --json` + compact header summary).
 */
export async function getPaseoUsage(opts = {}) {
  const args = ["usage", "ls", "--json"];
  if (opts.refresh) args.push("--refresh");
  const res = await runPaseoCli(args, { ...opts, timeoutMs: 15_000 });
  const items = Array.isArray(res.data) ? res.data : [];
  const providers = items.map((entry) => {
    const windows = Array.isArray(entry?.report?.windows) ? entry.report.windows : [];
    const primaryWin = windows.find((w) => w.summary) || windows[0] || null;
    const balances = Array.isArray(entry?.report?.balances) ? entry.report.balances : [];
    return {
      id: String(entry.id || entry.sourceId || ""),
      sourceId: String(entry.sourceId || ""),
      sourceLabel: String(entry.sourceLabel || entry.sourceId || ""),
      account: entry?.account?.label ? String(entry.account.label) : null,
      status: String(entry?.report?.status || "unknown"),
      planLabel: entry?.report?.planLabel ? String(entry.report.planLabel) : null,
      fetchedAt: entry.fetchedAt || null,
      usedPct: typeof primaryWin?.usedPct === "number" ? primaryWin.usedPct : null,
      remainingPct: typeof primaryWin?.remainingPct === "number" ? primaryWin.remainingPct : null,
      windowLabel: primaryWin?.label || null,
      shortLabel: primaryWin?.shortLabel || null,
      resetsAt: primaryWin?.resetsAt || null,
      tone: primaryWin?.tone || "ok",
      windows,
      balances,
    };
  });
  return {
    ok: res.ok,
    providers,
    error: !res.ok ? (res.stderr || res.stdout || "Failed to fetch usage").trim() : undefined,
  };
}

/**
 * Tab 3: Providers (`paseo provider ls --json` merged with `agents.providers` in `~/.paseo/config.json`, env masked).
 */
export async function getPaseoProviders(opts = {}) {
  const rawCfg = readRawPaseoConfig(opts).config;
  const cfgProviders = rawCfg?.agents?.providers && typeof rawCfg.agents.providers === "object" ? rawCfg.agents.providers : {};
  const lsRes = await runPaseoCli(["provider", "ls", "--json"], opts);
  const cliList = Array.isArray(lsRes.data) ? lsRes.data : [];
  const seen = new Set();
  const list = [];

  for (const row of cliList) {
    const id = String(row.provider || row.id || "").trim();
    if (!id) continue;
    seen.add(id);
    const cfgEntry = cfgProviders[id] && typeof cfgProviders[id] === "object" ? cfgProviders[id] : {};
    const enabled =
      typeof cfgEntry.enabled === "boolean"
        ? cfgEntry.enabled
        : row.enabled === undefined
          ? true
          : String(row.enabled || "").toLowerCase() === "enabled" || row.enabled === true;
    list.push({
      id,
      label: String(cfgEntry.label || row.label || id),
      description: String(cfgEntry.description || ""),
      status: String(row.status || "unknown"),
      enabled,
      defaultMode: String(row.defaultMode || ""),
      modes: String(row.modes || ""),
      extends: cfgEntry.extends ? String(cfgEntry.extends) : null,
      isCustomAcp: cfgEntry.extends === "acp",
      command: Array.isArray(cfgEntry.command) ? cfgEntry.command.map(String) : [],
      envKeys: cfgEntry.env && typeof cfgEntry.env === "object" ? Object.keys(cfgEntry.env) : [],
      envMasked: maskSecrets(cfgEntry.env || {}, "env", true),
      ...(row.error ? { error: maskSecretsInText(String(row.error)) } : {}),
      ...(row.detail ? { detail: maskSecretsInText(String(row.detail)) } : {}),
    });
  }

  for (const [id, cfgEntry] of Object.entries(cfgProviders)) {
    if (seen.has(id) || !cfgEntry || typeof cfgEntry !== "object") continue;
    list.push({
      id,
      label: String(cfgEntry.label || id),
      description: String(cfgEntry.description || ""),
      status: cfgEntry.enabled === false ? "disabled" : "configured",
      enabled: cfgEntry.enabled !== false,
      defaultMode: "",
      modes: "",
      extends: cfgEntry.extends ? String(cfgEntry.extends) : null,
      isCustomAcp: cfgEntry.extends === "acp",
      command: Array.isArray(cfgEntry.command) ? cfgEntry.command.map(String) : [],
      envKeys: cfgEntry.env && typeof cfgEntry.env === "object" ? Object.keys(cfgEntry.env) : [],
      envMasked: maskSecrets(cfgEntry.env || {}, "env", true),
    });
  }

  return { ok: true, providers: list };
}

export async function togglePaseoProvider(providerId, enabled, opts = {}) {
  const id = String(providerId || "").trim();
  if (!id || !PASEO_ID_RE.test(id)) throw new Error("Invalid provider id");
  return writePaseoConfigAndReload((cfg) => {
    cfg.agents = cfg.agents && typeof cfg.agents === "object" ? cfg.agents : {};
    cfg.agents.providers = cfg.agents.providers && typeof cfg.agents.providers === "object" ? cfg.agents.providers : {};
    const existing = cfg.agents.providers[id] && typeof cfg.agents.providers[id] === "object" ? cfg.agents.providers[id] : {};
    cfg.agents.providers[id] = {
      ...existing,
      enabled: Boolean(enabled),
    };
    return cfg;
  }, opts);
}

/**
 * Adds or edits a custom ACP provider (`extends: "acp"`).
 * Existing env values that arrive as `SECRET_MASK` ("••••••••") preserve their existing stored value on disk.
 */
export async function saveCustomAcpProvider(payload, opts = {}) {
  const id = String(payload?.id || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) throw new Error("Provider ID is required");
  const label = String(payload?.label || id).trim();
  const description = String(payload?.description || "").trim();
  const rawCommand = payload?.command;
  const command = Array.isArray(rawCommand)
    ? rawCommand.map((c) => String(c).trim()).filter(Boolean)
    : String(rawCommand || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
  if (!command.length) throw new Error("Command is required for a custom ACP provider");
  const enabled = payload?.enabled !== false;

  return writePaseoConfigAndReload((cfg) => {
    cfg.agents = cfg.agents && typeof cfg.agents === "object" ? cfg.agents : {};
    cfg.agents.providers = cfg.agents.providers && typeof cfg.agents.providers === "object" ? cfg.agents.providers : {};
    const prev = cfg.agents.providers[id] && typeof cfg.agents.providers[id] === "object" ? cfg.agents.providers[id] : {};
    const prevEnv = prev.env && typeof prev.env === "object" ? prev.env : {};
    const nextEnv = {};
    if (payload?.env && typeof payload.env === "object") {
      for (const [k, v] of Object.entries(payload.env)) {
        const cleanKey = String(k).trim();
        if (!cleanKey) continue;
        const strVal = String(v ?? "");
        if (strVal === SECRET_MASK && cleanKey in prevEnv) {
          nextEnv[cleanKey] = prevEnv[cleanKey];
        } else {
          nextEnv[cleanKey] = strVal;
        }
      }
    } else {
      Object.assign(nextEnv, prevEnv);
    }
    cfg.agents.providers[id] = {
      ...prev,
      extends: "acp",
      label,
      ...(description ? { description } : {}),
      command,
      env: nextEnv,
      enabled,
    };
    return cfg;
  }, opts);
}

export async function getPaseoProviderDiagnostic(providerId, opts = {}) {
  const id = String(providerId || "").trim();
  if (!id || !PASEO_ID_RE.test(id)) throw new Error("Invalid provider id");
  const res = await runPaseoCli(["provider", "diagnostic", id, "--json"], opts);
  const rawDiag = res.data?.diagnostic || res.stdout || res.stderr || "";
  return {
    ok: res.ok,
    provider: id,
    diagnostic: maskSecretsInText(String(rawDiag)),
  };
}

export async function getPaseoProviderModels(providerId, opts = {}) {
  const id = String(providerId || "").trim();
  if (!id || !PASEO_ID_RE.test(id)) throw new Error("Invalid provider id");
  const res = await runPaseoCli(["provider", "models", id, "--json"], opts);
  return {
    ok: res.ok,
    provider: id,
    models: Array.isArray(res.data) ? res.data : [],
    error: !res.ok ? (res.stderr || res.stdout || "Failed to list models").trim() : undefined,
  };
}

/**
 * Tab 4: Plugins (`paseo plugin ls --json` + enable/disable/reload/logs/install/update/remove).
 */
export async function getPaseoPlugins(opts = {}) {
  const rawCfg = readRawPaseoConfig(opts).config;
  const cfgPlugins = rawCfg?.plugins && typeof rawCfg.plugins === "object" ? rawCfg.plugins : {};
  const lsRes = await runPaseoCli(["plugin", "ls", "--json"], opts);
  const cliList = Array.isArray(lsRes.data) ? lsRes.data : [];
  const seen = new Set();
  const plugins = [];

  for (const row of cliList) {
    const id = String(row.id || row.plugin || "").trim();
    if (!id) continue;
    seen.add(id);
    const cfgEntry = cfgPlugins[id] && typeof cfgPlugins[id] === "object" ? cfgPlugins[id] : {};
    plugins.push({
      id,
      name: String(row.name || id),
      status: String(row.status || "unknown"),
      enabled: typeof cfgEntry.enabled === "boolean" ? cfgEntry.enabled : Boolean(row.enabled),
      source: String(row.source || cfgEntry.source || row.installation?.identity?.kind || "directory"),
      path: String(row.path || cfgEntry.path || row.remote || ""),
      error: row.error ? String(row.error) : null,
      isVibeSquad: id === "vibesquad",
    });
  }

  for (const [id, cfgEntry] of Object.entries(cfgPlugins)) {
    if (seen.has(id) || !cfgEntry || typeof cfgEntry !== "object") continue;
    plugins.push({
      id,
      name: id,
      status: cfgEntry.enabled === false ? "disabled" : "configured",
      enabled: cfgEntry.enabled !== false,
      source: String(cfgEntry.source || "directory"),
      path: String(cfgEntry.path || ""),
      error: null,
      isVibeSquad: id === "vibesquad",
    });
  }

  return {
    ok: true,
    pluginsEnabled: rawCfg?.pluginsEnabled !== false,
    plugins,
  };
}

export async function controlPaseoPlugin(action, payload = {}, opts = {}) {
  const id = String(payload.id || "").trim();
  if (action === "enable" || action === "disable") {
    if (!id || !PASEO_ID_RE.test(id)) throw new Error("Invalid plugin id");
    if (action === "disable" && id === "vibesquad" && !payload.confirmDisableVibeSquad) {
      return {
        ok: false,
        needsConfirmation: true,
        warning: "Disabling the vibesquad plugin stops role packs and roster guards. Confirm to disable.",
      };
    }
    const wantEnabled = action === "enable";
    const writeRes = await writePaseoConfigAndReload((cfg) => {
      cfg.plugins = cfg.plugins && typeof cfg.plugins === "object" ? cfg.plugins : {};
      if (cfg.plugins[id] && typeof cfg.plugins[id] === "object") {
        cfg.plugins[id].enabled = wantEnabled;
      }
      return cfg;
    }, opts);
    if (!writeRes.ok) return writeRes;
    // Also notify CLI if daemon is running
    await runPaseoCli(["plugin", action, id], opts).catch(() => {});
    return { ok: true, action, id, plugins: (await getPaseoPlugins(opts)).plugins };
  }

  if (action === "reload" || action === "update" || action === "remove") {
    if (!id || !PASEO_ID_RE.test(id)) throw new Error("Invalid plugin id");
    const res = await runPaseoCli(["plugin", action, id], { ...opts, timeoutMs: 30_000 });
    return {
      ok: res.ok,
      action,
      id,
      output: maskSecretsInText((res.stdout || res.stderr || "").trim()),
      error: !res.ok ? (res.stderr || res.stdout || `paseo plugin ${action} failed`).trim() : undefined,
      plugins: (await getPaseoPlugins(opts)).plugins,
    };
  }

  if (action === "logs") {
    if (!id || !PASEO_ID_RE.test(id)) throw new Error("Invalid plugin id");
    const res = await runPaseoCli(["plugin", "logs", id], opts);
    return {
      ok: res.ok,
      id,
      logs: maskSecretsInText(res.stdout || res.stderr || ""),
    };
  }

  if (action === "install") {
    const source = validatePluginSource(payload.source);
    if (!payload.confirmUnsandboxed) {
      return {
        ok: false,
        needsConfirmation: true,
        warning: "Paseo plugins are unsandboxed and run with full access to this PC. Confirm to install.",
      };
    }
    const res = await runPaseoCli(["plugin", "install", source], { ...opts, timeoutMs: 60_000 });
    return {
      ok: res.ok,
      action: "install",
      source,
      output: maskSecretsInText((res.stdout || res.stderr || "").trim()),
      error: !res.ok ? (res.stderr || res.stdout || "paseo plugin install failed").trim() : undefined,
      plugins: (await getPaseoPlugins(opts)).plugins,
    };
  }

  throw new Error(`Unknown plugin action: ${action}`);
}

/**
 * Tab 2 (Network & remote) + Tab 5 (Agent behaviour) + Tab 7 (Profiles / skills) + Tab 8 (Raw config & backups).
 */
export async function getPaseoConfigSurface(opts = {}) {
  const rawRes = readRawPaseoConfig(opts);
  const cfg = rawRes.config;
  const daemon = cfg?.daemon && typeof cfg.daemon === "object" ? cfg.daemon : {};
  const status = await getPaseoDaemonStatus(opts);
  const hubRes = await runPaseoCli(["hub", "status", "--json"], { ...opts, timeoutMs: 5000 });
  const hubRow = Array.isArray(hubRes.data) ? hubRes.data[0] : hubRes.data;
  const backups = listPaseoConfigBackups(opts).map((b) => ({ name: b.name, ts: b.ts }));

  return {
    ok: true,
    configPath: rawRes.path,
    network: {
      listen: String(daemon.listen || "127.0.0.1:6767"),
      activeListen: status.listen,
      restartRequired: status.restartRequired,
      corsAllowedOrigins: Array.isArray(daemon?.cors?.allowedOrigins) ? daemon.cors.allowedOrigins.map(String) : [],
      relayEnabled: Boolean(daemon?.relay?.enabled),
      appBaseUrl: String(cfg?.app?.baseUrl || "https://app.paseo.sh"),
      hub: {
        state: String(hubRow?.state || "not_connected"),
        hub: hubRow?.hub || null,
        daemonId: hubRow?.daemonId || null,
        permissions: hubRow?.permissions || "",
        connectedAt: hubRow?.connectedAt || null,
        error: hubRow?.error || null,
      },
    },
    behaviour: {
      mcpInjectIntoAgents: daemon?.mcp?.injectIntoAgents !== false,
      browserToolsEnabled: Boolean(daemon?.browserTools?.enabled),
      autoArchiveAfterMerge: Boolean(daemon?.autoArchiveAfterMerge),
      enableTerminalAgentHooks: daemon?.enableTerminalAgentHooks !== false,
      suppressDesktopFinishedNotifications: Boolean(daemon?.suppressDesktopFinishedNotifications),
    },
    skills: cfg?.agents?.skills ?? { selection: { mode: "all" } },
    profileCount: Array.isArray(daemon?.agentProfiles) ? daemon.agentProfiles.length : 0,
    maskedConfig: maskSecrets(cfg),
    backups,
  };
}

/**
 * Updates Network & Remote or Agent Behaviour settings in `~/.paseo/config.json`.
 * Changing `daemon.listen` updates `config.json` and flags `restartRequired: true` (does not force restart without confirmation).
 */
export async function updatePaseoSettingsPatch(patch = {}, opts = {}) {
  const wantListen = typeof patch.listen === "string" ? patch.listen.trim() : "";
  if (wantListen && !isLoopbackListen(wantListen) && patch.confirmExposure !== true) {
    return { ok: false, needsConfirmation: true, warning: exposureWarning(wantListen) };
  }
  let listenChanged = false;
  const res = await writePaseoConfigAndReload((cfg) => {
    cfg.daemon = cfg.daemon && typeof cfg.daemon === "object" ? cfg.daemon : {};
    if (typeof patch.listen === "string" && patch.listen.trim()) {
      const nextListen = patch.listen.trim();
      if (cfg.daemon.listen !== nextListen) listenChanged = true;
      cfg.daemon.listen = nextListen;
    }
    if (Array.isArray(patch.corsAllowedOrigins)) {
      cfg.daemon.cors = cfg.daemon.cors && typeof cfg.daemon.cors === "object" ? cfg.daemon.cors : {};
      cfg.daemon.cors.allowedOrigins = patch.corsAllowedOrigins.map((o) => String(o).trim()).filter(Boolean);
    }
    if (typeof patch.relayEnabled === "boolean") {
      cfg.daemon.relay = cfg.daemon.relay && typeof cfg.daemon.relay === "object" ? cfg.daemon.relay : {};
      cfg.daemon.relay.enabled = patch.relayEnabled;
    }
    if (typeof patch.mcpInjectIntoAgents === "boolean") {
      cfg.daemon.mcp = cfg.daemon.mcp && typeof cfg.daemon.mcp === "object" ? cfg.daemon.mcp : {};
      cfg.daemon.mcp.injectIntoAgents = patch.mcpInjectIntoAgents;
    }
    if (typeof patch.browserToolsEnabled === "boolean") {
      cfg.daemon.browserTools = cfg.daemon.browserTools && typeof cfg.daemon.browserTools === "object" ? cfg.daemon.browserTools : {};
      cfg.daemon.browserTools.enabled = patch.browserToolsEnabled;
    }
    if (typeof patch.autoArchiveAfterMerge === "boolean") {
      cfg.daemon.autoArchiveAfterMerge = patch.autoArchiveAfterMerge;
    }
    if (typeof patch.enableTerminalAgentHooks === "boolean") {
      cfg.daemon.enableTerminalAgentHooks = patch.enableTerminalAgentHooks;
    }
    if (typeof patch.suppressDesktopFinishedNotifications === "boolean") {
      cfg.daemon.suppressDesktopFinishedNotifications = patch.suppressDesktopFinishedNotifications;
    }
    return cfg;
  }, opts);

  checkDaemonListenExposure(opts);
  return {
    ...res,
    restartRequired: listenChanged,
    ...(wantListen && !isLoopbackListen(wantListen) ? { warning: exposureWarning(wantListen) } : {}),
    surface: await getPaseoConfigSurface(opts),
  };
}

/** True for loopback hosts (127.0.0.0/8, localhost, ::1) and local IPC paths (named pipe / unix socket). */
export function isLoopbackListen(listen) {
  const s = String(listen ?? "").trim();
  if (!s) return true;
  if (/^(unix:|\\\\\.\\pipe\\|\/)/i.test(s)) return true;
  const host = parseListen(s).host.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function exposureWarning(listen) {
  return `daemon.listen ${listen} is not loopback: any device that can reach it controls your agents with no pairing or token. VibeSquad's LAN mode already proxies the daemon with auth, so 127.0.0.1:6767 is enough.`;
}

/** Records (or clears) a config warning when `~/.paseo/config.json` daemon.listen isn't loopback. Never edits the file. */
export function checkDaemonListenExposure(opts = {}) {
  const cfgPath = getPaseoConfigPathForHome(opts);
  const key = `${cfgPath}#daemon.listen`;
  const listen = readRawPaseoConfig(opts).config?.daemon?.listen;
  if (typeof listen === "string" && !isLoopbackListen(listen)) {
    return recordConfigWarning(key, "~/.paseo/config.json", exposureWarning(listen), { kind: "exposure" });
  }
  clearConfigWarning(key);
  return null;
}

export async function getPaseoPairOffer(opts = {}) {
  const res = await runPaseoCli(["pair", "--json"], opts);
  const data = res.data && typeof res.data === "object" ? res.data : {};
  // Strip ANSI escape codes from QR text so it renders cleanly in a <pre>
  const cleanQr = String(data.qr || "").replace(/\u001b\[[0-9;]*m/g, "");
  return {
    ok: res.ok,
    relayEnabled: Boolean(data.relayEnabled),
    url: data.url ? String(data.url) : null,
    qr: cleanQr,
    error: !res.ok ? (res.stderr || res.stdout || "paseo pair failed").trim() : undefined,
  };
}

export async function controlPaseoHub(action, payload = {}, opts = {}) {
  if (action === "status") {
    const res = await runPaseoCli(["hub", "status", "--json"], opts);
    const row = Array.isArray(res.data) ? res.data[0] : res.data;
    return { ok: res.ok, hub: row || { state: "not_connected" } };
  }
  if (action === "connect") {
    const args = ["hub", "connect"];
    if (payload.origin && typeof payload.origin === "string" && payload.origin.trim()) {
      args.push(validateHubOrigin(payload.origin));
    }
    const res = await runPaseoCli(args, { ...opts, timeoutMs: 20_000 });
    return {
      ok: res.ok,
      output: maskSecretsInText((res.stdout || res.stderr || "").trim()),
      error: !res.ok ? maskSecretsInText((res.stderr || res.stdout || "paseo hub connect failed").trim()) : undefined,
    };
  }
  if (action === "disconnect") {
    const res = await runPaseoCli(["hub", "disconnect"], { ...opts, timeoutMs: 15_000 });
    return {
      ok: res.ok,
      output: maskSecretsInText((res.stdout || res.stderr || "").trim()),
      error: !res.ok ? maskSecretsInText((res.stderr || res.stdout || "paseo hub disconnect failed").trim()) : undefined,
    };
  }
  throw new Error(`Unknown hub action: ${action}`);
}

export function openPaseoConfigInEditor(opts = {}) {
  const cfgPath = getPaseoConfigPathForHome(opts);
  if (opts.dryRun) {
    return { ok: true, path: cfgPath, dryRun: true };
  }
  try {
    if (IS_WIN) {
      const child = spawn("cmd.exe", ["/d", "/s", "/c", `start "" "${cfgPath}"`], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    } else {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      const child = spawn(opener, [cfgPath], { detached: true, stdio: "ignore" });
      child.unref();
    }
    return { ok: true, path: cfgPath };
  } catch (e) {
    return { ok: false, path: cfgPath, error: String(e?.message ?? e) };
  }
}
