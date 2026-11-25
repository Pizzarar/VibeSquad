// Agent Client Protocol adapter (JSON-RPC 2.0 over stdio). Generic on purpose: every ACP agent differs only in
// command + args (ACP_PROVIDERS) and in how its model ids are spelled (pickModel).
import path from 'node:path';
import os from 'node:os';
import { existsSync, openSync, fstatSync, readSync, closeSync, statSync } from 'node:fs';
import { killTree, spawnNoShell, spawnErrorMessage } from '../spawn.mjs';
import { lineReader } from './lines.mjs';
import { mcpServerSpec, mcpServerPath } from './mcp.mjs';
import { estimateCostUsd } from './pricing.mjs';

const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== null && v !== '' ? Number(v) : undefined);

// PromptResponse.usage SUMS every model call of the turn's tool loop (real opencode turn: usage_update.used 268981 vs
// input 806154 = 3 calls x ~268k), so it is not the context size. opencode sends usage_update.used, which we use. agy
// never does, but writes exact per-call tokens on every PLANNER_RESPONSE line of its session transcript, so the agy meter
// is the LAST such line's input + cache_read + output (claude.mjs's contextTokens = the last call's prompt + reply).
export function agyTranscriptPath(sessionId, home = process.env.VS_AGY_HOME || os.homedir()) {
  return path.join(home, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
}
// Reads only the tail of the file (a line can hold big tool args, so the window grows up to 4 MB). Returns undefined if
// the file is missing/unreadable or has no PLANNER_RESPONSE yet.
export function lastPlannerContext(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    for (let win = 64 * 1024; ; win *= 4) {
      const n = Math.min(size, win);
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, size - n);
      const lines = buf.toString('utf8').split('\n');
      if (n < size) lines.shift(); // first line is cut mid-way
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"PLANNER_RESPONSE"')) continue;
        let m; try { m = JSON.parse(lines[i]); } catch { continue; }
        if (m.type !== 'PLANNER_RESPONSE' || !Number.isFinite(m.input_tokens)) continue;
        return m.input_tokens + (num(m.cache_read_tokens) ?? 0) + (num(m.output_tokens) ?? 0);
      }
      if (n >= size || win >= 4 * 1024 * 1024) return undefined;
    }
  } catch { return undefined; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ } }
}

/** Byte size of a file, or undefined if it is missing/unreadable (K2b: the agy transcript's length before a /compact turn). */
export function fileSizeOf(file) {
  try { return statSync(file).size; } catch { return undefined; }
}
// K2b (Review-Sonnet m1): output tokens of the LAST PLANNER_RESPONSE written at or after byte `since` (the agy transcript's size
// when the /compact turn started), i.e. a model call of that turn: its summarizing call. Undefined if the turn wrote none (an older
// line is the pre-compact context, never a post-compact estimate). Reads at most the last 4 MB.
export function plannerOutputSince(file, since) {
  if (!Number.isFinite(since) || since < 0) return undefined;
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    if (size <= since) return undefined;
    const start = Math.max(since, size - 4 * 1024 * 1024);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > since) lines.shift(); // cut mid-way
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"PLANNER_RESPONSE"')) continue;
      let m; try { m = JSON.parse(lines[i]); } catch { continue; }
      if (m.type !== 'PLANNER_RESPONSE') continue;
      const out = num(m.output_tokens);
      return out > 0 ? out : undefined;
    }
    return undefined;
  } catch { return undefined; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ } }
}

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

// K2b (docs/lanes/perfection/K2B.md): in-place compaction. Both ACP CLIs advertise a `compact` slash command and run it when a
// prompt turn's whole text is `/compact` (a /compact merged behind a steer or the first-turn system text is plain text to them).
// opencode marks it: session_info_update _meta["opencode/compaction"] {status: started|completed, reason}. agy marks nothing: its
// /compact turn just ends (end_turn) after a real summarizing call, so the boundary is synthesized there, and only for a BARE
// `/compact` (a focus argument is unverified on agy: an unparsed "/compact <text>" would be an ordinary prompt and a false boundary).
const COMPACT_PROMPT_RE = /^\s*\/compact\b/i;
const BARE_COMPACT_RE = /^\s*\/compact\s*$/i;
const SYNTH_COMPACT_PROVIDERS = new Set(['antigravity-cli']);
export const compactMarker = (u) => u?._meta?.['opencode/compaction'] ?? null;

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

