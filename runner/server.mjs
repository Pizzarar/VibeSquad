// Runner entry point + local API. Loopback HTTP/JSON: any VS process (or curl) can talk to it,
// it survives VS restarts, and needs no framing code.
//   node runner/server.mjs [--port 0] [--dir <agent log dir>] [--home <runner home>]
// Two caller kinds (PLAN_X1_IDENTITY X1a):
//   admin: `Authorization: Bearer <token>` (the token lives in <home>/token, mode 0600) and NO `x-vs-agent-id` header: the
//          VS server, its hook host and scripts/restart-runtime.mjs. Authorised on every route, as always.
//   agent: `x-vs-agent-id` + `x-vs-agent-token` (the per-agent token the runner minted into that agent's env). Verified
//          against runner memory (GET /verify-agent tells the VS server who is calling); scoped per route (see agentMay).
//          A request that carries `x-vs-agent-id` without a matching token is 403 whatever else it carries.
// Discovery for VS: <home>/runner.json = { port, pid, startedAt }.
import { startLoopLagMonitor, loopLagStats } from './loop-lag.mjs';
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runner, agentMay, crossSquadInput, protectedMetaIn, spawnMetaForAgent } from './runner.mjs';
import { FOLD_INDEX_FILE } from './fold-index.mjs';
import { createChildLedger, sweepOrphans } from './children.mjs';
import { setChildLedger } from './spawn.mjs';
import { createDevServerReaper } from './reap.mjs';
import { DETACHED_FILE, createDetachedProbe, detachedSupported } from './detached.mjs';
import { acquireRunnerLock, holdsLock, readLock, readPublished, releaseLock } from './lock.mjs';
import { buildHealthLiveDiag, createHealthSnapshotCache } from './health-diag.mjs';

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_INPUT_BYTES = 24 * 1024 * 1024; // /input carries base64 image attachments
const SSE_SKIP = new Set(['stderr', 'raw']); // noisy, never rendered
const SSE_HEARTBEAT_MS = 15000;
// idea-870: live entry statuses POST /restart-gate counts as busy beside an open turn (the VS server's runnerBusy RUNNING set).
const GATE_BUSY = new Set(['running', 'initializing', 'starting', 'working']);

/**
 * Content hash of a runner's own *.mjs files, recursive (adapters/ etc.), one process = one set. The supervisor hashes
 * the runtime runner/ dir on disk the same way and compares against the hash the live runner reports on /health, so a
 * build → sync-runtime that changed runner code is detected and the runner auto-restarts (RR1).
 * Cached by (relative path, size, mtimeMs): a tick that rehashes unchanged files only stats them, never re-reads them.
 */
const runnerHashCache = new Map(); // dir -> { key, hash }
export function hashRunnerFiles(dir = path.dirname(fileURLToPath(import.meta.url))) {
  const files = [];
  const walk = (d, rel) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; } // dir missing: empty digest
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue; // never follow links (node_modules, junctions)
      const p = path.join(d, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(p, r);
      else if (ent.name.endsWith('.mjs')) {
        try {
          const st = statSync(p);
          files.push({ r, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* vanished mid-walk */ }
      }
    }
  };
  walk(dir, '');
  files.sort((a, b) => (a.r < b.r ? -1 : 1));
  const key = files.map((f) => `${f.r}\u0000${f.size}\u0000${f.mtimeMs}`).join('\n');
  const hit = runnerHashCache.get(dir);
  if (hit && hit.key === key) return hit.hash;
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f.r);
    h.update('\0');
    try { h.update(readFileSync(path.join(dir, f.r))); } catch { /* file vanished mid-read */ }
    h.update('\0');
  }
  const hash = h.digest('hex');
  runnerHashCache.set(dir, { key, hash });
  return hash;
}

