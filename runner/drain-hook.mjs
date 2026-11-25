// Claude Code PreToolUse hook for runner agents (ideas 198 + 186): while a `vs restart` drains the runner, a NEW background
// command (Bash/PowerShell with run_in_background) is refused with a clear message instead of becoming a park hold the
// restart has to wait out. idea-697: so is a FOREGROUND command that backgrounds itself (`nohup x &`, setsid; selfBackgrounds).
// Other foreground commands and everything outside a drain pass untouched.
//   node runner/drain-hook.mjs <runner home>/drain.json      (installed by adapters/claude.mjs via --settings hooks)
// The drain file is written by Runner.setDrain and removed on clear, expiry and runner start; the hook also checks `until`
// itself, so a file a crashed runner left behind never blocks anything past its TTL. Any read/parse error allows (exit 0).
// Exit 2 + stderr is Claude Code's "block this tool call and show the model why".
// idea-767: with --git-guard (installed for role=worker agents only) the same hook also refuses destructive git in a repo's
// main checkout (runner/git-guard.mjs). Workers always read stdin; everyone else keeps the no-drain fast path.
//   node runner/drain-hook.mjs <drain.json | -> [--git-guard]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DRAIN_TOOLS = new Set(['Bash', 'PowerShell']);

/** The refusal text an agent sees for a background launch while draining. */
export function drainRefusalText(drain) {
  if (drain?.kind === 'request') { // idea-476: a server-side restart request is open (runner setRequestDrain); vs restart has not started yet
    const what = drain.request?.id ? `restart request ${drain.request.id}${drain.request.tip ? `, tip ${drain.request.tip}` : ''}` : 'a restart request';
    return `restart drain open (${what}): new background commands are refused so the restart is not held up. ` +
      'Run it in the foreground, or wait for restart-done and start it in the background then. Already-running background work keeps running.';
  }
  const until = Number.isFinite(drain?.until) ? new Date(drain.until).toISOString() : 'shortly';
  return `VibeSquad is draining for a runtime restart (${drain?.reason || 'vs restart'}; drain ends by ${until} at the latest): ` +
    'new background commands are refused so the restart is not held up. Already-running background work keeps running. ' +
    'Do not start the suite/build in the foreground instead; finish your turn and retry it after the restart.';
}