// Profiles name models loosely ("gemini-4-neon", "deepseek/deepseek-flash"); ACP agents advertise exact ids
// ("gemini-4-neon-medium"). Exact id wins, else the first advertised id that extends it with a variant suffix.
export function pickModel(want, available = []) {
  const ids = available.map((m) => m?.modelId ?? m?.id).filter(Boolean);
  if (ids.includes(want)) return want;
  const variants = ids.filter((i) => i.startsWith(`${want}-`) || i.startsWith(`${want}/`));
  return variants.find((i) => /medium$/.test(i)) ?? variants[0] ?? null;
}

// A model-API failure relayed by the agent (not our bug, not the task's): worth a short provider cap so failover routes around it.
export const UPSTREAM_FAILURE_RE = /internal (service )?(error|failure)|service unavailable|overloaded|rate.?limit|\b(429|500|502|503|504)\b/i;

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
      let cancelling = false; // cancel() sent: the aborted prompt's rejection and a following exit are ours, never an upstream failure
      let stopped = false; // set by kill(): pump() must not start another turn after the child is being torn down
      const queue = [];
      let pendingSystem = systemPrompt || '';
      let replaying = false; // session/load replays the old transcript as session/update; our log already has it
      let activeModel = model;
      let ctxNow = 0; // latest usage_update.used (context size)
      let ctxPrev = resume ? null : 0; // context size at the end of the previous turn; null = unknown (resumed session restored an unseen history)
      let reportedCost; // agent-reported cumulative session cost (usage_update.cost), if any
      let costTotal = 0; // cumulative session cost, same convention as claude's total_cost_usd (the fold diffs it)
      let costKnown = false;
      let lastError = null; // latest session/prompt (or handshake) failure: the agent often exits right after it, so the exit must carry it
      let compacting = false; // a /compact prompt is in flight: its usage_update is the summarizer call's prompt, not the new context
      let compactSeen = false; // the agent's own compaction-completed marker arrived during that prompt (opencode)
      let compactHeld = null; // the usage_update held back during that prompt: applied if the prompt did not compact after all
      const synthCompact = SYNTH_COMPACT_PROVIDERS.has(PROVIDER_ALIASES[provider] ?? provider);

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
              // K2b: during a /compact turn the reading is the summarizer call (agy: above the pre-compact size), never the new context.
              if (Number.isFinite(u.used) && compacting) compactHeld = u;
              else if (Number.isFinite(u.used)) { ctxNow = u.used; emit('usage', { contextTokens: u.used, contextMax: u.size }); }
              // some agents report a cumulative session cost here; it beats our price-table estimate
              if (Number.isFinite(u.cost?.amount) && (u.cost.currency ?? 'USD') === 'USD') reportedCost = u.cost.amount;
              break;
            case 'tool_call_update': emit('tool', { phase: 'update', id: u.toolCallId, status: u.status }); break;
            case 'session_info_update': {
              const c = compactMarker(u);
              if (compacting && c?.status === 'completed' && !compactSeen) { compactSeen = true; emit('compacted', { before: ctxNow || undefined, trigger: c.reason ?? 'manual' }); }
              break;
            }
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
      child.on('error', (err) => onExit({ code: null, error: spawnErrorMessage(command, err, { cwd }) }));
      child.on('exit', (code, signal) => {
        for (const p of pending.values()) p.reject(new Error('process exited'));
        // idea-442: opencode answers a prompt with "Internal error: Internal service failure" (upstream model API) and exits 1 with
        // empty stderr. Say why on the exit so the status is loud and the server can cap the provider briefly.
        const why = code !== 0 && code !== null && !stopped && !cancelling && lastError;
        onExit({ code, signal, ...(why ? { error: `${name} exited (code ${code}) after: ${lastError}`, upstream: UPSTREAM_FAILURE_RE.test(lastError) } : {}) });
      });

      const ready = (async () => {
        const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
        imageCapable = !!init?.agentCapabilities?.promptCapabilities?.image;
        const sessionParams = { cwd, mcpServers: mcp ? [acpMcpServer(mcpServerSpec({ env, path: mcpPath }), env)] : [] };
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
            const primer = (await history?.()) ?? ''; // async: the runner reads the log in yielding slices (idea-307)
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
        lastError = e.message;
        emit('error', { message: e.message });
        killTree(child);
      });

      let running = false;
      // The drop names the runner's input event (inputSeq) so the fresh-session recap can skip it (idea-214).
      const steerDrop = (reason, q) => ({ reason, chars: q.text.length, ...(Number.isInteger(q.inputSeq) ? { input: q.inputSeq } : {}) });
      // A steer-only prompt (idea-169) never runs as a session/prompt of its own: ACP cannot inject into a running prompt,
      // so leading steer-only items ride along with the next real prompt, and ones left with no real prompt behind them
      // are dropped when the turn ends (running them would start a new turn).
      const dropOrphanSteers = () => {
        if (!queue.length || queue.some((q) => !q.steerOnly)) return;
        for (const q of queue.splice(0)) emit('steer_dropped', steerDrop('turn-ended', q));
      };
      // True while a send would join work already under way (a prompt in flight or a real one queued).
      const steerable = () => !failed && !stopped && (promptInFlight || queue.some((q) => !q.steerOnly));
      async function pump() {
        if (promptInFlight || stopped) return; // a steer queued behind the prompt in flight waits for it to end
        dropOrphanSteers();
        if (!queue.length) return;
        promptInFlight = true;
        cancelling = false;
        const steers = [];
        while (queue[0]?.steerOnly) steers.push(queue.shift());
        const real = queue.shift();
        const next = steers.length ? { text: [...steers.map((q) => q.text), real.text].join('\n\n'), images: [...steers.flatMap((q) => q.images ?? []), ...(real.images ?? [])] } : real;
        let text = next.text;
        if (pendingSystem) { text = `${pendingSystem}\n\n${text}`; pendingSystem = ''; } // ACP has no system slot: lead the first turn with it
        if (!running) {
          running = true;
          // A fresh turn after an idle gap: a prior turn's failure must not be read as this turn's cause. A queued
          // prompt pumped with running already true keeps lastError (the immediately-preceding failure is the cause).
          lastError = null;
          emit('status', { status: 'running' });
        }
        // ACP image content blocks need the agent's promptCapabilities.image; without it say so instead of dropping silently.
        const images = next.images ?? [];
        if (images.length && !imageCapable) {
          text += `\n\n[${images.length} image attachment(s) omitted: this agent does not accept image input]`;
          emit('stderr', { line: 'agent does not advertise promptCapabilities.image; images dropped' });
        }
        const prompt = [{ type: 'text', text }, ...(imageCapable ? images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType })) : [])];
        const compactPrompt = COMPACT_PROMPT_RE.test(text);
        compacting = compactPrompt;
        compactSeen = false;
        compactHeld = null;
        // K2b: where this turn's agy transcript lines start (the summarizing call's output is the fallback `after`).
        const transcriptStart = compactPrompt && synthCompact && sessionId ? fileSizeOf(agyTranscriptPath(sessionId)) : undefined;
        try {
          const ctxStart = ctxPrev;
          const r = await request('session/prompt', { sessionId, prompt });
          compacting = false;
          // Real per-turn tokens from PromptResponse.usage; else estimate from context-size growth (marked estimated).
          let tok = parseAcpUsage(r?.usage);
          const compacted = compactPrompt && (compactSeen || (synthCompact && r?.stopReason === 'end_turn' && BARE_COMPACT_RE.test(text)));
          let usage = null;
          if (compacted) {
            // K2b: no reading of the new context exists until the next real turn, so the meter shows the summary (this turn's
            // output) as an estimate now: the stale pre-compact figure would read as still over the cap and hand off right after
            // a good compaction. The next turn's usage_update / transcript reading replaces it; its delta baseline is unknown.
            // No PromptResponse.usage (Review-Sonnet m1): the summarizing call's output from the agy transcript lines this turn wrote.
            // Neither: no usage is emitted (the meter keeps its pre-compact value, compact-step reports still-over: fails safe) and
            // the boundary says `unmeasured`, so the live okRate check can count it apart from a compaction that did not shrink.
            let after = tok?.outputTokens > 0 ? tok.outputTokens : undefined;
            let afterSource = after !== undefined ? 'usage' : undefined;
            if (after === undefined && transcriptStart !== undefined) {
              after = plannerOutputSince(agyTranscriptPath(sessionId), transcriptStart);
              if (after !== undefined) afterSource = 'transcript';
            }
            if (!compactSeen) emit('compacted', { before: ctxNow || undefined, after, trigger: 'manual', synthesized: true, ...(afterSource ? { afterSource } : { unmeasured: true }) });
            ctxNow = 0;
            ctxPrev = null;
            if (after !== undefined) usage = { contextTokens: after, estimated: true, compacted: true };
          } else {
            if (compactHeld) { ctxNow = compactHeld.used; emit('usage', { contextTokens: compactHeld.used, contextMax: compactHeld.size }); } // an ordinary turn after all
            let estimated = false;
            if (!tok && ctxNow > 0 && ctxStart !== null) {
              const promptTokens = Math.ceil(text.length / 4);
              const grew = ctxNow - ctxStart;
              tok = { inputTokens: ctxStart + promptTokens, outputTokens: Math.max(0, grew - promptTokens), cachedReadTokens: 0 };
              estimated = true;
            }
            ctxPrev = ctxNow;
            // agy: exact last-call context from its transcript. Fallback (provider not agy, or no transcript file yet): the
            // turn's summed input+output, an UPPER BOUND that overstates by the number of model calls in the loop.
            const ctxAgy = ctxNow > 0 || (PROVIDER_ALIASES[provider] ?? provider) !== 'antigravity-cli' || !sessionId ? undefined : lastPlannerContext(agyTranscriptPath(sessionId));
            // contextTokens stays on the event (agy sends no usage_update) so the context meter keeps working
            if (tok) usage = { contextTokens: ctxNow > 0 ? ctxNow : (ctxAgy ?? tok.inputTokens + tok.outputTokens), ...(estimated ? { estimated: true } : {}) };
          }
          let turnCost = null;
          // A compacted turn with no measure at all emits no usage: the meter keeps its pre-compact value (compact-step: still-over).
          // `compacted: true` marks the estimate: the server's crossing tracker never re-arms on it (compact-crossing isCompactEstimate).
          if (usage) emit('usage', { contextTokens: usage.contextTokens, ...(tok ? { inputTokens: tok.inputTokens, outputTokens: tok.outputTokens, ...(tok.cachedReadTokens ? { cachedReadTokens: tok.cachedReadTokens } : {}), ...(tok.cachedWriteTokens ? { cachedWriteTokens: tok.cachedWriteTokens } : {}) } : {}), ...(usage.estimated ? { estimated: true } : {}), ...(usage.compacted ? { compacted: true } : {}) });
          if (tok) turnCost = estimateCostUsd(activeModel, tok);
          const done = { stopReason: r?.stopReason };
          if (reportedCost !== undefined) { costTotal = reportedCost; costKnown = true; }
          else if (turnCost !== null) { costTotal += turnCost; costKnown = true; done.costEstimated = true; } // price-table figure, not provider-billed
          if (costKnown) done.costUsd = costTotal;
          lastError = null;
          emit('turn_done', done);
        } catch (e) { compacting = false; if (!cancelling && !stopped) lastError = e.message; emit('error', { message: e.message }); }
        promptInFlight = false;
        dropOrphanSteers(); // the prompt ended: a steer-only item with no real prompt behind it must not start the next one
        if (queue.length && !stopped) {
          pump();
        } else if (running) {
          running = false;
          emit('status', { status: 'idle' });
        }
      }
      return {
        pid: child.pid, // the runner probes this tree for background work before an after-turn park
        ready, // the session handshake: a prompt-less resume reads `starting` until it resolves
        steerable,
        // opts.steerOnly (idea-169): joins the running turn or is dropped (returns false now, or a steer_dropped event later);
        // it never starts a session/prompt of its own.
        send(text, { images = [], steerOnly = false, inputSeq } = {}) {
          if (failed) throw new Error(`agent session failed to start: ${failed.message}`);
          if (steerOnly && !steerable()) return false;
          queue.push({ text, images, ...(steerOnly ? { steerOnly: true, inputSeq } : {}) });
          ready.then(pump, () => {});
          return true;
        },
        // Cancel ends the current turn AND drops prompts queued behind it (a cancelled lane must not resume on stale asks).
        // Differs from the claude adapter, whose cancel only interrupts the current turn and lets later prompts run.
        cancel() {
          for (const q of queue.splice(0)) if (q.steerOnly) emit('steer_dropped', steerDrop('cancelled', q)); // logged, so the recap skips it too
          if (promptInFlight) cancelling = true;
          if (sessionId) write({ method: 'session/cancel', params: { sessionId } });
        },
        kill() { stopped = true; killTree(child); },
      };
    },
  };
}