export function tokenMatches(header, token) {
  const m = /^Bearer (.+)$/.exec(String(header ?? ''));
  if (!m || !token) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// teamLog(entry): appends { team, lane, agent, type, text, refs } to the VS team log (teamLogWriter); a no-op when not wired (tests).
export function createServer(runner, { token, maxBodyBytes = MAX_BODY_BYTES, maxInputBytes = MAX_INPUT_BYTES, heartbeatMs = SSE_HEARTBEAT_MS, hash = hashRunnerFiles(), onShutdown = null, teamLog = () => {}, processSnapshot, processSnapshotTtlMs } = {}) {
  const getHealthProcs = createHealthSnapshotCache({
    ...(processSnapshot !== undefined ? { snapshot: processSnapshot } : {}),
    ...(processSnapshotTtlMs !== undefined ? { ttlMs: processSnapshotTtlMs } : {}),
  });
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req, limit = maxBodyBytes) => new Promise((resolve, reject) => {
    let s = '';
    let size = 0;
    let dead = false;
    req.on('data', (c) => {
      if (dead) return;
      size += c.length;
      if (size > limit) {
        dead = true;
        const err = new Error('request body too large');
        err.status = 413;
        reject(err);
        return;
      }
      s += c;
    });
    req.on('end', () => { if (!dead) { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } } });
    req.on('error', reject);
  });

  // The caller of a request: { kind: 'admin' } or { kind: 'agent', id, role, lane, team, status, ... } (verifyAgent's record),
  // or a refusal { deny: 401 | 403, error }. Agent headers win over the bearer: a claimed id is never looked up unverified.
  const resolveCaller = (req) => {
    const h = (k) => { const v = req.headers[k]; return Array.isArray(v) ? v[0] : v; };
    const agentId = String(h('x-vs-agent-id') ?? '').trim();
    if (agentId) {
      const v = runner.verifyAgent(agentId, String(h('x-vs-agent-token') ?? ''));
      return v ? { kind: 'agent', ...v } : { deny: 403, error: 'agent token invalid (x-vs-agent-id does not match x-vs-agent-token, or the agent is gone/retired)' };
    }
    if (token && !tokenMatches(req.headers.authorization, token)) return { deny: 401, error: 'unauthorized' };
    return { kind: 'admin' };
  };
  const forbid = (res, what) => json(res, 403, { error: what });
  // Scope check for an agent caller on an existing target (admin passes). 404 for a missing target, 403 when out of scope.
  const scoped = (res, caller, action, id) => {
    if (caller.kind !== 'agent') return true;
    const target = runner.status(id);
    if (!target) { json(res, 404, { error: 'no such agent' }); return false; }
    if (agentMay(caller, action, target)) return true;
    forbid(res, `${caller.id} may not ${action} ${id}`);
    return false;
  };

  // Settled non-GET requests since this runner booted, from ANY client process (idea-233 d). The VS server's roster-read
  // coalescing checks it before a reader joins a read already in flight: a write another process (an agent sidecar, a CLI)
  // made after that read started must not be answered from it. `boot` tells a restarted runner's count from the old one's.
  const writes = { boot: randomBytes(6).toString('hex'), seq: 0 };
  const handle = async (req, res) => {
    try {
      const caller = resolveCaller(req);
      if (caller.deny) return json(res, caller.deny, { error: caller.error });
      const isAgent = caller.kind === 'agent';
      const declared = Number(req.headers['content-length'] ?? 0);
      const isInput = req.method === 'POST' && /^\/agents\/[^/]+\/input$/.test(req.url.split('?')[0]);
      if (declared > (isInput ? maxInputBytes : maxBodyBytes)) { res.setHeader('connection', 'close'); return json(res, 413, { error: 'request body too large' }); }
      const url = new URL(req.url, 'http://x');
      const parts = url.pathname.split('/').filter(Boolean); // agents, :id, action
      if (req.method === 'GET' && parts[0] === 'health') {
        let running = 0;
        let quiet = 0;
        for (const e of runner.live.values()) { if (e.inflight > 0) running += 1; if (e.quiet) quiet += 1; }
        // held: idle agents whose background work (a suite, a build) holds their park; running counts open turns only.
        // Checked against reality first (ideas 228 + 229: a hold whose shells are all dead is dropped, not reported).
        const heldAgents = runner.heldIds?.() ?? [];
        // heldWork: id -> the live shells each hold is on ({ pid, name, cmd }), so a deferral names what actually holds.
        const heldWork = runner.heldWork?.() ?? {};
        // idea-909: read-only live breakdown (provider × state, per-agent rows with process count) + orphan provider processes.
        const procs = await getHealthProcs();
        const diag = buildHealthLiveDiag(runner, { heldAgents, heldWork, procs });
        // drain: { since, until, reason } while a `vs restart` refuses new background work (ideas 198 + 186), else null.
        return json(res, 200, { ok: true, live: runner.live.size, running, quiet, held: heldAgents.length, heldAgents, heldWork, ...diag, drain: runner.drainState?.() ?? null, bootFoldMs: runner.bootFoldReport?.() ?? null, pid: process.pid, hash, ...loopLagStats() });
      }
      if (req.method === 'GET' && parts[0] === 'write-seq' && parts.length === 1) return json(res, 200, { boot: writes.boot, seq: writes.seq });
      if (parts[0] === 'drain' && parts.length === 1 && (req.method === 'POST' || req.method === 'DELETE')) {
        // Restart drain (ideas 198 + 186), set/cleared by scripts/restart-runtime.mjs: POST { ttlMs, reason } starts or refreshes
        // it, DELETE ends it. Admin bearer only and only with a token configured (like /shutdown): an agent token never sets it.
        if (isAgent) return forbid(res, 'drain is admin only (set by vs restart)');
        if (!token || typeof runner.setDrain !== 'function') return json(res, 403, { error: 'drain not enabled' });
        if (req.method === 'DELETE') {
          const cleared = runner.clearDrain();
          console.log(JSON.stringify({ drain: 'cleared', active: cleared }));
          return json(res, 200, { ok: true, cleared, drain: runner.drainState() }); // an open restart request's drain stays (idea-476)
        }
        const b = await readBody(req);
        const drain = runner.setDrain({ ttlMs: b.ttlMs, reason: typeof b.reason === 'string' ? b.reason : '' });
        console.log(JSON.stringify({ drain: 'set', ...drain }));
        return json(res, 200, { ok: true, drain });
      }
      if (parts[0] === 'drain' && parts[1] === 'request' && parts.length === 2 && (req.method === 'POST' || req.method === 'DELETE')) {
        // idea-476 (1): the open restart request's drain, refreshed by the VS server's request loop (server/restart-request.mjs):
        // POST { id, tip, ttlMs, reason } starts or refreshes it, DELETE { id } ends that request's drain. Admin only, as /drain.
        if (isAgent) return forbid(res, 'drain is admin only (set by the restart request loop)');
        if (!token || typeof runner.setRequestDrain !== 'function') return json(res, 403, { error: 'drain not enabled' });
        const b = await readBody(req);
        if (req.method === 'DELETE') {
          const cleared = runner.clearRequestDrain({ id: typeof b.id === 'string' && b.id ? b.id : null });
          console.log(JSON.stringify({ drain: 'request-cleared', id: b.id ?? null, active: cleared }));
          return json(res, 200, { ok: true, cleared, drain: runner.drainState() });
        }
        const drain = runner.setRequestDrain({ id: b.id, tip: typeof b.tip === 'string' ? b.tip : '', ttlMs: b.ttlMs, reason: typeof b.reason === 'string' ? b.reason : '' });
        return json(res, 200, { ok: true, drain });
      }
      if (parts[0] === 'restart-gate' && parts.length === 1 && (req.method === 'POST' || req.method === 'DELETE')) {
        // idea-870: the VS server's runner restart (owner "Restart runner", RR1) closes this gate right before its kill. POST
        // { ttlMs } checks idle and closes the gate in one synchronous step (no await between them), so no turn can start
        // between the idle check and the kill: a new turn queues instead (recoverQueued replays it on the next runner).
        // Busy -> { gated: false, running, held, ids } and the gate stays open. DELETE reopens it. Admin only, as /drain.
        if (isAgent) return forbid(res, 'restart-gate is admin only (the VS server restart)');
        if (!token) return json(res, 403, { error: 'restart gate not enabled' }); // as /drain: a tokenless runner fails closed
        if (typeof runner.setRestartGate !== 'function') return json(res, 404, { error: 'not found' });
        if (req.method === 'DELETE') return json(res, 200, { ok: true, cleared: runner.clearRestartGate() });
        const b = await readBody(req);
        // From here to setRestartGate: synchronous.
        const ids = new Set();
        let running = 0;
        for (const [id, e] of runner.live) if (e.inflight > 0 || GATE_BUSY.has(e.status)) { running += 1; ids.add(id); }
        const heldAgents = runner.heldIds?.() ?? [];
        for (const id of heldAgents) ids.add(id);
        if (running > 0 || heldAgents.length > 0) return json(res, 200, { ok: true, gated: false, running, held: heldAgents.length, ids: [...ids] });
        const gate = runner.setRestartGate(b.ttlMs);
        console.log(JSON.stringify({ restartGate: 'closed', until: gate.until }));
        return json(res, 200, { ok: true, gated: true, until: gate.until, running: 0, held: 0, ids: [] });
      }
      if (req.method === 'GET' && parts[0] === 'verify-agent' && parts.length === 1) {
        // Who is calling, from runner memory: the VS server forwards an agent's headers here once per request (X1c).
        if (!isAgent) return json(res, 400, { error: 'agent headers required (x-vs-agent-id + x-vs-agent-token)' });
        const { kind, ...who } = caller;
        return json(res, 200, who);
      }
      if (req.method === 'POST' && parts[0] === 'shutdown' && parts.length === 1) {
        // Graceful stop for the detached restart script (scripts/restart-runtime.mjs): Windows has no SIGTERM. It kills every
        // agent, so it is only served to the admin bearer (a missing/wrong one was rejected above) when a token is configured.
        if (isAgent) return forbid(res, 'shutdown is admin only');
        if (!token || !onShutdown) return json(res, 403, { error: 'shutdown not enabled' });
        json(res, 202, { ok: true, pid: process.pid });
        setImmediate(onShutdown);
        return;
      }
      if (req.method === 'GET' && parts[0] === 'events' && parts.length === 1) {
        if (isAgent) return forbid(res, 'the event stream is admin only');
        // SSE tail of every log append. Cleaned up on client disconnect; nothing buffers per client.
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': ok\n\n');
        const off = runner.subscribe((id, ev) => {
          if (!SSE_SKIP.has(ev.type)) res.write(`data: ${JSON.stringify({ id, event: ev })}\n\n`);
        });
        const beat = setInterval(() => res.write(': hb\n\n'), heartbeatMs);
        beat.unref?.();
        const done = () => { off(); clearInterval(beat); };
        req.on('close', done);
        res.on('close', done);
        return;
      }
      if (parts[0] !== 'agents') return json(res, 404, { error: 'not found' });
      if (parts.length === 1) {
        if (req.method === 'POST') {
          const b = await readBody(req);
          // An agent spawn gets the caller's team + parent stamped and its role checked (never silently downgraded): see spawnMetaForAgent.
          if (isAgent) b.meta = spawnMetaForAgent(caller, b.meta ?? {}, { laneHasLiveLead: (team, lane) => runner.laneHasLiveLead(team, lane) });
          const nid = runner.create(b);
          return json(res, 201, { id: nid, ...runner.queuePosition(nid) }); // over a turn cap it queues and answers at once
        }
        if (req.method === 'GET') {
          if (url.searchParams.get('full') !== '1') return json(res, 200, { ids: runner.list() });
          const writeSeq = { boot: writes.boot, seq: writes.seq }; // taken before the scan: every write it counts is in the answer
          const all = await runner.statusAllAsync(); // async: yields between slices so a full scan never stalls POST /agents
          // archived=0: leave archived records out (most of a long-lived roster). Serialising them here and parsing them in the
          // VS server on every roster read stalled the server's event loop (unit-loop-stall). `ids` stays complete.
          return json(res, 200, url.searchParams.get('archived') === '0' ? { ids: all.ids, agents: all.agents.filter((a) => !a.archivedAt), writeSeq } : { ...all, writeSeq });
        }
      }
      const id = parts[1];
      if (parts.length === 2 && req.method === 'GET') {
        const s = runner.status(id);
        return s ? json(res, 200, s) : json(res, 404, { error: 'no such agent' });
      }
      if (parts[2] === 'timeline' && req.method === 'GET') {
        if (!runner.store.exists(id)) return json(res, 404, { error: 'no such agent' });
        const tail = Number(url.searchParams.get('tail') ?? 0); // idea-308: the last N raw events, so a tail read costs O(tail), not O(log)
        const total = runner.store.count(id);
        const after = tail > 0 ? Math.max(0, total - tail) : Number(url.searchParams.get('after') ?? 0);
        // until=<seq>: only events with seq < until (a bounded window); types=tool: only tool events (small answer for a long tail)
        const until = url.searchParams.has('until') ? Number(url.searchParams.get('until')) : Infinity;
        const types = url.searchParams.get('types');
        const limit = Number(url.searchParams.get('limit') ?? Infinity);
        const events = types
          ? await runner.store.readAsync(id, after, Infinity, undefined, (e) => e.type === types && e.seq < until)
          : await runner.timelineAsync(id, after, Number.isFinite(until) ? Math.min(limit, Math.max(0, until - after)) : limit);
        return json(res, 200, { events, from: after, total, next: events.length ? events[events.length - 1].seq + 1 : after });
      }
      if (parts[2] === 'input' && req.method === 'POST') {
        const b = await readBody(req, maxInputBytes);
        if (!scoped(res, caller, 'input', id)) return;
        const target = isAgent ? runner.status(id) : null;
        const xsquad = isAgent && crossSquadInput(caller, target); // passed scope only through the Overlord's cross-Squad grant
        // Agent callers: owner and senderId come from the verified caller, never the body; an interrupt needs cancel rights
        // on the target (runner.send cancels from input), else it is a steer.
        const owner = isAgent ? false : b.owner === true;
        const senderId = isAgent ? caller.id : undefined;
        let activeTurnBehavior = b.activeTurnBehavior;
        if (isAgent && activeTurnBehavior === 'interrupt' && !agentMay(caller, 'cancel', target)) activeTurnBehavior = 'steer';
        // steerOnly (idea-169): join the open turn or drop ({ delivered: false, reason }); never starts a turn. Any caller may ask: it is strictly weaker.
        const pos = runner.send(id, b.text, { images: b.images, activeTurnBehavior, owner, senderId, ...(b.steerOnly === true ? { steerOnly: true } : {}) }); // over a turn cap it queues and answers at once
        if (xsquad) {
          // Audit: every cross-Squad input lands in the sender's team log. Never fails the delivered send.
          const to = target.meta?.team ?? target.meta?.labels?.team;
          try { teamLog({ team: caller.team, lane: caller.lane, agent: caller.id, type: 'decision', text: `xsquad input ${caller.id} (${caller.team}) -> ${id} (${to})`, refs: [caller.id, id] }); } catch (err) { console.error('xsquad audit log failed', err); }
        }
        return json(res, 202, { ok: true, ...pos, ...(senderId ? { senderId } : {}) });
      }
      if (parts[2] === 'resume' && req.method === 'POST') {
        if (!runner.store.exists(id)) return json(res, 404, { error: 'no such agent' });
        if (!scoped(res, caller, 'resume', id)) return;
        if (!runner.resume(id)) return json(res, 409, { error: 'agent cannot be resumed' });
        return json(res, 202, { ok: true });
      }
      if (parts[2] === 'unwedge' && req.method === 'POST') {
        if (isAgent) return forbid(res, 'unwedge is admin only');
        if (!runner.store.exists(id)) return json(res, 404, { error: 'no such agent' });
        const b = await readBody(req);
        return json(res, 200, { ok: true, ...runner.unwedge(id, { retry: b.retry === true, reason: typeof b.reason === 'string' ? b.reason.slice(0, 300) : '' }) });
      }
      if (parts[2] === 'stop-background' && req.method === 'POST') {
        // Ideas 228 + 229: stop an idle agent's background work, each shell's whole tree (taskkill /T /F). Same scope as cancel,
        // plus (idea-474) a lane lead over its retired predecessor lead in the same Squad + lane (agentMay 'stop-background').
        if (!runner.store.exists(id)) return json(res, 404, { error: 'no such agent' });
        if (!scoped(res, caller, 'stop-background', id)) return;
        try {
          const r = await runner.stopBackground(id, { by: isAgent ? caller.id : 'admin' });
          return json(res, 200, { ok: true, stopped: r.stopped, ...(r.spared ? { spared: r.spared, held: r.held } : {}) });
        } catch (err) { return json(res, err.status ?? 500, { error: String(err.message ?? err) }); }
      }
      if (parts[2] === 'cancel' && req.method === 'POST') {
        if (!scoped(res, caller, 'cancel', id)) return;
        runner.cancel(id);
        return json(res, 202, { ok: true });
      }
      if (parts[2] === 'meta' && req.method === 'POST') {
        const patch = await readBody(req);
        if (isAgent) {
          const hit = protectedMetaIn(patch);
          if (hit) return forbid(res, `an agent may not set ${hit.join(', ')} (admin only)`);
          if (!scoped(res, caller, 'meta', id)) return;
        }
        runner.updateMeta(id, patch);
        return json(res, 202, { ok: true });
      }
      if (parts[2] === 'config' && req.method === 'POST') {
        const b = await readBody(req);
        if (!scoped(res, caller, 'config', id)) return;
        return json(res, 202, { ok: true, ...runner.setConfig(id, b) });
      }
      if (parts[2] === 'archive' && req.method === 'POST') {
        if (!scoped(res, caller, 'archive', id)) return;
        runner.archive(id);
        return json(res, 202, { ok: true });
      }
      if (parts[2] === 'unarchive' && req.method === 'POST') {
        if (!scoped(res, caller, 'unarchive', id)) return;
        runner.unarchive(id);
        return json(res, 202, { ok: true });
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, err.status ?? 400, { error: err.message });
    }
  };
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') return handle(req, res);
    // Bumped once the handler is done (its change is applied and answered), before this loop serves another request.
    try { await handle(req, res); } finally { writes.seq += 1; }
  });
}

