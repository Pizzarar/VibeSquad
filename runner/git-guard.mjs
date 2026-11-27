// Worker main-checkout git guard (idea-767, R12 from EFI lesson 9011cb76: a worker's `git reset` in EFI's shared main
// checkout wiped 3 Buddies' uncommitted edits). Runs inside the claude PreToolUse hook (runner/drain-hook.mjs
// --git-guard), which adapters/claude.mjs installs for every role=worker agent on this runner, so it covers every Squad
// on the machine. Leads and Buddies get no --git-guard flag and are never blocked.
//
// A worker's Bash/PowerShell call is refused when it would run a destructive git command (reset --hard, checkout of
// paths / `checkout .` / checkout -f, switch -f, clean (not -n), stash push/pop/apply/drop/clear/branch, restore) in a
// repo's MAIN checkout: the first `.git` found walking up from the target dir is a directory, not a gitfile. Inside a
// linked worktree (`.git` is a file) or outside any repo it passes. The target dir follows the hook's cwd through
// `cd`/`pushd`/Set-Location, `( )` subshells, `git -C` (cumulative), `--work-tree`/`--git-dir` (and GIT_WORK_TREE /
// GIT_DIR prefixes, exports or the agent's inherited env, carried into every nested shell), `env -C`/`sudo -D`,
// `bash -c`/`sh -c`/eval/`env -S` bodies and $(...) substitutions (checked in the dir the shell is in at that point),
// case arms and pushd/popd stacks. Compound-command keywords (if/then/do/while/{/function ...) and wrappers
// (env/sudo/nice/time/timeout/exec/command/xargs by basename, with their option arguments) are stripped first; operands
// xargs appends count as paths. A destructive command whose dir cannot be resolved (cd "$(...)", unset $VAR) fails
// closed. Read-only git, `--help`, `checkout -b`/branch switches and `clean -n`/`stash list|show` always pass.
// idea-888 adds the shared-branch writes R17 names (commit, merge, rebase, pull, cherry-pick, revert, am) to the same
// classifier, so the hook and the PATH gate below refuse the same set.
//
// Provider-neutral PATH gate (idea-888): the hook above exists only for Claude. Every role=worker agent, whatever its
// provider (claude, agy/Gemini, opencode, Codex over ACP), also gets runner/git-shim/ first on PATH (applyGitShim, called by
// runner.mjs agentEnv). Its `git` is a POSIX sh script: argv that holds none of the write subcommand names execs the real git
// at once (no node start: git is called constantly); otherwise runner/git-guard-check.mjs judges the real argv + cwd +
// GIT_DIR/GIT_WORK_TREE with gitArgvViolation (this file: same classifier, same main-checkout test) and the shim execs the
// real git only on exit 0. Any other outcome (refusal, node missing, a crash) refuses the write: it fails closed.
// Main checkouts under the OS temp dir are exempt there only: unlike the hook, the PATH gate also sees git run by scripts and
// test suites (`git init` + commit in a mkdtemp repo), and a shared project checkout never lives in a temp dir.
// Aliases (round 1 of the Tier A review): the shim's fast path runs only for a subcommand on GIT_SAFE_BUILTINS (git never
// lets an alias shadow a builtin), so `git -c alias.x=reset x --hard`, --config-env and config-file aliases all reach the
// check, and classifyGit (hook and shim alike) resolves a non-builtin subcommand with `git <globals> config --get
// alias.<sub>` and judges the expansion; a `!shell` alias, or one that cannot be resolved, is refused in a main checkout.
// What the PATH gate does NOT cover (an accident guard, not a sandbox): an absolute git path (/usr/bin/git), a PATH or
// TMPDIR the agent rewrites, libgit2/JGit tools that never exec git, git writes outside the classifier (apply, rm, mv,
// update-ref, branch -f, read-tree -u, checkout-index, external git-<x> commands), and win32 (no shim yet: the Claude hook
// still covers Claude workers there). git's own children (hooks, `pull` -> merge, an external git-<x>) get git's exec-path
// first on PATH, so they bypass the shim; only the outer command is judged.
import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, closeSync, constants as fsConstants, fstatSync, openSync, readSync, statSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OPS = ['&&', '||', ';;', ';', '|&', '|', '&', '\n', '(', ')'];
// Leading reserved words of compound commands: `if x; then git ...; fi`, `for ...; do git ...; done`, `{ git ...; }`.
// They are words, not tokenizer operators, so `find -exec {} \;` and `--format={x}` keep their braces.
const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', 'fi', 'done', 'esac', '{', '}', '!']);
// Command wrappers: `short` = short flags that take a value, `long` = long options that take one (also `--x=v`),
// `chdir` = flags that move the wrapped command's dir, `split` = flags whose value is itself a command line,
// `positional` = leading operands before the command (timeout's DURATION), `unset`/`clear` = env flags that drop variables,
// `appends` = the wrapper adds operands to the end of the command. Matched by basename, quoted or not (`/usr/bin/env`, "env").
const WRAPPERS = {
  env: { short: 'uCS', long: ['unset', 'chdir', 'split-string'], chdir: ['-C', '--chdir'], split: ['-S', '--split-string'], unset: ['-u', '--unset'], clear: ['-i', '--ignore-environment'] },
  sudo: { short: 'ugCDhprtUTR', long: ['user', 'group', 'close-from', 'chdir', 'host', 'prompt', 'role', 'type', 'other-user', 'command-timeout', 'chroot'], chdir: ['-D', '--chdir'] },
  nice: { short: 'n', long: ['adjustment'] },
  time: { short: 'fo', long: ['format', 'output'] },
  timeout: { short: 'sk', long: ['signal', 'kill-after'], positional: 1 },
  exec: { short: 'a', long: [] },
  nohup: {},
  // xargs appends stdin words as operands (`echo . | xargs git checkout --`); optional-value flags (-i/-e/-l) only attach.
  xargs: { short: 'ILnPdEsa', long: ['max-args', 'max-procs', 'delimiter', 'max-chars', 'arg-file', 'process-slot-var'], appends: true },
  command: {},
  builtin: {},
};
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const CD = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl', 'push-location']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const UNKNOWN = Symbol('unknown-dir');

