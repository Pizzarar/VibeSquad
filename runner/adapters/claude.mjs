// Claude NATIVE adapter: one `claude` CLI child per agent in stream-json mode, stdin kept open
// for multi-turn. Chosen over @anthropic-ai/claude-agent-sdk because the SDK is not a
// dependency here and the CLI already gives exactly one child per agent.
import { spawnNoShell } from '../spawn.mjs';
import { lineReader } from './lines.mjs';

export function createClaudeAdapter({ spawnImpl, command = 'claude' } = {}) {
  return {
    name: 'claude',
    start({ model, cwd, meta = {}, emit, onExit }) {
      const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
      if (model) args.push('--model', model);
      if (meta.permissionMode) args.push('--permission-mode', meta.permissionMode);
      const child = spawnNoShell(command, args, { cwd }, spawnImpl);
      let turnOpen = false;
      const stdin = (o) => child.stdin.write(JSON.stringify(o) + '\n');
      lineReader(child.stdout, (line) => {
        let m;
        try { m = JSON.parse(line); } catch { emit('raw', { line }); return; }
        if (m.type === 'system' && m.subtype === 'init') emit('session', { sessionId: m.session_id, model: m.model });
        else if (m.type === 'assistant') {
          for (const b of m.message?.content ?? []) {
            if (b.type === 'text' && b.text) emit('output', { text: b.text });
            else if (b.type === 'tool_use') emit('tool', { phase: 'call', id: b.id, name: b.name, input: b.input });
          }
        } else if (m.type === 'user') {
          for (const b of m.message?.content ?? []) {
            if (b.type === 'tool_result') emit('tool', { phase: 'result', id: b.tool_use_id, isError: !!b.is_error });
          }
        } else if (m.type === 'result') {
          turnOpen = false;
          emit('turn_done', { stopReason: m.stop_reason ?? m.subtype, costUsd: m.total_cost_usd });
          emit('status', { status: 'idle' });
        }
      });
      lineReader(child.stderr, (line) => emit('stderr', { line }));
      child.on('error', (err) => onExit({ code: null, error: String(err.message) }));
      child.on('exit', (code, signal) => onExit({ code, signal }));
      return {
        send(text) {
          turnOpen = true;
          emit('status', { status: 'running' });
          stdin({ type: 'user', message: { role: 'user', content: text } });
        },
        cancel() {
          if (turnOpen) stdin({ type: 'control_request', request_id: `int-${Date.now()}`, request: { subtype: 'interrupt' } });
        },
        kill() { child.kill(); },
      };
    },
  };
}
