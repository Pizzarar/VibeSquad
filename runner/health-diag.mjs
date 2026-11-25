// idea-909 (O3 follow-up, idea-896): read-only live-agent and orphan-provider-process diagnostics for runner GET /health.
// Pure breakdown from runner.live + held state (idea-631 _bgHeldNow / heldSince / heldWork) + an on-demand cached process
// snapshot (no polling loop, never kills anything).
import { snapshotProcesses, shellCmdTail } from './background.mjs';
import { PROVIDER_ALIASES } from './adapters/acp.mjs';

export const HEALTH_SNAPSHOT_TTL_MS = 15_000;
export const HEALTH_SNAPSHOT_TIMEOUT_MS = 3_000;
export const HELD_CMD_MAX = 120;
export const ORPHAN_CMD_MAX = 160;

const BUSY_STATUSES = new Set(['running', 'starting', 'initializing', 'working']);
const JS_RUNTIMES = new Set(['node', 'bun', 'deno', 'npx']);
const LINK_SLACK_MS = 50;
const MAX_DEPTH = 64;

const imageOf = (name) => String(name ?? '').replace(/^["']|["']$/g, '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');

function firstToken(cmd) {
  const s = String(cmd ?? '').trim();
  if (!s) return '';
  if (s[0] === '"' || s[0] === "'") {
    const end = s.indexOf(s[0], 1);
    return end > 1 ? s.slice(1, end) : s.slice(1);
  }
  return s.split(/\s+/)[0] ?? '';
}

function cleanCmd(text, max) {
  const s = String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, Math.max(0, max - 3)).trimEnd()}...` : s;
}

/** Truncated held shell command string for an idle-held agent, or null when no live shell is known yet. */
export function formatHeldCmd(shells, max = HELD_CMD_MAX) {
  if (!Array.isArray(shells) || !shells.length) return null;
  const parts = [];
  for (const w of shells) {
    const raw = shellCmdTail(w?.cmd || w?.name || '', max * 2);
    const cleaned = cleanCmd(raw, max);
    if (cleaned) parts.push(cleaned);
  }
  if (!parts.length) return null;
  return cleanCmd(parts.join('; '), max);
}

/**
 * Classifies a process as a runner-managed provider process (for orphan reporting), or null.
 * Matches only executable images / runtime launchers of supported providers so shells (`bash -c "grep opencode"`)
 * and unrelated scripts are never flagged.
 */
export function matchProviderProcess(proc) {
  if (!proc || typeof proc !== 'object') return null;
  const img = imageOf(proc.name);
  const cmd = String(proc.cmd ?? '');
  const exe = imageOf(firstToken(cmd));

  if (img === 'opencode' || exe === 'opencode') return 'opencode';
  if (JS_RUNTIMES.has(img) || JS_RUNTIMES.has(exe)) {
    if (/(?:^|[\s"'\\/])opencode(?:\.(?:m?js|cjs))?["']?\s+(?:acp|serve)\b/i.test(cmd)) return 'opencode';
    if (/(?:@anthropic-ai[\\/]claude-code|claude-code[\\/]cli\.(?:m?js|cjs))\b/i.test(cmd) &&
        (/--(?:input-format|output-format)\s+stream-json\b/i.test(cmd) || /--strict-mcp-config\b/i.test(cmd) || /\s-p(?:\s|$)/.test(cmd))) {
      return 'claude';
    }
    if (/(?:^|[\s"'\\/])(?:agy|antigravity-cli)(?:\.(?:m?js|cjs))?["']?\s+acp\b/i.test(cmd)) return 'antigravity-cli';
    if (/@zed-industries[\\/]codex-acp\b|(?:^|[\s"'\\/])codex-acp(?:\.(?:m?js|cjs))?["']?(?:\s|$)/i.test(cmd)) return 'codex';
  }

  if (img === 'claude' || exe === 'claude') {
    if (/--(?:input-format|output-format)\s+stream-json\b/i.test(cmd) || /--strict-mcp-config\b/i.test(cmd) || /\s-p(?:\s|$)/.test(cmd)) {
      return 'claude';
    }
    return null;
  }

  if (img === 'agy' || exe === 'agy' || img === 'antigravity-cli' || exe === 'antigravity-cli') {
    return /\bacp\b/i.test(cmd) ? 'antigravity-cli' : null;
  }

  if (img === 'codex-acp' || exe === 'codex-acp') return 'codex';

  return null;
}

function validParent(child, parent) {
  if (!parent || child.pid === parent.pid) return false;
  if (parent.createdMs > 0 && child.createdMs > 0 && child.createdMs + LINK_SLACK_MS < parent.createdMs) return false;
  return true;
}

function subtreePids(rootPid, byPid, kids) {
  if (!byPid.has(rootPid)) return [];
  const out = [];
  const seen = new Set();
  const walk = (pid, depth) => {
    if (seen.has(pid) || depth > MAX_DEPTH) return;
    const p = byPid.get(pid);
    if (!p) return;
    seen.add(pid);
    out.push(pid);
    for (const c of kids.get(pid) ?? []) {
      if (validParent(c, p)) walk(c.pid, depth + 1);
    }
  };
  walk(rootPid, 0);
  return out;
}

/**
 * Pure read-only breakdown of live agents (by provider × state, per-agent rows with process count)
 * and orphan provider processes with no owning live agent.
 */
export function buildHealthLiveDiag(runner, { heldAgents = null, heldWork = null, procs = null, now = Date.now() } = {}) {
  const live = runner?.live instanceof Map ? runner.live : new Map();
  const heldSet = new Set(Array.isArray(heldAgents) ? heldAgents : (typeof runner?.heldIds === 'function' ? runner.heldIds() : []));
  const workMap = heldWork && typeof heldWork === 'object' ? heldWork : (typeof runner?.heldWork === 'function' ? runner.heldWork() : {});

  const hasProcs = Array.isArray(procs);
  const byPid = new Map();
  const kids = new Map();
  if (hasProcs) {
    for (const p of procs) {
      if (!p || !Number.isInteger(p.pid) || p.pid <= 0) continue;
      byPid.set(p.pid, p);
      if (!kids.has(p.ppid)) kids.set(p.ppid, []);
      kids.get(p.ppid).push(p);
    }
  }

  const ownedPids = new Set();
  const liveByProvider = {};
  const liveAgents = [];

  for (const [id, e] of live) {
    const rawProvider = String(e?.provider ?? 'unknown');
    const provider = PROVIDER_ALIASES[rawProvider] ?? rawProvider;
    const isRunning = (Number(e?.inflight) > 0) || BUSY_STATUSES.has(e?.status);
    let state;
    if (isRunning) {
      state = 'running';
    } else {
      const isHeld = typeof runner?._bgHeldNow === 'function'
        ? Boolean(runner._bgHeldNow(id))
        : ((e?.heldSince !== null && e?.heldSince !== undefined) || heldSet.has(id));
      state = isHeld ? 'idle-held' : 'idle-unparked';
    }

    if (!liveByProvider[provider]) {
      liveByProvider[provider] = { running: 0, 'idle-held': 0, 'idle-unparked': 0, total: 0 };
    }
    liveByProvider[provider][state] += 1;
    liveByProvider[provider].total += 1;

    let procCount = null;
    if (hasProcs) {
      const rootPid = Number.isInteger(e?.handle?.pid) && e.handle.pid > 0 ? e.handle.pid : null;
      if (rootPid === null) {
        procCount = 0;
      } else {
        const tree = subtreePids(rootPid, byPid, kids);
        procCount = tree.length;
        for (const pid of tree) ownedPids.add(pid);
      }
    }

    const row = { id, provider, state, procCount };
    if (state === 'idle-held') {
      const shells = Array.isArray(workMap[id]) ? workMap[id] : (Array.isArray(e?.heldNow) ? e.heldNow : []);
      row.heldCmd = formatHeldCmd(shells);
    }
    liveAgents.push(row);
  }

  const orphanProviderProcs = [];
  if (hasProcs) {
    for (const p of procs) {
      if (!p || !Number.isInteger(p.pid) || p.pid <= 0 || ownedPids.has(p.pid)) continue;
      const provider = matchProviderProcess(p);
      if (!provider) continue;
      const ageSec = Number.isFinite(p.createdMs) && p.createdMs > 0 ? Math.max(0, Math.round((now - p.createdMs) / 1000)) : null;
      orphanProviderProcs.push({
        pid: p.pid,
        ppid: Number.isInteger(p.ppid) ? p.ppid : null,
        provider,
        cmd: cleanCmd(p.cmd || p.name || '', ORPHAN_CMD_MAX),
        ...(ageSec !== null ? { ageSec } : {}),
      });
    }
    orphanProviderProcs.sort((a, b) => a.pid - b.pid);
  }

  return { liveByProvider, liveAgents, orphanProviderProcs };
}

/**
 * On-demand single-flight cached process snapshot (no polling loop). Returns null on error/timeout so /health stays 200 OK.
 */
export function createHealthSnapshotCache({ snapshot = () => snapshotProcesses({ timeoutMs: HEALTH_SNAPSHOT_TIMEOUT_MS }), ttlMs = HEALTH_SNAPSHOT_TTL_MS, now = () => Date.now() } = {}) {
  if (snapshot === null) return async () => null;
  let cached = null; // { at, procs }
  let inflight = null;
  return async () => {
    const t = now();
    if (cached && t - cached.at < ttlMs) return cached.procs;
    if (inflight) return inflight;
    inflight = Promise.resolve()
      .then(() => snapshot())
      .then(
        (procs) => {
          const list = Array.isArray(procs) ? procs : null;
          if (list) cached = { at: now(), procs: list };
          return list;
        },
        () => null,
      )
      .finally(() => { inflight = null; });
    return inflight;
  };
}
