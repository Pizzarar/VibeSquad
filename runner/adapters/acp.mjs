// Agent Client Protocol adapter (JSON-RPC 2.0 over stdio). Generic on purpose: every ACP agent differs only in
// command + args (ACP_PROVIDERS) and in how its model ids are spelled (pickModel).
import path from 'node:path';
import { existsSync } from 'node:fs';
import { killTree, spawnNoShell } from '../spawn.mjs';
import { lineReader } from './lines.mjs';
import { mcpServerSpec, mcpServerPath } from './mcp.mjs';

// Provider ids are the ones profiles use (server/profiles.mjs). Codex has no ACP mode of its own: Zed's
// codex-acp wraps it (Paseo drives `codex app-server` natively instead; we stay on ACP until it measurably fails).
export const ACP_PROVIDERS = {
  opencode: { command: 'opencode', args: ['acp'] },
  'antigravity-cli': { command: 'agy', args: ['acp'] },
  codex: { command: 'npx', args: ['-y', '@zed-industries/codex-acp'], resolve: resolveNpx },
};

// npx is a .cmd shim that cannot be spawned without a shell; run npm's own npx-cli.js with the current node instead.
function resolveNpx() {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  return existsSync(cli) ? { file: process.execPath, args: [cli] } : undefined;
}
export const PROVIDER_ALIASES = { agy: 'antigravity-cli', antigravity: 'antigravity-cli' };
export const acpProviderIds = () => Object.keys(ACP_PROVIDERS);

// Profiles name models loosely ("gemini-4-argon", "deepseek/deepseek-flash"); ACP agents advertise exact ids
// ("gemini-4-argon-medium"). Exact id wins, else the first advertised id that extends it with a variant suffix.
export function pickModel(want, available = []) {
  const ids = available.map((m) => m?.modelId ?? m?.id).filter(Boolean);
  if (ids.includes(want)) return want;
  const variants = ids.filter((i) => i.startsWith(`${want}-`) || i.startsWith(`${want}/`));
  return variants.find((i) => /medium$/.test(i)) ?? variants[0] ?? null;
}