async function holderHealthy(home) {
  try {
    const { port } = JSON.parse(readFileSync(path.join(home, 'runner.json'), 'utf8'));
    const token = readFileSync(path.join(home, 'token'), 'utf8').trim();
    const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// The Squad's hub lane (its Overlord's lane) from the teams registry, mirroring server/lane-pure.mjs isHubLane without
// importing server code into the runner: a lane flagged `hub: true`, else the lane whose id is the team id. Reads
// VIBESQUAD_TEAMS_FILE or <VIBESQUAD_HOME>/teams.json, re-parsed only when the file changed; no file → the default rule.
export function hubLaneReader(vsHome, env = process.env) {
  const file = env.VIBESQUAD_TEAMS_FILE || path.join(vsHome, 'teams.json');
  let stamp = null;
  let hubs = new Map(); // team id -> hub lane id
  return (team) => {
    try {
      const st = statSync(file);
      const now = `${st.size}:${st.mtimeMs}`;
      if (now !== stamp) {
        const next = new Map();
        for (const t of JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))?.teams ?? []) {
          const flagged = (t?.lanes ?? []).find((l) => l?.hub === true);
          if (t?.id) next.set(String(t.id), flagged?.id != null ? String(flagged.id) : String(t.id));
        }
        hubs = next;
        stamp = now;
      }
    } catch { /* no registry here: default rule */ }
    return hubs.get(String(team)) ?? String(team);
  };
}

