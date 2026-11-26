// idea-697: detached background work. An agent's tool call can start work that leaves its CLI's process tree at once:
// `nohup x > log 2>&1 &`, `setsid x`, `(x &)` inside a FOREGROUND shell call. The tool shell exits, the work is reparented
// to the nearest subreaper (systemd --user on a unit host, init elsewhere), and from then on nothing in the runner sees it:
// background.mjs walks the CLI's tree only (no park hold, no drain refusal), park()/shutdown() tree-kill only the CLI's tree,
// and the drain hook (claude only) checks run_in_background only. Live 11-23 21:42Z (forge, rr-eea2): an opencode worker's
// foreground `shell` call ran `nohup <godot suite> &` mid-turn during the restart request's drain; the suite (bash pid
// 965801) survived the restart in the vibesquad.service cgroup (KillMode=process), owned by nobody.
// Proof of ownership is the reap.mjs one: every process an agent's CLI starts inherits VS_AGENT_ID + VS_AGENT_TOKEN, the
// token is this runner lifetime's per-agent secret, and only its sha256 is compared. What this module gives the runner:
//   scan:       detached work of THIS lifetime's agents (marker = a current token, outside every live CLI tree). The runner
//               scans while a drain is open (refusing work started after the drain began) and right before a /shutdown, and
//               keeps the result in <runner home>/detached.json (the ledger: pid, pgid, start time, agent, token sha).
//   reapLedger: at the next boot, after a grace, a ledger entry is killed only if its root pid is alive with the SAME start
//               time and its env still carries the SAME agent id + token sha (pid reuse and strangers fail that). A process
//               outside every live CLI tree that carries a VS_AGENT_ID of this runner's agents but matches no ledger entry
//               and no current token is unattributed: logged (`left`), never killed.
// Linux only (the unit hosts). Fail closed everywhere: no snapshot, an env that cannot be read, an undated pid: nothing killed.
import { readFileSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnCaptureOffLoop } from './spawn-off-loop.mjs';
import { killPids, liveAncestors, liveSubtree, readEnvMarkers, reapCmdText, redatePids, sha256, snapshotListeners, VS_RUNTIME } from './reap.mjs';
import { killPidTree } from './spawn.mjs';

export const DETACHED_FILE = 'detached.json';
// ps etimes is whole seconds counted back from "now": two reads of one process can differ by ~1 s (reap.mjs START_MATCH_MS).
export const DETACHED_START_TOL_MS = 2500;
const MAX_LEDGER = 200;
const START_ID = /^[\w-]{8,64}\/\d{1,20}$/;

// Review L4: the exact start of a process, `<boot_id>/<starttime>` (starttime = /proc/<pid>/stat field 22, clock ticks since
// boot; the boot id makes a value from before a reboot never match). Two reads of one live process are equal; a reused pid
// is not. comm (field 2) may hold spaces and parens, so the fields are counted after its LAST ')'.
export function parseStatStart(text) {
  const t = String(text ?? '');
  const i = t.lastIndexOf(')');
  if (i < 0) return null;
  const f = t.slice(i + 1).trim().split(/\s+/); // f[0] = field 3 (state) ... f[19] = field 22 (starttime)
  return /^\d+$/.test(f[19] ?? '') ? f[19] : null;
}

/** Map<pid, startId> for the pids whose /proc/<pid>/stat could be read (none if the boot id cannot be). Never throws. */
export async function readStartIds(pids, { readFileImpl = readFile } = {}) {
  const out = new Map();
  let boot;
  try { boot = String(await readFileImpl('/proc/sys/kernel/random/boot_id', 'utf8')).trim(); } catch { return out; }
  if (!/^[\w-]{8,64}$/.test(boot)) return out;
  for (const pid of new Set(pids)) {
    if (!Number.isInteger(pid) || pid <= 1) continue;
    try { const st = parseStatStart(await readFileImpl(`/proc/${pid}/stat`, 'utf8')); if (st) out.set(pid, `${boot}/${st}`); } catch { /* gone or hidden */ }
  }
  return out;
}

