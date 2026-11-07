// First-run checklist: detects Claude Code / Gemini / git. Only an agent CLI is required.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const IS_WIN = process.platform === "win32";

function onPath(names, env = process.env) {
  const dirs = String(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) for (const n of names) if (existsSync(join(dir, n))) return join(dir, n);
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
  const probe = opts.probeVersions !== false;

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
  return {
    claude,
    gemini,
    git,
    // Only an agent CLI is required.
    ready: Boolean(claude.installed || gemini.installed),
  };
}