// The runner's writer for the VS team log, mirroring server/brainstorm.mjs appendVsLogEntry without importing server
// code: one JSON line in <vsHome>/logs/<team>--<lane>.jsonl and <vsHome>/teams/<team>/log.jsonl.
export function teamLogWriter(vsHome) {
  const seg = (v) => String(v ?? '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'vibesquad';
  return ({ team, lane, agent, type = 'metric', text, refs = [] }) => {
    const t = seg(team);
    const l = seg(lane || team);
    const line = JSON.stringify({ ts: new Date().toISOString(), agent: String(agent || 'runner'), lane: l, type, text: String(text ?? '').trim(), refs: refs.map(String) }) + '\n';
    mkdirSync(path.join(vsHome, 'logs'), { recursive: true });
    appendFileSync(path.join(vsHome, 'logs', `${t}--${l}.jsonl`), line, 'utf8');
    mkdirSync(path.join(vsHome, 'teams', t), { recursive: true });
    appendFileSync(path.join(vsHome, 'teams', t, 'log.jsonl'), line, 'utf8');
  };
}

// idea-515 (Z1): what a worker's reap did, as one runner.log line ({ reap: ... }) and, per reaped listener, a team-log metric
// in the worker's lane (agent id, pid, port, redacted command). Skips are runner.log only (fail-closed reasons, no kill).
export function reapReporter(teamLog, log = (o) => console.log(JSON.stringify(o))) {
  return ({ id, why, team, lane, reaped = [], skipped = [], error }) => {
    log({ reap: { agent: id, why, reaped: reaped.map((r) => ({ pid: r.pid, port: r.port, root: r.root, pids: r.pids, cmd: r.cmd })), ...(skipped.length ? { skipped } : {}), ...(error ? { error } : {}) } });
    for (const r of reaped) {
      try { teamLog({ team: team || 'vibesquad', lane, agent: 'runner', type: 'metric', text: `reap: worker ${id} left a listener after its process ended (${why}): killed pid ${r.pid} port ${r.port} (tree root ${r.root}, ${r.pids.length} pids): ${r.cmd}`, refs: [id] }); } catch (err) { console.error('reap team log failed', err); }
    }
  };
}
// idea-697: what a detached-work scan did (runner/detached.mjs, Runner.scanDetached / reapBootLedger), as one runner.log line
// ({ detached: ... }) and, per refused / reaped / newly found / left root, a team-log metric in the agent's lane. Skips are
// runner.log only (fail-closed reasons, nothing killed).
export function detachedReporter(teamLog, log = (o) => console.log(JSON.stringify(o))) {
  const brief = (r) => ({ agent: r.agentId, root: r.root ?? r.pid, ...(r.pids ? { pids: r.pids.length } : {}), cmd: r.cmd });
  return ({ why, refused = [], found = [], reaped = [], left = [], skipped = [] }) => {
    log({ detached: { why, ...(refused.length ? { refused: refused.map(brief) } : {}), ...(found.length ? { found: found.map(brief) } : {}), ...(reaped.length ? { reaped: reaped.map(brief) } : {}), ...(left.length ? { left: left.map(brief) } : {}), ...(skipped.length ? { skipped } : {}) } });
    const metric = (r, text) => { try { teamLog({ team: r.team || 'vibesquad', lane: r.lane, agent: 'runner', type: 'metric', text, refs: [r.agentId] }); } catch (err) { console.error('detached team log failed', err); } };
    for (const r of refused) metric(r, `detached: ${r.agentId} started detached background work during a restart drain (nohup / & / setsid): killed tree root ${r.root} (${r.pids?.length ?? 0} pids): ${r.cmd}`);
    for (const r of found) metric(r, `detached: ${r.agentId} has detached background work running outside its CLI (${why}): tree root ${r.root} (${r.pids?.length ?? 0} pids), kept in the ledger: ${r.cmd}`);
    for (const r of reaped) metric(r, `detached: ${r.agentId} left detached background work across a runner restart: killed tree root ${r.root} (${r.pids?.length ?? 0} pids): ${r.cmd}`);
    for (const r of left) metric(r, `detached: unattributed work carrying agent id ${r.agentId} outside every live CLI (pid ${r.pid}), not in the ledger: left running: ${r.cmd}`);
  };
}
export const reapSupported = (platform = process.platform, env = process.env) => (platform === 'win32' || platform === 'linux') && env.VS_RUNNER_REAP !== '0';

// lockStartedAt = the startedAt of the runner.lock this runner holds: it ties runner.json to that exact holder, so a stale
// runner.json whose pid the OS reused never reads as the new holder's (lock.mjs publishedBy).
export function writeDiscovery(home, { port, token, lockStartedAt }) {
  mkdirSync(home, { recursive: true });
  const tokenFile = path.join(home, 'token');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  try { chmodSync(tokenFile, 0o600); } catch { /* win32: ACL inherited from the user profile dir */ }
  writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ port, pid: process.pid, startedAt: Date.now(), lockStartedAt }));
}

