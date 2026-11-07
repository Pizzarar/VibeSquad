// The browser's agent store. Agents come from the VS runner (roster over its SSE stream, actions over /__vibesquad/runner/*).
import type { ActiveTurnBehavior, PaseoAgent, PaseoWorkspace } from "./agentTypes";
import { applyLabelsOptimistic } from "./attentionItems";
import { clearUnreadLocal, dismissLocal, markUnreadLocal, subscribeAttentionLocal } from "./attentionLocal";
import { isRunnerId, runnerArchive, runnerCancel, runnerListArchived, runnerSend, runnerSpawn, runnerUpdate, runnerStatusLoaded, startRunnerBridge, onRunnerStatusChange } from "./runnerBridge";
import { useSyncExternalStore } from "react";
import { refreshTeams, retiredLeadTitle } from "./teams";
import { normalizeProviderUsage, runnerUsageToQuota, type ProviderQuotaView } from "./antigravity";
import { loadRunnerUsage } from "./paseoProviders";
import { LEGACY_NEEDS_LABEL, LEGACY_NEEDS_UNTIL, LEGACY_NEEDS_REASON } from "./userName";
import { DEMO } from "./demoFlag";
import { demoAgents, demoArchived, demoProviderUsage, demoWorkspaces } from "./demo";
import { perfRecord, perfSendBegin, perfSendResolved } from "./perf";
import { addPending, failPending, markDelivered, retryPending } from "./pendingSend";

// DEMO lives in a leaf module (see demoFlag.ts); re-exported for existing importers.
export { DEMO };

export type ConnStatus = "connecting" | "connected" | "disconnected";

type State = {
  /** The VS runner's event stream, as conn/status. */
  conn: ConnStatus;
  runnerConn: "unknown" | "up" | "down";
  status: "connecting" | "connected" | "disconnected" | "error";
  error?: string;
  agents: Map<string, PaseoAgent>;
  /** The first agent list has arrived (it may be empty). conn can be "connected" before this. */
  rosterLoaded: boolean;
  archivedAgents: Map<string, PaseoAgent>;
  archivedStatus: "idle" | "loading" | "ready" | "error";
  workspaces: Map<string, PaseoWorkspace>;
  providerUsage: ProviderQuotaView[];
};

let state: State = {
  conn: "connecting",
  runnerConn: "unknown",
  status: "connecting",
  agents: new Map(),
  rosterLoaded: false,
  archivedAgents: new Map(),
  archivedStatus: "idle",
  workspaces: new Map(),
  providerUsage: [],
};
const listeners = new Set<() => void>();

// Bursts of runner messages land as one store update per frame: upserts queue here and
// listeners are notified once from flush(). Hidden tabs get no rAF, so a timer backs it up.
const pendingAgents = new Map<string, PaseoAgent | null>(); // null = remove
let flushQueued = false;

function flush() {
  if (!flushQueued) return;
  flushQueued = false;
  const f0 = performance.now();
  const queued = pendingAgents.size;
  if (pendingAgents.size) {
    const agents = new Map(state.agents);
    for (const [id, a] of pendingAgents) {
      if (a) agents.set(id, a);
      else agents.delete(id);
    }
    pendingAgents.clear();
    state = { ...state, agents };
  }
  listeners.forEach((l) => l());
  perfRecord("roster-flush", performance.now() - f0, `queued=${queued} agents=${state.agents.size}`);
}

function schedule() {
  if (flushQueued) return;
  flushQueued = true;
  requestAnimationFrame(flush);
  setTimeout(flush, 100);
}

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  schedule();
}

export function upsertLocalAgent(agent: PaseoAgent, removeOldId?: string) {
  const agents = new Map(state.agents);
  if (removeOldId) {
    pendingAgents.delete(removeOldId);
    agents.delete(removeOldId);
  }
  pendingAgents.delete(agent.id);
  agents.set(agent.id, agent);
  state = { ...state, agents };
  listeners.forEach((l) => l());
}

export function removeLocalAgent(agentId: string) {
  if (!agentId) return;
  const agents = new Map(state.agents);
  const existing = agents.get(agentId);
  pendingAgents.delete(agentId);
  agents.delete(agentId);
  const archivedAgents = new Map(state.archivedAgents);
  if (existing) {
    archivedAgents.set(agentId, {
      ...existing,
      status: "closed",
      archivedAt: new Date().toISOString(),
    } as PaseoAgent);
  }
  state = { ...state, agents, archivedAgents };
  listeners.forEach((l) => l());
}

/** Forget an agent without archiving it (it vanished from a roster; only a real archive event archives). */
function dropLocalAgent(agentId: string) {
  if (!state.agents.has(agentId) && !pendingAgents.has(agentId)) return;
  const agents = new Map(state.agents);
  pendingAgents.delete(agentId);
  agents.delete(agentId);
  state = { ...state, agents };
  listeners.forEach((l) => l());
}

