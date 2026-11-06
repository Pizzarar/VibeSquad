import { createPaseoApi, type PaseoAgent, type PaseoClient, type PaseoWorkspace } from "@getpaseo/client";
import { applyLabelsOptimistic } from "./attentionItems";
import { clearUnreadLocal, dismissLocal, markUnreadLocal, subscribeAttentionLocal } from "./attentionLocal";
import { clearWorkspaceIfQuiet } from "./paseoAttention";
import { fetchRunnerStatus, getRunnerStatus, isRunnerId, isRunnerLane, runnerArchive, runnerCancel, runnerSend, runnerSpawn, runnerUpdate, runnerStatusLoaded, startRunnerBridge } from "./runnerBridge";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { spawnEnvFor } from "./spawn-env";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import { useSyncExternalStore } from "react";
import { refreshTeams, retiredLeadTitle } from "./teams";
import { normalizeProviderUsage, type ProviderQuotaView } from "./antigravity";
import { LEGACY_NEEDS_LABEL, LEGACY_NEEDS_UNTIL, LEGACY_NEEDS_REASON } from "./userName";
import { demoAgents, demoArchived, demoProviderUsage, demoWorkspaces } from "./demo";
import { applyDaemonClientPassword, fetchLocalDaemonPassword, readClientAuthFailure } from "./paseoDaemonAuth";
import { createPaseoLink } from "./paseoLink";
import { remoteDaemonClient } from "./paseoRemote";
import { isRemote } from "./remoteSession";
import { perfRecord, perfSendBegin, perfSendResolved } from "./perf";
import { addPending, failPending, retryPending } from "./pendingSend";

declare const __PASEO_SERVER_ID__: string;
export const SERVER_ID = __PASEO_SERVER_ID__;

// Same-origin URL; Vite proxies /ws to the daemon (see vite.config.ts).
const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

// ?demo swaps the daemon for a fixed cast so the art can be reviewed without live agents.
export const DEMO = new URLSearchParams(location.search).has("demo");

export type ConnStatus = "connecting" | "connected" | "disconnected";

type State = {
  conn: ConnStatus;
  /** The VS runner's event stream (what blocking UI keys off); Paseo's own conn never blocks. */
  runnerConn: "unknown" | "up" | "down";
  status: "connecting" | "connected" | "disconnected" | "error";
  error?: string;
  authFailureReason: "password_required" | "incorrect_password" | null;
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
  authFailureReason: null,
  agents: new Map(),
  rosterLoaded: false,
  archivedAgents: new Map(),
  archivedStatus: "idle",
  workspaces: new Map(),
  providerUsage: [],
};
const listeners = new Set<() => void>();

// Bursts of daemon messages land as one store update per frame: upserts queue here and
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

function queueAgent(id: string, agent: PaseoAgent | null) {
  const cur = pendingAgents.has(id) ? pendingAgents.get(id) : state.agents.get(id);
  if (agent ? sameAgent(cur ?? undefined, agent) : cur === undefined) return; // no-op update
  pendingAgents.set(id, agent);
  schedule();
}

// Same construction as createPaseoClient, but we keep the DaemonClient for calls the SDK api lacks.
// A paired remote page (R2-2) gets the relay + e2ee client from paseoRemote.ts instead; local boot: null.
export const daemonClient =
  remoteDaemonClient() ??
  new DaemonClient({
    url: WS_URL,
    clientId: "vibesquad",
    clientType: "browser",
    appVersion: "0.0.1",
    reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 10000 },
  });
const api = createPaseoApi(daemonClient);

export const client: PaseoClient = {
  ...api,
  connect: () => daemonClient.connect(),
  close: async () => {
    try {
      await api.dispose();
    } finally {
      await daemonClient.close();
    }
  },
  ensureConnected: () => daemonClient.ensureConnected(),
  getConnectionState: () => daemonClient.getConnectionState(),
} as PaseoClient;