/**
 * Git Bash (MSYS) drive paths on win32: `/c/Users/x` and `/cygdrive/c/Users/x` are C:\Users\x (bash cd goes there, and MSYS
 * converts such argv and GIT_DIR / GIT_WORK_TREE values before native git.exe sees them), while path.resolve('/c/x') is
 * <current drive>:\c\x and would miss the main checkout. Other platforms, and other strings, are returned unchanged.
 */
export function msysToWin(p, platform = process.platform) {
  if (platform !== 'win32' || typeof p !== 'string') return p;
  const m = /^\/(?:cygdrive\/)?([A-Za-z])(\/.*)?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:${m[2] ?? '/'}` : p;
}
/** path.resolve over host paths: every part goes through msysToWin first. */
const resolveHost = (...ps) => path.resolve(...ps.map((p) => msysToWin(p)));

// ---- shell tokenizer ----

function readBalanced(s, i, open, close) {
  // s[i] is just past `open`; returns [inner, indexAfterClose]
  let depth = 1;
  let q = '';
  const start = i;
  for (; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ''; else if (c === '\\' && q === '"') i++; continue; }
    if (c === "'" || c === '"') q = c;
    else if (c === '\\') i++;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return [s.slice(start, i), i + 1];
  }
  return [s.slice(start), s.length];
}

/**
 * Split a command line into words and operators. Words: { text, dynamic } (dynamic = holds a substitution or an
 * unresolvable variable). Each word's `subs` holds its $(...) / `...` bodies, checked as commands in the dir the shell is
 * in when that word is expanded; the top-level `subs` lists them all.
 */
export function tokenize(src, { env = process.env, vars = {}, powershell = false } = {}) {
  const s = String(src ?? '');
  const out = [];
  const subs = [];
  let word = null;
  const start = () => { if (!word) word = { text: '', dynamic: false, quoted: false, subs: [] }; };
  const addSub = (body) => { start(); subs.push(body); word.subs.push(body); word.dynamic = true; };
  const flush = () => { if (word) out.push({ type: 'word', ...word }); word = null; };
  const lookup = (name) => (Object.hasOwn(vars, name) ? vars[name] : env?.[name]);
  const expandVar = (i) => {
    // s[i] === '$'; returns index after the reference
    if (s[i + 1] === '(') {
      const [inner, next] = readBalanced(s, i + 2, '(', ')');
      addSub(inner);
      return next;
    }
    if (s[i + 1] === '{') {
      const [inner, next] = readBalanced(s, i + 2, '{', '}');
      const v = /^[A-Za-z_][A-Za-z0-9_]*$/.test(inner) ? lookup(inner) : undefined;
      start();
      if (v === undefined) word.dynamic = true; else word.text += v;
      return next;
    }
    const m = /^(?:env:)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(s.slice(i + 1));
    if (!m) { start(); word.text += '$'; return i + 1; }
    const v = lookup(m[1]);
    start();
    if (v === undefined) word.dynamic = true; else word.text += v;
    return i + 1 + m[0].length;
  };
  const heredocs = []; // delimiters whose bodies start after the next newline (bodies are data, not commands)
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<' && !powershell) {
      const m = /^<<-?[ \t]*(['"]?)([A-Za-z0-9_.-]+)\1/.exec(s.slice(i));
      if (m) { flush(); heredocs.push(m[2]); i += m[0].length; continue; }
    }
    if (c === '\n' && heredocs.length) {
      flush();
      out.push({ type: 'op', op: '\n' });
      i++;
      while (heredocs.length && i < s.length) {
        const nl = s.indexOf('\n', i);
        const line = s.slice(i, nl < 0 ? s.length : nl);
        i = nl < 0 ? s.length : nl + 1;
        if (line.replace(/^\t+/, '').trimEnd() === heredocs[0]) heredocs.shift();
      }
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      start(); word.quoted = true;
      word.text += s.slice(i + 1, end < 0 ? s.length : end);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === '"') {
      start(); word.quoted = true;
      i++;
      while (i < s.length && s[i] !== '"') {
        // In "...", bash keeps a backslash unless it escapes $ ` " \ or a newline: `cd "C:\Users\x\repo"` (Git Bash) is
        // C:\Users\x\repo, not C:Usersxrepo (that misread let a Windows main-checkout reset through).
        if (s[i] === '\\' && !powershell && i + 1 < s.length && '$`"\\\n'.includes(s[i + 1])) {
          if (s[i + 1] !== '\n') word.text += s[i + 1];
          i += 2;
          continue;
        }
        if (s[i] === '$') { i = expandVar(i); continue; }
        if (s[i] === '`' && !powershell) {
          const end = s.indexOf('`', i + 1);
          addSub(s.slice(i + 1, end < 0 ? s.length : end));
          i = end < 0 ? s.length : end + 1;
          continue;
        }
        word.text += s[i++];
      }
      i++;
      continue;
    }
    if (c === '\\' && !powershell) {
      if (s[i + 1] === '\n') { i += 2; continue; }
      start(); word.text += s[i + 1] ?? ''; i += 2; continue;
    }
    if (c === '`' && !powershell) {
      const end = s.indexOf('`', i + 1);
      addSub(s.slice(i + 1, end < 0 ? s.length : end));
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === '$') { i = expandVar(i); continue; }
    if (c === '#' && !word) { // comment to end of line
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue; }
    const op = OPS.find((o) => s.startsWith(o, i));
    if (op) {
      // redirections like 2>&1 / &> are not separators
      if (op === '&' && (s[i - 1] === '>' || s[i + 1] === '>')) { start(); word.text += c; i++; continue; }
      flush();
      out.push({ type: 'op', op });
      i += op.length;
      continue;
    }
    if (c === '~' && !word && (s[i + 1] === '/' || s[i + 1] === undefined || /[\s;&|)]/.test(s[i + 1]))) {
      start(); word.text += env?.HOME || os.homedir(); i++; continue;
    }
    start(); word.text += c; i++;
  }
  flush();
  return { tokens: out, subs };
}

