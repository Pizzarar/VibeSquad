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
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnCaptureOffLoop } from './spawn-off-loop.mjs';
import { liveAncestors, liveSubtree, readEnvMarkers, reapCmdText, redatePids, VS_RUNTIME } from './reap.mjs';
import { killPidTree } from './spawn.mjs';

export const DETACHED_FILE = 'detached.json';
// ps etimes is whole seconds counted back from "now": two reads of one process can differ by ~1 s (reap.mjs START_MATCH_MS).
export const DETACHED_START_TOL_MS = 2500;
const MAX_LEDGER = 200;

// Linux: `ps -U <uid> -o pid= -o ppid= -o pgid= -o etimes= -o args=` (no comm: it may hold spaces). createdMs to ~1 s.
export function parsePsDetached(text, now = Date.now()) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[5].trim();
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), createdMs: now - Number(m[4]) * 1000, name: path.basename(cmd.split(/\s+/)[0] ?? ''), cmd });
  }
  return out;
}

export async function snapshotDetachedTable({ uid = process.getuid?.(), run = spawnCaptureOffLoop } = {}) {
  const now = Date.now();
  const sel = Number.isInteger(uid) ? ['-U', String(uid)] : ['-A'];
  return parsePsDetached(await run('ps', [...sel, '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'etimes=', '-o', 'args='], { timeoutMs: 20_000 }), now);
}

// Every pid inside a live agent CLI's tree (valid parent links only): that work is background.mjs's, not detached.
function treePids(procs, byPid, cliPids) {
  const out = new Set();
  for (const c of cliPids) if (Number.isInteger(c) && c > 0) for (const p of liveSubtree(c, procs, byPid)) out.add(p.pid);
  return out;
}

/** Pids whose env must be read: outside every live CLI tree, not protected, created since `since` (the oldest live token). */
export function detachedCandidates({ procs, cliPids = [], protectedPids = [], since = 0 }) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const inTree = treePids(procs, byPid, cliPids);
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
 *   agents: Map<tokenSha, agentId> (this lifetime's tokens)   cliPids: live agent CLI pids   protectedPids: runner + ancestors
 * Returns [{ agentId, tokenSha, root, pgid, createdMs, cmd, pids: [{ pid, createdMs }] }], one per topmost root.
 */
export function planDetached({ procs, markers, agents, cliPids = [], protectedPids = [] }) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const inTree = treePids(procs, byPid, cliPids);
  const prot = new Set(protectedPids);
  const ownerOf = (pid) => { const m = markers.get(pid); if (!m || m.error || !m.tokenSha) return null; const id = agents.get(m.tokenSha); return id && id === m.agentId ? { agentId: id, tokenSha: m.tokenSha } : null; };
  const roots = new Map();
  for (const p of procs) {
    if (p.pid <= 1 || inTree.has(p.pid) || prot.has(p.pid) || !(p.createdMs > 0)) continue;
    const own = ownerOf(p.pid);
    if (!own) continue;
    const ancestors = liveAncestors(p.pid, byPid);
    if (ancestors.some((a) => inTree.has(a.pid) || prot.has(a.pid))) continue;
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
export function planLedgerReap({ procs, markers, ledger, cliPids = [], protectedPids = [], currentShas = new Set(), knownIds = null }) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const inTree = treePids(procs, byPid, cliPids);
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
    if (ancestors.some((a) => inTree.has(a.pid) || prot.has(a.pid))) { skip('in-live-tree'); continue; }
    const tree = liveSubtree(rec.root, procs, byPid);
    if (tree.some((t) => inTree.has(t.pid) || prot.has(t.pid))) { skip('live-tree-inside'); continue; }
    if ([...tree, ...ancestors].some((t) => VS_RUNTIME.test(String(t.cmd ?? '')))) { skip('vs-runtime'); continue; }
    for (const t of tree) claimed.add(t.pid);
    reap.push({ ...rec, pgid: Number.isInteger(p.pgid) ? p.pgid : rec.pgid ?? null, pids: tree.map((t) => ({ pid: t.pid, createdMs: t.createdMs })) });
  }
  // Unattributed: carries one of this store's agent ids, outside every live tree, no current token, no verified ledger entry.
  const known = (id) => !!id && (!knownIds || knownIds.has(id));
  const orphanOf = (pid) => { const m = markers.get(pid); return m && !m.error && known(m.agentId) && !currentShas.has(m.tokenSha) ? m : null; };
  const left = new Map();
  for (const p of procs) {
    if (p.pid <= 1 || claimed.has(p.pid) || inTree.has(p.pid) || prot.has(p.pid)) continue;
    const m = orphanOf(p.pid);
    if (!m) continue;
    if (liveAncestors(p.pid, byPid).some((a) => inTree.has(a.pid) || prot.has(a.pid))) continue;
    const root = climb(p, byPid, (pid) => { const o = orphanOf(pid); return !!o && o.agentId === m.agentId && !claimed.has(pid); }, inTree, prot);
    if (!left.has(root.pid)) left.set(root.pid, { pid: root.pid, agentId: m.agentId, createdMs: root.createdMs, cmd: reapCmdText(root.cmd || root.name) });
  }
  return { reap, gone, skipped, left: [...left.values()] };
}

/** The ledger file's entries (never throws: a missing or broken file is an empty ledger). */
export function readDetachedLedger(file) {
  if (!file) return [];
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(j?.entries) ? j.entries : [];
    return list.filter((r) => r && Number.isInteger(r.root) && r.root > 1 && typeof r.agentId === 'string' && typeof r.tokenSha === 'string' && Number.isFinite(r.createdMs)).slice(0, MAX_LEDGER);
  } catch { return []; }
}

/** Replaces the ledger (async tmp + rename; mode 600: it holds token hashes). An empty ledger removes the file. */
export async function writeDetachedLedger(file, entries, { fs = { writeFile, rename, rm } } = {}) {
  if (!file) return;
  const list = entries.slice(0, MAX_LEDGER).map((e) => ({ agentId: e.agentId, tokenSha: e.tokenSha, root: e.root, pgid: e.pgid ?? null, createdMs: e.createdMs, cmd: e.cmd, recordedAt: Date.now() }));
  if (!list.length) { await fs.rm(file, { force: true }); return; }
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ v: 1, entries: list }), { mode: 0o600 });
  await fs.rename(tmp, file);
}

