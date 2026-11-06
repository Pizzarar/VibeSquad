// Agent Client Protocol adapter (JSON-RPC 2.0 over stdio). Used with `opencode acp`.
// Generic on purpose: Codex/AGY ACP agents differ only in command + args.
import { killTree, spawnNoShell } from '../spawn.mjs';
import { lineReader } from './lines.mjs';

export function createAcpAdapter({ spawnImpl, name = 'opencode', command = 'opencode', args = ['acp'] } = {}) {
  return {
    name,
    start({ cwd, systemPrompt, emit, onExit }) {
      const child = spawnNoShell(command, args, { cwd }, spawnImpl);
      let nextId = 1;
      const pending = new Map();
      const write = (o) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
      const request = (method, params) => new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        write({ id, method, params });
      });
      let sessionId = null;
      let promptInFlight = false;
      const queue = [];
      let pendingSystem = systemPrompt || '';

      lineReader(child.stdout, (line) => {
        let m;
        try { m = JSON.parse(line); } catch { emit('raw', { line }); return; }
        if (m.id !== undefined && m.id !== null && !m.method) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          if (p) { if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }
        } else if (m.method === 'session/update') {
          const u = m.params?.update ?? {};
          switch (u.sessionUpdate) {
            case 'agent_message_chunk': if (u.content?.type === 'text') emit('output', { text: u.content.text }); break;
            case 'agent_thought_chunk': if (u.content?.type === 'text') emit('thought', { text: u.content.text }); break;
            case 'tool_call': emit('tool', { phase: 'call', id: u.toolCallId, name: u.title, kind: u.kind }); break;
            case 'tool_call_update': emit('tool', { phase: 'update', id: u.toolCallId, status: u.status }); break;
            default: break;
          }
        } else if (m.method && m.id !== undefined) {
          // Agent -> client request. The spike grants no permissions and no fs/terminal capabilities.
          write({ id: m.id, result: m.method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : null });
        }
      });
      lineReader(child.stderr, (line) => emit('stderr', { line }));
      child.on('error', (err) => onExit({ code: null, error: String(err.message) }));
      child.on('exit', (code, signal) => {
        for (const p of pending.values()) p.reject(new Error('process exited'));
        onExit({ code, signal });
      });

      const ready = (async () => {
        await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
        const s = await request('session/new', { cwd, mcpServers: [] });
        sessionId = s.sessionId;
        emit('session', { sessionId, model: s.models?.currentModelId });
      })();
      ready.catch((e) => emit('error', { message: e.message }));

      async function pump() {
        if (promptInFlight || !queue.length) return;
        promptInFlight = true;
        let text = queue.shift();
        if (pendingSystem) { text = `${pendingSystem}\n\n${text}`; pendingSystem = ''; } // ACP has no system slot: lead the first turn with it
        emit('status', { status: 'running' });
        try {
          const r = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
          emit('turn_done', { stopReason: r?.stopReason });
        } catch (e) { emit('error', { message: e.message }); }
        promptInFlight = false;
        emit('status', { status: 'idle' });
        pump();
      }
      return {
        send(text) { queue.push(text); ready.then(pump, () => {}); },
        cancel() { if (sessionId) write({ method: 'session/cancel', params: { sessionId } }); },
        kill() { killTree(child); },
      };
    },
  };
}