// ---- repo kind ----

/** Walk up from `dir`: the first `.git` decides. 'main' = a directory (the shared checkout), 'linked' = a gitfile. */
export function repoKind(dir, { stat = statSync } = {}) {
  let d = resolveHost(dir);
  for (;;) {
    let st = null;
    try { st = stat(path.join(d, '.git')); } catch { /* none here */ }
    if (st) return { kind: st.isDirectory() ? 'main' : 'linked', root: d };
    const up = path.dirname(d);
    if (up === d) return { kind: 'none', root: null };
    d = up;
  }
}

const exists = (p) => { try { statSync(p); return true; } catch { return false; } };

// ---- git classification ----

/** Short-flag cluster test: `-fdx` has `f`. */
const hasShort = (args, ch) => args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(ch));
/**
 * `--name`, `--name=v`, or an abbreviation of it: parse-options takes any unique prefix (`git reset --ha` is --hard). Used
 * only on the destructive side: a prefix that is ambiguous makes git exit with an error, so over-matching never lets a write
 * through. The allowing flags (--dry-run, --help) are matched exactly.
 */
const longIs = (a, name) => {
  if (!a.startsWith('--') || a.length < 3) return false;
  const n = a.slice(2).split('=')[0];
  return n.length > 0 && name.startsWith(n);
};
const hasLongAbbr = (args, ...names) => args.some((a) => names.some((n) => longIs(a, n)));
const hasLongExact = (opts, ...names) => opts.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));

/**
 * A subcommand's args as parse-options reads them: stops at `--` and skips the value of an option that takes one (`-m <msg>`,
 * `-am <msg>`, `--file <f>` or an abbreviation of such a long option), so `commit -m -h` or `clean -e -n` never reads a value as
 * a flag. `short` = short flags with a value, `long` = long options with a value. Returns { opts, pos, after } (pos =
 * operands before `--`, after = the words after it, or null). Only the allowing tests use it; destructive flags are matched
 * on every word (over-matching only refuses).
 */
function scanArgs(args, { short = '', long = [] } = {}) {
  const opts = [];
  const pos = [];
  let after = null;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { after = args.slice(k + 1); break; }
    if (a.startsWith('--')) { opts.push(a); if (!a.includes('=') && long.some((n) => longIs(a, n))) k++; continue; }
    if (a.startsWith('-') && a.length > 1) {
      opts.push(a);
      for (let j = 1; j < a.length; j++) if (short.includes(a[j])) { if (j === a.length - 1) k++; break; }
      continue;
    }
    pos.push(a);
  }
  return { opts, pos, after };
}
const COMMIT_VALUES = { short: 'mFCct', long: ['message', 'file', 'reuse-message', 'reedit-message', 'fixup', 'squash', 'author', 'date', 'template', 'cleanup', 'trailer', 'pathspec-from-file'] };
const CLEAN_VALUES = { short: 'e', long: ['exclude'] };
const RESET_VALUES = { short: 'U', long: ['pathspec-from-file', 'unified', 'inter-hunk-context'] };

/**
 * Is `git <sub> <args>` destructive to uncommitted work or the shared branch? Returns a short label or null. `dir` (or
 * UNKNOWN) is used only to tell a path from a revision when no `--` separates them (`checkout <x>`, `reset <x>`).
 * `appended`: a wrapper (xargs) adds more operands at the end.
 */
export function destructiveGit(sub, args, dir, { appended = false } = {}) {
  // Help only as the first word: git turns `git <cmd> --help` into `git help <cmd>`, and `-h` first prints usage. Elsewhere
  // `-h` may be an option's value (`commit -m -h`).
  if (args[0] === '-h' || args[0] === '--help') return null;
  switch (sub) {
    case 'reset': {
      if (hasLongAbbr(args, 'hard')) return 'git reset --hard';
      if (hasLongAbbr(args, 'merge')) return 'git reset --merge'; // both rewrite work-tree files too
      if (hasLongAbbr(args, 'keep')) return 'git reset --keep';
      if (hasLongAbbr(args, 'soft')) return 'git reset --soft'; // only ever moves HEAD: the shared branch
      // Mixed: with paths it only unstages (index); with a lone revision it moves the shared branch like a commit.
      const { pos, after } = scanArgs(args, RESET_VALUES);
      if (after !== null || pos.length !== 1 || appended) return null; // `reset [<rev>] -- <paths>` / `reset <rev> <paths>`
      const p = pos[0];
      if (p === 'HEAD' || p === '@') return null;
      if (dir !== UNKNOWN && exists(path.resolve(dir, p))) return null; // `git reset a.txt`: unstage a path
      return 'git reset <commit>';
    }
    case 'checkout': {
      if (hasLongAbbr(args, 'force') || hasShort(args, 'f')) return 'git checkout -f';
      const dd = args.indexOf('--');
      if (dd >= 0 && (dd < args.length - 1 || appended)) return 'git checkout -- <paths>'; // xargs supplies the paths
      if (hasLongAbbr(args, 'pathspec-from-file')) return 'git checkout --pathspec-from-file';
      const creates = hasShort(args, 'b') || hasShort(args, 'B') || hasLongExact(args, '--orphan');
      const pos = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (a === '--') break;
        if (/^-[bB]$/.test(a) || a === '--orphan' || a === '--conflict') { k++; continue; } // option with a value
        if (!a.startsWith('-')) pos.push(a);
      }
      if (pos.some((p) => p === '.' || p.startsWith(':/') || p === '*' || p.endsWith('/'))) return 'git checkout .';
      if (creates) return null; // checkout -b <new> [<start-point>]
      if (pos.length >= 2 || (appended && pos.length === 1)) return 'git checkout <tree-ish> <paths>'; // without -b, everything after the first is a path
      // A lone argument: a branch switch, unless it names something on disk (then git restores that path).
      if (pos.length === 1 && dir !== UNKNOWN && exists(path.resolve(dir, pos[0]))) return 'git checkout <paths>';
      return null;
    }
    case 'switch':
      return hasLongAbbr(args, 'discard-changes', 'force') || hasShort(args, 'f') ? 'git switch --discard-changes' : null;
    case 'clean': {
      const { opts } = scanArgs(args, CLEAN_VALUES);
      return hasLongExact(opts, '--dry-run') || hasShort(opts, 'n') ? null : 'git clean';
    }
    case 'stash': {
      const verb = args[0] && !args[0].startsWith('-') ? args[0] : 'push'; // `git stash -u` = push
      if (['list', 'show', 'create'].includes(verb)) return null;
      return `git stash ${verb}`;
    }
    case 'restore':
      return 'git restore';
    // idea-888 (R17): writes that move or rewrite the shared checkout's branch, index or files.
    case 'commit':
      return hasLongExact(scanArgs(args, COMMIT_VALUES).opts, '--dry-run') ? null : 'git commit';
    case 'merge':
    case 'rebase':
    case 'pull':
    case 'cherry-pick':
    case 'revert':
    case 'am':
      return `git ${sub}`;
    default:
      return null;
  }
}

