import type { PaseoAgent } from "@getpaseo/client";

// Pure detectors and guards for the Antigravity issues A1-A9 (docs/PLAN_STEP5_AGY_HARDENING.md).
// No React, no daemon calls: Unit 5B feeds these the agent snapshot and projected timeline tail.

// Shape of a projected timeline entry as the drawer reads it (see AgentDrawer.tsx).
export type TimelineEntry = { item: any; timestamp?: string; seqStart?: number };

const AGY = "antigravity-cli";
const isAgy = (a: PaseoAgent) => a.provider === AGY;
const hasPending = (a: PaseoAgent) => !!a.pendingPermissions?.length;
const itemOf = (e: TimelineEntry) => (e?.item && typeof e.item === "object" ? e.item : null);
const textOf = (e: TimelineEntry): string => String(itemOf(e)?.text ?? "").trim();

function lastIndexOfType(events: TimelineEntry[], type: string): number {
  for (let i = events.length - 1; i >= 0; i--) if (itemOf(events[i])?.type === type) return i;
  return -1;
}

// ---- A1 / A6: spawn defaults and stalled-permission warning ----

export type SpawnDefaults = {
  modeId?: string;
  approvalPolicy?: string;
  sandbox?: string;
  shareMcp: boolean;
};

export function defaultSpawnConfigFor(provider: string): SpawnDefaults {
  switch (provider) {
    case AGY:
      return { approvalPolicy: "skip", modeId: "accept-edits", shareMcp: true };
    case "claude":
      return { modeId: "auto", shareMcp: true };
    case "codex":
      return { approvalPolicy: "never", sandbox: "danger-full-access", shareMcp: true };
    case "opencode":
      return { modeId: "build", shareMcp: true };
    default:
      return { shareMcp: true };
  }
}

export const STALLED_PERMISSION_SECONDS = 90;

export function detectStalledAgyPermission(
  agent: PaseoAgent,
  nowMs: number = Date.now(),
): { stalled: boolean; idleSeconds: number; message: string } | null {
  if (!isAgy(agent) || agent.status !== "running" || hasPending(agent)) return null;
  const updated = Date.parse(agent.updatedAt ?? "");
  if (Number.isNaN(updated)) return null;
  const idleSeconds = Math.max(0, Math.floor((nowMs - updated) / 1000));
  if (idleSeconds < STALLED_PERMISSION_SECONDS) return null;
  return {
    stalled: true,
    idleSeconds,
    message: `Running with no update for ${idleSeconds}s and no visible permission request. Antigravity may be waiting on a permission Paseo never shows (check approvalPolicy: skip).`,
  };
}

// ---- A2: idle but promised a run ----

export const PROMISED_RUN_SYSTEM_GUARD =
  "Do not end your turn while a background run or check you started is still in flight; wait for it and report the result, unless you are using a reactive wakeup.";

export const PROMISED_RUN_NUDGE_PROMPT =
  "Your turn ended while a promised action or background check appeared incomplete. Please check status and continue, or report final completion.";

