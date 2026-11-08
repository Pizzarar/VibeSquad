// Agent Client Protocol adapter (JSON-RPC 2.0 over stdio). Generic on purpose: every ACP agent differs only in
// command + args (ACP_PROVIDERS) and in how its model ids are spelled (pickModel).
import path from 'node:path';
import { existsSync } from 'node:fs';
import { killTree, spawnNoShell } from '../spawn.mjs';
import { lineReader } from './lines.mjs';
import { mcpServerSpec, mcpServerPath } from './mcp.mjs';
import { estimateCostUsd } from './pricing.mjs';

const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== null && v !== '' ? Number(v) : undefined);

// ACP PromptResponse.usage (camelCase per spec; snake_case tolerated). Per the real opencode/agy payloads inputTokens
// EXCLUDES cache, so the returned inputTokens is the whole prompt size (fresh + cache read + cache write), like claude.mjs.
// thoughtTokens are billed as output: added unless totalTokens shows they are already inside outputTokens.
// Returns undefined when the agent reports none.
export function parseAcpUsage(u) {
  if (!u || typeof u !== 'object') return undefined;
  const input = num(u.inputTokens ?? u.input_tokens);
  const output = num(u.outputTokens ?? u.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  const thought = num(u.thoughtTokens ?? u.thought_tokens) ?? 0;
  const total = num(u.totalTokens ?? u.total_tokens);
  const cachedReadTokens = num(u.cachedReadTokens ?? u.cached_read_tokens) ?? 0;
  const cachedWriteTokens = num(u.cachedWriteTokens ?? u.cached_write_tokens) ?? 0;
  const inT = input ?? 0;
  const outT = output ?? 0;
  const thoughtOutside = total === undefined || total - inT - outT >= thought;
  return { inputTokens: inT + cachedReadTokens + cachedWriteTokens, outputTokens: outT + (thoughtOutside ? thought : 0), cachedReadTokens, cachedWriteTokens };
}

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
    canPark: true, // sessions persist agent-side: resumed with session/resume or session/load, else a new session primed from our log
    start({ cwd, model, meta = {}, systemPrompt, env, emit, onExit, resume, history }) {
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
      let replaying = false; // session/load replays the old transcript as session/update; our log already has it
      let activeModel = model;
      let ctxNow = 0; // latest usage_update.used (context size)
      let ctxPrev = resume ? null : 0; // context size at the end of the previous turn; null = unknown (resumed session restored an unseen history)
      let reportedCost; // agent-reported cumulative session cost (usage_update.cost), if any
      let costTotal = 0; // cumulative session cost, same convention as claude's total_cost_usd (the fold diffs it)
      let costKnown = false;

      lineReader(child.stdout, (line) => {
        let m;
        try { m = JSON.parse(line); } catch { emit('raw', { line }); return; }
        if (m.id !== undefined && m.id !== null && !m.method) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          if (p) { if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }
        } else if (m.method === 'session/update') {
          if (replaying) return;
          const u = m.params?.update ?? {};
          switch (u.sessionUpdate) {
            case 'agent_message_chunk': if (u.content?.type === 'text') emit('output', { text: u.content.text }); break;
            case 'agent_thought_chunk': if (u.content?.type === 'text') emit('thought', { text: u.content.text }); break;
            case 'tool_call': emit('tool', { phase: 'call', id: u.toolCallId, name: u.title, kind: u.kind }); break;
            case 'usage_update':
              if (Number.isFinite(u.used)) { ctxNow = u.used; emit('usage', { contextTokens: u.used, contextMax: u.size }); }
              // some agents report a cumulative session cost here; it beats our price-table estimate
              if (Number.isFinite(u.cost?.amount) && (u.cost.currency ?? 'USD') === 'USD') reportedCost = u.cost.amount;
              break;
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
        const sessionParams = { cwd, mcpServers: mcp ? [acpMcpServer(mcpServerSpec({ env, path: mcpPath }))] : [] };
        const caps = init?.agentCapabilities ?? {};
        let s = null;
        if (resume) {
          // session/resume restores without replaying history, so prefer it; session/load replays (swallowed above).
          const via = caps.sessionCapabilities?.resume ? 'session/resume' : caps.loadSession ? 'session/load' : null;
          let reason = via ? null : 'agent advertises neither session/resume nor session/load';
          if (via) {
            replaying = via === 'session/load';
            try { s = (await request(via, { sessionId: resume, ...sessionParams })) ?? {}; sessionId = resume; }
            catch (e) { reason = `${via} failed: ${e.message}`; }
            replaying = false;
          }
          if (s) pendingSystem = ''; // the restored session already has its system prompt
          else {
            emit('resume_fallback', { sessionId: resume, reason });
            const primer = history?.() ?? '';
            if (primer) pendingSystem = `${pendingSystem ? `${pendingSystem}\n\n` : ''}${primer}`;
          }
        }
        if (!s) { s = await request('session/new', sessionParams); sessionId = s.sessionId; }
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
        if (meta.acpMode && s.modes && !(s.modes.availableModes ?? []).some((m) => m.id === meta.acpMode)) emit('stderr', { line: `mode "${meta.acpMode}" not offered by ${name}; using ${s.modes.currentModeId ?? 'its default'}` });
        if (meta.acpMode && (s.modes?.availableModes ?? []).some((m) => m.id === meta.acpMode) && meta.acpMode !== s.modes?.currentModeId) {
          try { await request('session/set_mode', { sessionId, modeId: meta.acpMode }); }
          catch (e) { emit('stderr', { line: `set_mode ${meta.acpMode} failed: ${e.message}` }); }
        }
        // modes/models the agent really offers, so the UI lists only those and a live change to anything else is refused up front
        activeModel = current ?? model;
        emit('session', { sessionId, model: current, mode: s.modes?.currentModeId, modes: (s.modes?.availableModes ?? []).map((m) => m.id), models: (s.models?.availableModels ?? (opt?.options ?? []).map((o) => ({ modelId: o.value }))).map((m) => m.modelId ?? m.id).filter(Boolean) });
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
          const ctxStart = ctxPrev;
          const r = await request('session/prompt', { sessionId, prompt });
          // Real per-turn tokens from PromptResponse.usage; else estimate from context-size growth (marked estimated).
          let tok = parseAcpUsage(r?.usage);
          let estimated = false;
          if (!tok && ctxNow > 0 && ctxStart !== null) {
            const promptTokens = Math.ceil(text.length / 4);
            const grew = ctxNow - ctxStart;
            tok = { inputTokens: ctxStart + promptTokens, outputTokens: Math.max(0, grew - promptTokens), cachedReadTokens: 0 };
            estimated = true;
          }
          ctxPrev = ctxNow;
          let turnCost = null;
          if (tok) {
            // contextTokens stays on the event (agy sends no usage_update) so the context meter keeps working
            emit('usage', { contextTokens: ctxNow > 0 ? ctxNow : tok.inputTokens + tok.outputTokens, inputTokens: tok.inputTokens, outputTokens: tok.outputTokens, ...(tok.cachedReadTokens ? { cachedReadTokens: tok.cachedReadTokens } : {}), ...(tok.cachedWriteTokens ? { cachedWriteTokens: tok.cachedWriteTokens } : {}), ...(estimated ? { estimated: true } : {}) });
            turnCost = estimateCostUsd(activeModel, tok);
          }
          const done = { stopReason: r?.stopReason };
          if (reportedCost !== undefined) { costTotal = reportedCost; costKnown = true; }
          else if (turnCost !== null) { costTotal += turnCost; costKnown = true; done.costEstimated = true; } // price-table figure, not provider-billed
          if (costKnown) done.costUsd = costTotal;
          emit('turn_done', done);
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