/**
 * The listen callback: publish runner.json only while this runner still holds runner.lock (`me`). A runner robbed during its
 * boot calls onLost('boot') and publishes nothing, so the holder's runner.json is never overwritten. True if published.
 */
export function publishIfHolding(home, { port, token, me, onLost }) {
  if (!holdsLock(path.join(home, 'runner.lock'), me)) {
    onLost?.('boot');
    return false;
  }
  writeDiscovery(home, { port, token, lockStartedAt: me?.startedAt });
  return true;
}

/** runner.json was written by this process under the lock `me` (pid + lockStartedAt). */
export const publishedByMe = (home, me) => {
  const pub = readPublished(home);
  return !!pub && pub.pid === process.pid && pub.lockStartedAt === me?.startedAt;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
  const home = arg('home', path.join(os.homedir(), '.vibesquad', 'runner'));
  const dir = arg('dir', path.join(home, 'agents'));
  mkdirSync(home, { recursive: true });
  const lockFile = path.join(home, 'runner.lock');
  // Boot-phase timing (ms), logged once as {boot: ...}: the P0 11-15 boot took ~3.5 min live but 8.2s offline, so the next
  // restart's runner.log has to say which phase was slow.
  const boot = {};
  let mark = Date.now();
  const phase = (name) => { const t = Date.now(); boot[name] = t - mark; mark = t; };
  // One runner per home: if a live runner already owns the lock, leave its discovery files alone and exit 0.
  const lock = await acquireRunnerLock(home, { isHealthy: () => holderHealthy(home) });
  phase('lock');
  if (!lock.owned) {
    console.log(JSON.stringify({ alreadyRunning: lock.holder, home }));
    process.exit(0);
  }
  // Who we are in runner.lock ({ pid, startedAt }). Another runner may take the lock from us (it judged us wedged): from then
  // on runner.json, drain.json and the queue belong to it, so this runner admits nothing, never publishes, and exits.
  const me = readLock(lockFile) ?? { pid: process.pid };
  const holding = () => holdsLock(lockFile, me);
  // Kill what a previous, hard-killed runner left behind (image name + start time must match), then start a fresh ledger.
  try {
    const swept = sweepOrphans(home);
    if (swept.killed.length || swept.skipped.length) console.log(JSON.stringify({ orphanSweep: swept }));
  } catch (err) { console.error('orphan sweep failed', err); }
  phase('sweepOrphans');
  setChildLedger(createChildLedger(home));
  const token = randomBytes(32).toString('hex');
  const teamLog = teamLogWriter(path.dirname(home));
  const runner = new Runner({ dir, drainFile: path.join(home, 'drain.json'), limitsFile: path.join(home, 'limits.jsonl'), pollAgy: true, hubLane: hubLaneReader(path.dirname(home)), foldIndexFile: path.join(home, FOLD_INDEX_FILE), reaper: reapSupported() ? createDevServerReaper() : null, onReap: reapReporter(teamLog), detachedProbe: detachedSupported() ? createDetachedProbe() : null, detachedFile: path.join(home, DETACHED_FILE), onDetached: detachedReporter(teamLog) });
  // idea-697: /shutdown (vs restart) records the agents' detached work in the ledger first (bounded 5 s); the next runner reaps it.
  const server = createServer(runner, { token, onShutdown: () => runner.recordDetached(5000).finally(() => stop({ keepResumable: true })), teamLog });
  phase('init');
  // A cold fold (no fold-index entry: first boot, a fold-code change) runs on worker threads first; the boot pass then serves
  // those logs from their entries (runner/fold-cold.mjs). Part of the 'fold' phase; foldIndex.cold says what it did.
  try { await runner.prefoldCold(); } catch (err) { console.error('cold fold failed', err); }
  try { const back = runner.recoverQueued({ shouldAdmit: holding }); if (back.length) console.log(JSON.stringify({ requeued: back })); } catch (err) { console.error('queue recovery failed', err); }
  phase('fold');
  startLoopLagMonitor('runner');
  let stopping = false;
  const lockLost = (where) => {
    if (stopping) return;
    console.log(JSON.stringify({ lockLost: where, me, holder: readLock(lockFile), home }));
    stop({ keepResumable: true });
  };
  server.listen(Number(arg('port', 0)), '127.0.0.1', () => {
    phase('listen');
    // foldIndex: how fold-index.json served the fold phase (trusted = log unchanged, nothing read; resumed = only the bytes
    // appended since the save were folded; full = folded from byte 0; bytes = log bytes folded). Absent with the index off.
    // cold (when present): logs the index had no entry for, how many the worker threads folded (counted in trusted/resumed
    // from then on), the threads used and the ms; a log they could not settle is in `full`. entries = saved (read from the file)
    // + the cold entries; discardReason (+ foldWas/foldNow) when the file gave none (missing, fold-version, malformed, ...).
    // bootFoldMs: where the 'fold' phase went (Runner.bootFoldReport: prefold, load, pass {stat, seed, read}, tokens, plans, admit, rest).
    const fi = runner.foldIndexStats;
    const fm = runner.bootFoldReport(boot.fold);
    console.log(JSON.stringify({ boot: { ...boot, total: Object.values(boot).reduce((a, b) => a + b, 0) }, ...(fm ? { bootFoldMs: fm } : {}), ...(fi ? { foldIndex: fi } : {}) }));
    // Saved after listen (yielding between logs), so the next boot resumes from this one's fold; the boot line is already out.
    setImmediate(() => runner.saveFoldIndex().then((r) => { if (r) console.log(JSON.stringify({ foldIndexSave: r })); }, (err) => console.error('fold index save failed', err)));
    const port = server.address().port;
    if (!publishIfHolding(home, { port, token, me, onLost: lockLost })) return;
    console.log(JSON.stringify({ listening: port, dir, home }));
    runner.armBootReap(30_000); // idea-697: the previous lifetime's detached-work ledger, after the boot grace (only the lock holder)
  });
  const lockCheckMs = Number(process.env.VS_RUNNER_LOCK_CHECK_MS) > 0 ? Number(process.env.VS_RUNNER_LOCK_CHECK_MS) : 5000;
  const lockCheck = setInterval(() => { if (!holding()) lockLost('check'); }, lockCheckMs);
  lockCheck.unref();
  // Leave the lock holder's files alone: runner.json, drain.json and runner.lock are touched only while we hold the lock, and
  // runner.json only when it is ours (pid + lockStartedAt). A robbed runner never deletes: the new holder may be publishing.
  const leave = (opts) => {
    const held = holding();
    const first = !runner._shutDown;
    try { runner.shutdown({ ...opts, keepDrainFile: !held }); } catch (err) { console.error('runner shutdown failed', err); } // later calls are no-ops
    // The shutdown save is what the next boot resumes from: a boot with logs missing from the index (cold > 0) then shows whether
    // this runner saved at all (idea-337: the 83f29842 runner never logged one; its pid was left alone by the restart).
    if (first && runner.foldIndexSave) { try { console.log(JSON.stringify({ foldIndexSave: { ...runner.foldIndexSave, at: 'shutdown' } })); } catch { /* ignore */ } }
    if (held && publishedByMe(home, me)) { try { rmSync(path.join(home, 'runner.json'), { force: true }); } catch { /* ignore */ } }
    if (held) { try { releaseLock(lockFile); } catch { /* ignore */ } }
  };
  const stop = (opts) => {
    if (stopping) return;
    stopping = true;
    clearInterval(lockCheck);
    leave(opts?.keepResumable ? { keepResumable: true } : {});
    server.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  // Every way out kills the agents' process trees (claude.exe + its MCP sidecars). 'exit' covers process.exit and
  // a crash; shutdown() is idempotent. A hard kill (taskkill /F, power loss) cannot run any of this.
  process.on('exit', () => leave({}));
  process.on('SIGINT', () => stop());
  process.on('SIGTERM', () => stop());
  process.on('SIGBREAK', () => stop());
  process.on('SIGHUP', () => stop());
  process.on('uncaughtException', (err) => { console.error(err); process.exitCode = 1; stop(); });
}
