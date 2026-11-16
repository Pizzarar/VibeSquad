// The "everything that needs you" list behind a team's pink badge: which rows exist, and which
// clear/snooze call each kind maps to. Pure (deps injected) so tests drive it with fixtures.
import type { PaseoAgent } from "./agentTypes";
import { isLocallyHidden, isMarkedUnread } from "./attentionLocal.ts";
import { boringNeedsYouStall } from "./boringHeaderStrip.ts";
import type { Member } from "./teams.ts";

export const LATER_MS = 2 * 3_600_000;

export type ItemKind = "permission" | "label" | "unread" | "error" | "stalled" | "finished";

export type AttentionItem = {
  id: string;
  agent: PaseoAgent;
  who: string;
  reason: string;
  kind: ItemKind;
  /** Pending permission that can be answered with one tap (plain allow/deny, no questions or plan). */
  quickPermission?: { requestId: string };
};

export type AttentionDeps = {
  clearNeedsYou: (agent: PaseoAgent) => Promise<void>;
  snoozeNeedsYou: (agent: PaseoAgent, ms: number) => Promise<void>;
  clearAgentAttention: (agentId: string) => Promise<void>;
  respondToPermission: (agentId: string, requestId: string, response: Record<string, unknown>) => Promise<void>;
  snoozeLocal: (id: string, untilMs: number) => void;
  dismissLocal: (id: string, signature: string) => void;
  clearUnreadLocal: (id: string) => void;
  now: () => number;
  /** Re-derive badges when a local snooze expires. */
  after: (ms: number, fn: () => void) => void;
  refresh: () => void;
};

const whoOf = (a: PaseoAgent) => a.title ?? a.id.slice(0, 8);

export function kindOfAttention(m: Pick<Member, "agent" | "attention">): ItemKind | null {
  const att = m.attention;
  if (!att) return null;
  if (att.tone === "permission") return "permission";
  if (att.tone === "needs-you") return isMarkedUnread(m.agent.id) && att.reason === "marked unread" ? "unread" : "label";
  return att.tone === "error" ? "error" : "finished";
}

const ORDER: Record<ItemKind, number> = { permission: 0, label: 1, unread: 2, error: 3, stalled: 4, finished: 5 };

/** Dismissing a stall hides it only until the agent shows new activity (its updatedAt moves). */
export const stalledSignature = (a: PaseoAgent) => `stalled:${a.updatedAt ?? ""}`;

/**
 * R4-1 switch (docs/UX_REVIEW_R4.md): stalled agents count in the Needs-you list, count and badges. The interim unit held this at false
 * while tool-in-flight was client-only (the count flickered when an agent was opened); the server now reports the oldest open tool call
 * on the agent payload (openToolSince / openToolName / openToolTimeoutMs), so every client reads the same answer. The 90s `st-stalled`
 * glyph in the tree/Workers tab is unaffected.
 */
export const STALLED_IN_NEEDS_YOU = true;

/** The oldest open tool call as this client knows it: server fields first, else the timeline hint (seconds only), else null. */
export function openToolOf(a: PaseoAgent, now: number, hintSeconds?: number | null): { seconds: number; name: string | null; timeoutMs: number | null } | null {
  // Server field present (number or null): authoritative. undefined = an older server / another backend: fall back to the hint.
  if (a.openToolSince !== undefined) {
    if (a.openToolSince === null || !Number.isFinite(a.openToolSince)) return null;
    const timeoutMs = a.openToolTimeoutMs != null && Number.isFinite(a.openToolTimeoutMs) && a.openToolTimeoutMs > 0 ? a.openToolTimeoutMs : null;
    return { seconds: Math.max(0, Math.floor((now - a.openToolSince) / 1000)), name: a.openToolName || null, timeoutMs };
  }
  return hintSeconds != null ? { seconds: hintSeconds, name: null, timeoutMs: null } : null;
}

const mins = (s: number) => (s >= 120 ? `${Math.round(s / 60)}m` : `${s}s`);