// Linux: `ps -U <uid> -o pid= -o ppid= -o pgid= -o etimes= -o args=` (no comm: it may hold spaces). createdMs to ~1 s.
export function parsePsDetached(text, now = Date.now()) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[5].trim();
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), createdMs: now - Number(m[4]) * 1000, createdTolMs: 2000, name: path.basename(cmd.split(/\s+/)[0] ?? ''), cmd });
  }
  return out;
}

export async function snapshotDetachedTable({ uid = process.getuid?.(), run = spawnCaptureOffLoop } = {}) {
  const now = Date.now();
  const sel = Number.isInteger(uid) ? ['-U', String(uid)] : ['-A'];
  return parsePsDetached(await run('ps', [...sel, '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'etimes=', '-o', 'args='], { timeoutMs: 20_000 }), now);
}

// Every pid inside a live agent CLI's tree or the runner's own (selfPid) tree (valid parent links only): that work is
// background.mjs's or the runner's, not detached.
// Review M1: protectedPids (the runner and its PARENT) are never killed and stop a root climb, but only these trees make
// what is under them "not detached". The runner's parent may be the very subreaper detached work lands under (systemd
// --user, or pid 1 once the launcher exits): counting its descendants as protected would hide every detached root.
function treePids(procs, byPid, cliPids, selfPid = null) {
  const out = new Set();
  for (const c of [...cliPids, selfPid]) if (Number.isInteger(c) && c > 0) for (const p of liveSubtree(c, procs, byPid)) out.add(p.pid);
  return out;
}

/** Pids whose env must be read: outside every live CLI tree, not protected, created since `since` (the oldest live token). */
export function detachedCandidates({ procs, cliPids = [], protectedPids = [], since = 0, selfPid = null }) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const inTree = treePids(procs, byPid, cliPids, selfPid);
  const prot = new Set(protectedPids);
  return procs.filter((p) => p.pid > 1 && !inTree.has(p.pid) && !prot.has(p.pid) && p.createdMs > 0 && p.createdMs + 1000 >= since).map((p) => p.pid);
}

// The topmost process of a detached chain: climb live parents while they carry the same marker (wrappers: nohup -> bash
// -> timeout -> godot all inherit it); stop at a CLI tree, a protected pid or a process without it (the subreaper).
function climb(p, byPid, same, inTree, prot) {
  let root = p;
  for (const a of liveAncestors(p.pid, byPid)) {
    if (inTree.has(a.pid) || prot.has(a.pid) || !(a.createdMs > 0) || !same(a.pid)) break;
    root = a;
  }
  return root;
}

function entryFor(root, procs, byPid, extra) {
  const tree = liveSubtree(root.pid, procs, byPid);
  return { ...extra, root: root.pid, pgid: Number.isInteger(root.pgid) ? root.pgid : null, createdMs: root.createdMs, cmd: reapCmdText(root.cmd || root.name), pids: tree.map((t) => ({ pid: t.pid, createdMs: t.createdMs })) };
}

// Roots nested in another root's tree (a chain broken by a process without the marker) are covered by the outer one.
function topmost(entries) {
  const inner = new Set();
  for (const r of entries) for (const q of entries) if (q !== r && q.pids.some((x) => x.pid === r.root)) inner.add(r.root);
  return entries.filter((r) => !inner.has(r.root));
}

/**
 * Pure. Detached work of this runner lifetime's agents.
 *   procs: [{ pid, ppid, pgid, createdMs, name, cmd }]   markers: Map<pid, { agentId, tokenSha } | { error }>
 *   agents: Map<tokenSha, agentId> (this lifetime's tokens)   cliPids: live agent CLI pids   selfPid: the runner (its tree is
 *   never detached)   protectedPids: the runner + its parent (never killed, a climb stops there; NOT an exclusion of what is under them)
 * Returns [{ agentId, tokenSha, root, pgid, createdMs, cmd, pids: [{ pid, createdMs }] }], one per topmost root.
 */
export function planDetached({ procs, markers, agents, cliPids = [], protectedPids = [], selfPid = null }) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const inTree = treePids(procs, byPid, cliPids, selfPid);
  const prot = new Set(protectedPids);
  const ownerOf = (pid) => { const m = markers.get(pid); if (!m || m.error || !m.tokenSha) return null; const id = agents.get(m.tokenSha); return id && id === m.agentId ? { agentId: id, tokenSha: m.tokenSha } : null; };
  const roots = new Map();
  for (const p of procs) {
    if (p.pid <= 1 || inTree.has(p.pid) || prot.has(p.pid) || !(p.createdMs > 0)) continue;
    const own = ownerOf(p.pid);
    if (!own) continue;
    const ancestors = liveAncestors(p.pid, byPid);
    if (ancestors.some((a) => inTree.has(a.pid))) continue;
    const root = climb(p, byPid, (pid) => ownerOf(pid)?.tokenSha === own.tokenSha, inTree, prot);
    if (roots.has(root.pid)) continue;
    const e = entryFor(root, procs, byPid, own);
    if ([...e.pids.map((x) => byPid.get(x.pid)), ...liveAncestors(root.pid, byPid)].some((t) => t && VS_RUNTIME.test(String(t.cmd ?? '')))) continue; // the runtime itself: never
    if (e.pids.some((x) => inTree.has(x.pid) || prot.has(x.pid))) continue;
    roots.set(root.pid, e);
  }
  return topmost([...roots.values()]);
}

/**
 * Pure. The boot reap: which ledger entries (a previous runner lifetime's detached work) are provably still that work.
 *   ledger: [{ agentId, tokenSha, root, pgid, createdMs, cmd }]   currentShas: this lifetime's token shas (never "left")
 *   knownIds: agent ids with a log in this runner's store (what "a VS agent" means here)
 * Returns { reap: [entry + pids], gone: [entry], skipped: [{ root, agentId, reason }], left: [{ pid, agentId, createdMs, cmd }] }.
 */
export function planLedgerReap({ procs, markers, ledger, cliPids = [], protectedPids = [], selfPid = null, currentShas = new Set(), knownIds = null }) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const inTree = treePids(procs, byPid, cliPids, selfPid);
  const prot = new Set(protectedPids);
  const reap = [];
  const gone = [];
  const skipped = [];
  const claimed = new Set(); // pids inside a reaped entry's tree
  for (const rec of ledger) {
    const skip = (reason) => skipped.push({ root: rec.root, agentId: rec.agentId, reason });
    const p = byPid.get(rec.root);
    if (!p) { gone.push(rec); continue; }
    if (!(p.createdMs > 0) || !(rec.createdMs > 0) || Math.abs(p.createdMs - rec.createdMs) > DETACHED_START_TOL_MS) { skip('pid-changed'); continue; } // pid reuse
    const m = markers.get(rec.root);
    if (!m) { skip('env-not-read'); continue; }
    if (m.error) { skip(`env-unreadable:${m.error}`); continue; }
    if (m.agentId !== rec.agentId || !rec.tokenSha || m.tokenSha !== rec.tokenSha) { skip('marker-mismatch'); continue; }
    if (inTree.has(rec.root) || prot.has(rec.root)) { skip('in-live-tree'); continue; }
    const ancestors = liveAncestors(rec.root, byPid);
    if (ancestors.some((a) => inTree.has(a.pid))) { skip('in-live-tree'); continue; }
    const tree = liveSubtree(rec.root, procs, byPid);
    if (tree.some((t) => inTree.has(t.pid) || prot.has(t.pid))) { skip('live-tree-inside'); continue; }
    if ([...tree, ...ancestors].some((t) => VS_RUNTIME.test(String(t.cmd ?? '')))) { skip('vs-runtime'); continue; }
    for (const t of tree) claimed.add(t.pid);
    reap.push({ ...rec, pgid: Number.isInteger(p.pgid) ? p.pgid : rec.pgid ?? null, pids: tree.map((t) => ({ pid: t.pid, createdMs: t.createdMs })) });
  }
  // Unattributed: carries one of this store's agent ids, outside every live tree, no current token, no verified ledger entry.
  // idea-1140 kept this class `left` even when the id's agent has since exited or been archived: tokens are memory-only and
  // minted per runner lifetime (Runner.tokenFor, X1a "never persisted"), so after a restart nothing can check the token sha
  // these carry; VS_AGENT_ID alone is a plain env var any same-user process can set. The proof lives in-lifetime instead: an
  // ended worker's leftovers are reaped at its exit / archive (planAgentLeftovers), and work still running at a /shutdown is
  // put in the ledger (scan) with its token sha, which this boot verifies above.
  const known = (id) => !!id && (!knownIds || knownIds.has(id));
  const orphanOf = (pid) => { const m = markers.get(pid); return m && !m.error && known(m.agentId) && !currentShas.has(m.tokenSha) ? m : null; };
  const left = new Map();
  for (const p of procs) {
    if (p.pid <= 1 || claimed.has(p.pid) || inTree.has(p.pid) || prot.has(p.pid)) continue;
    const m = orphanOf(p.pid);
    if (!m) continue;
    if (liveAncestors(p.pid, byPid).some((a) => inTree.has(a.pid))) continue;
    const root = climb(p, byPid, (pid) => { const o = orphanOf(pid); return !!o && o.agentId === m.agentId && !claimed.has(pid); }, inTree, prot);
    if (!left.has(root.pid)) left.set(root.pid, { pid: root.pid, agentId: m.agentId, createdMs: root.createdMs, cmd: reapCmdText(root.cmd || root.name) });
  }
  return { reap, gone, skipped, left: [...left.values()] };
}