/** Labels that write only the repository (HEAD, refs, index), never work-tree files: judged by the git dir when one is given. */
const REPO_ONLY = new Set(['git commit', 'git reset --soft', 'git reset <commit>']);

/** Parse `git [global opts] <sub> <args>` from argv (without the leading `git`). */
export function parseGitArgv(argv, cwd, { workTree: envWorkTree = null, gitDir: envGitDir = null } = {}) {
  let dir = cwd;
  let workTree = envWorkTree; // GIT_WORK_TREE / GIT_DIR from the command's env; --work-tree / --git-dir override them
  let gitDir = envGitDir;
  const resolveFrom = (base, p) => (base === UNKNOWN || p === UNKNOWN ? (path.isAbsolute(String(p)) ? resolveHost(p) : UNKNOWN) : resolveHost(base, p));
  let k = 0;
  for (; k < argv.length; k++) {
    const w = argv[k];
    const a = w.text;
    const val = () => { const n = argv[++k]; return !n ? UNKNOWN : n.dynamic ? UNKNOWN : n.text; };
    if (a === '-C') { dir = resolveFrom(dir, val()); continue; }
    if (a === '--work-tree') { workTree = val(); continue; }
    if (a.startsWith('--work-tree=')) { workTree = w.dynamic ? UNKNOWN : a.slice(12); continue; }
    if (a === '--git-dir') { gitDir = val(); continue; }
    if (a.startsWith('--git-dir=')) { gitDir = w.dynamic ? UNKNOWN : a.slice(10); continue; }
    // The other global options whose value is the next word (git.c handle_options; `--opt=value` forms fall through to the
    // `-` skip). Keep in sync with the shim's skip list (runner/git-shim/git).
    if (GIT_GLOBAL_VALUE_OPTS.has(a)) { k++; continue; }
    if (a.startsWith('-')) continue;
    break;
  }
  const sub = argv[k]?.text ?? '';
  const args = argv.slice(k + 1).map((w) => w.text);
  // Relative --git-dir / GIT_DIR resolve against the cwd (after every -C), as git does: never against the work tree.
  const base = dir;
  if (workTree !== null) dir = resolveFrom(dir, workTree);
  let forced = null;
  // The repository a --git-dir / GIT_DIR names (even next to a work tree): a commit writes only there, so a shadow repo over
  // the main checkout's files (opencode/agy snapshots: `--git-dir=<shadow> --work-tree=<checkout> commit`) is not the main repo.
  let gitDirRepo = null;
  if (gitDir !== null) {
    const gd = resolveFrom(base, gitDir);
    if (gd !== UNKNOWN) gitDirRepo = path.basename(gd) === '.git' ? repoKind(path.dirname(gd)) : { kind: 'linked', root: gd };
  }
  if (workTree === null && gitDir !== null) {
    if (gitDirRepo === null) dir = UNKNOWN;
    else forced = gitDirRepo; // .git/worktrees/<x> or a bare repo is 'linked': not the shared checkout
  }
  return {
    sub, args, dir, forced, gitDirRepo,
    subDynamic: !!argv[k]?.dynamic, globalWords: argv.slice(0, k), restWords: argv.slice(k + 1),
  };
}

// ---- aliases (Tier A review round 1) ----

/** Global options that take the next word as their value (git 2.53 handle_options; --super-prefix for older gits). */
export const GIT_GLOBAL_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source', '--shallow-file', '--super-prefix']);
/** The write subcommands both gates classify (destructiveGit). Keep in sync with the shim's list. */
export const GIT_WRITE_VERBS = ['reset', 'checkout', 'switch', 'clean', 'stash', 'restore', 'commit', 'merge', 'rebase', 'pull', 'cherry-pick', 'revert', 'am'];
/**
 * Long-standing git builtins (or git-core commands) that destructiveGit never refuses. git runs a builtin or a git-core
 * command before it looks at aliases, so no `-c alias.<x>=` / --config-env / config-file alias can turn one into a write:
 * the shim execs these at once (no node start) and classifyGit skips the alias lookup. Anything not here or in
 * GIT_WRITE_VERBS (an alias, an external git-<x>, a newer builtin) costs one `git config --get alias.<sub>`. Never add a
 * name that is not a builtin on every git a worker may run: an alias of that name would then skip the check.
 */