export async function stopAgent(agentId: string): Promise<void> {
  if (DEMO) return;
  if (isRunnerId(agentId)) return runnerCancel(agentId);
  await daemonClient.cancelAgent(agentId);
}

type SendArgs = { images?: Array<{ data: string; mimeType: string }>; opts?: { activeTurnBehavior?: ActiveTurnBehavior } };
const sendArgs = new Map<string, SendArgs>();

async function deliver(agentId: string, text: string, args: SendArgs): Promise<void> {
  const sendOpts = { activeTurnBehavior: "steer" as ActiveTurnBehavior, ...args.opts };
  const lb = (state.agents.get(agentId)?.labels ?? {}) as Record<string, string>;
  perfSendBegin(agentId, lb.team, lb.lane);
  if (isRunnerId(agentId)) {
    await runnerSend(agentId, text, { images: args.images, activeTurnBehavior: sendOpts.activeTurnBehavior });
    perfSendResolved(agentId);
    return;
  }
  if (args.images?.length) await daemonClient.sendAgentMessage(agentId, text, { ...sendOpts, images: args.images });
  else await daemonClient.sendAgentMessage(agentId, text, sendOpts);
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
  } catch (e) {
    failPending(id, e instanceof Error ? e.message : String(e));
  }
}

export async function archiveAgent(agentId: string): Promise<{ archivedAt: string }> {
  if (DEMO) return { archivedAt: new Date().toISOString() };
  const res = isRunnerId(agentId) ? await runnerArchive(agentId) : await client.agents.ref(agentId).archive();
  pendingAgents.delete(agentId);
  const agents = new Map(state.agents);
  agents.delete(agentId);
  set({ agents });
  return res;
}

export async function detachAgent(agentId: string): Promise<void> {
  if (DEMO) return;
  await client.agents.ref(agentId).detach();
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
  if (isRunnerId(agentId)) return runnerUpdate(agentId, updates);
  if (opts.optimistic && updates.labels) return updateLabelsOptimistic(agentId, updates.labels);
  await daemonClient.updateAgent(agentId, updates);
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
    send: () => daemonClient.updateAgent(agentId, { labels }),
  });
}

/** Re-derive everything that depends on local attention state or the clock (new Map, same agents). */
export function bumpAgents() {
  state = { ...state, agents: new Map(state.agents) };
  listeners.forEach((l) => l());
}
subscribeAttentionLocal(bumpAgents);

export async function clearAgentAttention(agentId: string): Promise<void> {
  if (DEMO) return;
  await daemonClient.clearAgentAttention(agentId);
}

/** Mark a chat unread: local flag puts it back in the attention list; Paseo's flag is best effort. */
export async function markAgentUnread(agent: PaseoAgent): Promise<void> {
  markUnreadLocal(agent.id);
  const ws = (agent as { workspaceId?: string }).workspaceId;
  if (DEMO || !ws) return;
  try {
    await daemonClient.markWorkspaceUnread(ws);
  } catch (err) {
    console.warn("markWorkspaceUnread failed", err);
  }
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
  await clearWorkspaceIfQuiet(agent.id);
}

const labelsOf = (a: PaseoAgent) => (a.labels ?? {}) as Record<string, string>;
/** Labels as of now, not as of the render that handed us `agent`. */
const latestLabels = (a: PaseoAgent) => labelsOf(state.agents.get(a.id) ?? a);

/** Legacy-labelled agents keep working: when the old label is set, clear/snooze it alongside the canonical one. */
const hasLegacy = (a: PaseoAgent) => !!labelsOf(a)[LEGACY_NEEDS_LABEL];

export function setNeedsYou(agent: PaseoAgent, reason: string): Promise<void> {
  const legacy = hasLegacy(agent)
    ? { [LEGACY_NEEDS_LABEL]: reason, [LEGACY_NEEDS_REASON]: reason, [LEGACY_NEEDS_UNTIL]: "" }
    : {};
  return updateAgent(agent.id, {
    labels: { ...latestLabels(agent), ...legacy, "needs-you": reason, "needs-you-reason": reason, "needs-you-until": "" },
  });
}