/**
 * The R4-1 stall rule (boringNeedsYouStall) on one agent, or null: running with nothing pending AND either no update for 10m with no tool
 * in flight ("Stalled: no update for 12m"), or its oldest open tool call past its ceiling, the tool's own timeout else 60m
 * ("Tool Bash running 61m"). `toolRunningSeconds` is only the client hint for agents whose payload has no openToolSince field.
 */
export function stalledReason(a: PaseoAgent, now: number, toolRunningSeconds?: number | null): string | null {
  const updated = Date.parse(a.updatedAt ?? "");
  // A missing / invalid updatedAt only rules out the "quiet" branch (idle 0); the tool-ceiling branch does not read it.
  const idle = Number.isNaN(updated) ? 0 : Math.max(0, Math.floor((now - updated) / 1000));
  const tool = openToolOf(a, now, toolRunningSeconds);
  const stall = boringNeedsYouStall({
    status: a.status,
    hasPendingPermission: !!a.pendingPermissions?.length,
    idleSeconds: idle,
    toolRunningSeconds: tool?.seconds ?? null,
    toolCeilingSeconds: tool?.timeoutMs != null ? tool.timeoutMs / 1000 : null,
  });
  if (!stall) return null;
  if (stall.kind === "tool") return `Tool ${tool?.name ? `${tool.name} ` : ""}running ${Math.max(1, Math.floor(stall.toolSeconds / 60))}m`;
  return `Stalled: no update for ${mins(stall.idleSeconds)}`;
}

/**
 * Everything that needs the owner. Pass `now` to also list running agents that went quiet as `stalled`
 * (opt-in: badges and the other queues keep counting only what Paseo/labels flag).
 */
export function attentionItems(members: Member[], now?: number, toolRunningSeconds?: (a: PaseoAgent) => number | null | undefined): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const m of members) {
    // Retired leads and archived/closed agents never need you (same rule as the badge counts).
    if (m.kind === "old-lead" || m.agent.archivedAt || m.agent.status === "closed") continue;
    let kind = kindOfAttention(m);
    let reason = m.attention?.reason ?? "";
    if (STALLED_IN_NEEDS_YOU && !kind && now !== undefined && !m.attention && !isLocallyHidden(m.agent.id, stalledSignature(m.agent), now)) {
      const stalled = stalledReason(m.agent, now, toolRunningSeconds?.(m.agent));
      if (stalled) (kind = "stalled"), (reason = stalled);
    }
    if (!kind) continue;
    const item: AttentionItem = { id: m.agent.id, agent: m.agent, who: whoOf(m.agent), reason, kind };
    if (kind === "permission") {
      const p = m.agent.pendingPermissions?.[0] as { id?: string; kind?: string } | undefined;
      if (p?.id && p.kind !== "question" && p.kind !== "plan") item.quickPermission = { requestId: p.id };
    }
    out.push(item);
  }
  return out.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}

/** When this item started needing the owner: the `needs-you-at` stamp (label items), else the agent's last update. */
export function itemSince(item: AttentionItem): number | null {
  const a = item.agent as PaseoAgent & { lastActivityAt?: string | null };
  const labels = (a.labels ?? {}) as Record<string, string>;
  const stamp = item.kind === "label" ? Date.parse(labels["needs-you-at"] ?? "") : NaN;
  const t = Number.isNaN(stamp) ? Date.parse(a.updatedAt ?? a.lastActivityAt ?? "") : stamp;
  return Number.isNaN(t) ? null : t;
}