export function createAcpAdapter({ spawnImpl, provider = 'opencode', name, command, args, mcp = true, mcpPath = mcpServerPath(), resolved } = {}) {
  const def = ACP_PROVIDERS[PROVIDER_ALIASES[provider] ?? provider];
  if (!def && !command) throw new Error(`no ACP definition for provider "${provider}"`);
  command ??= def.command;
  args ??= def.args;
  name ??= provider;
  resolved ??= def?.resolve?.();
  return {
    name,
    start({ cwd, model, meta = {}, systemPrompt, env, emit, onExit }) {
      const child = spawnNoShell(command, args, { cwd, ...(resolved ? { resolved } : {}), ...(env ? { env } : {}) }, spawnImpl);
      let nextId = 1;
      const pending = new Map();
      child.stdin.on('error', () => {}); // EPIPE from a write racing child exit: the 'exit' handler already reports it
      const write = (o) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
      const request = (method, params) => new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        write({ id, method, params });
      });
      let sessionId = null;
      let promptInFlight = false;
      let imageCapable = false;
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
            case 'usage_update': if (Number.isFinite(u.used)) emit('usage', { contextTokens: u.used, contextMax: u.size }); break;
            case 'tool_call_update': emit('tool', { phase: 'update', id: u.toolCallId, status: u.status }); break;
            default: break;
          }
        } else if (m.method && m.id !== undefined) {
          // Agent -> client request. The spike grants no permissions and no fs/terminal capabilities.
          // Approve by default (like the claude adapter's 'auto'); only an explicit lane permissionMode 'deny' denies.
          let result = null;
          if (m.method === 'session/request_permission') {
            // Logged as request + resolved so pendingPermissions (derived from the log) is accurate for any future non-auto policy.
            const permId = String(m.params?.toolCall?.toolCallId ?? m.id);
            emit('permission', { phase: 'request', id: permId, toolName: m.params?.toolCall?.title });
            result = permissionOutcome(m.params, meta.permissionMode);
            emit('permission', { phase: 'resolved', id: permId, outcome: result.outcome?.outcome });
          }
          write({ id: m.id, result });
        }
      });
      lineReader(child.stderr, (line) => emit('stderr', { line }));
      child.on('error', (err) => onExit({ code: null, error: String(err.message) }));
      child.on('exit', (code, signal) => {
        for (const p of pending.values()) p.reject(new Error('process exited'));
        onExit({ code, signal });
      });

      const ready = (async () => {
        const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
        imageCapable = !!init?.agentCapabilities?.promptCapabilities?.image;
        const s = await request('session/new', { cwd, mcpServers: mcp ? [acpMcpServer(mcpServerSpec({ env, path: mcpPath }))] : [] });
        sessionId = s.sessionId;
        // Model lists come either as `models` (opencode, agy: session/set_model) or as a `model` configOption
        // (codex-acp: session/set_config_option).
        const opt = (s.configOptions ?? []).find((o) => o.id === 'model' || o.category === 'model');
        const viaConfig = !s.models && !!opt;
        let current = s.models?.currentModelId ?? opt?.currentValue;
        if (model) {
          const advertised = s.models?.availableModels ?? (opt?.options ?? []).map((o) => ({ modelId: o.value }));
          const id = (advertised.length ? pickModel(model, advertised) : null) ?? (viaConfig ? model : null); // codex-acp's bundled list lags the account's real models: trust the profile
          if (!id) emit('stderr', { line: `model "${model}" not offered by ${name}; using ${current ?? 'its default'}` });
          else if (id !== current) {
            try {
              if (viaConfig) await request('session/set_config_option', { sessionId, configId: opt.id, value: id });
              else await request('session/set_model', { sessionId, modelId: id });
              current = id;
            } catch (e) { emit('stderr', { line: `set model ${id} failed: ${e.message}` }); }
          }
        }
        // The profile mode is this provider's own ACP mode (meta.acpMode); apply it only if the agent advertises it.
        if (meta.acpMode && (s.modes?.availableModes ?? []).some((m) => m.id === meta.acpMode) && meta.acpMode !== s.modes?.currentModeId) {
          try { await request('session/set_mode', { sessionId, modeId: meta.acpMode }); }
          catch (e) { emit('stderr', { line: `set_mode ${meta.acpMode} failed: ${e.message}` }); }
        }
        emit('session', { sessionId, model: current });
      })();
      let failed = null;
      ready.catch((e) => {
        // A session that never came up is dead: surface it and end the process so the agent reads as exited, not "starting".
        failed = e;
        emit('error', { message: e.message });
        killTree(child);
      });

      async function pump() {
        if (promptInFlight || !queue.length) return;
        promptInFlight = true;
        const next = queue.shift();
        let text = next.text;
        if (pendingSystem) { text = `${pendingSystem}\n\n${text}`; pendingSystem = ''; } // ACP has no system slot: lead the first turn with it
        emit('status', { status: 'running' });
        // ACP image content blocks need the agent's promptCapabilities.image; without it say so instead of dropping silently.
        const images = next.images ?? [];
        if (images.length && !imageCapable) {
          text += `\n\n[${images.length} image attachment(s) omitted: this agent does not accept image input]`;
          emit('stderr', { line: 'agent does not advertise promptCapabilities.image; images dropped' });
        }
        const prompt = [{ type: 'text', text }, ...(imageCapable ? images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType })) : [])];
        try {
          const r = await request('session/prompt', { sessionId, prompt });
          emit('turn_done', { stopReason: r?.stopReason });
        } catch (e) { emit('error', { message: e.message }); }
        promptInFlight = false;
        emit('status', { status: 'idle' });
        pump();
      }
      return {
        send(text, { images = [] } = {}) {
          if (failed) throw new Error(`agent session failed to start: ${failed.message}`);
          queue.push({ text, images });
          ready.then(pump, () => {});
        },
        // Cancel ends the current turn AND drops prompts queued behind it (a cancelled lane must not resume on stale asks).
        // Differs from the claude adapter, whose cancel only interrupts the current turn and lets later prompts run.
        cancel() {
          queue.length = 0;
          if (sessionId) write({ method: 'session/cancel', params: { sessionId } });
        },
        kill() { killTree(child); },
      };
    },
  };
}

// ACP wants env as a [{name, value}] list.
function acpMcpServer(spec) {
  return { name: spec.name, command: spec.command, args: spec.args, env: Object.entries(spec.env).map(([name, value]) => ({ name, value })) };
}

// Auto-approve unless the lane explicitly asks to deny (meta.permissionMode === 'deny'); a profile's own mode
// (e.g. "default") never denies, it is the provider's ACP mode.
function permissionOutcome(params, mode) {
  if (mode === 'deny') return { outcome: { outcome: 'cancelled' } };
  const opt = (params?.options ?? []).find((o) => o.kind === 'allow_once') ?? (params?.options ?? []).find((o) => String(o.kind).startsWith('allow'));
  return opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } };
}
