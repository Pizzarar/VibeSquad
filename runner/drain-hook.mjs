// Claude Code PreToolUse hook for runner agents (ideas 198 + 186): while a `vs restart` drains the runner, a NEW background
// command (Bash/PowerShell with run_in_background) is refused with a clear message instead of becoming a park hold the
// restart has to wait out. Foreground commands and everything outside a drain pass untouched.
//   node runner/drain-hook.mjs <runner home>/drain.json      (installed by adapters/claude.mjs via --settings hooks)
// The drain file is written by Runner.setDrain and removed on clear, expiry and runner start; the hook also checks `until`
// itself, so a file a crashed runner left behind never blocks anything past its TTL. Any read/parse error allows (exit 0).
// Exit 2 + stderr is Claude Code's "block this tool call and show the model why".
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

/** Pure: the refusal text when `input` (the hook's stdin JSON) is a background launch during an unexpired drain, else null. */
export function drainHookDecision(input, drain, now = Date.now()) {
  if (!drain || !Number.isFinite(drain.until) || now >= drain.until) return null;
  if (!DRAIN_TOOLS.has(input?.tool_name)) return null;
  if (input?.tool_input?.run_in_background !== true) return null;
  return drainRefusalText(drain);
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
  const drain = readDrain(process.argv[2] ?? '');
  if (!drain || !Number.isFinite(drain.until) || Date.now() >= drain.until) process.exit(0); // the common case: no stdin read at all
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    let input = null;
    try { input = JSON.parse(raw); } catch { process.exit(0); }
    const why = drainHookDecision(input, drain);
    if (!why) process.exit(0);
    process.stderr.write(why + '\n');
    process.exit(2);
  });
}