const sameAgent = (a: PaseoAgent | undefined, b: PaseoAgent) => !!a && JSON.stringify(a) === JSON.stringify(b);

export async function stopAgent(agentId: string): Promise<void> {
  if (DEMO) return;
  return runnerCancel(agentId);
}

type SendArgs = { images?: Array<{ data: string; mimeType: string }>; opts?: { activeTurnBehavior?: ActiveTurnBehavior } };
const sendArgs = new Map<string, SendArgs>();

async function deliver(agentId: string, text: string, args: SendArgs): Promise<void> {
  const sendOpts = { activeTurnBehavior: "steer" as ActiveTurnBehavior, ...args.opts };
  const lb = (state.agents.get(agentId)?.labels ?? {}) as Record<string, string>;
  perfSendBegin(agentId, lb.team, lb.lane);
  await runnerSend(agentId, text, { images: args.images, activeTurnBehavior: sendOpts.activeTurnBehavior });
  perfSendResolved(agentId);
}

/** Send with an optimistic "pending" bubble (src/pendingSend.ts); a rejected send keeps the text as a failed bubble and rethrows. */
export async function sendMessage(
  agentId: string,
  text: string,
  images?: Array<{ data: string; mimeType: string }>,
  opts?: { activeTurnBehavior?: ActiveTurnBehavior },
): Promise<void> {
  if (DEMO) return;
  const id = addPending(agentId, text);
  const args = { images, opts };
  sendArgs.set(id, args);
  try {
    await deliver(agentId, text, args);
    markDelivered(id);
  } catch (e) {
    failPending(id, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

export async function retrySend(id: string): Promise<void> {
  const p = retryPending(id);
  if (!p) return;
  try {
    await deliver(p.agentId, p.text, sendArgs.get(id) ?? {});
    markDelivered(id);
  } catch (e) {
    failPending(id, e instanceof Error ? e.message : String(e));
  }
}

export async function archiveAgent(agentId: string): Promise<{ archivedAt: string }> {
  if (DEMO) return { archivedAt: new Date().toISOString() };
  const res = await runnerArchive(agentId);
  pendingAgents.delete(agentId);
  const agents = new Map(state.agents);
  agents.delete(agentId);
  set({ agents });
  return res;
}

export async function detachAgent(agentId: string): Promise<void> {
  if (DEMO || isRunnerId(agentId)) return; // runner agents have no attach/detach
}

export async function updateAgent(
  agentId: string,
  updates: { name?: string; labels?: Record<string, string> },
  opts: { optimistic?: boolean } = {},
): Promise<void> {
  if (DEMO) {
    const cur = state.agents.get(agentId);
    if (cur) {
      upsertLocalAgent({
        ...cur,
        ...(updates.name ? { title: updates.name } : {}),
        ...(updates.labels ? { labels: { ...(cur.labels ?? {}), ...updates.labels } } : {}),
      });
    }
    return;
  }
  if (opts.optimistic && updates.labels) return updateLabelsOptimistic(agentId, updates.labels);
  return runnerUpdate(agentId, updates);
}

/** Opt-in (attention list only): see applyLabelsOptimistic. */
function updateLabelsOptimistic(agentId: string, labels: Record<string, string>): Promise<void> {
  return applyLabelsOptimistic(labels, {
    get: () => state.agents.get(agentId)?.labels as Record<string, string> | undefined,
    patch: (fn) => {
      const agent = state.agents.get(agentId);
      if (!agent) return;
      const agents = new Map(state.agents);
      agents.set(agentId, { ...agent, labels: fn((agent.labels ?? {}) as Record<string, string>) });
      state = { ...state, agents };
      listeners.forEach((l) => l());
    },
    send: () => runnerUpdate(agentId, { labels }),
  });
}

/** Re-derive everything that depends on local attention state or the clock (new Map, same agents). */
export function bumpAgents() {
  state = { ...state, agents: new Map(state.agents) };
  listeners.forEach((l) => l());
}
subscribeAttentionLocal(bumpAgents);

// Runner agents have no daemon attention flag: the local dismiss + the needs-you label are the whole state.
export async function clearAgentAttention(_agentId: string): Promise<void> {}

/** Mark a chat unread: the local flag puts it back in the attention list. */
export async function markAgentUnread(agent: PaseoAgent): Promise<void> {
  markUnreadLocal(agent.id);
}

/** Mark a chat read: clears local unread, dismisses error/attention locally, clears needs-you label, and clears daemon/workspace attention. */
export async function markAgentRead(agent: PaseoAgent): Promise<void> {
  clearUnreadLocal(agent.id);
  if (agent.status === "error" || agent.requiresAttention) {
    dismissLocal(agent.id, agent.status === "error" ? (agent.lastError ?? "error") : (agent.attentionReason ?? "attention"));
  }
  if (
    (agent.labels?.["needs-you"] && agent.labels["needs-you"] !== "cleared") ||
    (agent.labels?.[LEGACY_NEEDS_LABEL] && agent.labels[LEGACY_NEEDS_LABEL] !== "cleared")
  ) {
    await clearNeedsYou(agent, { optimistic: true });
  }
  await clearAgentAttention(agent.id);
}

const labelsOf = (a: PaseoAgent) => (a.labels ?? {}) as Record<string, string>;
/** Labels as of now, not as of the render that handed us `agent`. */
const latestLabels = (a: PaseoAgent) => labelsOf(state.agents.get(a.id) ?? a);

/** Legacy-labelled agents keep working: when the old label is set, clear/snooze it alongside the canonical one. */
const hasLegacy = (a: PaseoAgent) => !!labelsOf(a)[LEGACY_NEEDS_LABEL];

export function setNeedsYou(agent: PaseoAgent, reason: string, extra?: Record<string, string>): Promise<void> {
  const legacy = hasLegacy(agent)
    ? { [LEGACY_NEEDS_LABEL]: reason, [LEGACY_NEEDS_REASON]: reason, [LEGACY_NEEDS_UNTIL]: "" }
    : {};
  return updateAgent(agent.id, {
    labels: { ...latestLabels(agent), ...extra, ...legacy, "needs-you": reason, "needs-you-reason": reason, "needs-you-until": "", "needs-you-at": new Date().toISOString() },
  });
}

export function clearNeedsYou(agent: PaseoAgent, opts?: { optimistic?: boolean }): Promise<void> {
  const legacy = hasLegacy(agent) ? { [LEGACY_NEEDS_LABEL]: "cleared", [LEGACY_NEEDS_UNTIL]: "" } : {};
  return updateAgent(agent.id, { labels: { ...latestLabels(agent), ...legacy, "needs-you": "cleared", "needs-you-until": "", "needs-you-at": "" } }, opts);
}

export function snoozeNeedsYou(agent: PaseoAgent, durationMs: number, opts?: { optimistic?: boolean }): Promise<void> {
  const until = new Date(Date.now() + durationMs).toISOString();
  const legacy = hasLegacy(agent) ? { [LEGACY_NEEDS_UNTIL]: until } : {};
  return updateAgent(agent.id, { labels: { ...latestLabels(agent), ...legacy, "needs-you-until": until } }, opts);
}

export async function loadArchived(): Promise<void> {
  if (DEMO) {
    set({ archivedAgents: demoArchived(), archivedStatus: "ready" });
    return;
  }
  set({ archivedStatus: "loading" });
  try {
    const next = new Map<string, PaseoAgent>();
    for (const a of await runnerListArchived()) next.set(a.id, a);
    set({ archivedAgents: next, archivedStatus: "ready" });
  } catch (e) {
    console.error("loadArchived failed", e);
    set({ archivedStatus: "error" });
  }
}

/** Workspaces are not registered anywhere any more (a cwd is enough): nothing to archive. */
export async function archiveWorkspace(_workspaceId: string): Promise<void> {}

// A9: per-provider quota for the sidebar.
async function refetchProviderUsage() {
  try {
    set({ providerUsage: runnerUsageToQuota(await loadRunnerUsage()) });
  } catch (err) {
    console.warn("runner usage failed", err);
  }
}

let started = false;
export function start() {
  if (started) return;
  started = true;
  if (DEMO) {
    set({ conn: "connected", status: "connected", error: undefined, rosterLoaded: true, agents: demoAgents(), workspaces: demoWorkspaces() as Map<string, PaseoWorkspace>, providerUsage: normalizeProviderUsage(demoProviderUsage()) });
    return;
  }
  // The runner stream (startRunnerBridge, below) drives conn and the roster; usage is polled on a slow timer.
  setInterval(() => void refetchProviderUsage(), 60_000);
}

export function subscribePaseo(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const getPaseoState = (): State => state;

export function usePaseo(): State {
  return useSyncExternalStore(subscribePaseo, getPaseoState);
}

export type SpawnRequest = {
  provider: string; // "claude", "antigravity-cli", ...
  model: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  notes?: string;
  systemPrompt?: string;
  approvalPolicy?: string;
  sandbox?: string;
  shareMcp?: boolean;
  title: string;
  labels: Record<string, string>;
  prompt: string;
  images?: Array<{ data: string; mimeType: string }>;
  cwd: string;
  worktree?: { branch: string };
};

/** Lane integrity: mark a lead or brainstorm as retired (role=former-*). Leads also get `(old) <Code><ord>[ · objective]`. */
/** Patches only role (and ord); the daemon merges labels, so the rest are left as they are now, not as of `agent`. */
export function retireAgent(agent: PaseoAgent, laneName?: string): Promise<void> {
  const l = labelsOf(agent);
  if (l.role === "brainstorm" || l.role === "buddy") {
    // Same title rule as the plugin's retirePredecessors: "(old) <title>".
    const title = (agent.title ?? "").trim();
    const name = title && !title.toLowerCase().startsWith("(old)") ? `(old) ${title}` : undefined;
    return updateAgent(agent.id, { ...(name ? { name } : {}), labels: { role: "former-brainstorm" } });
  }
  const ord = l.ord;
  const laneId = l.lane ?? l.lead ?? "";
  const lane = laneName ?? laneId;
  return updateAgent(agent.id, {
    ...(lane && ord ? { name: retiredLeadTitle(lane, laneId, ord, l.job) } : {}),
    labels: { role: "former-lead", ...(ord ? { ord } : {}) },
  });
}

async function retirePredecessors(req: SpawnRequest, newId: string): Promise<void> {
  const role = req.labels.role;
  const lane = (req.labels.lane || req.labels.lead || "").toLowerCase();
  if ((role !== "lead" && role !== "brainstorm") || !lane || !req.labels.team) return;
  const reqTopic = (req.labels.topic || req.labels["vs.inbox-card-id"] || "").trim().toLowerCase();
  for (const a of state.agents.values()) {
    const l = labelsOf(a);
    if (a.id === newId || a.archivedAt || a.status === "closed" || l.role !== role) continue;
    if (role === "brainstorm") {
      const aTopic = (l.topic || l["vs.inbox-card-id"] || "").trim().toLowerCase();
      if (aTopic !== reqTopic) continue;
    }
    if (l.team === req.labels.team && (l.lane || l.lead || "").toLowerCase() === lane) await retireAgent(a, req.labels.lane ? undefined : lane).catch(console.error);
  }
}

/** Creates a worktree if asked, then the agent. In ?demo the agent is injected straight into the store. */
export async function spawnTeamAgent(req: SpawnRequest): Promise<{ id: string; cwd: string }> {
  if (DEMO) {
    const id = `demo-new-${Date.now().toString(36)}`;
    const branch = req.worktree ? req.worktree.branch.replace(/[\\/]/g, "-") : "";
    const cwd = req.worktree ? `${req.cwd}\\..\\${branch}` : req.cwd;
    const agent = {
      id,
      provider: req.provider,
      model: req.model,
      title: req.title,
      status: "idle",
      cwd,
      labels: req.labels,
      updatedAt: new Date().toISOString(),
      pendingPermissions: [],
      requiresAttention: false,
    } as unknown as PaseoAgent;
    const agents = new Map(state.agents);
    agents.set(id, agent);
    set({ agents });
    await retirePredecessors(req, id);
    return { id, cwd };
  }

  await Promise.race([runnerStatusLoaded, new Promise((r) => setTimeout(r, 3000))]); // the first click must not race the status probe
  const agent = await runnerSpawn({
    config: { provider: req.provider, model: req.model, cwd: req.cwd, title: req.title, modeId: req.modeId, ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}) },
    initialPrompt: req.prompt || undefined,
    labels: req.labels,
  });
  upsertLocalAgent(agent);
  await retirePredecessors(req, agent.id);
  return { id: agent.id, cwd: req.cwd };
}
/** A5: copy files into `<cwd>/scratch/inputs` via the dev server. Returns the copied destination paths. */
export async function attachFiles(cwd: string, files: string[]): Promise<string[]> {
  if (DEMO) return files.map((f) => `${cwd}/scratch/inputs/${f.split(/[\\/]/).pop()}`);
  const res = await fetch("/__vibesquad/attach", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd, files }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `attach failed (${res.status})`);
  return body.copied as string[];
}

// Mirror the runner roster into the store.
if (!DEMO && typeof window !== "undefined") {
  onRunnerStatusChange(() => set({}));
  startRunnerBridge(
    (agents, archivedIds) => {
      const live = new Set(agents.map((a) => a.id));
      for (const a of agents) if (!sameAgent(state.agents.get(a.id), a)) upsertLocalAgent(a);
      for (const id of [...state.agents.keys()]) {
        if (!isRunnerId(id) || live.has(id)) continue;
        if (archivedIds.includes(id)) removeLocalAgent(id);
        else dropLocalAgent(id);
      }
    },
    (up) => {
      set({
        runnerConn: up ? "up" : "down",
        conn: up ? "connected" : "disconnected",
        status: up ? "connected" : "disconnected",
        ...(up ? { error: undefined, rosterLoaded: true } : {}),
      });
      if (up) {
        void refetchProviderUsage();
        void refreshTeams();
      }
    },
  );
}