/** "4m", "2h", "3d" (under a minute: "now"; unknown: ""). */
export function formatAge(since: number | null, now: number): string {
  if (since == null) return "";
  const m = Math.max(0, Math.floor((now - since) / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

/** The squad-wide "Needs you" queue: permissions first, then everything else oldest first (unknown age last). */
export function squadQueue(members: Member[]): AttentionItem[] {
  const keyed = attentionItems(members).map((item) => ({ item, since: itemSince(item) ?? Infinity }));
  const rank = (i: AttentionItem) => (i.kind === "permission" ? 0 : 1);
  return keyed.sort((a, b) => rank(a.item) - rank(b.item) || (a.since === b.since ? 0 : a.since - b.since)).map((k) => k.item);
}

/** Items the badge counts (finished ones are listed but not counted). */
export const countedItems = (items: AttentionItem[]) => items.filter((i) => i.kind !== "finished");

/**
 * R3.2: THE Needs-you count (list rows, sidebar badges). One source so the heading never differs from the badges' sum:
 * counted kinds only (finished excluded), stalled only past the 10-minute / no-tool-in-flight rule.
 */
export const needsYouCount = (members: Member[], now?: number, toolRunningSeconds?: (a: PaseoAgent) => number | null | undefined): number =>
  countedItems(attentionItems(members, now, toolRunningSeconds)).length;

/**
 * Stalled items alone (R3.2). Pin/lane `needsYou` fields count labelled/permission/error items without `now`; a stalled agent is never
 * among those (stalled needs no existing attention), so `pin.needsYou + stalledCount(members, now) == needsYouCount(members, now)`.
 */
export const stalledCount = (members: Member[], now: number, toolRunningSeconds?: (a: PaseoAgent) => number | null | undefined): number =>
  attentionItems(members, now, toolRunningSeconds).filter((i) => i.kind === "stalled").length;

const signatureOf = (a: PaseoAgent, kind: ItemKind) =>
  kind === "error" && a.status === "error" ? (a.lastError ?? "error") : (a.attentionReason ?? "attention");

export async function clearItem(item: AttentionItem, d: AttentionDeps): Promise<void> {
  switch (item.kind) {
    case "label":
      return d.clearNeedsYou(item.agent);
    case "unread":
      d.clearUnreadLocal(item.id);
      return d.refresh();
    case "stalled":
      d.dismissLocal(item.id, stalledSignature(item.agent));
      return d.refresh();
    case "error":
    case "finished":
      // Hide locally first so the badge drops at once; Paseo's clear covers requiresAttention.
      d.dismissLocal(item.id, signatureOf(item.agent, item.kind));
      d.refresh();
      return d.clearAgentAttention(item.id);
    case "permission":
      throw new Error("permissions are answered with Approve / Deny, not cleared");
  }
}

export async function laterItem(item: AttentionItem, d: AttentionDeps): Promise<void> {
  if (item.kind === "label") return d.snoozeNeedsYou(item.agent, LATER_MS);
  d.snoozeLocal(item.id, d.now() + LATER_MS);
  d.refresh();
  d.after(LATER_MS + 50, d.refresh);
}

export async function answerItem(item: AttentionItem, behavior: "allow" | "deny", d: AttentionDeps): Promise<void> {
  if (!item.quickPermission) throw new Error("this request needs the chat");
  return d.respondToPermission(item.id, item.quickPermission.requestId, { behavior });
}

/** Clear all: everything clearable. Permissions are left for an explicit Approve/Deny. */
export async function clearAll(items: AttentionItem[], d: AttentionDeps): Promise<{ cleared: number; failed: number }> {
  let cleared = 0;
  let failed = 0;
  await Promise.all(
    items
      .filter((i) => i.kind !== "permission")
      .map((i) =>
        clearItem(i, d).then(
          () => void cleared++,
          () => void failed++,
        ),
      ),
  );
  return { cleared, failed };
}

type Labels = Record<string, string>;

/**
 * Show `labels` at once, then roll back only the keys we changed, and only if they still hold our value.
 * Other fields, live daemon pushes and queued updates are never touched.
 */
export async function applyLabelsOptimistic(
  labels: Labels,
  io: { get: () => Labels | undefined; patch: (fn: (cur: Labels) => Labels) => void; send: () => Promise<void> },
): Promise<void> {
  const prev = io.get() ?? {};
  const changed = Object.keys(labels).filter((k) => prev[k] !== labels[k]);
  io.patch((cur) => ({ ...cur, ...labels }));
  try {
    await io.send();
  } catch (err) {
    io.patch((cur) => {
      const next = { ...cur };
      for (const k of changed) {
        if (next[k] !== labels[k]) continue; // a push or newer edit owns this key now
        if (k in prev) next[k] = prev[k];
        else delete next[k];
      }
      return next;
    });
    throw err;
  }
}