// idea-697: a FOREGROUND command that backgrounds itself (`nohup x > log &`, `setsid x`, `(x &)`, `disown`) leaves the tool
// shell at once: the shell exits, the work is reparented outside the CLI's tree and no park hold or drain refusal ever sees
// it. Quoted strings, escapes and comments are dropped first (`echo "a & b"`, `grep '&'`), so only a real control operator
// counts; `&&`, `2>&1`, `>&2`, `&>`, `|&` never match. PowerShell: `&` is the call operator, so only Start-Job /
// Start-ThreadJob, Start-Process without -Wait, and a statement-ending `&` (PowerShell 7's background job) count.
const BASH_STRIP = /\\[\s\S]|'[^']*'|"(?:[^"\\]|\\[\s\S])*"/g;
const PS_STRIP = /`[\s\S]|'(?:[^']|'')*'|"(?:[^"`]|`[\s\S])*"/g;
const COMMENT = /(^|\s)#.*$/gm;
const BASH_AMP = /(?:^|[^&|<>])&(?![&>])/m;
// Review L3: nohup / setsid / disown count only in COMMAND position (line start, or after ; & | && || ( { ` $( and an
// optional `then`/`do`/`else`, `sudo`/`exec`/`command`/`time`/`env`, and VAR=value prefixes), so an argument such as
// `cat nohup.out` or `git checkout fix/nohup-leak` passes.
const BASH_DETACH = /(?:^|[;&|({`]|\$\()\s*(?:(?:then|do|else|sudo|exec|command|time|env)\s+)*(?:[A-Za-z_]\w*=\S*\s+)*(?:nohup|setsid|disown)(?=$|[\s;&|)])/m;
// Arithmetic ($(( a & b )), (( x & 1 ))) is not a control operator: dropped before the & check.
const ARITH = /\$?\(\((?:[^()]|\([^()]*\))*\)\)/g;
// A heredoc body is data (`git commit -F - <<'EOF' ... R&D ... EOF`): dropped, its opening line kept.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?^\s*\2\s*$/gm;
export function selfBackgrounds(command, tool = 'Bash') {
  const raw = String(command ?? '');
  if (!raw.trim()) return false;
  if (tool === 'PowerShell') {
    const t = raw.replace(PS_STRIP, ' _ ').replace(COMMENT, '$1'); // a placeholder: a call operator's quoted path stays an operand
    if (/\bStart-(?:Thread)?Job\b/i.test(t)) return true;
    if (/&\s*(?:$|;|\r?\n)/m.test(t.replace(/&&/g, ' '))) return true;
    return t.split(/[;\r\n|]/).some((seg) => /\bStart-Process\b|\bsaps\b/i.test(seg) && !/-Wait\b/i.test(seg));
  }
  const t = raw.replace(HEREDOC, '<<_$3\n').replace(BASH_STRIP, ' _ ').replace(COMMENT, '$1').replace(ARITH, ' _ ');
  return BASH_AMP.test(t) || BASH_DETACH.test(t);
}

/** The refusal text for a foreground command that backgrounds itself while draining (idea-697). */
export function drainDetachRefusalText(drain) {
  const what = drain?.kind === 'request'
    ? `restart drain open (${drain.request?.id ? `restart request ${drain.request.id}` : 'a restart request'})`
    : `VibeSquad is draining for a runtime restart (${drain?.reason || 'vs restart'})`;
  return `${what}: this command backgrounds itself (\`&\`, nohup, setsid or disown; PowerShell Start-Job / Start-Process without -Wait). ` +
    'Work started that way leaves your shell at once, outside anything the restart can see, so new detached work is refused during a drain ' +
    '(and the runner stops any that slips through). Run it in the foreground without & / nohup only if it is short; otherwise finish your turn and rerun it after restart-done.';
}

/** Pure: the refusal text when `input` (the hook's stdin JSON) is a background launch during an unexpired drain, else null. */
export function drainHookDecision(input, drain, now = Date.now()) {
  if (!drain || !Number.isFinite(drain.until) || now >= drain.until) return null;
  if (!DRAIN_TOOLS.has(input?.tool_name)) return null;
  if (input?.tool_input?.run_in_background === true) return drainRefusalText(drain);
  if (selfBackgrounds(input?.tool_input?.command, input.tool_name)) return drainDetachRefusalText(drain); // idea-697
  return null;
}

// idea-673: the drain file lags an abort (the server clears the request drain on its next tick, ~15 s, or the drain lapses
// within its 5 min TTL if that call fails). A request-only drain is lifted here at once when the request it names is
// no longer current or no longer holds background work: aborted, done, queued, or firing with vs restart launched (the
// script's own drain, kind 'restart', takes over). A missing or unreadable request file keeps the refusal (fail closed:
// the drain file is the runner's word, this is only a shortcut). <vs home>/restart-request.json = dirname(dirname(drainFile)).
export const REQUEST_FILE = 'restart-request.json';
export function requestFileFor(drainFile) { return path.join(path.dirname(path.dirname(path.resolve(drainFile))), REQUEST_FILE); }
export function requestDrainLifted(drain, doc) {
  if (drain?.kind !== 'request' || !doc || typeof doc !== 'object' || !('current' in doc)) return false;
  const cur = doc.current;
  if (!cur) return true;
  if (drain.request?.id && cur.id !== drain.request.id) return true;
  return cur.state === 'done' || cur.state === 'aborted' || cur.state === 'queued' || (cur.state === 'firing' && !!cur.launch);
}
export function readRequestDoc(file) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

// idea-476: an unreadable drain file fails OPEN (a broken file must never block every background command), but not
// silently: anything but "no file" (no drain, the common case) leaves a line on stderr, which the CLI keeps in its hook
// output, so the agent and the transcript show that the drain could not be checked.
export function readDrain(file, warn = (m) => process.stderr.write(`${m}\n`)) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch (e) {
    if (e?.code !== 'ENOENT') warn(`vs drain-hook: drain file unreadable (${e?.code ?? e?.message ?? e}); background commands are allowed`);
    return null;
  }
  try { return JSON.parse(raw); } catch (e) {
    warn(`vs drain-hook: drain file is not valid JSON (${e?.message ?? e}); background commands are allowed`);
    return null;
  }
}

const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
if (process.argv[1] && norm(fileURLToPath(import.meta.url)) === norm(process.argv[1])) {
  const argv = process.argv.slice(2);
  const gitGuard = argv.includes('--git-guard');
  const drainPath = argv.find((a) => !a.startsWith('--')) ?? '';
  const drain = drainPath && drainPath !== '-' ? readDrain(drainPath) : null;
  // idea-673: a request drain whose request already ended (or was replaced) is lifted here, before the server's next tick.
  const draining = Boolean(drain && Number.isFinite(drain.until) && Date.now() < drain.until) && !requestDrainLifted(drain, readRequestDoc(requestFileFor(drainPath)));
  if (!draining && !gitGuard) process.exit(0); // the common case for leads/Buddies: no stdin read at all
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', async () => {
    let input = null;
    try { input = JSON.parse(raw); } catch { process.exit(0); }
    let why = draining ? drainHookDecision(input, drain) : null;
    if (!why && gitGuard) {
      try {
        const { gitGuardDecision } = await import('./git-guard.mjs');
        why = gitGuardDecision(input);
      } catch (e) {
        process.stderr.write(`vs git-guard: check failed (${e?.message ?? e}); command allowed\n`);
      }
    }
    if (!why) process.exit(0);
    process.stderr.write(why + '\n');
    process.exit(2);
  });
}