// ---- idea-1140: what an ENDED agent left running ----------------------------------------------------------------------
// Live 11-26 (rn-10db93c202e8): a worker's Bash script ran `chromium-browser --headless` and exited; crashpad and the helpers
// were reparented to the subreaper, outside the CLI's tree and group. The end kill (killTree) only reaches the CLI's tree, the
// listener reaper (reap.mjs) only listeners, and the detached ledger only drains: nothing reaped them, and at every later boot
// they read as `left` (their token is a dead lifetime's). When a worker is really done (exit, archive stop: not park, whose
// detached work may be the next turn's, see Runner._reapAfterEnd) the runner reaps everything still carrying ITS id + token
// (planDetached with this one agent), with these gates on top:
//   - never the runner, its parent, the runtime (VS_RUNTIME), a held shell, or anything inside / above a live CLI tree
//     (planDetached's protected set + selfPid / cliPids trees);
//   - only processes created before the agent ended (a resumed CLI carries the same token: its new work is never touched);
//   - a tree that holds another agent's marker (or a half marker) is skipped whole; an unread / unreadable member is not killed;
//   - leaf-first exact pids; the process group only when the root leads it and EVERY member of the group in the table is one
//     of the verified pids (the group signal then also reaches what they forked meanwhile);
//   - the executor brackets the env proof with exact start reads (before the env read, again right before the kill): a pid
//     whose start moved or vanished is dropped (pid reuse).