export const GIT_SAFE_BUILTINS = [
  'status', 'log', 'diff', 'show', 'rev-parse', 'rev-list', 'branch', 'tag', 'fetch', 'push', 'remote', 'config', 'worktree',
  'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'describe', 'blame', 'annotate', 'grep', 'for-each-ref', 'show-ref',
  'symbolic-ref', 'merge-base', 'name-rev', 'shortlog', 'reflog', 'format-patch', 'range-diff', 'diff-tree', 'diff-index',
  'diff-files', 'check-ignore', 'check-attr', 'check-ref-format', 'hash-object', 'count-objects', 'fsck', 'gc', 'var', 'help',
  'version', 'init', 'clone', 'add', 'rm', 'mv', 'notes', 'show-branch', 'cherry', 'archive', 'bundle', 'verify-commit',
  'verify-tag', 'submodule', 'bisect', 'difftool', 'mergetool',
];
const BUILTIN = new Set([...GIT_SAFE_BUILTINS, ...GIT_WRITE_VERBS]);
const ALIAS_DEPTH = 8;

/** git's split_cmdline for an alias value: whitespace-separated words, '...' / "..." quoting, backslash escapes; null on an open quote. */
export function splitAlias(s) {
  const out = [];
  let cur = null;
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = '';
      else if (c === '\\' && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
      continue;
    }
    if (/\s/.test(c)) { if (cur !== null) out.push(cur); cur = null; continue; }
    if (cur === null) cur = '';
    if (c === "'" || c === '"') q = c;
    else if (c === '\\' && i + 1 < s.length) cur += s[++i];
    else cur += c;
  }
  if (q) return null;
  if (cur !== null) out.push(cur);
  return out;
}

/**
 * The alias git would expand for `git <globals> <sub>`: asks git itself, `git <globals> config --get alias.<sub>` in `cwd`
 * with `env`, so inline `-c alias.<sub>=`, --config-env, GIT_CONFIG_* and every config file (repo, worktree, global,
 * includes) count exactly as they would. Returns the value, null (no alias: an external git-<sub> or a typo), or UNKNOWN
 * (the lookup could not run: the caller fails closed).
 */