export function clearNeedsYou(agent: PaseoAgent, opts?: { optimistic?: boolean }): Promise<void> {
  const legacy = hasLegacy(agent) ? { [LEGACY_NEEDS_LABEL]: "cleared", [LEGACY_NEEDS_UNTIL]: "" } : {};
  return updateAgent(agent.id, { labels: { ...latestLabels(agent), ...legacy, "needs-you": "cleared", "needs-you-until": "" } }, opts);
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
    const res = await client.agents.list({ filter: { includeArchived: true }, page: { limit: 200 } });
    const next = new Map<string, PaseoAgent>();
    for (const e of res.entries) if (e.agent.archivedAt) next.set(e.agent.id, e.agent);
    set({ archivedAgents: next, archivedStatus: "ready" });
  } catch (err) {
    console.error("loadArchived failed", err);
    set({ archivedStatus: "error" });
  }
}

export async function archiveWorkspace(workspaceId: string) {
  if (DEMO) return;
  return client.workspaces.archive(workspaceId);
}

async function refetchAll() {
  const r0 = performance.now();
  // includeArchived:false keeps it to what the Paseo sidebar would show, plus closed ones.
  const res = await client.agents.list({ subscribe: {}, filter: { includeArchived: false } });
  const r1 = performance.now();
  // Keep the old object for agents that did not change so their rows stay memoized.
  // Always publish a new Map: time-based state (needs-you snooze expiry) is re-derived from it.
  const next = new Map<string, PaseoAgent>();
  for (const e of res.entries) {
    const old = state.agents.get(e.agent.id);
    next.set(e.agent.id, old && sameAgent(old, e.agent) ? old : e.agent);
  }
  for (const [id, a] of state.agents) if (isRunnerId(id)) next.set(id, a); // runner agents are not in the Paseo snapshot
  pendingAgents.clear(); // anything queued is older than this snapshot
  const firstRoster = !state.rosterLoaded;
  set({ agents: next, rosterLoaded: true });
  let bytes = 0;
  try {
    bytes = JSON.stringify(res.entries).length;
  } catch {
    /* ignore */
  }
  perfRecord("roster-fetch", r1 - r0, `agents=${res.entries.length} payloadKB=${Math.round(bytes / 1024)} diff+set=${Math.round(performance.now() - r1)}ms`);
  // Cold load: navigation start → first roster usable (performance.now() is relative to navigation start).
  if (firstRoster) perfRecord("cold-load", performance.now(), `agents=${res.entries.length}`);
}

// A9: per-provider quota for the sidebar. Best effort: older daemons lack providers.listUsage.
async function refetchProviderUsage() {
  try {
    const res: any = await daemonClient.listProviderUsage();
    set({ providerUsage: normalizeProviderUsage(res?.payload ?? res) });
  } catch (err) {
    console.warn("listProviderUsage failed", err);
  }
}

async function refetchWorkspaces() {
  const res = await client.workspaces.list({ subscribe: {} });
  const next = new Map<string, PaseoWorkspace>();
  for (const w of res.entries) if (!(w as { internal?: boolean }).internal) next.set(w.id, w);
  set({ workspaces: next });
}

// Which transports are up: state.conn is "connected" when either the Paseo websocket or the runner event stream is.
// The state machine (park / resume / conn transitions / pinned-spawn gate) lives in paseoLink.ts so it can be unit-tested.
/** Paseo agents we can no longer reach: drop them rather than show dead rows that fail on click. Runner agents stay. */
function dropPaseoAgents(): void {
  if (![...state.agents.keys()].some((id) => !isRunnerId(id))) return;
  const agents = new Map<string, PaseoAgent>();
  for (const [id, a] of state.agents) if (isRunnerId(id)) agents.set(id, a);
  set({ agents });
}