/**
 * Pure. What agentId (token sha tokenSha) left running after it ended at endedAt.
 *   procs: [{ pid, ppid, pgid?, createdMs, name, cmd }]   markers: Map<pid, { agentId, tokenSha } | { error }>
 *   cliPids: live CLI pids   selfPid: the runner   protectedPids: never killed (runner, its parent, held shells)
 * Returns { reap: [{ agentId, tokenSha, root, pgid, cmd, pids: [{ pid, createdMs }] (leaf-first) }], skipped: [{ pid, root, reason }] }.
 */
export function planAgentLeftovers({ procs, markers, agentId, tokenSha, endedAt, cliPids = [], protectedPids = [], selfPid = null }) {
  const reap = [];
  const skipped = [];
  if (!agentId || !tokenSha || !Number.isFinite(endedAt)) return { reap, skipped };
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const entries = planDetached({ procs, markers, agents: new Map([[tokenSha, agentId]]), cliPids, protectedPids, selfPid });
  for (const e of entries) {
    const foreign = e.pids.find((x) => { const m = markers.get(x.pid); return m && !m.error && (m.agentId !== null || m.tokenSha !== null) && (m.agentId !== agentId || m.tokenSha !== tokenSha); });
    if (foreign) { skipped.push({ pid: foreign.pid, root: e.root, reason: 'foreign-in-tree' }); continue; }
    const pids = [];
    for (const x of e.pids) {
      const m = markers.get(x.pid);
      const skip = (reason) => skipped.push({ pid: x.pid, root: e.root, reason });
      if (SYSTEM_PID.has(x.pid) || x.pid <= 1) { skip('system'); continue; }
      if (!(x.createdMs > 0)) { skip('undated'); continue; }
      if (x.createdMs > endedAt) { skip('created-after-end'); continue; }
      if (!m) { skip('env-not-read'); continue; }
      if (m.error) { skip(`env-unreadable:${m.error}`); continue; }
      pids.push(x);
    }
    if (!pids.length) continue;
    const mine = new Set(pids.map((x) => x.pid));
    const root = byPid.get(e.root);
    const self = byPid.get(selfPid);
    const group = Number.isInteger(root?.pgid) && root.pgid === e.root && root.pgid > 1 && mine.has(e.root) && (!self || self.pgid !== root.pgid)
      && procs.every((p) => p.pgid !== root.pgid || mine.has(p.pid)) ? root.pgid : null;
    reap.push({ agentId, tokenSha, root: e.root, pgid: group, cmd: e.cmd, pids: pids.reverse() }); // liveSubtree is pre-order: reversed = leaf-first
  }
  return { reap, skipped };
}
const SYSTEM_PID = new Set([0, 4]); // Windows: Idle and System