// ACP wants env as a [{name, value}] list. The per-agent token (X1a) goes in as a literal: this frame lives in memory and
// on the child's stdin only (stdin frames are never logged; only unparseable stdout lines emit `raw`, redacted by the runner).
export function acpMcpServer(spec, env = {}) {
  const list = Object.entries(spec.env).map(([name, value]) => ({ name, value }));
  if (env?.VS_AGENT_TOKEN) list.push({ name: 'VS_AGENT_TOKEN', value: String(env.VS_AGENT_TOKEN) });
  return { name: spec.name, command: spec.command, args: spec.args, env: list };
}

// Restart drain (Runner.setDrain / setRequestDrain): the mid-turn refusal is Claude-only. Claude Code's --settings
// PreToolUse hook (adapters/claude.mjs drainHookSettings + runner/drain-hook.mjs) blocks a NEW run_in_background
// Bash/PowerShell before it runs. ACP providers (opencode, antigravity-cli/agy, codex) have no PreToolUse equivalent:
// their native shell tools run as the agent's own child processes and surface to the client only as `tool_call` session
// updates, which this adapter observes (line ~141) rather than approves — there is no client-side point to veto a
// background shell before it starts. The `session/request_permission` path (permissionOutcome below) auto-approves, and
// its params carry the tool's title/id, not its input, so it could not detect a run_in_background launch even if the
// drain state were wired in here. For these providers the drain is therefore enforced only at turn end:
// Runner._drainRefusesHold stops background shells started after the drain began and tells the agent why on its next
// input. Closing the mid-turn gap would need a protocol change in ACP (or per-provider hooks outside it), out of scope.
// Auto-approve unless the lane explicitly asks to deny (meta.permissionMode === 'deny'); a profile's own mode
// (e.g. "default") never denies, it is the provider's ACP mode.
function permissionOutcome(params, mode) {
  if (mode === 'deny') return { outcome: { outcome: 'cancelled' } };
  const opt = (params?.options ?? []).find((o) => o.kind === 'allow_once') ?? (params?.options ?? []).find((o) => String(o.kind).startsWith('allow'));
  return opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } };
}