export function gitAliasLookup(globals, sub, { cwd, env = process.env, git = 'git' } = {}) {
  if (!cwd || cwd === UNKNOWN || globals.some((g) => g === UNKNOWN)) return UNKNOWN;
  const e = env?.PATH ? env : { ...env, PATH: process.env.PATH ?? '' };
  let r;
  try {
    r = spawnSync(git, [...globals, 'config', '--get', `alias.${sub}`], { cwd, env: e, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { return UNKNOWN; }
  if (r.status === 0) return r.stdout.replace(/\r?\n$/, '');
  if (r.status === 1 && !r.error) return null;
  return UNKNOWN;
}

/**
 * Classify one git invocation (words after `git`): parse it, expand aliases the way git would (a non-builtin subcommand
 * through `lookup(globalTexts, sub)`, repeatedly, alias words re-parsed in place so an alias may carry global options),
 * then destructiveGit. Returns { label, g } with g the final parseGitArgv result. A `!shell` alias (its commands run with
 * git's exec-path first on PATH, past the shim) and an alias that cannot be resolved get a label, so judgeGit refuses
 * them in a main checkout or an unresolved dir.
 */
export function classifyGit(words, cwd, gitEnv, { appended = false, lookup = () => UNKNOWN } = {}) {
  let ws = words;
  for (let depth = 0; ; depth++) {
    const g = parseGitArgv(ws, cwd, gitEnv);
    if (!g.sub || g.subDynamic || BUILTIN.has(g.sub)) return { label: destructiveGit(g.sub, g.args, g.dir, { appended }), g };
    const globals = g.globalWords.map((w) => (w.dynamic ? UNKNOWN : w.text));
    const value = depth >= ALIAS_DEPTH ? UNKNOWN : lookup(globals, g.sub);
    if (value === null) return { label: null, g };
    if (value === UNKNOWN) return { label: `git ${g.sub} (an alias that could not be resolved)`, g };
    if (value.trimStart().startsWith('!')) return { label: `git ${g.sub} (a !shell alias)`, g };
    const expanded = splitAlias(value);
    if (!expanded || !expanded.length) return { label: `git ${g.sub} (an alias that could not be resolved)`, g };
    ws = [...g.globalWords, ...expanded.map((text) => ({ text, dynamic: false, quoted: true })), ...g.restWords];
  }
}

/** The violation for a classified git command `g` (parseGitArgv) with destructive label `label`, or null. */
function judgeGit(label, g) {
  const target = REPO_ONLY.has(label) && g.gitDirRepo ? g.gitDirRepo : g.forced;
  if (target) return target.kind === 'main' ? { label, dir: target.root, root: target.root, unresolved: false } : null;
  if (g.dir === UNKNOWN) return { label, dir: null, root: null, unresolved: true };
  const rk = repoKind(g.dir);
  return rk.kind === 'main' ? { label, dir: g.dir, root: rk.root, unresolved: false } : null;
}

// ---- command walk ----

/**
 * Find the first destructive git command a worker would run in a main checkout. Returns null (allow) or
 * { label, dir, root, unresolved } for the refusal message.
 */
const GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE'];

/** GIT_DIR / GIT_WORK_TREE of an env-like object (values: string or UNKNOWN). */
const gitEnvOf = (e) => Object.fromEntries(GIT_ENV.filter((k) => e && Object.hasOwn(e, k) && e[k] !== undefined && e[k] !== '').map((k) => [k, e[k]]));

export function findViolation(command, { cwd = process.cwd(), env = process.env, powershell = false, depth = 0, gitEnv = null } = {}) {
  const src = String(command ?? '');
  if (depth > 4 || !/git/i.test(src)) return null;
  // Pass 1 collects literal `NAME=value` assignment statements, so pass 2 can expand `D=/x; cd $D` (approximation: the
  // last literal assignment of a name wins wherever it is used).
  const vars = {};
  {
    let stmt = [];
    const take = () => {
      if (stmt.length && stmt.every((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text) && !w.dynamic)) {
        for (const w of stmt) { const eq = w.text.indexOf('='); vars[w.text.slice(0, eq)] = w.text.slice(eq + 1); }
      }
      stmt = [];
    };
    for (const t of tokenize(src, { env, powershell }).tokens) { if (t.type === 'op') take(); else stmt.push(t); }
    take();
  }
  const { tokens } = tokenize(src, { env, vars, powershell });
  // split into segments
  const segs = [];
  let cur = [];
  for (const t of tokens) {
    if (t.type === 'op') { segs.push({ words: cur, op: t.op }); cur = []; } else cur.push(t);
  }
  segs.push({ words: cur, op: null });

  let dir = cwd ? resolveHost(cwd) : UNKNOWN;
  const resolveDir = (base, w) => {
    if (!w || w === UNKNOWN || w.dynamic) return UNKNOWN;
    if (path.isAbsolute(w.text)) return resolveHost(w.text);
    return base === UNKNOWN ? UNKNOWN : resolveHost(base, w.text);
  };
  // GIT_DIR / GIT_WORK_TREE every git here sees: inherited from the agent's env (the hook's own env), or handed down by the
  // caller (bash -c / eval / xargs / $(...) bodies get the env their shell had), then `export`/`unset` along the line.
  const exported = gitEnv ? { ...gitEnv } : gitEnvOf(env);
  const nested = (body, at, e) => findViolation(body, { cwd: at === UNKNOWN ? null : at, env, powershell, depth: depth + 1, gitEnv: gitEnvOf(e) });
  const stack = []; // open `( ... )` subshells ({ kind: 'sub', dir }) and `case ... esac` ({ kind: 'case' }): a case pattern's `)` closes nothing
  const dirStack = [];
  let prevOp = null;
  for (const { words, op } of segs) {
    const piped = prevOp === '|' || prevOp === '|&' || op === '|' || op === '|&' || op === '&';
    prevOp = op;
    // $(...) / `...` in any word run first, in the dir the shell is in now (before this segment's cd takes effect)
    for (const w of words) {
      for (const body of w.subs ?? []) {
        const v = nested(body, dir, exported);
        if (v) return v;
      }
    }
    const endSeg = () => {
      if (op === '(') stack.push({ kind: 'sub', dir });
      else if (op === ')' && stack.at(-1)?.kind === 'sub') dir = stack.pop().dir;
    };
    let ws = words;
    let appended = false;
    let segDir = dir; // env -C / sudo -D move only the wrapped command
    const segEnv = { ...exported };
    // Strip leading NAME=value prefixes, compound-command keywords and wrappers (with their option values), in any order.
    for (let guard = 0; ws.length && guard < 64; guard++) {
      const w0 = ws[0];
      if (ASSIGN.test(w0.text)) {
        const eq = w0.text.indexOf('=');
        segEnv[w0.text.slice(0, eq)] = w0.dynamic ? UNKNOWN : w0.text.slice(eq + 1);
        ws = ws.slice(1);
        continue;
      }
      if (!w0.quoted && w0.text === 'function') { ws = ws.slice(2); continue; } // `function f { ...; }`: name, then the body
      if (!w0.quoted && w0.text === 'esac') { if (stack.at(-1)?.kind === 'case') stack.pop(); ws = ws.slice(1); continue; }
      if (!w0.quoted && KEYWORDS.has(w0.text)) { ws = ws.slice(1); continue; }
      const wname = path.basename(w0.text).toLowerCase().replace(/\.exe$/, '');
      const spec = Object.hasOwn(WRAPPERS, wname) ? WRAPPERS[wname] : null;
      if (!spec) break;
      ws = ws.slice(1);
      if (spec.appends) appended = true;
      const apply = (flag, value) => {
        if (spec.chdir?.includes(flag)) segDir = resolveDir(segDir, value);
        else if (spec.unset?.includes(flag) && value && value !== UNKNOWN) delete segEnv[value.text];
        else if (spec.split?.includes(flag) && value && value !== UNKNOWN) {
          ws = [...tokenize(value.text, { env, vars, powershell }).tokens.filter((t) => t.type === 'word'), ...ws];
        }
      };
      while (ws.length) {
        const a = ws[0].text;
        if (a === '--') { ws = ws.slice(1); break; }
        if (!a.startsWith('-') || a === '-') break;
        const flagWord = ws[0];
        ws = ws.slice(1);
        const iAt = /^-[A-Za-z]+$/.test(a) ? a.indexOf('i') : -1; // `-i` or a cluster with i before any value flag (`-iC dir`)
        if (spec.clear?.includes(a) || (spec.clear && iAt > 0 && !/[uCS]/.test(a.slice(1, iAt)))) {
          for (const k of GIT_ENV) delete segEnv[k]; // env -i: the command starts with an empty environment
        }
        if (a.startsWith('--')) {
          const eq = a.indexOf('=');
          const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
          if (!(spec.long ?? []).includes(name)) continue;
          let value;
          if (eq >= 0) value = { text: a.slice(eq + 1), dynamic: flagWord.dynamic };
          else { value = ws[0] ?? UNKNOWN; ws = ws.slice(1); }
          apply(`--${name}`, value);
          continue;
        }
        for (let j = 1; j < a.length; j++) {
          if (!(spec.short ?? '').includes(a[j])) continue;
          const rest = a.slice(j + 1);
          let value;
          if (rest) value = { text: rest, dynamic: flagWord.dynamic };
          else { value = ws[0] ?? UNKNOWN; ws = ws.slice(1); }
          apply(`-${a[j]}`, value);
          break;
        }
      }
      ws = ws.slice(spec.positional ?? 0);
    }
    if (!ws.length) { endSeg(); continue; }
    const cmd = ws[0].text;
    const base = path.basename(cmd).toLowerCase().replace(/\.exe$/, '');
    if (!ws[0].quoted && cmd === 'case') {
      stack.push({ kind: 'case' }); // `case WORD in PATTERN)`: that `)` (and later ones) are pattern ends until esac
    } else if (CD.has(cmd.toLowerCase())) {
      const t = ws.slice(1).filter((w) => !/^-(L|P|e|@|Path|LiteralPath)$/i.test(w.text))[0];
      const push = cmd.toLowerCase() === 'pushd' || cmd.toLowerCase() === 'push-location';
      if (!piped) {
        if (push && !t) {
          // bare pushd swaps the current dir with the top of the stack (an error, no change, when the stack is empty)
          if (dirStack.length) { const top = dirStack.pop(); dirStack.push(dir); dir = top; }
        } else if (push && /^[+-]\d+$/.test(t.text)) {
          dir = UNKNOWN; // stack rotation
        } else {
          const next = !t ? resolveHost(env?.HOME || os.homedir()) : t.text === '-' ? UNKNOWN : resolveDir(dir, t);
          if (push) dirStack.push(dir);
          dir = next;
        }
      }
    } else if (base === 'popd' || base === 'pop-location') {
      if (!piped) dir = dirStack.length ? dirStack.pop() : UNKNOWN;
    } else if (base === 'unset') {
      if (!piped) for (const w of ws.slice(1)) delete exported[w.text];
    } else if (base === 'export') {
      for (const w of ws.slice(1)) {
        if (!ASSIGN.test(w.text)) continue;
        const eq = w.text.indexOf('=');
        if (!piped) exported[w.text.slice(0, eq)] = w.dynamic ? UNKNOWN : w.text.slice(eq + 1);
      }
    } else if (SHELLS.has(base)) {
      // bash parses every option first (`-c -- 'x'`, `-o pipefail -c 'x'`, `-ec 'x'`); with -c the first operand is the script
      let sawC = false;
      let script = null;
      for (let i = 1; i < ws.length; i++) {
        const t = ws[i].text;
        if (t === '--') { if (sawC) script = ws[i + 1] ?? null; break; }
        if (/^[-+][oO]$/.test(t)) { i++; continue; }
        if (/^[-+][A-Za-z]+$/.test(t)) { if (t[0] === '-' && t.includes('c')) sawC = true; continue; }
        if (t.startsWith('--')) continue;
        if (sawC) script = ws[i];
        break;
      }
      if (script) {
        const v = nested(script.text, segDir, segEnv);
        if (v) return v;
      }
    } else if (base === 'eval') {
      const rest = ws.slice(1);
      const v = nested((rest[0]?.text === '--' ? rest.slice(1) : rest).map((w) => w.text).join(' '), segDir, segEnv);
      if (v) return v;
    } else if (base === 'git') {
      const gitEnv = {
        workTree: Object.hasOwn(segEnv, 'GIT_WORK_TREE') ? segEnv.GIT_WORK_TREE : null,
        gitDir: Object.hasOwn(segEnv, 'GIT_DIR') ? segEnv.GIT_DIR : null,
      };
      // Alias lookups see the env this git would: the hook's env with this segment's GIT_DIR / GIT_WORK_TREE.
      const lookup = (globals, sub) => {
        if (gitEnv.workTree === UNKNOWN || gitEnv.gitDir === UNKNOWN) return UNKNOWN;
        const e = { ...env };
        for (const k of GIT_ENV) delete e[k];
        if (gitEnv.workTree !== null) e.GIT_WORK_TREE = gitEnv.workTree;
        if (gitEnv.gitDir !== null) e.GIT_DIR = gitEnv.gitDir;
        return gitAliasLookup(globals, sub, { cwd: segDir, env: e });
      };
      const { label, g } = classifyGit(ws.slice(1), segDir, gitEnv, { appended, lookup });
      const v = label ? judgeGit(label, g) : null;
      if (v) return v;
    }
    endSeg();
  }
  return null;
}

/** The text the worker sees (Claude Code shows hook stderr on exit 2). */
export function gitGuardRefusalText(v) {
  if (v.unresolved) {
    return `vs git-guard: refused \`${v.label}\`: workers may run it only inside their own linked worktree, and the directory it runs in ` +
      'could not be resolved (a dynamic cd / -C target such as $(...) or an unset variable). ' +
      'Use a literal path: `cd <your worktree> && pwd` first, or `git -C <absolute worktree path> ...`. ' +
      'No worktree yet? `vs worktree create <unit>`, then cd into the path it prints.';
  }
  return `vs git-guard: refused \`${v.label}\` in ${v.root}: that is the repo's MAIN checkout (.git is a directory), shared by every agent; ` +
    'other agents\' uncommitted edits live there and this would wipe them or rewrite the branch under them (R17: workers never run git writes in a main checkout). ' +
    'Run it in your own linked worktree instead: `vs worktree create <unit>`, then `cd <the path it prints> && pwd`, and rerun it there. ' +
    'Read-only git (status, diff, log, show), `git checkout -b`, `git clean -n` and `git stash list` are fine here.';
}

/** Pure hook decision: refusal text for a worker's Bash/PowerShell call, else null. */
export function gitGuardDecision(input, { env = process.env } = {}) {
  const tool = input?.tool_name;
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || !/git/i.test(command)) return null;
  const v = findViolation(command, { cwd: input?.cwd || process.cwd(), env, powershell: tool === 'PowerShell' });
  return v ? gitGuardRefusalText(v) : null;
}

// ---- provider-neutral PATH gate (idea-888) ----

/** The runner role that gets the guard (hook and PATH gate): the agent env (runner agentEnv's VS_ROLE) wins, then meta. */
export const isWorkerAgent = (meta = {}, env = {}) => String(env?.VS_ROLE ?? meta?.role ?? meta?.labels?.role ?? '').trim().toLowerCase() === 'worker';

/** The dir whose `git` shim goes first on a worker's PATH. Holds nothing else, so no other command resolves there. */
export const GIT_SHIM_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'git-shim');
/** Env var naming the node binary the shim runs the check with (the runner's own node); unset -> `node` from PATH. */
export const GIT_SHIM_NODE_ENV = 'VS_GIT_GUARD_NODE';

// A shim that lost its exec bit (a copy that dropped the mode) is skipped by every PATH lookup: git would run unguarded with
// no error. Restore 0755 once per runner process; a missing file stays a silent miss (the Claude hook still covers Claude).
const executableOk = new Set();
function ensureExecutable(file) {
  if (executableOk.has(file)) return;
  try { accessSync(file, fsConstants.X_OK); executableOk.add(file); return; } catch { /* not executable or missing */ }
  try { chmodSync(file, 0o755); accessSync(file, fsConstants.X_OK); executableOk.add(file); } catch { /* missing or read-only: nothing to heal */ }
}

/** The marker line every copy of runner/git-shim/git carries in its header (since 77f30d4c, the shim's first commit). */
export const GIT_SHIM_MARKER = 'VibeSquad worker git gate';

/**
 * Is PATH entry `dir` a VibeSquad git-shim dir, of ANY copy (this module's, the runtime's, an older checkout's)? Two tests,
 * both required: the cheap path rule first (basename `git-shim`, the same rule the shim uses to skip shims when it looks
 * for the real git), then the content rule (its `git` opens, following symlinks, to a regular file whose first 512 bytes hold GIT_SHIM_MARKER). The
 * path rule keeps the cost at zero I/O for ordinary entries; the content rule keeps a user's own `git-shim` dir that holds
 * some other git (or none) on PATH. A dir like /usr/bin is never even opened. Unreadable or missing `git`: not a shim.
 */
export function isGitShimDir(dir) {
  if (!dir || path.basename(path.resolve(dir)) !== 'git-shim') return false;
  let fd;
  try {
    // One open, then fstat and read on that same fd: no stat/open TOCTOU (Gemini Tier A low on d7f115fe). O_NONBLOCK so a
    // FIFO named `git` fails the isFile check instead of hanging the open. Symlinks are followed (no O_NOFOLLOW): the fd is
    // what gets checked, and a `git` that links to a real shim IS a shim; not stripping it would re-gate leads (idea-1167).
    fd = openSync(path.join(dir, 'git'), fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) return false;
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8', 0, n).includes(GIT_SHIM_MARKER);
  } catch { return false; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ } }
}