// Kill one planned entry: the group first (when the plan proved the whole group is the agent's), then each pid leaf-first.
function posixKillEntry(pids, pgid, { killImpl = process.kill.bind(process), selfPid = process.pid } = {}) {
  if (Number.isInteger(pgid) && pgid > 1 && pgid !== selfPid) { try { killImpl(-pgid, 'SIGKILL'); } catch { /* gone */ } }
  for (const p of pids) if (Number.isInteger(p) && p > 1 && p !== selfPid) { try { killImpl(p, 'SIGKILL'); } catch { /* gone */ } }
}

/**
 * The end reap's executor: (job) -> Promise<{ reaped: [{ agentId, root, pgid, pids, cmd }], skipped: [...], error? }>.
 *   job: { agentId, token, since (token mint), endedAt, protectedPids, liveCliPids, selfPid, stillOk }
 * Linux: the uid's ps table (with pgid), /proc environ, exact start ids (boot id + starttime) before the env read and again
 * right before the kill, SIGKILL group / leaf-first pids. Windows: the CIM table (exact CreationDate ms), the PEB env reader
 * (WIN_ENV_CS), the CreationDate re-read right before the kill, one taskkill /F /PID per pid (never /T). Anything else: fails
 * closed (the snapshot rejects). Every seam is injectable; the runner reaches it through createDevServerReaper({ leftovers }).
 */
