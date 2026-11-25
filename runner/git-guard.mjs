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
// Known gaps: git aliases, scripts that run git themselves, and ACP providers (no PreToolUse hook: adapters/acp.mjs).
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
        if (s[i] === '\\' && !powershell && i + 1 < s.length) { word.text += s[i + 1]; i += 2; continue; }
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
  let d = path.resolve(dir);
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
const hasLong = (args, ...names) => args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));

/**
 * Is `git <sub> <args>` destructive to uncommitted work? Returns a short label or null. `dir` (or UNKNOWN) is used only
 * to tell a `checkout <path>` from a `checkout <branch>` when no `--` separates them. `appended`: a wrapper (xargs) adds
 * more operands at the end.
 */
export function destructiveGit(sub, args, dir, { appended = false } = {}) {
  if (hasLong(args, '--help') || args.includes('-h')) return null;
  switch (sub) {
    case 'reset':
      return hasLong(args, '--hard') ? 'git reset --hard' : null;
    case 'checkout': {
      if (hasLong(args, '--force') || hasShort(args, 'f')) return 'git checkout -f';
      const dd = args.indexOf('--');
      if (dd >= 0 && (dd < args.length - 1 || appended)) return 'git checkout -- <paths>'; // xargs supplies the paths
      if (hasLong(args, '--pathspec-from-file')) return 'git checkout --pathspec-from-file';
      const creates = hasShort(args, 'b') || hasShort(args, 'B') || hasLong(args, '--orphan');
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
      return hasLong(args, '--discard-changes', '--force') || hasShort(args, 'f') ? 'git switch --discard-changes' : null;
    case 'clean':
      return hasLong(args, '--dry-run') || hasShort(args, 'n') ? null : 'git clean';
    case 'stash': {
      const verb = args[0] && !args[0].startsWith('-') ? args[0] : 'push'; // `git stash -u` = push
      if (['list', 'show', 'create'].includes(verb)) return null;
      return `git stash ${verb}`;
    }
    case 'restore':
      return 'git restore';
    default:
      return null;
  }
}

/** Parse `git [global opts] <sub> <args>` from argv (without the leading `git`). */
export function parseGitArgv(argv, cwd, { workTree: envWorkTree = null, gitDir: envGitDir = null } = {}) {
  let dir = cwd;
  let workTree = envWorkTree; // GIT_WORK_TREE / GIT_DIR from the command's env; --work-tree / --git-dir override them
  let gitDir = envGitDir;
  const resolveFrom = (base, p) => (base === UNKNOWN || p === UNKNOWN ? (path.isAbsolute(String(p)) ? path.resolve(p) : UNKNOWN) : path.resolve(base, p));
  let k = 0;
  for (; k < argv.length; k++) {
    const w = argv[k];
    const a = w.text;
    const val = () => { const n = argv[++k]; return !n ? UNKNOWN : n.dynamic ? UNKNOWN : n.text; };
    if (a === '-C') { dir = resolveFrom(dir, val()); continue; }
    if (a === '-c' || a === '--namespace' || a === '--super-prefix' || a === '--config-env' || a === '--exec-path') { if (!a.includes('=')) k++; continue; }
    if (a === '--work-tree') { workTree = val(); continue; }
    if (a.startsWith('--work-tree=')) { workTree = w.dynamic ? UNKNOWN : a.slice(12); continue; }
    if (a === '--git-dir') { gitDir = val(); continue; }
    if (a.startsWith('--git-dir=')) { gitDir = w.dynamic ? UNKNOWN : a.slice(10); continue; }
    if (a.startsWith('-')) continue;
    break;
  }
  const sub = argv[k]?.text ?? '';
  const args = argv.slice(k + 1).map((w) => w.text);
  if (workTree !== null) dir = resolveFrom(dir, workTree);
  let forced = null;
  if (workTree === null && gitDir !== null) {
    const gd = resolveFrom(dir, gitDir);
    if (gd === UNKNOWN) dir = UNKNOWN;
    else if (path.basename(gd) === '.git') forced = repoKind(path.dirname(gd));
    else forced = { kind: 'linked', root: gd }; // .git/worktrees/<x> or a bare repo: not the shared checkout
  }
  return { sub, args, dir, forced };
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

  let dir = cwd ? path.resolve(cwd) : UNKNOWN;
  const resolveDir = (base, w) => {
    if (!w || w === UNKNOWN || w.dynamic) return UNKNOWN;
    if (path.isAbsolute(w.text)) return path.resolve(w.text);
    return base === UNKNOWN ? UNKNOWN : path.resolve(base, w.text);
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
          const next = !t ? env?.HOME || os.homedir() : t.text === '-' ? UNKNOWN : resolveDir(dir, t);
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
      const g = parseGitArgv(ws.slice(1), segDir, {
        workTree: Object.hasOwn(segEnv, 'GIT_WORK_TREE') ? segEnv.GIT_WORK_TREE : null,
        gitDir: Object.hasOwn(segEnv, 'GIT_DIR') ? segEnv.GIT_DIR : null,
      });
      const label = destructiveGit(g.sub, g.args, g.dir, { appended });
      if (label) {
        if (g.forced) {
          if (g.forced.kind === 'main') return { label, dir: g.forced.root, root: g.forced.root, unresolved: false };
        } else if (g.dir === UNKNOWN) {
          return { label, dir: null, root: null, unresolved: true };
        } else {
          const rk = repoKind(g.dir);
          if (rk.kind === 'main') return { label, dir: g.dir, root: rk.root, unresolved: false };
        }
      }
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
    'other agents\' uncommitted edits live there and this would wipe them (R17: workers never run destructive git in a main checkout). ' +
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