const link = createPaseoLink({
  daemonClient,
  getRunnerStatus,
  fetchRunnerStatus,
  isRemote,
  getConn: () => state.conn,
  setConn: (patch) => set(patch),
  dropPaseoAgents,
  reconnect: () => void connect(),
});
const parkPaseo = link.park;

async function connect(): Promise<void> {
  try {
    if (!DEMO && !isRemote()) {
      await Promise.race([runnerStatusLoaded, new Promise((r) => setTimeout(r, 1500))]);
      if (!(await link.shouldConnectPaseo())) return; // runner-only: no Paseo to connect to
    }
    if (!DEMO && !isRemote()) {
      const auth = await fetchLocalDaemonPassword();
      if (auth.password || auth.localCredential) {
        applyDaemonClientPassword(daemonClient, auth.password, auth.localCredential);
      }
    }
    await daemonClient.connect();
    link.setPaseoConn(true);
    set({ conn: "connected", status: "connected", error: undefined, authFailureReason: null });
    refetchAll().catch(console.error);
    refetchWorkspaces().catch(console.error);
    refetchProviderUsage();
  } catch (e) {
    link.setPaseoConn(false);
    const authReason = readClientAuthFailure(daemonClient, e);
    if (!authReason && link.runnerOn()) {
      parkPaseo(); // Paseo is down but the runner is up: stay connected, stop hammering /ws
      return;
    }
    if (authReason) {
      set({
        conn: "disconnected",
        status: "error",
        error: authReason === "password_required" ? "Daemon password required" : "Daemon password rejected",
        authFailureReason: authReason,
      });
    } else {
      set({
        conn: "disconnected",
        status: "error",
        error: String((e as Error)?.message ?? e),
        authFailureReason: null,
      });
    }
  }
}

export async function reconnectWithDaemonPassword(password?: string): Promise<void> {
  if (password !== undefined) {
    applyDaemonClientPassword(daemonClient, password);
  }
  set({ authFailureReason: null, error: undefined, status: "connecting", conn: "connecting" });
  await connect();
}