export function createLeftoverReaper({ platform = process.platform, snapshot = null, markers = null, starts = null, kill = null } = {}) {
  const win = platform === 'win32';
  const snap = snapshot ?? (win ? async () => (await snapshotListeners({ platform })).procs : platform === 'linux' ? () => snapshotDetachedTable() : async () => { throw new Error(`leftover reap: unsupported platform ${platform}`); });
  const env = markers ?? ((pids) => readEnvMarkers(pids, { platform }));
  // Map<pid, string>: an exact start (Linux boot id + starttime; Windows CreationDate ms). Absent = gone or unreadable.
  const startIds = starts ?? (win ? async (pids) => new Map([...(await redatePids(pids, { platform }))].map(([p, i]) => [p, String(i.createdMs)])) : (pids) => readStartIds(pids));
  const killer = kill ?? (win ? (pids) => killPids(pids, { platform }) : (pids, pgid) => posixKillEntry(pids, pgid));
  const startsOf = async (pids) => { try { return (await startIds(pids)) ?? new Map(); } catch { return new Map(); } };
  return async ({ agentId, token, since = 0, endedAt, protectedPids: held = [], liveCliPids = [], selfPid = process.pid, stillOk = () => true }) => {
    if (!agentId || !token) return { reaped: [], skipped: [], error: 'no agent token' };
    const protectedPids = [...new Set([...held, process.pid, process.ppid])].filter((p) => Number.isInteger(p) && p > 0); // the runner and its parent, whatever the caller passed
    let procs;
    try { procs = await snap(); } catch (err) { return { reaped: [], skipped: [], error: `snapshot: ${err?.message ?? err}` }; }
    const want = detachedCandidates({ procs, cliPids: liveCliPids, protectedPids, selfPid, since }).filter((p) => !SYSTEM_PID.has(p));
    if (!want.length) return { reaped: [], skipped: [] };
    // Windows: the CIM row's CreationDate is already exact (ms) and was read before the env; Linux: read the start ids now.
    const before = win ? new Map(procs.filter((p) => p.createdMs > 0).map((p) => [p.pid, String(p.createdMs)])) : await startsOf(want);
    let m;
    try { m = await env(want); } catch (err) { return { reaped: [], skipped: [], error: `env: ${err?.message ?? err}` }; }
    const plan = planAgentLeftovers({ procs, markers: m, agentId, tokenSha: sha256(token), endedAt, cliPids: liveCliPids, protectedPids, selfPid });
    const reaped = [];
    const skipped = [...plan.skipped];
    if (!plan.reap.length) return { reaped, skipped };
    const late = (reason) => plan.reap.map((r) => ({ pid: r.root, root: r.root, reason }));
    if (!stillOk()) return { reaped, skipped: [...skipped, ...late('agent-live-again')] };
    const now = await startsOf(plan.reap.flatMap((r) => r.pids.map((x) => x.pid)));
    for (const r of plan.reap) {
      const pids = [];
      for (const x of r.pids) {
        const a = before.get(x.pid);
        const b = now.get(x.pid);
        if (a && b && a === b) pids.push(x.pid);
        else skipped.push({ pid: x.pid, root: r.root, reason: b ? 'pid-changed' : 'gone' });
      }
      if (!pids.length) continue;
      const pgid = r.pgid !== null && pids.length === r.pids.length ? r.pgid : null; // a dropped member: exact pids only
      if (!stillOk()) { skipped.push({ pid: r.root, root: r.root, reason: 'agent-live-again' }); continue; }
      try { await killer(pids, pgid); } catch { skipped.push({ pid: r.root, root: r.root, reason: 'kill-failed' }); continue; }
      reaped.push({ agentId, root: r.root, pgid, pids, cmd: r.cmd });
    }
    return { reaped, skipped };
  };
}

/** The ledger file's entries (never throws: a missing or broken file is an empty ledger). */
export function readDetachedLedger(file) {
  if (!file) return [];
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(j?.entries) ? j.entries : [];
    return list.filter((r) => r && Number.isInteger(r.root) && r.root > 1 && typeof r.agentId === 'string' && typeof r.tokenSha === 'string' && Number.isFinite(r.createdMs)).slice(0, MAX_LEDGER)
      .map((r) => ({ ...r, start: typeof r.start === 'string' && START_ID.test(r.start) ? r.start : null }));
  } catch { return []; }
}

/** Replaces the ledger (async tmp + rename; mode 600: it holds token hashes). An empty ledger removes the file. */
export async function writeDetachedLedger(file, entries, { fs = { writeFile, rename, rm } } = {}) {
  if (!file) return;
  const list = entries.slice(0, MAX_LEDGER).map((e) => ({ agentId: e.agentId, tokenSha: e.tokenSha, root: e.root, pgid: e.pgid ?? null, createdMs: e.createdMs, start: e.start ?? null, cmd: e.cmd, recordedAt: Date.now() }));
  if (!list.length) { await fs.rm(file, { force: true }); return; }
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ v: 1, entries: list }), { mode: 0o600 });
  await fs.rename(tmp, file);
}

