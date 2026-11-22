// POSIX PATH repair (forge-host A6, audit R6/R21). A systemd user unit or agent shell starts with a thin PATH, so node/npm/
// claude/agy/opencode vanish. Off win32 only: source the login-shell PATH once per process and probe the usual node-manager
// bin dirs (nvm, fnm, volta, then `npm prefix -g` run with the widened PATH). Two runners share the planning code: a sync one
// (restart-runtime's spawn path) and an async one (HTTP request path: must never block the event loop). Everything is
// injectable (platform/env/home/exists/readdir/readFile/exec) so POSIX branches are testable on Windows. Never throws;
// win32 always returns inputs untouched.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readdir as readdirP, readFile as readFileP, access } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";

const MARK = "__VSPATH__";
const TIMEOUT_MS = 3000;
// Only known POSIX shells are run as `$SHELL -lc` (SHELL is env-controlled; never exec an arbitrary binary).
export const KNOWN_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "mksh", "fish"]);
let cached; // sync login-shell PATH, once per process (default exec only)
let cachedAsync; // async login-shell PATH promise

const defaultExec = (file, args, o) => execFileSync(file, args, { encoding: "utf8", timeout: o.timeout, env: o.env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
const defaultExecAsync = (file, args, o) => new Promise((ok, no) => execFile(file, args, { encoding: "utf8", timeout: o.timeout, env: o.env, windowsHide: true }, (e, out) => (e ? no(e) : ok(out))));
const defaultExistsAsync = (p) => access(p).then(() => true, () => false);

const shellArgs = () => ["-lc", `printf '${MARK}%s${MARK}' "$PATH"`];
const shellOk = (platform, env) => platform !== "win32" && env.SHELL && posix.isAbsolute(env.SHELL) && KNOWN_SHELLS.has(posix.basename(env.SHELL));
function parseShell(raw) {
  const m = String(raw).match(new RegExp(`${MARK}([^\\n]*?)${MARK}`)); // profile noise may surround the markers
  return m && m[1].trim() ? m[1].trim() : null;
}

/** Login-shell PATH string, or null (win32, unknown/relative/missing SHELL, failure, timeout, empty). Sync. */
export function loginShellPath({ platform = process.platform, env = process.env, exec, exists = existsSync, timeout = TIMEOUT_MS } = {}) {
  if (platform === "win32") return null;
  const useCache = !exec;
  if (useCache && cached !== undefined) return cached;
  let out = null;
  try {
    if (shellOk(platform, env) && exists(env.SHELL)) out = parseShell((exec || defaultExec)(env.SHELL, shellArgs(), { timeout, env }));
  } catch { out = null; }
  if (useCache) cached = out;
  return out;
}

/** Async twin of loginShellPath: never blocks the event loop. */
export async function loginShellPathAsync({ platform = process.platform, env = process.env, exec, exists = defaultExistsAsync, timeout = TIMEOUT_MS } = {}) {
  if (platform === "win32") return null;
  const run = async () => {
    try {
      if (shellOk(platform, env) && await exists(env.SHELL)) return parseShell(await (exec || defaultExecAsync)(env.SHELL, shellArgs(), { timeout, env }));
    } catch { /* fall through */ }
    return null;
  };
  if (exec) return run();
  return (cachedAsync ??= run());
}

export function resetLoginShellCache() { cached = undefined; cachedAsync = undefined; }

/** Existing entries first, then additions; empty and duplicate entries dropped. */
export function mergePathLists(existing, ...more) {
  const seen = new Set(); const out = [];
  for (const e of [existing, ...more].flatMap((s) => (Array.isArray(s) ? s : String(s ?? "").split(":")))) {
    if (!e || seen.has(e)) continue;
    seen.add(e); out.push(e);
  }
  return out;
}

/** Numeric/semver-aware descending compare so v22.1.0 > v9.0.0 and v20.10 > v20.9. */
export function cmpVersionDesc(a, b) {
  const seg = (s) => String(s).replace(/^v/, "").split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const x = seg(a); const y = seg(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i]; const q = y[i];
    if (p === q) continue;
    if (p === undefined) return 1;
    if (q === undefined) return -1;
    if (typeof p === "number" && typeof q === "number") return q - p;
    return String(q) < String(p) ? -1 : 1;
  }
  return 0;
}
const sortVers = (names) => names.map(String).sort(cmpVersionDesc);

function plan({ env, home }) {
  const nvmRoot = env.NVM_DIR || posix.join(home, ".nvm");
  const fnmRoots = [env.FNM_DIR, posix.join(home, ".local", "share", "fnm"), posix.join(home, ".fnm")].filter(Boolean);
  return { nvmVer: posix.join(nvmRoot, "versions", "node"), aliasFile: posix.join(nvmRoot, "alias", "default"), fnmRoots, volta: posix.join(env.VOLTA_HOME || posix.join(home, ".volta"), "bin") };
}
const nvmOrder = (vers, alias) => {
  const a = String(alias || "").trim().replace(/^v/, "");
  const pref = a ? vers.filter((v) => v.replace(/^v/, "") === a || v.replace(/^v/, "").startsWith(`${a}.`)) : [];
  return [...pref, ...vers.filter((v) => !pref.includes(v))];
};
const npmBin = (out) => { const o = String(out ?? "").trim(); return o && posix.isAbsolute(o) ? posix.join(o, "bin") : null; };
// env handed to `npm prefix -g`: the thin PATH widened with everything found so far (M2).
const npmEnv = (env, ...lists) => ({ ...env, PATH: mergePathLists(env.PATH ?? env.Path ?? "", ...lists).join(":") });

/** Entries to append to PATH (login-shell PATH, npm -g bin, manager dirs). Sync. */
export function extraPathEntries(env = process.env, { platform = process.platform, home = homedir(), exists = existsSync, readdir = readdirSync, readFile = (p) => readFileSync(p, "utf8"), shellExec, npmExec, timeout = TIMEOUT_MS } = {}) {
  if (platform === "win32") return [];
  const login = loginShellPath({ platform, env, exec: shellExec, exists, timeout });
  const p = plan({ env, home }); const mgr = [];
  const add = (d) => { try { if (d && exists(d)) mgr.push(d); } catch { /* skip */ } };
  const ls = (d) => { try { return sortVers(readdir(d)); } catch { return []; } };
  let alias = ""; try { alias = readFile(p.aliasFile); } catch { /* none */ }
  for (const v of nvmOrder(ls(p.nvmVer), alias)) add(posix.join(p.nvmVer, v, "bin"));
  for (const r of p.fnmRoots) { add(posix.join(r, "aliases", "default", "bin")); for (const v of ls(posix.join(r, "node-versions"))) add(posix.join(r, "node-versions", v, "installation", "bin")); }
  add(p.volta);
  let npm = null;
  try { npm = npmBin((npmExec || defaultExec)("npm", ["prefix", "-g"], { timeout, env: npmEnv(env, login || [], mgr) })); if (npm && !exists(npm)) npm = null; } catch { /* npm absent */ }
  return mergePathLists(login || [], npm ? [npm] : [], mgr);
}

/** Async twin of extraPathEntries. */
export async function extraPathEntriesAsync(env = process.env, { platform = process.platform, home = homedir(), exists = defaultExistsAsync, readdir = (d) => readdirP(d), readFile = (p) => readFileP(p, "utf8"), shellExec, npmExec, timeout = TIMEOUT_MS } = {}) {
  if (platform === "win32") return [];
  const login = await loginShellPathAsync({ platform, env, exec: shellExec, exists, timeout });
  const p = plan({ env, home }); const mgr = [];
  const add = async (d) => { try { if (d && await exists(d)) mgr.push(d); } catch { /* skip */ } };
  const ls = async (d) => { try { return sortVers(await readdir(d)); } catch { return []; } };
  let alias = ""; try { alias = await readFile(p.aliasFile); } catch { /* none */ }
  for (const v of nvmOrder(await ls(p.nvmVer), alias)) await add(posix.join(p.nvmVer, v, "bin"));
  for (const r of p.fnmRoots) { await add(posix.join(r, "aliases", "default", "bin")); for (const v of await ls(posix.join(r, "node-versions"))) await add(posix.join(r, "node-versions", v, "installation", "bin")); }
  await add(p.volta);
  let npm = null;
  try { npm = npmBin(await (npmExec || defaultExecAsync)("npm", ["prefix", "-g"], { timeout, env: npmEnv(env, login || [], mgr) })); if (npm && !(await exists(npm))) npm = null; } catch { /* npm absent */ }
  return mergePathLists(login || [], npm ? [npm] : [], mgr);
}

/** PATH string with login-shell PATH and tool dirs appended (nothing dropped, no dupes). Off win32 only. Sync. */
export function augmentedPath(env = process.env, opts = {}) {
  const base = env.PATH ?? env.Path ?? "";
  if ((opts.platform ?? process.platform) === "win32") return base;
  return mergePathLists(base, extraPathEntries(env, opts)).join(":");
}
