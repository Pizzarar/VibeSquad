// POSIX PATH repair (forge-host A6, audit R6/R21). A systemd user unit or agent shell starts with a thin PATH, so node/npm/
// claude/agy/opencode vanish. Off win32 only: source the login-shell PATH once per process and probe the usual node-manager
// bin dirs (npm -g prefix, nvm, fnm, volta). Everything is injectable (platform/env/home/exists/readdir/readFile/exec) so the
// POSIX branches are testable on Windows. Never throws; win32 always returns inputs untouched.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";

const MARK = "__VSPATH__";
const SHELL_TIMEOUT_MS = 3000;
let cached; // login-shell PATH, once per process (default exec only)

const defaultExec = (file, args, o) => execFileSync(file, args, { encoding: "utf8", timeout: o.timeout, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });

/** Login-shell PATH string, or null (win32, no/relative/missing SHELL, failure, timeout, empty). */
export function loginShellPath({ platform = process.platform, env = process.env, exec, exists = existsSync, timeout = SHELL_TIMEOUT_MS } = {}) {
  if (platform === "win32") return null;
  const useCache = !exec;
  if (useCache && cached !== undefined) return cached;
  let out = null;
  try {
    const sh = env.SHELL;
    if (sh && posix.isAbsolute(sh) && exists(sh)) {
      const raw = String((exec || defaultExec)(sh, ["-lc", `printf '${MARK}%s${MARK}' "$PATH"`], { timeout }));
      const m = raw.match(new RegExp(`${MARK}([^\n]*?)${MARK}`)); // profile noise may surround the markers
      out = m && m[1].trim() ? m[1].trim() : null;
    }
  } catch { out = null; }
  if (useCache) cached = out;
  return out;
}

export function resetLoginShellCache() { cached = undefined; }

/** Existing entries first, then additions; empty and duplicate entries dropped. */
export function mergePathLists(existing, ...more) {
  const seen = new Set(); const out = [];
  for (const e of [existing, ...more].flatMap((s) => (Array.isArray(s) ? s : String(s ?? "").split(":")))) {
    if (!e || seen.has(e)) continue;
    seen.add(e); out.push(e);
  }
  return out;
}

const ls = (readdir, dir) => { try { return readdir(dir).map(String).sort().reverse(); } catch { return []; } }; // newest-ish version first

/** Node-manager bin dirs that exist: npm -g prefix, nvm (default alias first), fnm, volta. */
export function toolDirs({ platform = process.platform, env = process.env, home = homedir(), exists = existsSync, readdir = readdirSync, readFile = (p) => readFileSync(p, "utf8"), exec } = {}) {
  if (platform === "win32") return [];
  const found = [];
  const add = (d) => { if (d && exists(d)) found.push(d); };
  try {
    const out = String((exec || defaultExec)("npm", ["prefix", "-g"], { timeout: SHELL_TIMEOUT_MS })).trim();
    if (out && posix.isAbsolute(out)) add(posix.join(out, "bin"));
  } catch { /* npm absent from thin PATH: the manager dirs below still cover it */ }
  const nvmRoot = env.NVM_DIR || posix.join(home, ".nvm");
  const nvmVer = posix.join(nvmRoot, "versions", "node");
  let alias = ""; try { alias = String(readFile(posix.join(nvmRoot, "alias", "default"))).trim(); } catch { /* none */ }
  const vers = ls(readdir, nvmVer);
  const pref = alias ? vers.filter((v) => v === alias || v.startsWith(`v${alias.replace(/^v/, "")}.`) || v === `v${alias.replace(/^v/, "")}`) : [];
  for (const v of [...pref, ...vers.filter((v) => !pref.includes(v))]) add(posix.join(nvmVer, v, "bin"));
  for (const root of [env.FNM_DIR, posix.join(home, ".local", "share", "fnm"), posix.join(home, ".fnm")].filter(Boolean)) {
    add(posix.join(root, "aliases", "default", "bin"));
    for (const v of ls(readdir, posix.join(root, "node-versions"))) add(posix.join(root, "node-versions", v, "installation", "bin"));
  }
  add(posix.join(env.VOLTA_HOME || posix.join(home, ".volta"), "bin"));
  return mergePathLists(found);
}

/** PATH string with login-shell PATH and tool dirs appended (nothing dropped, no dupes). Off win32 only. */
export function augmentedPath(env = process.env, opts = {}) {
  const base = env.PATH ?? env.Path ?? "";
  if ((opts.platform ?? process.platform) === "win32") return base;
  const o = { ...opts, env };
  return mergePathLists(base, loginShellPath({ ...o, exec: opts.shellExec }) || [], toolDirs({ ...o, exec: opts.npmExec })).join(":");
}
