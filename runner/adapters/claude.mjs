// Claude NATIVE adapter: one `claude` CLI child per agent in stream-json mode, stdin kept open
// for multi-turn. Chosen over @anthropic-ai/claude-agent-sdk because the SDK is not a
// dependency here and the CLI already gives exactly one child per agent.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killTree, spawnNoShell } from '../spawn.mjs';
import { lineReader } from './lines.mjs';
import { mcpServerSpec, mcpServerPath } from './mcp.mjs';
import { parseClaudeRateLimit } from '../limits.mjs';
import { readFileSync, readdirSync } from 'node:fs';

export const DEFAULT_PERMISSION_MODE = 'auto';
export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'];
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']; // claude --effort levels
export const effectivePermissionMode = (meta = {}) => meta.permissionMode || DEFAULT_PERMISSION_MODE;

// K4: runner agents load only the vibesquad MCP (--strict-mcp-config) and none of the synced user plugins
// (data/engineering/productivity/cowork connectors + skills, ~2.3k tokens/call), turned off via --settings enabledPlugins.
// The user setting source stays: ~/.claude/CLAUDE.md and user settings (global git/push rules) must reach every agent.
// VS hooks run on the runner lifecycle bus, not CLI settings. Never --bare (skips hooks) or --disable-slash-commands (/compact).
export const SYNCED_PLUGINS = ['engineering', 'productivity', 'cowork-plugin-management', 'data'];
export function pluginsOffSettings(home = os.homedir()) {
  const names = new Set(SYNCED_PLUGINS);
  try { // also any other synced plugin on this machine: <synced>/<account>/<name>.meta.json
    const root = path.join(home, '.claude', 'plugins', 'synced');
    for (const acct of readdirSync(root)) for (const f of readdirSync(path.join(root, acct))) if (f.endsWith('.meta.json')) names.add(f.slice(0, -'.meta.json'.length));
  } catch { /* no synced plugins */ }
  return JSON.stringify({ enabledPlugins: Object.fromEntries([...names].map((n) => [`${n}@synced`, false])) });
}
// Extras are opt-in: a profile with mcpExtras:["playwright"] (server/profiles.mjs; the backend stamps it as the vs.mcp label)
// or any agent labelled vs.mcp=playwright (comma list).
export const wantsPlaywright = (meta = {}) => String(meta.labels?.['vs.mcp'] ?? '').split(',').map((s) => s.trim().toLowerCase()).includes('playwright');
// Reuse the owner's own playwright server config (browser/headless flags) when present, else a headless default.
export function playwrightSpec(home = os.homedir()) {
  try {
    const s = JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8'))?.mcpServers?.playwright;
    if (s?.command) return { command: s.command, args: s.args ?? [], env: s.env ?? {} };
  } catch { /* fall through to the default */ }
  return { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated'], env: {} };
}

// promptsDir: <runner home>/prompts (the Runner passes it); the tmpdir fallback only serves adapters built standalone.
export function createClaudeAdapter({ spawnImpl, command = 'claude', mcp = true, mcpPath = mcpServerPath(), promptsDir = path.join(os.tmpdir(), 'vibesquad-runner-prompts') } = {}) {
  const promptFile = (id) => path.join(promptsDir, `${String(id ?? 'agent').replace(/[^\w.-]/g, '_')}.md`);
  const mcpFile = (id) => path.join(promptsDir, `${String(id ?? 'agent').replace(/[^\w.-]/g, '_')}.mcp.json`);
  return {
    name: 'claude',
    canPark: true, // the CLI keeps its transcript on disk, so a killed idle agent can be resumed with --resume <sessionId>
    cleanup(id) { for (const f of [promptFile(id), mcpFile(id)]) { try { rmSync(f, { force: true }); } catch { /* best effort */ } } }, // on archive; start rewrites them
    start({ id, model, cwd, meta = {}, systemPrompt, env, emit, onExit, resume }) {
      const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
      if (resume) args.push('--resume', String(resume));
      if (model) args.push('--model', model);
      args.push('--permission-mode', effectivePermissionMode(meta));
      if (CLAUDE_EFFORTS.includes(meta.thinkingOptionId)) args.push('--effort', meta.thinkingOptionId);
      args.push('--settings', pluginsOffSettings());
      if (mcp) {
        const spec = mcpServerSpec({ env, path: mcpPath });
        // Via a file too: server args/env grow without bound toward the same 32,767-char cap.
        const file = mcpFile(id);
        mkdirSync(path.dirname(file), { recursive: true });
        const extra = wantsPlaywright(meta);
        const servers = { [spec.name]: { command: spec.command, args: spec.args, env: spec.env } };
        if (extra) servers.playwright = playwrightSpec();
        writeFileSync(file, JSON.stringify({ mcpServers: servers }), 'utf8');
        args.push('--strict-mcp-config', '--mcp-config', file);
        args.push('--allowedTools', `mcp__${spec.name}`, ...(extra ? ['mcp__playwright'] : []));
      }
      // The prompt goes via a file, never argv: a long role prompt blows the Windows 32,767-char command-line cap (spawn ENAMETOOLONG).
      // Rewritten on every start/resume so a parked agent restarts with the same prompt.
      if (systemPrompt) {
        const file = promptFile(id);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, String(systemPrompt), 'utf8'); // UTF-8, no BOM
        args.push('--append-system-prompt-file', file);
      }
      let child;
      try { child = spawnNoShell(command, args, { cwd, ...(env ? { env } : {}) }, spawnImpl); } catch (err) { this.cleanup(id); throw err; } // don't leak the files written above
      let pending = 0; // open turns written to stdin whose `result` has not arrived yet
      let interrupted = false; // an interrupt was issued: the next send opens its own turn (it does not merge)
      let stopped = false; // set by kill(): a result that lands after we were stopped must not log a follow-up turn
      child.stdin.on('error', () => {}); // EPIPE from a write racing child exit: the 'exit' handler already reports it
      const stdin = (o) => child.stdin.write(JSON.stringify(o) + '\n');
      lineReader(child.stdout, (line) => {
        let m;
        try { m = JSON.parse(line); } catch { emit('raw', { line }); return; }
        if (m.type === 'system' && m.subtype === 'init') emit('session', { sessionId: m.session_id, model: m.model });
        else if (m.type === 'system' && m.subtype === 'compact_boundary') {
          // K0 probe 11-08: a `/compact <focus>` user turn emits this with compact_metadata {trigger, pre_tokens, post_tokens, ...}.
          // No assistant usage follows until the next real turn, so post_tokens is the "after" and also resets the context meter now.
          const c = m.compact_metadata ?? {};
          const num = (v) => (Number.isFinite(v) ? v : undefined);
          emit('compacted', { before: num(c.pre_tokens), after: num(c.post_tokens), trigger: c.trigger, durationMs: num(c.duration_ms) });
          if (Number.isFinite(c.post_tokens)) emit('usage', { contextTokens: c.post_tokens, inputTokens: c.post_tokens, outputTokens: 0 });
        }
        else if (m.type === 'rate_limit_event') {
          for (const w of parseClaudeRateLimit(m)) emit('limit', { provider: 'claude', ...w, source: 'provider' });
        } else if (m.type === 'assistant') {
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
          pending = Math.max(0, pending - 1);
          interrupted = false; // an interrupt flag lasts only until the turn it interrupts produces its result
          // A failed turn must read as an error (push "Agent Error", UI status), not a normal completion.
          if (m.is_error || String(m.subtype ?? '').startsWith('error')) {
            emit('error', { message: (typeof m.result === 'string' && m.result) || m.subtype || 'turn failed' });
          }
          emit('turn_done', { stopReason: m.stop_reason ?? m.subtype, costUsd: m.total_cost_usd });
          emit('status', { status: 'idle' });
          if (pending > 0 && !stopped) emit('status', { status: 'running' }); // a follow-up turn (steer/interrupt) now runs
        }
      });
      lineReader(child.stderr, (line) => emit('stderr', { line }));
      child.on('error', (err) => onExit({ code: null, error: String(err.message) }));
      child.on('exit', (code, signal) => onExit({ code, signal }));
      return {
        send(text, { images = [] } = {}) {
          // A send into an open, non-interrupted turn merges into it (the CLI emits ONE result for the merged turn), so
          // it must not open another slot. Only a fresh turn (none open) or one after an interrupt/cancel opens its own.
          if (interrupted || pending === 0) {
            pending++;
            interrupted = false;
          }
          emit('status', { status: 'running' });
          // stream-json accepts Anthropic content blocks: images go as base64 sources ahead of the text.
          const content = images.length
            ? [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } })), { type: 'text', text }]
            : text;
          stdin({ type: 'user', message: { role: 'user', content } });
        },
        // Interrupts the current turn only; prompts already written to stdin still run (the ACP adapter drops its queue).
        cancel() {
          if (pending > 0) {
            interrupted = true;
            stdin({ type: 'control_request', request_id: `int-${Date.now()}`, request: { subtype: 'interrupt' } });
          }
        },
        kill() { stopped = true; killTree(child); },
      };
    },
  };
}
