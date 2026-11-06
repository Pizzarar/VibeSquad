// Claude NATIVE adapter: one `claude` CLI child per agent in stream-json mode, stdin kept open
// for multi-turn. Chosen over @anthropic-ai/claude-agent-sdk because the SDK is not a
// dependency here and the CLI already gives exactly one child per agent.
import { killTree, spawnNoShell } from '../spawn.mjs';
import { lineReader } from './lines.mjs';
import { mcpServerSpec, mcpServerPath } from './mcp.mjs';

export const DEFAULT_PERMISSION_MODE = 'auto';
export const effectivePermissionMode = (meta = {}) => meta.permissionMode || DEFAULT_PERMISSION_MODE;

export function createClaudeAdapter({ spawnImpl, command = 'claude', mcp = true, mcpPath = mcpServerPath() } = {}) {
  return {
    name: 'claude',
    canPark: true, // the CLI keeps its transcript on disk, so a killed idle agent can be resumed with --resume <sessionId>
    start({ model, cwd, meta = {}, systemPrompt, env, emit, onExit, resume }) {
      const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
      if (resume) args.push('--resume', String(resume));
      if (model) args.push('--model', model);
      args.push('--permission-mode', effectivePermissionMode(meta));
      if (mcp) {
        const spec = mcpServerSpec({ env, path: mcpPath });
        args.push('--mcp-config', JSON.stringify({ mcpServers: { [spec.name]: { command: spec.command, args: spec.args, env: spec.env } } }));
        args.push('--allowedTools', `mcp__${spec.name}`);
      }
      if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
      const child = spawnNoShell(command, args, { cwd, ...(env ? { env } : {}) }, spawnImpl);
      let turnOpen = false;
      child.stdin.on('error', () => {}); // EPIPE from a write racing child exit: the 'exit' handler already reports it
      const stdin = (o) => child.stdin.write(JSON.stringify(o) + '\n');
      lineReader(child.stdout, (line) => {
        let m;
        try { m = JSON.parse(line); } catch { emit('raw', { line }); return; }
        if (m.type === 'system' && m.subtype === 'init') emit('session', { sessionId: m.session_id, model: m.model });
        else if (m.type === 'assistant') {
          const u = m.message?.usage;
          if (u) {
            // Context size = everything the last call read (fresh + cached input); outputs add on top for the next call.
            const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            emit('usage', { contextTokens: input + (u.output_tokens ?? 0), inputTokens: input, outputTokens: u.output_tokens ?? 0 });
          }
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
          // A failed turn must read as an error (push "Agent Error", UI status), not a normal completion.
          if (m.is_error || String(m.subtype ?? '').startsWith('error')) {
            emit('error', { message: (typeof m.result === 'string' && m.result) || m.subtype || 'turn failed' });
          }
          emit('turn_done', { stopReason: m.stop_reason ?? m.subtype, costUsd: m.total_cost_usd });
          emit('status', { status: 'idle' });
        }
      });
      lineReader(child.stderr, (line) => emit('stderr', { line }));
      child.on('error', (err) => onExit({ code: null, error: String(err.message) }));
      child.on('exit', (code, signal) => onExit({ code, signal }));
      return {
        send(text, { images = [] } = {}) {
          turnOpen = true;
          emit('status', { status: 'running' });
          // stream-json accepts Anthropic content blocks: images go as base64 sources ahead of the text.
          const content = images.length
            ? [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } })), { type: 'text', text }]
            : text;
          stdin({ type: 'user', message: { role: 'user', content } });
        },
        // Interrupts the current turn only; prompts already written to stdin still run (the ACP adapter drops its queue).
        cancel() {
          if (turnOpen) stdin({ type: 'control_request', request_id: `int-${Date.now()}`, request: { subtype: 'interrupt' } });
        },
        kill() { killTree(child); },
      };
    },
  };
}
