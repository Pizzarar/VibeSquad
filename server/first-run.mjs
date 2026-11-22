// First-run checklist: detects Claude Code / Gemini / git. Only an agent CLI is required.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, posix, win32 } from "node:path";
import { extraPathEntriesAsync, mergePathLists } from "./posix-path.mjs";

const IS_WIN = process.platform === "win32";

function onPath(names, env = process.env, has = existsSync, delim = delimiter, pj = join) {
  const dirs = String(env.PATH ?? env.Path ?? "").split(delim).filter(Boolean);
  for (const dir of dirs) for (const n of names) if (has(pj(dir, n))) return pj(dir, n);
  return null;
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

function findClaude(env, win = IS_WIN, has = existsSync, delim = delimiter) {
  const hits = [
    onPath(win ? ["claude.exe", "claude.cmd"] : ["claude"], env, has, delim, win ? win32.join : posix.join),
    env.APPDATA && join(env.APPDATA, "npm", "claude.cmd"),
    join(home(), ".local", "bin", win ? "claude.exe" : "claude"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "claude", "claude.exe"),
  ].filter(Boolean);
  return hits.find((h) => has(h)) ?? null;
}

function findGemini(env, win = IS_WIN, has = existsSync, delim = delimiter) {
  const names = win ? ["agy.exe", "agy.cmd", "antigravity.cmd", "antigravity.exe", "gemini.cmd", "gemini.exe"] : ["agy", "antigravity", "gemini"];
  const hit = onPath(names, env, has, delim, win ? win32.join : posix.join);
  if (hit) return hit;
  if (env.APPDATA) for (const n of ["agy.cmd", "antigravity.cmd", "gemini.cmd"]) if (has(join(env.APPDATA, "npm", n))) return join(env.APPDATA, "npm", n);
  const dir = join(home(), ".gemini", "antigravity-cli");
  return has(dir) ? dir : null;
}

// A6: off win32 a thin PATH (systemd user unit) is widened with the login-shell PATH + npm-prefix/nvm/fnm/volta dirs. The
// probe is async (never blocks the event loop on the HTTP status route) and runs once per process; the base PATH is merged per call.
let extrasOnce;
const defaultExtras = (env) => (extrasOnce ??= extraPathEntriesAsync(env));

export async function inspectFirstRunStatus(opts = {}) {
  const baseEnv = opts.env ?? process.env;
  const win = (opts.platform ?? process.platform) === "win32";
  const has = opts.exists ?? existsSync;
  let env = baseEnv;
  if (!win) {
    try { // opts.augmentPath(env) -> extra PATH string/array (tests); default = cached async probe
      const extra = opts.augmentPath ? await opts.augmentPath(baseEnv) : await defaultExtras(baseEnv);
      env = { ...baseEnv, PATH: mergePathLists(baseEnv.PATH ?? baseEnv.Path ?? "", extra || []).join(":") };
    } catch { env = baseEnv; }
  }
  const delim = win ? ";" : ":";
  const probe = opts.probeVersions !== false;

  const claudeBin = findClaude(env, win, has, delim);
  const geminiBin = findGemini(env, win, has, delim);
  const gitBin = onPath(win ? ["git.exe", "git.cmd"] : ["git"], env, has, delim, win ? win32.join : posix.join);
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
  return {
    claude,
    gemini,
    git,
    // Only an agent CLI is required.
    ready: Boolean(claude.installed || gemini.installed),
  };
}