/**
 * Put the git shim first on PATH for a worker, in place on `env` (runner.mjs agentEnv's copy). Every role first loses EVERY
 * inherited git-shim entry, whichever copy it is (isGitShimDir; idea-1167): a runner or a test suite started from a worker's
 * shell carries the runtime copy (~/.vibesquad/runtime/runner/git-shim), not this module's, and must not gate its leads.
 * Workers then carry exactly one shim, their own `shimDir`, first. win32: no-op (the shim is a POSIX sh script; cmd/PowerShell
 * would not run it). Returns `env`.
 */
export function applyGitShim(env, { worker = false, platform = process.platform, execPath = process.execPath, shimDir = GIT_SHIM_DIR } = {}) {
  if (platform === 'win32' || !env) return env;
  const rest = String(env.PATH ?? '').split(':').filter((d) => d && path.resolve(d) !== shimDir && !isGitShimDir(d));
  delete env[GIT_SHIM_NODE_ENV];
  if (worker) {
    ensureExecutable(path.join(shimDir, 'git'));
    env.PATH = [shimDir, ...rest].join(':');
    // Only a real node binary: a runner hosted in another executable (electron etc.) leaves the shim on PATH's node.
    if (/^node(\.exe)?$/i.test(path.basename(execPath ?? ''))) env[GIT_SHIM_NODE_ENV] = execPath;
  } else if (env.PATH !== undefined) {
    env.PATH = rest.join(':');
  }
  return env;
}