/**
 * The runner's probe (Linux): { scan, kill, reapLedger }. Every seam is injectable (tests use a fake process table).
 *   scan({ agents, cliPids, protectedPids, selfPid, since }) -> [entry]          (planDetached on a fresh snapshot; entry.start
 *                                                                                = the root's exact start id when readable)
 *   kill(entries) -> { killed: [entry], skipped: [{ root, reason }] }            (root re-dated first; tree kill)
 *   reapLedger({ ledger, cliPids, protectedPids, selfPid, currentShas, knownIds }) -> { reaped, gone, skipped, left }
 * kill re-dates each root right before its kill (review L4): with an exact start id on both sides (entry.start and a fresh
 * /proc/<pid>/stat read) they must be equal; otherwise the ps etimes date must be within DETACHED_START_TOL_MS. A root that
 * moved (pid reuse) or is gone is skipped. The tree kill is killPidTree (SIGKILL: the process group when the root leads
 * one, else a leaf-first descendant walk; never the runner or its group).
 */
export function createDetachedProbe({ snapshot = () => snapshotDetachedTable(), markers = (pids) => readEnvMarkers(pids, { platform: 'linux' }), inspect = (pids) => redatePids(pids, { platform: 'linux' }), starts = (pids) => readStartIds(pids), killTree = (pid) => killPidTree(pid) } = {}) {
  const startsOf = async (pids) => { try { return (await starts(pids)) ?? new Map(); } catch { return new Map(); } };
  const kill = async (entries) => {
    const killed = [];
    const skippedK = [];
    if (!entries.length) return { killed, skipped: skippedK };
    const exact = await startsOf(entries.map((e) => e.root));
    const coarse = entries.filter((e) => !(e.start && exact.has(e.root))).map((e) => e.root);
    let now = new Map();
    if (coarse.length) { try { now = await inspect(coarse); } catch { now = new Map(); } }
    for (const e of entries) {
      const skip = (reason) => skippedK.push({ root: e.root, agentId: e.agentId, reason });
      if (e.start && exact.has(e.root)) {
        if (exact.get(e.root) !== e.start) { skip('pid-changed'); continue; }
      } else {
        const i = now.get(e.root);
        if (!i || Math.abs(i.createdMs - e.createdMs) > DETACHED_START_TOL_MS) { skip(i ? 'pid-changed' : 'gone'); continue; }
      }
      let ok = false;
      try { ok = killTree(e.root) !== false; } catch { ok = false; }
      if (ok) killed.push(e); else skip('kill-refused');
    }
    return { killed, skipped: skippedK };
  };
  return {
    async scan({ agents, cliPids = [], protectedPids = [], selfPid = null, since = 0 }) {
      if (!agents?.size) return [];
      const procs = await snapshot();
      const want = detachedCandidates({ procs, cliPids, protectedPids, selfPid, since });
      const env = await markers(want);
      const found = planDetached({ procs, markers: env, agents, cliPids, protectedPids, selfPid });
      if (!found.length) return found;
      const st = await startsOf(found.map((e) => e.root));
      return found.map((e) => ({ ...e, start: st.get(e.root) ?? null }));
    },
    kill,
    async reapLedger({ ledger = [], cliPids = [], protectedPids = [], selfPid = null, currentShas = new Set(), knownIds = null }) {
      const procs = await snapshot();
      const env = await markers(detachedCandidates({ procs, cliPids, protectedPids, selfPid, since: 0 }));
      const plan = planLedgerReap({ procs, markers: env, ledger, cliPids, protectedPids, selfPid, currentShas, knownIds });
      const { killed, skipped } = await kill(plan.reap);
      return { reaped: killed, gone: plan.gone, skipped: [...plan.skipped, ...skipped], left: plan.left };
    },
  };
}

export const detachedSupported = (platform = process.platform, env = process.env) => platform === 'linux' && env.VS_RUNNER_DETACHED !== '0';