let started = false;
export function start() {
  if (started) return;
  started = true;
  if (DEMO) {
    set({ conn: "connected", status: "connected", error: undefined, authFailureReason: null, rosterLoaded: true, agents: demoAgents(), workspaces: demoWorkspaces() as Map<string, PaseoWorkspace>, providerUsage: normalizeProviderUsage(demoProviderUsage()) });
    return;
  }

  client.agents.subscribe((u) => {
    if (u.kind === "upsert") queueAgent(u.agent.id, u.agent.archivedAt ? null : u.agent);
    else queueAgent(u.agentId, null);
  });

  client.workspaces.subscribe((u) => {
    const workspaces = new Map(state.workspaces);
    if (u.kind === "upsert") {
      if ((u.workspace as { internal?: boolean }).internal) workspaces.delete(u.workspace.id);
      else workspaces.set(u.workspace.id, u.workspace);
    } else {
      workspaces.delete(u.id);
    }
    set({ workspaces });
  });

  // DaemonClient reconnects on its own (exponential backoff); we mirror its state and refetch after a gap.
  let wasConnected = false;
  (daemonClient as unknown as { subscribeConnectionStatus?: (cb: (s: { status: string; reason?: string }) => void) => () => void }).subscribeConnectionStatus?.((s) => {
    if (link.parked && s.status !== "connected") return; // paused on purpose
    link.setPaseoConn(s.status === "connected");
    if (s.status === "connected") {
      set({ conn: "connected", status: "connected", error: undefined, authFailureReason: null });
      if (!wasConnected) {
        wasConnected = true;
        refetchAll().catch(console.error);
        refetchWorkspaces().catch(console.error);
        refetchProviderUsage();
        void refreshTeams();
      }
      return;
    }
    wasConnected = false;
    if (link.runnerOn() && !readClientAuthFailure(daemonClient, s)) {
      if (s.status === "disconnected") parkPaseo(); // runner keeps the UI live; no endless /ws retries, no dead Paseo rows
      return;
    }
    if (s.status === "connecting" || s.status === "idle") {
      if (state.conn !== "connecting") set({ conn: "connecting", status: "connecting" });
      return;
    }
    if (s.status === "disconnected") {
      const authReason = readClientAuthFailure(daemonClient, s);
      if (authReason) {
        set({
          conn: "disconnected",
          status: "error",
          error: authReason === "password_required" ? "Daemon password required" : "Daemon password rejected",
          authFailureReason: authReason,
        });
      } else {
        set({ conn: "disconnected", status: "disconnected" });
      }
    }
  });

  // Belt and braces: a full refetch every minute in case an update was dropped.
  setInterval(() => {
    if (link.paseoConn) {
      refetchAll().catch(console.error);
      refetchProviderUsage();
    }
  }, 60_000);

  void connect();
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
  // A Paseo-pinned lane with no Paseo: say so now instead of hanging on a dead websocket ("Transport not connected").
  if (!isRunnerLane(req.labels.lane)) link.assertCanSpawnOnPaseo();
  if (isRunnerLane(req.labels.lane)) {
    const agent = await runnerSpawn({
      config: { provider: req.provider, model: req.model, cwd: req.cwd, title: req.title, modeId: req.modeId, ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}) },
      initialPrompt: req.prompt || undefined,
      labels: req.labels,
    });
    upsertLocalAgent(agent);
    await retirePredecessors(req, agent.id);
    return { id: agent.id, cwd: req.cwd };
  }

  // approvalPolicy/sandbox/shareMcp and profile featureValues (e.g. auto_accept) travel in `featureValues`.
  const featureValues: Record<string, unknown> = { ...(req.featureValues ?? {}) };
  if (req.approvalPolicy && featureValues.approvalPolicy === undefined) featureValues.approvalPolicy = req.approvalPolicy;
  if (req.sandbox && featureValues.sandbox === undefined) featureValues.sandbox = req.sandbox;
  if (req.shareMcp !== undefined && featureValues.shareMcp === undefined) {
    // antigravity-cli exposes shareMcp as a string select ("on" | "off").
    featureValues.shareMcp = req.provider === "antigravity-cli" ? (req.shareMcp ? "on" : "off") : req.shareMcp;
  }
  const sysPrompt = (req.systemPrompt ?? req.notes ?? "").trim() || undefined;

  const handle = await client.agents.create({
    config: {
      provider: `${req.provider}/${req.model}`,
      modeId: req.modeId,
      thinkingOptionId: req.thinkingOptionId,
      featureValues: Object.keys(featureValues).length ? featureValues : undefined,
      ...(sysPrompt ? { systemPrompt: sysPrompt } : {}),
    } as any,
    cwd: req.cwd,
    title: req.title,
    labels: req.labels,
    ...(spawnEnvFor(req.labels) ? { env: spawnEnvFor(req.labels) } : {}),
    prompt: req.prompt || undefined,
    ...(req.images?.length ? { images: req.images } : {}),
    worktree: req.worktree ? { mode: "branch-off", newBranch: req.worktree.branch } : undefined,
  });
  const newId = (handle as { id: string }).id;
  await retirePredecessors(req, newId);
  return { id: newId, cwd: req.cwd };
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

// Runner-backed lanes (inert unless one is switched): mirror the runner roster into the store.
if (!DEMO && typeof window !== "undefined") {
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
      // The VS server's own stream is a connection: with the Paseo websocket down (or absent) the UI is still live.
      if (up && state.conn !== "connected") set({ rosterLoaded: true });
      set({ runnerConn: up ? "up" : "down" });
      link.onRunnerConnection(up);
    },
  );
}