const PROMISE_RE = /\b(let me|i will|i'll|going to|now i'll|(?:i'm|i am|now|currently)\s+(?:running|checking|starting|dispatching))\b|^(?:running|checking|starting|dispatching)\b/i;
const GERUND_START_RE = /^(?:running|checking|starting|dispatching)\b/i;
const DESCRIPTIVE_VERB_RE = /\b(?:updates|shows|happens|publishes|syncs|is|was|are|were|does|makes|means|allows|prevents|causes|returns|produces)\b/i;
const DONE_RE = /\b(done|complete[d]?|finished|all set|summary|in summary|final report)\b/i;

function lastSentence(text: string): string {
  const parts = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function cleanExcerpt(s: string): string {
  return s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
}

export function detectPromisedRunIdle(
  agent: PaseoAgent,
  events: TimelineEntry[],
): { flagged: boolean; excerpt: string } | null {
  if (!isAgy(agent) || agent.status !== "idle" || hasPending(agent)) return null;
  const ai = lastIndexOfType(events, "assistant_message");
  if (ai < 0) return null;
  const text = textOf(events[ai]);
  if (!text) return null;
  const tail = lastSentence(text);
  const trailing = /(:|\.\.\.|…)$/.test(text);
  const gerundDescriptive = GERUND_START_RE.test(tail) && DESCRIPTIVE_VERB_RE.test(tail);
  const promised = (PROMISE_RE.test(tail) && !gerundDescriptive) || (trailing && !DONE_RE.test(tail));
  // A shell started after the last assistant text with no later synthesis also counts.
  const bgShell = events.slice(ai + 1).some((e) => {
    const it = itemOf(e);
    return it?.type === "tool_call" && it.detail?.type === "shell" && it.status === "running";
  });
  if (!promised && !bgShell) return null;
  const cleaned = cleanExcerpt(tail);
  const excerpt = cleaned.length > 110 ? `${cleaned.slice(0, 107)}…` : cleaned;
  return { flagged: true, excerpt };
}

// ---- A3: hung tool call watchdog ----

export const HUNG_TOOL_WARN_SECONDS = 180;
export const HUNG_TOOL_CRITICAL_SECONDS = 600;

export const CANCEL_AND_RESUME_PROMPT = (toolName: string): string =>
  `Cancelled hung tool call (${toolName}). Re-run without nested blocking quotes or stdin wait.`;

const OPEN_STATUSES = new Set(["running", "in_progress", "pending"]);

export function detectHungToolCall(
  agent: PaseoAgent,
  events: TimelineEntry[],
  nowMs: number = Date.now(),
): { callId: string; name: string; ageSeconds: number; severity: "warn" | "critical" } | null {
  if (agent.status !== "running") return null;
  let worst: { callId: string; name: string; ageSeconds: number } | null = null;
  for (const e of events) {
    const it = itemOf(e);
    if (it?.type !== "tool_call" || !OPEN_STATUSES.has(String(it.status))) continue;
    const started = Date.parse(e.timestamp ?? agent.updatedAt ?? "");
    if (Number.isNaN(started)) continue;
    const ageSeconds = Math.max(0, Math.floor((nowMs - started) / 1000));
    if (!worst || ageSeconds > worst.ageSeconds) {
      worst = { callId: String(it.callId ?? it.id ?? e.seqStart ?? ""), name: String(it.name ?? "tool"), ageSeconds };
    }
  }
  if (!worst || worst.ageSeconds < HUNG_TOOL_WARN_SECONDS) return null;
  return { ...worst, severity: worst.ageSeconds >= HUNG_TOOL_CRITICAL_SECONDS ? "critical" : "warn" };
}

// ---- A4: transient error classifier ----

export type TransientKind = "eof" | "dns" | "reset" | "quota" | "other";

export const TRANSIENT_RETRY_PROMPT = "Transient network/API error encountered; please resume from where you left off.";

export function classifyTransientError(agent: PaseoAgent): {
  retryable: boolean;
  kind: TransientKind;
  summary: string;
  retryPrompt: string;
} | null {
  if (agent.status !== "error") return null;
  const raw = String(agent.lastError ?? agent.attentionReason ?? "").trim();
  if (!raw) return null;
  const summary = raw.slice(0, 200);
  const make = (kind: TransientKind, retryable: boolean) => ({
    retryable,
    kind,
    summary,
    retryPrompt: retryable ? TRANSIENT_RETRY_PROMPT : "",
  });
  if (/quota|rate.?limit|resource.?exhausted|\b429\b/i.test(raw)) return make("quota", false);
  if (/no such host/i.test(raw)) return make("dns", true);
  if (/ECONNRESET|ETIMEDOUT|socket hang up/i.test(raw)) return make("reset", true);
  if (/\bEOF\b|googleapis/i.test(raw)) return make("eof", true);
  return make("other", false);
}

// ---- A5: workspace read restriction ----

const BLOCK_RE =
  /(outside (of )?the (current )?workspace|not (in|within) (the )?workspace|workspace (boundary|restriction)|cannot (read|access)[^.]*workspace|copy[^.]*(into|to) (the |your )?workspace|attach (the )?files?|path is not allowed)/i;
const PATH_RE = /(?:[A-Za-z]:[\\/][^\s"'`<>|*?,;]+|(?<![\w.])\/(?:[\w.-]+\/)+[\w.-]+)/g;

export function detectWorkspaceReadBlock(
  events: TimelineEntry[],
): { blocked: boolean; requestedPaths: string[]; excerpt: string } | null {
  const recent = events.slice(-10);
  const hits: string[] = [];
  for (const e of recent) {
    const it = itemOf(e);
    if (!it) continue;
    let text = "";
    if (it.type === "assistant_message" || it.type === "error") text = String(it.text ?? it.message ?? "");
    else if (it.type === "tool_call" && it.status === "failed") text = String(it.error ?? it.detail?.output ?? "");
    if (text && BLOCK_RE.test(text)) hits.push(text);
  }
  if (!hits.length) return null;
  const paths = new Set<string>();
  for (const h of hits) for (const m of h.match(PATH_RE) ?? []) paths.add(m.replace(/[.)\]]+$/, ""));
  return { blocked: true, requestedPaths: [...paths], excerpt: hits[hits.length - 1].slice(0, 200) };
}

export function scratchInputDirFor(cwd: string): string {
  return `${cwd.replace(/[\\/]+$/, "")}/scratch/inputs`;
}

// ---- A7: .agents/mcp_config.json git exclusion ----

export function checkMcpConfigExcluded(gitignoreContent: string): { excluded: boolean; warning: string | null } {
  const covered = gitignoreContent.split(/\r?\n/).some((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) return false;
    const p = line.replace(/^\//, "").replace(/\/+$/, "");
    return p === ".agents" || p === ".agents/*" || p === ".agents/**" || p === ".agents/mcp_config.json" || p === "**/.agents" || p === "mcp_config.json";
  });
  return covered
    ? { excluded: true, warning: null }
    : {
        excluded: false,
        warning: "shareMcp writes credentials to .agents/mcp_config.json, which is not git-excluded. Add `.agents/` to .gitignore.",
      };
}

// ---- A8: silent zero-output turn ----

export function detectSilentTurn(
  agent: PaseoAgent,
  events: TimelineEntry[],
): { silent: boolean; reason: string } | null {
  if (agent.status !== "idle" || events.length === 0) return null;
  const ui = lastIndexOfType(events, "user_message");
  const turn = events.slice(ui + 1);
  if (turn.length === 0) return null;
  const said = turn.some((e) => itemOf(e)?.type === "assistant_message" && textOf(e) !== "");
  if (said) return null;
  const worked = turn.some((e) => {
    const t = itemOf(e)?.type;
    return t === "tool_call" || t === "todo" || t === "notification" || t === "reasoning";
  });
  return {
    silent: true,
    reason: worked
      ? "Turn ended with tool activity but no assistant message."
      : "Turn ended with no assistant message.",
  };
}

// ---- A10/A11: report routing (workers must report in their final message) ----

export const WORKER_REPORT_ROUTING_GUARD =
  "Your final message is the report; never call built-in SendMessage or ListAgents; mid-task use `send` (VS MCP or `vs send`).";

// Claude Code's built-in agent messaging, which cannot reach a Paseo lead.
const MISROUTED_TOOLS = new Set(["sendmessage", "listagents"]);

export function detectMisroutedReport(
  events: TimelineEntry[],
): { flagged: boolean; tools: string[]; excerpt: string } | null {
  const ui = lastIndexOfType(events, "user_message");
  const turn = events.slice(ui + 1);
  const tools: string[] = [];
  for (const e of turn) {
    const it = itemOf(e);
    if (it?.type !== "tool_call") continue;
    const name = String(it.name ?? "");
    if (MISROUTED_TOOLS.has(name.toLowerCase().replace(/[^a-z]/g, ""))) tools.push(name);
  }
  if (!tools.length) return null;
  return {
    flagged: true,
    tools,
    excerpt: `Worker used built-in ${tools.join(", ")} instead of reporting in its final message.`,
  };
}

// ---- A9: provider usage / quota ----

export type ProviderQuotaView = {
  provider: string;
  account?: string;
  usedPct?: number;
  remainingLabel: string;
  resetAt?: string;
  staleModelListWarning?: boolean;
};

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function normalizeProviderUsage(raw: unknown): ProviderQuotaView[] {
  const root = rec(raw);
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray(root?.providers)
      ? (root!.providers as unknown[])
      : Array.isArray(root?.entries)
        ? (root!.entries as unknown[])
        : Array.isArray(root?.usage)
          ? (root!.usage as unknown[])
          : [];
  const out: ProviderQuotaView[] = [];
  for (const entry of list) {
    const r = rec(entry);
    const provider = str(r?.provider) ?? str(r?.id) ?? str(r?.name);
    if (!r || !provider) continue;
    let usedPct = num(r.usedPct) ?? num(r.usedPercent) ?? num(r.percentUsed);
    const used = num(r.used);
    const limit = num(r.limit) ?? num(r.total);
    if (usedPct === undefined && used !== undefined && limit) usedPct = (used / limit) * 100;
    if (usedPct !== undefined && usedPct <= 1 && r.fraction === true) usedPct *= 100;
    if (usedPct !== undefined) usedPct = Math.min(100, Math.max(0, Math.round(usedPct * 10) / 10));
    const remaining = num(r.remaining);
    const remainingLabel =
      str(r.remainingLabel) ??
      (usedPct !== undefined
        ? `${Math.round(100 - usedPct)}% left`
        : remaining !== undefined
          ? `${remaining} left`
          : "usage unknown");
    out.push({
      provider,
      account: str(r.account) ?? str(r.accountId) ?? str(r.email),
      usedPct,
      remainingLabel,
      resetAt: str(r.resetAt) ?? str(r.resetsAt),
      staleModelListWarning: r.staleModelList === true || r.staleModelListWarning === true ? true : undefined,
    });
  }
  return out;
}

// ---- Aggregate ----

export type AntigravityAudit = {
  a1Stalled: ReturnType<typeof detectStalledAgyPermission>;
  a2PromisedIdle: ReturnType<typeof detectPromisedRunIdle>;
  a3HungTool: ReturnType<typeof detectHungToolCall>;
  a4TransientError: ReturnType<typeof classifyTransientError>;
  a5ReadBlocked: ReturnType<typeof detectWorkspaceReadBlock>;
  a8SilentTurn: ReturnType<typeof detectSilentTurn>;
  a11MisroutedReport: ReturnType<typeof detectMisroutedReport>;
};

export function auditAntigravityAgent(
  agent: PaseoAgent,
  events: TimelineEntry[] = [],
  nowMs: number = Date.now(),
): AntigravityAudit {
  const agy = isAgy(agent);
  return {
    a1Stalled: detectStalledAgyPermission(agent, nowMs),
    a2PromisedIdle: detectPromisedRunIdle(agent, events),
    a3HungTool: detectHungToolCall(agent, events, nowMs),
    a4TransientError: classifyTransientError(agent),
    a5ReadBlocked: agy ? detectWorkspaceReadBlock(events) : null,
    a8SilentTurn: agy ? detectSilentTurn(agent, events) : null,
    a11MisroutedReport: detectMisroutedReport(events),
  };
}