const within = (p, root) => { const r = path.relative(root, p); return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r)); };

/** Temp dirs whose main checkouts are scratch repos (tests, scripts), not a shared checkout: os.tmpdir() for `env`, plus its realpath. */
export function scratchRootsOf(env = process.env) {
  const t = env?.TMPDIR || env?.TMP || env?.TEMP || os.tmpdir();
  const resolved = resolveHost(t);
  const roots = new Set([resolved]);
  try { roots.add(realpathSync(resolved)); } catch { /* missing temp dir: the literal path only */ }
  return [...roots].filter((r) => path.dirname(r) !== r); // never `/`: TMPDIR=/ must not exempt every repo
}

/**
 * The PATH gate's decision for one real git invocation: `argv` without the leading `git`, run in `cwd` with `env`
 * (GIT_DIR / GIT_WORK_TREE read from it). Same classifier and main-checkout test as the hook. `git`: the real git for
 * alias lookups (the shim passes its own pick, VS_GIT_REAL). Returns null (allow) or the violation for gitGuardRefusalText.
 */
export function gitArgvViolation(argv, { cwd = process.cwd(), env = process.env, scratchRoots = scratchRootsOf(env), git = 'git' } = {}) {
  const words = (argv ?? []).map((text) => ({ text: String(text), dynamic: false, quoted: true }));
  const at = resolveHost(cwd);
  const lookup = (globals, sub) => gitAliasLookup(globals, sub, { cwd: at, env, git });
  const { label, g } = classifyGit(words, at, { workTree: env?.GIT_WORK_TREE || null, gitDir: env?.GIT_DIR || null }, { lookup });
  const v = label ? judgeGit(label, g) : null;
  if (v?.root && scratchRoots.some((r) => within(v.root, r))) return null;
  return v;
}