/**
 * The runner's probe (Linux): { scan, kill, reapLedger }. Every seam is injectable (tests use a fake process table).
 *   scan({ agents, cliPids, protectedPids, since }) -> [entry]                    (planDetached on a fresh snapshot)
 *   kill(entries) -> { killed: [entry], skipped: [{ root, reason }] }            (root re-dated first; tree kill)
 *   reapLedger({ ledger, cliPids, protectedPids, currentShas, knownIds }) -> { reaped, gone, skipped, left }
 * kill: a root whose start time moved since its snapshot (gone, or pid reuse) is skipped. The tree kill is killPidTree
 * (SIGKILL: the process group when the root leads one, else a leaf-first descendant walk; never the runner or its group).
 */
export function createDetachedProbe({ snapshot = () => snapshotDetachedTable(), markers = (pids) => readEnvMarkers(pids, { platform: 'linux' }), inspect = (pids) => redatePids(pids, { platform: 'linux' }), killTree = (pid) => killPidTree(pid) } = {}) {
  const kill = async (entries) => {
    const killed = [];
    const skippedK = [];
    if (!entries.length) return { killed, skipped: skippedK };
    let now;
    try { now = await inspect(entries.map((e) => e.root)); } catch { now = new Map(); }
    for (const e of entries) {
      const i = now.get(e.root);
      if (!i || Math.abs(i.createdMs - e.createdMs) > DETACHED_START_TOL_MS) { skippedK.push({ root: e.root, agentId: e.agentId, reason: i ? 'pid-changed' : 'gone' }); continue; }
      let ok = false;
      try { ok = killTree(e.root) !== false; } catch { ok = false; }
      if (ok) killed.push(e); else skippedK.push({ root: e.root, agentId: e.agentId, reason: 'kill-refused' });
    }
    return { killed, skipped: skippedK };
  };
  return {
    async scan({ agents, cliPids = [], protectedPids = [], since = 0 }) {
      if (!agents?.size) return [];
      const procs = await snapshot();
      const want = detachedCandidates({ procs, cliPids, protectedPids, since });
      const env = await markers(want);
      return planDetached({ procs, markers: env, agents, cliPids, protectedPids });
    },
    kill,
    async reapLedger({ ledger = [], cliPids = [], protectedPids = [], currentShas = new Set(), knownIds = null }) {
      const procs = await snapshot();
      const env = await markers(detachedCandidates({ procs, cliPids, protectedPids, since: 0 }));
      const plan = planLedgerReap({ procs, markers: env, ledger, cliPids, protectedPids, currentShas, knownIds });
      const { killed, skipped } = await kill(plan.reap);
      return { reaped: killed, gone: plan.gone, skipped: [...plan.skipped, ...skipped], left: plan.left };
    },
  };
}

export const detachedSupported = (platform = process.platform, env = process.env) => platform === 'linux' && env.VS_RUNNER_DETACHED !== '0';
