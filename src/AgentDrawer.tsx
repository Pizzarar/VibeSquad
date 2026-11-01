import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { buildAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import {
  attachFiles,
  clearNeedsYou,
  client,
  DEMO,
  SERVER_ID,
  sendMessage,
  setNeedsYou,
  snoozeNeedsYou,
  stopAgent,
  updateAgent,
  upsertLocalAgent,
} from "./paseo";
import {
  auditAntigravityAgent,
  CANCEL_AND_RESUME_PROMPT,
  PROMISED_RUN_NUDGE_PROMPT,
  scratchInputDirFor,
  TRANSIENT_RETRY_PROMPT,
} from "./antigravity";
import { demoTimeline } from "./demo";
import { useDraft } from "./drafts";
import { blobsToPaseoImages, rememberSent, sentImagesFor, useImageDraft } from "./imageDrafts";
import {
  AGENT_TYPE_LABEL,
  attentionOf,
  brainstormUsedTokens,
  budgetFor,
  classifyAgent,
  expectedTitleFor,
  getBrainstormThresholds,
  isBrainstormAgent,
  isTopicBrainstorm,
  kindOf,
  leadLadderFor,
  leadVariant,
  teamForAgent,
  topicOfBrainstorm,
  usedTokens,
  useTeams,
} from "./teams";
import { AgentActions, StatusDot, ago, shortPath, useTick } from "./ui";
import {
  TOPIC_SOFT_CAP,
  TopicCapBanner,
  handoffTopicBrainstormClient,
  parkIdeasInInbox,
  parkTopicBrainstormClient,
  isImeComposing,
  shouldComposerSubmit,
} from "./IdeaInbox";
import { Avatar, TokenMeter, providerSpec } from "./pixel";
import { LEGACY_NEEDS_LABEL, LEGACY_NEEDS_REASON, LEGACY_NEEDS_UNTIL, needsYouBadge, useUserName } from "./userName";
import { openAgentInTab, paneOfAgent } from "./panes";

type Entry = { item: any; timestamp?: string; seqStart?: number };

const PLAN_HANDOFF_RE = /\b(handed off|plan handoff|sent to lead|PLAN_[A-Z0-9_]+\.md)\b/i;

// A hidden tab (active=false) stays mounted but ignores live events; it refetches once on return.
function useTimeline(agentId: string, status: string, active = true) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const stale = useRef(false);
  const reload = useRef<() => void>(() => {});

  useEffect(() => {
    if (DEMO) {
      setEntries(demoTimeline(agentId) as Entry[]);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handle = client.agents.ref(agentId);

    const load = async () => {
      try {
        const t = await handle.timeline.refetch({ direction: "tail", limit: 60, projection: "projected" });
        if (!alive) return;
        if (t.error) setError(String(t.error));
        else {
          setError(null);
          setEntries(t.entries as Entry[]);
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
    };
    // Live events stream in token-by-token; refetching the projected tail on a short
    // debounce is simpler than merging deltas ourselves and is plenty for a dashboard.
    const soon = () => {
      if (!activeRef.current) {
        stale.current = true;
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        load();
      }, 600);
    };

    reload.current = load;
    load();
    const sub = handle.timeline.subscribe(() => soon());
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      if (typeof sub === "function") sub();
      else if (sub && typeof (sub as any).unsubscribe === "function") (sub as any).unsubscribe();
    };
  }, [agentId]);

  // Status flips (running -> idle) can land without a timeline event; reload then too.
  useEffect(() => {
    if (DEMO) return;
    if (!activeRef.current) {
      stale.current = true;
      return;
    }
    let alive = true;
    client.agents
      .ref(agentId)
      .timeline.refetch({ direction: "tail", limit: 60, projection: "projected" })
      .then((t) => {
        if (!alive) return;
        if (!t.error) setEntries(t.entries as Entry[]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agentId, status]);

  useEffect(() => {
    if (active && stale.current) {
      stale.current = false;
      reload.current();
    }
  }, [active]);

  return { entries, error };
}

function TimelineItem({ e, agentId, onParkText }: { e: Entry; agentId: string; onParkText?: (text: string) => void }) {
  const it = e.item;
  if (!it || typeof it !== "object") return null;
  switch (it.type) {
    case "user_message":
    {
      const urls: string[] = it.images?.length
        ? it.images.map((im: any) => (im.data ? `data:${im.mimeType ?? "image/png"};base64,${im.data}` : im.url)).filter(Boolean)
        : sentImagesFor(agentId, it.text);
      return (
        <div className="tl tl-user">
          {urls.length > 0 && (
            <div className="tl-images">
              {urls.map((u, i) => (
                <img key={i} src={u} alt="sent attachment" />
              ))}
            </div>
          )}
          {it.text}
          {onParkText && typeof it.text === "string" && it.text.trim() && (
            <button
              className="tl-park-btn"
              title="Park message lines in Idea Inbox (0 tokens)"
              onClick={() => onParkText(it.text)}
            >
              📥 Park in Inbox
            </button>
          )}
        </div>
      );
    }
    case "assistant_message":
      return (
        <div className="tl tl-assistant">
          {typeof it.text === "string" ? <AssistantText text={it.text} agentId={agentId} /> : it.text}
          {onParkText && typeof it.text === "string" && it.text.trim() && (
            <button
              className="tl-park-btn"
              title="Park message lines in Idea Inbox (0 tokens)"
              onClick={() => onParkText(it.text)}
            >
              📥 Park in Inbox
            </button>
          )}
        </div>
      );
    case "reasoning":
      return null;
    case "tool_call": {
      const d = it.detail ?? {};
      if (d.type === "sub_agent")
        return (
          <div className={`tl tl-sub ${it.status}`}>
            <b>◈ sub-agent</b> {d.subAgentType ? `[${d.subAgentType}] ` : ""}
            {d.description ?? ""} <span className="muted">· {it.status}</span>
          </div>
        );
      const summary =
        d.type === "shell" ? d.command : d.filePath ?? d.query ?? d.url ?? d.label ?? d.text ?? "";
      return (
        <div className={`tl tl-tool ${it.status}`}>
          <span className="tool-name">{it.name}</span> <span className="muted">{String(summary).slice(0, 160)}</span>
        </div>
      );
    }
    case "todo":
      return (
        <div className="tl tl-todo">
          {(Array.isArray(it.items) ? it.items : []).map((t: any, i: number) => (
            <div key={i}>
              {t.completed || t.status === "completed" ? "☑" : t.status === "in_progress" ? "◐" : "☐"} {t.text}
            </div>
          ))}
        </div>
      );
    case "error":
      return <div className="tl tl-error">{it.message}</div>;
    case "notification":
      return <div className={`tl tl-note ${it.level}`}>{it.message}</div>;
    default:
      return null;
  }
}

// Agent messages embed local screenshots as ![alt](file:///...). Browsers can't load file://, so route
// them through the server's allowlisted /__vibesquad/local-image proxy (works over the HTTPS/phone path).
const MD_IMAGE = /!\[([^\]]*)\]\(((?:file:\/\/|[A-Za-z]:[\\/])[^)\s]+)\)/g;

export function localImageSrc(u: string, agentId?: string): string {
  const base = `/__vibesquad/local-image?path=${encodeURIComponent(u)}`;
  return agentId ? `${base}&agentId=${encodeURIComponent(agentId)}` : base;
}

function AssistantText({ text, agentId }: { text: string; agentId?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const parts: Array<string | { alt: string; src: string }> = [];
  let last = 0;
  for (const m of text.matchAll(MD_IMAGE)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push({ alt: m[1] || "image", src: localImageSrc(m[2], agentId) });
    last = m.index + m[0].length;
  }
  if (!parts.length) return <>{text}</>;
  if (last < text.length) parts.push(text.slice(last));
  const imgs = parts.filter((p): p is { alt: string; src: string } => typeof p !== "string");
  const rest = parts.filter((p): p is string => typeof p === "string").join("").trim();
  return (
    <>
      <div className="tl-images">
        {imgs.map((im, i) => (
          <img key={i} src={im.src} alt={im.alt} className="tl-thumb" onClick={() => setOpen(im.src)} />
        ))}
      </div>
      {rest}
      {open && (
        <div className="img-lightbox" onClick={() => setOpen(null)}>
          <img src={open} alt="full size" />
        </div>
      )}
    </>
  );
}

function NeedsYouControls({ agent }: { agent: PaseoAgent }) {
  const [reason, setReason, clearReason] = useDraft(`${agent.id}:reason`);
  const [busy, setBusy] = useState(false);
  const labels = (agent.labels ?? {}) as Record<string, string>;
  const userName = useUserName();
  const needsValue = labels["needs-you"] || labels[LEGACY_NEEDS_LABEL];
  const flagged = !!needsValue && needsValue !== "cleared";
  const until = Date.parse(labels["needs-you-until"] || labels[LEGACY_NEEDS_UNTIL] || "");
  const snoozed = flagged && !Number.isNaN(until) && until > Date.now();
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      alert(`Update failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  if (flagged)
    return (
      <div className="you-bar">
        <span className="you-tag">{snoozed ? "SNOOZED" : needsYouBadge(userName)}</span>
        <span className="you-reason">
          {labels["needs-you-reason"] || labels[LEGACY_NEEDS_REASON] || needsValue}
          {snoozed && <span className="muted"> · until {new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
        </span>
        <button className="btn ok" disabled={busy} onClick={() => run(() => clearNeedsYou(agent))}>
          Clear
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => run(() => snoozeNeedsYou(agent, 30 * 60_000))}>
          Snooze 30m
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => run(() => snoozeNeedsYou(agent, 2 * 3_600_000))}>
          Snooze 2h
        </button>
      </div>
    );

  return (
    <div className="you-flag">
      <span className="muted small">+ Flag needs {userName}</span>
      <input
        value={reason}
        placeholder="reason…"
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !isImeComposing(e) && reason.trim()) {
            e.preventDefault();
            run(() => setNeedsYou(agent, reason.trim()).then(clearReason));
          }
        }}
      />
      <button
        className="btn bad"
        disabled={busy || !reason.trim()}
        onClick={() => run(() => setNeedsYou(agent, reason.trim()).then(clearReason))}
      >
        Flag
      </button>
    </div>
  );
}

const REQUEST_REPORT_PROMPT =
  "Your last turn produced no report. Reply now with your final report as a normal message (what you did, files changed, done-check result). Do not use SendMessage or ListAgents.";

function HardeningBanner(props: { tone: "warn" | "hot"; text: React.ReactNode; action: string; onAction: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className={`hard-bar ${props.tone}`}>
      <span className="hard-text">{props.text}</span>
      <button
        className="btn warn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await props.onAction();
          } catch (e) {
            alert(`${props.action} failed: ${e}`);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "…" : props.action}
      </button>
    </div>
  );
}

// A1-A5, A8, A11: Antigravity failure modes with a one-click fix each (detectors in antigravity.ts).
function HardeningBar({ agent, entries }: { agent: PaseoAgent; entries: Entry[] }) {
  useTick();
  const a = auditAntigravityAgent(agent, entries);
  const nudge = (text: string) => () => sendMessage(agent.id, text);
  return (
    <>
      {a.a1Stalled && (
        <HardeningBanner
          tone="warn"
          text={`Running >90s with no activity — Antigravity may be waiting on an unsurfaced permission (${a.a1Stalled.idleSeconds}s idle)`}
          action="Nudge"
          onAction={nudge(PROMISED_RUN_NUDGE_PROMPT)}
        />
      )}
      {a.a2PromisedIdle && (
        <HardeningBanner
          tone="warn"
          text={<>Turn ended after promising an action <span className="muted">“{a.a2PromisedIdle.excerpt}”</span></>}
          action="Nudge foreground"
          onAction={nudge(PROMISED_RUN_NUDGE_PROMPT)}
        />
      )}
      {a.a3HungTool && (
        <HardeningBanner
          tone={a.a3HungTool.severity === "critical" ? "hot" : "warn"}
          text={`Tool "${a.a3HungTool.name}" running for ${a.a3HungTool.ageSeconds}s`}
          action="Cancel & Resume"
          onAction={async () => {
            await stopAgent(agent.id);
            await sendMessage(agent.id, CANCEL_AND_RESUME_PROMPT(a.a3HungTool!.name), undefined, { activeTurnBehavior: "interrupt" });
          }}
        />
      )}
      {a.a4TransientError && (
        <HardeningBanner
          tone={a.a4TransientError.retryable ? "warn" : "hot"}
          text={`${a.a4TransientError.retryable ? "Transient error" : "Error"} (${a.a4TransientError.kind}): ${a.a4TransientError.summary}`}
          action="Retry turn"
          onAction={nudge(a.a4TransientError.retryable ? TRANSIENT_RETRY_PROMPT : "Please retry the last turn.")}
        />
      )}
      {a.a8SilentTurn && (
        <HardeningBanner tone="warn" text={`Silent turn: ${a.a8SilentTurn.reason}`} action="Request report" onAction={nudge(REQUEST_REPORT_PROMPT)} />
      )}
      {a.a11MisroutedReport && (
        <HardeningBanner tone="warn" text={a.a11MisroutedReport.excerpt} action="Request report" onAction={nudge(REQUEST_REPORT_PROMPT)} />
      )}
    </>
  );
}

// A5: copy files into <cwd>/scratch/inputs when the agent cannot read outside its workspace.
function AttachFiles({ agent, entries }: { agent: PaseoAgent; entries: Entry[] }) {
  const blocked = auditAntigravityAgent(agent, entries).a5ReadBlocked;
  const [open, setOpen] = useState(false);
  const [paths, setPaths, clearPaths] = useDraft(`${agent.id}:paths`);
  const [tell, setTell] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useDraft(`${agent.id}:msg`);
  const wasBlocked = useRef(false);
  useEffect(() => {
    if (blocked && !wasBlocked.current) {
      setOpen(true);
      if (!paths) setPaths(blocked.requestedPaths.join("\n"));
    }
    wasBlocked.current = !!blocked;
  }, [blocked]);

  const files = paths.split(/\r?\n|;/).map((p) => p.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const run = async () => {
    setBusy(true);
    setMsg("");
    try {
      const copied = await attachFiles(agent.cwd, files);
      if (tell) await sendMessage(agent.id, `I copied the file(s) into your workspace: ${copied.join(", ")}. You can read them there now.`);
      setMsg(`Copied ${copied.length} file(s) to ${scratchInputDirFor(agent.cwd)}`);
      clearPaths();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`attach-bar ${blocked ? "hot" : ""}`}>
      <button className="attach-toggle" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} Attach files to scratch/inputs
        {blocked && <span className="pill diag hot"> READ BLOCKED</span>}
      </button>
      {open && (
        <div className="attach-body">
          <textarea rows={2} value={paths} placeholder="Source file path(s), one per line" onChange={(e) => setPaths(e.target.value)} />
          <div className="attach-row">
            <label className="small muted">
              <input type="checkbox" checked={tell} onChange={(e) => setTell(e.target.checked)} /> tell the agent the copied path
            </label>
            <button className="btn warn" disabled={busy || !files.length} onClick={run}>
              {busy ? "Copying…" : "Attach"}
            </button>
          </div>
          {msg && <div className="small muted">{msg}</div>}
        </div>
      )}
    </div>
  );
}

function TitleLint({ agent }: { agent: PaseoAgent }) {
  const [busy, setBusy] = useState(false);
  const expected = agent.archivedAt ? null : expectedTitleFor(agent);
  if (!expected || expected === agent.title) return null;
  return (
    <div className="lint-bar">
      <span>
        Title mismatch · expected "<b>{expected}</b>"
      </span>
      <button
        className="btn ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await updateAgent(agent.id, { name: expected });
          } catch (e) {
            alert(`Rename failed: ${e}`);
          } finally {
            setBusy(false);
          }
        }}
      >
        Fix title
      </button>
    </div>
  );
}

async function postVsLog(payload: { team?: string; lane?: string; type: string; text: string; agent?: string; refs?: string[] }) {
  try {
    await fetch("/__vibesquad/vs-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.warn("vs-log post failed", err);
  }
}

export async function triggerBrainstormRestart(opts: {
  agent: PaseoAgent;
  teamId: string;
  laneId: string;
  reason: string;
  usedTokens: number;
  pendingPrompt?: string;
  summaryUpdate?: string;
}): Promise<{ newAgentId: string; title?: string }> {
  const { agent, teamId, laneId, reason, usedTokens, pendingPrompt, summaryUpdate } = opts;
  const pane = paneOfAgent(agent.id);
  const res = await fetch("/__vibesquad/brainstorm-restart", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentId: agent.id,
      teamId,
      laneId,
      reason,
      usedTokens,
      ...(pendingPrompt ? { pendingPrompt } : {}),
      ...(summaryUpdate ? { summaryUpdate } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !DEMO) {
    throw new Error(body.error ?? `brainstorm-restart failed (${res.status})`);
  }
  const newAgentId: string = body.newAgentId || `demo-bs-${Date.now().toString(36)}`;
  const title: string = body.title || `BRAINSTORM · ${laneId.toUpperCase()}`;
  const createdAgent: PaseoAgent =
    body.agent ??
    ({
      ...agent,
      id: newAgentId,
      title,
      status: "idle",
      updatedAt: new Date().toISOString(),
      lastUsage: { contextWindowUsedTokens: 0, inputTokens: 0 },
      labels: {
        ...((agent.labels ?? {}) as Record<string, string>),
        team: teamId,
        lane: laneId,
        role: "brainstorm",
        "vs.restarted-from": agent.id,
        "vs.restart-tokens": String(usedTokens),
        "vs.restart-reason": reason,
        "vs.mock-tokens": "",
      },
    } as unknown as PaseoAgent);
  upsertLocalAgent(createdAgent, agent.id);
  openAgentInTab(newAgentId, pane, agent.id);
  return { newAgentId, title };
}

type DrawerProps = { agent: PaseoAgent; onClose: () => void; onSuccessor?: () => void; active?: boolean };

export const AgentDrawer = memo(function AgentDrawer({ agent, onClose, onSuccessor, active = true }: DrawerProps) {
  useTeams();
  const { entries, error } = useTimeline(agent.id, agent.status, active);
  const [draft, setDraft, clearDraft] = useDraft(`${agent.id}:draft`);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryText, setSummaryText] = useState<string>("");
  const [summaryPath, setSummaryPath] = useState<string>("");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summarySaving, setSummarySaving] = useState(false);
  const [handoffMarked, setHandoffMarked] = useState(false);
  const [inboxPopoverOpen, setInboxPopoverOpen] = useState(false);
  const [inboxDumpText, setInboxDumpText] = useState("");
  const [inboxParking, setInboxParking] = useState(false);
  const [inboxToast, setInboxToast] = useState("");
  const [topicHandingOff, setTopicHandingOff] = useState(false);
  const [topicParking, setTopicParking] = useState(false);
  const feedbackKey = `vs.restart-feedback.${agent.id}`;
  const [feedbackDismissed, setFeedbackDismissed] = useState(() => localStorage.getItem(feedbackKey) === "1");
  const autoRestartFired = useRef<string | null>(null);
  const [lastSteered, setLastSteered] = useState<string | null>(null);
  const [permInputs, setPermInputs] = useState<Record<string, string>>({});

  const imgs = useImageDraft(`${agent.id}:images`);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  // Follow new entries only when the reader is already at the bottom, so a scrolled-back tab stays put.
  const pinned = useRef(true);
  const att = attentionOf(agent);
  const labels = (agent.labels ?? {}) as Record<string, string>;
  const isBs = isBrainstormAgent(agent);
  const isTopicBs = isTopicBrainstorm(agent);
  const topicName = isTopicBs ? topicOfBrainstorm(agent) : "";
  const topicCardId = labels["vs.inbox-card-id"] || "";
  const { team, laneId: resolvedLaneId } = teamForAgent(agent);
  const { warnTokens, restartTokens } = getBrainstormThresholds(team);
  const bsUsedTokens = isBs ? brainstormUsedTokens(agent) : 0;
  const used = usedTokens(agent);
  const budget = budgetFor(agent);
  const agentType = classifyAgent(agent);
  const prov = providerSpec(agent.provider);
  const teamId = labels.team || team.id || "vibesquad";
  const laneId = (labels.lane || labels.lead || resolvedLaneId || team.lanes?.[0]?.id || "vibesquad").toLowerCase();
  const restartedFrom = labels["vs.restarted-from"] || "";

  const runningSubs = entries.filter(
    (e) => e.item?.type === "tool_call" && e.item?.detail?.type === "sub_agent" && e.item?.status === "running",
  ).length;

  // Detect if the latest assistant message mentions handing off a plan.
  const lastAssistantMsg = (() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const it = entries[i]?.item;
      if (it?.type === "assistant_message" && typeof it.text === "string" && it.text.trim()) {
        return it.text;
      }
    }
    return "";
  })();
  const planHandedOff = isBs && (handoffMarked || PLAN_HANDOFF_RE.test(lastAssistantMsg));

  useEffect(() => {
    setFeedbackDismissed(localStorage.getItem(feedbackKey) === "1");
  }, [feedbackKey]);

  useEffect(() => {
    if (agent.status !== "running") setLastSteered(null);
  }, [agent.status]);

  useEffect(() => {
    const el = timeline.current;
    if (el && pinned.current && el.offsetParent) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const res = await fetch(`/__vibesquad/brainstorm-summary?lane=${encodeURIComponent(laneId)}`);
      const body = await res.json().catch(() => ({}));
      if (body.ok) {
        setSummaryText(String(body.content ?? ""));
        setSummaryPath(String(body.path ?? `docs/brainstorm/${laneId}.md`));
      }
    } catch (err) {
      console.warn("Failed to load brainstorm summary", err);
    } finally {
      setSummaryLoading(false);
    }
  }, [laneId]);

  const toggleSummary = () => {
    const next = !summaryOpen;
    setSummaryOpen(next);
    if (next) void loadSummary();
  };

  const saveSummary = async () => {
    setSummarySaving(true);
    try {
      const res = await fetch("/__vibesquad/brainstorm-summary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ laneId, content: summaryText }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Save failed (${res.status})`);
    } catch (err) {
      alert(`Summary save failed: ${err}`);
    } finally {
      setSummarySaving(false);
    }
  };

  const doRestart = useCallback(
    async (reason: string, pendingPrompt?: string) => {
      if (restarting) return;
      setRestarting(true);
      try {
        await triggerBrainstormRestart({
          agent,
          teamId,
          laneId,
          reason,
          usedTokens: bsUsedTokens,
          pendingPrompt,
        });
        if (pendingPrompt !== undefined) clearDraft();
      } catch (err) {
        alert(`Brainstorm restart failed: ${err}`);
      } finally {
        setRestarting(false);
      }
    },
    [agent, bsUsedTokens, clearDraft, laneId, restarting, teamId],
  );

  // Auto-restart without asking when an idle brainstorm crosses >= restartTokens (150k).
  useEffect(() => {
    if (!isBs || agent.archivedAt || agent.status === "running") return;
    if (bsUsedTokens >= restartTokens && autoRestartFired.current !== agent.id) {
      autoRestartFired.current = agent.id;
      void doRestart("auto-150k", draft.trim() ? draft : undefined);
    }
  }, [isBs, agent.id, agent.archivedAt, agent.status, bsUsedTokens, restartTokens, draft, doRestart]);

  const sendWithBehavior = async (behavior: ActiveTurnBehavior) => {
    if (!draft.trim() && !imgs.images.length) return;
    const text = draft.trim() ? draft : "(image)";

    // BF-P1: Auto-restart without asking at >= restartTokens (150k) or when next turn would push it past 150k.
    if (isBs && (bsUsedTokens >= restartTokens || bsUsedTokens + Math.ceil(draft.length / 3) >= restartTokens)) {
      autoRestartFired.current = agent.id;
      await doRestart("auto-150k", text);
      return;
    }

    setBusy(true);
    try {
      if (imgs.images.length) {
        await sendMessage(agent.id, text, await blobsToPaseoImages(imgs.images), { activeTurnBehavior: behavior });
        rememberSent(agent.id, text, imgs.images);
        imgs.clear();
      } else {
        await sendMessage(agent.id, draft, undefined, { activeTurnBehavior: behavior });
      }
      if (agent.status === "running" && behavior === "steer") setLastSteered(text);
      clearDraft();
    } catch (e) {
      alert(`Send failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const send = () => sendWithBehavior("steer");
  const sendInterrupt = () => sendWithBehavior("interrupt");

  const onFeedback = async (verdict: "good" | "lost") => {
    localStorage.setItem(feedbackKey, "1");
    setFeedbackDismissed(true);
    await postVsLog({
      team: teamId,
      lane: laneId,
      type: "metric",
      agent: agent.id,
      text: `restart-feedback: ${verdict} (from ${restartedFrom} -> ${agent.id})`,
      refs: [restartedFrom, agent.id].filter(Boolean),
    });
  };

  const parkToInbox = useCallback(
    async (rawText: string, fromComposer = false) => {
      const cleaned = rawText.trim();
      if (!cleaned || inboxParking) return;
      setInboxParking(true);
      try {
        const res = await parkIdeasInInbox({
          text: cleaned,
          splitDump: true,
          defaultLaneId: laneId,
          teamId,
          source: "brainstorm-dump",
        });
        setInboxToast(res.summary);
        if (fromComposer) clearDraft();
        else {
          setInboxDumpText("");
          setInboxPopoverOpen(false);
        }
        setTimeout(() => setInboxToast(""), 4500);
      } catch (err) {
        alert(`Park in Inbox failed: ${err}`);
      } finally {
        setInboxParking(false);
      }
    },
    [clearDraft, inboxParking, laneId, teamId],
  );

  const handleTopicHandoff = useCallback(async () => {
    if (topicHandingOff) return;
    setTopicHandingOff(true);
    try {
      const planNote = lastAssistantMsg ? lastAssistantMsg.slice(0, 240) : `Topic ${topicName} plan handed off to lead`;
      await handoffTopicBrainstormClient({
        cardId: topicCardId || undefined,
        agentId: agent.id,
        planNote,
        summaryUpdate: summaryOpen && summaryText.trim() ? summaryText : undefined,
        usedTokens: bsUsedTokens,
      });
    } catch (err) {
      alert(`Topic handoff failed: ${err}`);
    } finally {
      setTopicHandingOff(false);
    }
  }, [agent.id, bsUsedTokens, lastAssistantMsg, summaryOpen, summaryText, topicCardId, topicHandingOff, topicName]);

  const handleTopicPark = useCallback(async () => {
    if (topicParking) return;
    setTopicParking(true);
    try {
      const summaryNote =
        (lastAssistantMsg && lastAssistantMsg.slice(0, 240)) ||
        (draft.trim() && draft.trim().slice(0, 240)) ||
        `Parked topic summary: ${topicName}`;
      await parkTopicBrainstormClient({
        cardId: topicCardId || undefined,
        agentId: agent.id,
        summaryNote,
      });
    } catch (err) {
      alert(`Park topic failed: ${err}`);
    } finally {
      setTopicParking(false);
    }
  }, [agent.id, draft, lastAssistantMsg, topicCardId, topicName, topicParking]);

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length) {
      e.preventDefault();
      imgs.add(files);
    }
  };

  const respond = (
    requestId: string,
    allow: boolean,
    extra?: { selectedActionId?: string; updatedInput?: Record<string, unknown> },
  ) =>
    client.agents
      .ref(agent.id)
      .respondToPermission({ requestId, response: allow ? { behavior: "allow", ...extra } : { behavior: "deny" } })
      .catch((e) => alert(`Permission reply failed: ${e}`));

  const usedK = Math.round(bsUsedTokens / 1000);
  const warnK = Math.round(warnTokens / 1000);
  const restartK = Math.round(restartTokens / 1000);
  const bsPct = Math.min(100, Math.max(0, (bsUsedTokens / Math.max(1, restartTokens)) * 100));
  const warnPct = Math.min(100, Math.max(0, (warnTokens / Math.max(1, restartTokens)) * 100));
  const bsTone = bsUsedTokens >= restartTokens ? "red" : bsUsedTokens >= warnTokens ? "amber" : "ok";

  return (
    <aside className="drawer">
      <header className="drawer-head">
        <Avatar id={agent.id} provider={agent.provider} agentType={agentType} variant={leadVariant(agent)} size={56} />
        <div className="drawer-id">
          <div className="drawer-role-line">
            <span className="role-tag">{AGENT_TYPE_LABEL[agentType]}</span>
            <span className="prov-pill" style={{ color: prov.color, borderColor: prov.color }}>
              {prov.symbol} {prov.name}
            </span>
          </div>
          <div className="drawer-title">
            <StatusDot agent={agent} /> {agent.title ?? agent.id.slice(0, 8)}
          </div>
          <div className="muted small">
            {agent.provider}/{agent.model ?? "?"} · {shortPath(agent.cwd)} · updated {ago(agent.updatedAt)}
            {runningSubs ? ` · ${runningSubs} sub-agent(s) running` : ""}
          </div>
          <TokenMeter used={used} budget={budget} ladder={kindOf(agent) === "lead" ? leadLadderFor(team) : undefined} />
        </div>
        <div className="drawer-actions">
          <AgentActions agent={agent} archive />
          {SERVER_ID && (
            <a className="btn" href={buildAgentDeepLink({ serverId: SERVER_ID, agentId: agent.id })}>
              Open in Paseo
            </a>
          )}
          <button className="btn ghost" onClick={onClose}>
            ✕
          </button>
        </div>
      </header>

      {isBs && (
        <div className={`brainstorm-ctx-bar tone-${bsTone}`} data-testid="brainstorm-ctx-bar">
          {isTopicBs && (
            <div className="brainstorm-topic-row">
              <span className="brainstorm-topic-badge" data-testid="brainstorm-topic-badge">
                📌 Topic: {topicName}
                {topicCardId ? ` (Card #${topicCardId})` : ""}
              </span>
              <div className="brainstorm-topic-actions">
                <button
                  className="btn small ok btn-topic-handoff"
                  data-testid="btn-topic-handoff"
                  disabled={topicHandingOff}
                  onClick={() => void handleTopicHandoff()}
                  title="Mark card handed-off, log handoff metric, and archive/close this topic brainstorm"
                >
                  {topicHandingOff ? "Handing off…" : "✓ Hand off plan & close topic"}
                </button>
                <button
                  className="btn ghost small btn-topic-park"
                  data-testid="btn-topic-park"
                  disabled={topicParking}
                  onClick={() => void handleTopicPark()}
                  title="Save current summary onto the Inbox card and archive this topic chat"
                >
                  {topicParking ? "Parking…" : "📥 Park to card"}
                </button>
              </div>
            </div>
          )}
          <TopicCapBanner minCount={isTopicBs ? TOPIC_SOFT_CAP : TOPIC_SOFT_CAP + 1} />
          <div className="brainstorm-ctx-main">
            <span className="brainstorm-ctx-readout">
              {usedK}k / {restartK}k tok
            </span>
            <div className="brainstorm-ctx-track" title={`Warn at ${warnK}k · Auto-restart at ${restartK}k`}>
              <div className={`brainstorm-ctx-fill tone-${bsTone}`} style={{ width: `${bsPct}%` }} />
              <div
                className="brainstorm-ctx-marker"
                style={{ left: `${warnPct}%` }}
                title={`Warn threshold: ${warnK}k tok`}
              />
            </div>
            <div className="brainstorm-ctx-actions">
              <button
                className="btn small btn-brainstorm-restart"
                disabled={restarting}
                onClick={() => void doRestart(planHandedOff ? "handoff" : bsUsedTokens >= warnTokens ? "warn-80k" : "manual")}
                title="Spawn a fresh brainstorm seeded from docs/brainstorm/<lane>.md and archive this one"
              >
                {restarting ? "↻ Restarting…" : "↻ Restart from summary"}
              </button>
              <button
                className="btn ghost small btn-brainstorm-summary"
                onClick={toggleSummary}
                title={`Preview docs/brainstorm/${laneId}.md`}
              >
                📄 Summary
              </button>
              <button
                className={`btn ghost small btn-brainstorm-handoff ${handoffMarked ? "on" : ""}`}
                onClick={() => setHandoffMarked(true)}
                title="Mark plan handed off to lead"
              >
                ✓ Plan handed off
              </button>
              <button
                className={`btn ghost small btn-brainstorm-inbox ${inboxPopoverOpen ? "on" : ""}`}
                onClick={() => setInboxPopoverOpen((v) => !v)}
                title="Dump 1 or multiple newline-separated ideas straight into the Idea Inbox (0 tokens)"
                data-testid="brainstorm-park-inbox-btn"
              >
                📥 Park in Inbox
              </button>
            </div>
          </div>

          {inboxPopoverOpen && (
            <div className="brainstorm-inbox-popover" data-testid="brainstorm-inbox-popover">
              <div className="brainstorm-summary-head">
                <span className="muted small">Dump 1 or multiple newline-separated ideas → Idea Inbox (0 tokens at rest)</span>
                <button
                  className="btn small ok"
                  disabled={inboxParking || !inboxDumpText.trim()}
                  onClick={() => void parkToInbox(inboxDumpText, false)}
                >
                  {inboxParking ? "Parking…" : "📥 Park in Inbox"}
                </button>
              </div>
              <textarea
                rows={3}
                value={inboxDumpText}
                onChange={(e) => setInboxDumpText(e.target.value)}
                placeholder="One idea per line (Enter to park · Shift+Enter for newline · Cheap Sorter tags lane + scope and checks 'goes with card X')…"
                onKeyDown={(e) => {
                  if (shouldComposerSubmit(e) && inboxDumpText.trim()) {
                    e.preventDefault();
                    void parkToInbox(inboxDumpText, false);
                  }
                }}
              />
            </div>
          )}

          {inboxToast && (
            <div className="brainstorm-inbox-toast" role="status" data-testid="brainstorm-inbox-toast">
              <span>📥 {inboxToast}</span>
            </div>
          )}

          {summaryOpen && (
            <div className="brainstorm-summary-preview">
              <div className="brainstorm-summary-head">
                <code>{summaryPath || `docs/brainstorm/${laneId}.md`}</code>
                <span className="muted small">{summaryText.length} / 20000 chars (~5k tok cap)</span>
                <button className="btn small ok" disabled={summarySaving || summaryLoading} onClick={saveSummary}>
                  {summarySaving ? "Saving…" : "Save summary"}
                </button>
              </div>
              {summaryLoading ? (
                <div className="muted small">Loading summary…</div>
              ) : (
                <textarea
                  rows={6}
                  value={summaryText}
                  onChange={(e) => setSummaryText(e.target.value)}
                  placeholder="# Brainstorm Summary (Decided / Open / In flight)"
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.code === "Enter" || e.code === "NumpadEnter") && !isImeComposing(e) && (e.ctrlKey || e.metaKey) && !summarySaving && !summaryLoading) {
                      e.preventDefault();
                      void saveSummary();
                    }
                  }}
                />
              )}
            </div>
          )}

          {bsUsedTokens >= warnTokens && (
            <div className="brainstorm-warn-banner" role="status">
              <span>Getting heavy (≥{warnK}k) — restart from summary?</span>
              <button
                className="btn warn small btn-brainstorm-restart"
                disabled={restarting}
                onClick={() => void doRestart("warn-80k")}
              >
                {restarting ? "↻ Restarting…" : "↻ Restart from summary"}
              </button>
            </div>
          )}

          {planHandedOff && (
            <div className="brainstorm-handoff-banner" role="status">
              <span>Plan handed to lead — restart from summary?</span>
              <button
                className="btn ok small btn-brainstorm-restart"
                disabled={restarting}
                onClick={() => void doRestart("handoff")}
              >
                {restarting ? "↻ Restarting…" : "↻ Restart from summary"}
              </button>
            </div>
          )}
        </div>
      )}

      {restartedFrom && !feedbackDismissed && (
        <div className="brainstorm-feedback-bar" role="status">
          <span>
            Fresh start from <code>docs/brainstorm/{laneId}.md</code> · Did the restart lose something?
          </span>
          <div className="brainstorm-feedback-actions">
            <button className="btn ok small" onClick={() => void onFeedback("good")}>
              👍 Nothing lost
            </button>
            <button className="btn warn small" onClick={() => void onFeedback("lost")}>
              ⚠ Lost context
            </button>
          </div>
        </div>
      )}

      {att && att.tone !== "needs-you" && <div className={`banner ${att.tone}`}>{att.reason}</div>}
      <NeedsYouControls agent={agent} />
      <TitleLint agent={agent} />
      {kindOf(agent) === "lead" && onSuccessor && !agent.archivedAt && (
        <div className="lint-bar successor-bar">
          <span>Lead handoff</span>
          <button className="btn hot" onClick={onSuccessor}>
            Initiate Handoff / Spawn Successor
          </button>
        </div>
      )}
      {active && <HardeningBar agent={agent} entries={entries} />}
      <AttachFiles agent={agent} entries={entries} />

      {agent.pendingPermissions?.map((p) => {
        const inputObj = (p.input ?? {}) as Record<string, unknown>;
        const questions = Array.isArray(inputObj.questions)
          ? (inputObj.questions as Array<{
              question?: string;
              header?: string;
              options?: Array<{ label: string; description?: string }>;
            }>)
          : [];
        const planText = typeof inputObj.plan === "string" ? inputObj.plan : undefined;
        const submitQuestionAnswer = (ans: string, qText?: string) => {
          const firstQ = qText ?? questions[0]?.question;
          const updatedInput: Record<string, unknown> = {
            ...inputObj,
            answer: ans,
            ...(firstQ ? { answers: { ...((inputObj.answers as Record<string, string>) ?? {}), [firstQ]: ans } } : {}),
          };
          void respond(p.id, true, { updatedInput });
        };

        return (
          <div key={p.id} className="perm NeedsYouHighlight" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <div>
              <b>{p.title ?? p.name}</b>
              {p.description && <div className="muted small">{p.description}</div>}
              {p.kind === "plan" && planText && (
                <pre className="perm-plan-body" style={{ maxHeight: 180, overflowY: "auto", margin: "6px 0", padding: 8, background: "#090a16", border: "1px solid var(--line)", whiteSpace: "pre-wrap", fontSize: 11 }}>
                  {planText}
                </pre>
              )}
              {p.kind === "question" &&
                questions.map((q, qi) => (
                  <div key={qi} className="perm-question-item" style={{ marginTop: 6 }}>
                    {q.question && <div className="small" style={{ marginBottom: 4 }}>{q.question}</div>}
                    {Array.isArray(q.options) && q.options.length > 0 && (
                      <div className="perm-question-options" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 4 }}>
                        {q.options.map((opt) => (
                          <button
                            key={opt.label}
                            className="btn ok small"
                            title={opt.description}
                            onClick={() => submitQuestionAnswer(opt.label, q.question)}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
            </div>
            {p.kind === "question" ? (
              <div className="perm-actions perm-question" style={{ flexWrap: "wrap" }}>
                {p.actions?.map((a) => (
                  <button
                    key={a.id}
                    className={`btn ${a.variant === "danger" ? "bad" : a.behavior === "deny" ? "bad" : "ok"}`}
                    onClick={() => respond(p.id, a.behavior === "allow", { selectedActionId: a.id })}
                  >
                    {a.label}
                  </button>
                ))}
                <input
                  className="perm-text-input"
                  type="text"
                  placeholder="Your answer…"
                  value={permInputs[p.id] ?? ""}
                  onChange={(e) => setPermInputs((prev) => ({ ...prev, [p.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isImeComposing(e)) {
                      e.preventDefault();
                      submitQuestionAnswer(permInputs[p.id] ?? "");
                    }
                  }}
                />
                <button className="btn ok" onClick={() => submitQuestionAnswer(permInputs[p.id] ?? "")}>
                  Submit
                </button>
                <button className="btn bad" onClick={() => void respond(p.id, false)}>Deny</button>
              </div>
            ) : p.kind === "plan" ? (
              <div className="perm-actions perm-plan" style={{ flexWrap: "wrap" }}>
                {p.actions?.length ? (
                  p.actions.map((a) => (
                    <button
                      key={a.id}
                      className={`btn ${a.variant === "danger" ? "bad" : a.intent === "implement" || a.intent === "implement_resume" ? "ok" : "ghost"}`}
                      onClick={() => void respond(p.id, a.behavior === "allow", { selectedActionId: a.id })}
                    >
                      {a.label}
                    </button>
                  ))
                ) : (
                  <button className="btn ok" onClick={() => void respond(p.id, true)}>Approve</button>
                )}
                <button className="btn bad" onClick={() => void respond(p.id, false)}>Deny</button>
              </div>
            ) : (
              <div className="perm-actions" style={{ flexWrap: "wrap" }}>
                {p.actions?.map((a) => (
                  <button
                    key={a.id}
                    className={`btn ${a.variant === "danger" ? "bad" : a.behavior === "deny" ? "bad" : "ok"}`}
                    onClick={() => void respond(p.id, a.behavior === "allow", { selectedActionId: a.id })}
                  >
                    {a.label}
                  </button>
                ))}
                {!p.actions?.length && (
                  <>
                    <button className="btn ok" onClick={() => void respond(p.id, true)}>Allow</button>
                    <button className="btn bad" onClick={() => void respond(p.id, false)}>Deny</button>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}

      <div className="labels">
        {Object.entries(labels)
          .filter(([k]) => !k.startsWith("paseo.open-agent-tab"))
          .map(([k, v]) => (
            <span key={k} className="chip">
              {k}={v}
            </span>
          ))}
      </div>

      <div
        className="timeline"
        ref={timeline}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {error && <div className="tl tl-error">{error}</div>}
        {entries.map((e, i) => (
          <TimelineItem key={e.seqStart ?? i} e={e} agentId={agent.id} onParkText={(txt) => void parkToInbox(txt, false)} />
        ))}
        <div ref={bottom} />
      </div>

      {!isBs && inboxToast && (
        <div className="brainstorm-inbox-toast" role="status" data-testid="brainstorm-inbox-toast">
          <span>📥 {inboxToast}</span>
        </div>
      )}

      <footer
        className={`composer ${dragOver ? "drag-over composer-drop-active" : ""}`}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          imgs.add(Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/")));
        }}
      >
        {imgs.images.length > 0 && (
          <div className="composer-images composer-thumbs">
            {imgs.images.map((im) => (
              <div key={im.id} className="composer-thumb" title={im.name}>
                <img src={im.url} alt={im.name} />
                <span className="thumb-name">{im.name}</span>
                <button className="thumb-x composer-thumb-remove" aria-label={`Remove ${im.name}`} onClick={() => imgs.remove(im.id)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {lastSteered && (
          <div className="chip steered-chip" data-testid="steered-chip">steered</div>
        )}
        <div className="composer-row">
          <textarea
            value={draft}
            placeholder={`Message ${agent.title ?? "agent"}… (Enter to send, Ctrl+Enter to interrupt)`}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !isImeComposing(e)) {
                e.preventDefault();
                void sendInterrupt();
                return;
              }
              if (shouldComposerSubmit(e)) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              imgs.add(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <button className="btn ghost attach-img composer-attach composer-attach-btn" title="Attach image" onClick={() => fileInput.current?.click()}>
            📎
          </button>
          {isBs && (
            <button
              className="btn ghost composer-park-inbox-btn"
              disabled={inboxParking}
              title="Park composer draft (1 or multiple newline-separated ideas) straight into Idea Inbox (0 tokens)"
              onClick={() => (draft.trim() ? void parkToInbox(draft, true) : setInboxPopoverOpen(true))}
              data-testid="composer-park-inbox-btn"
            >
              📥 Park in Inbox
            </button>
          )}
          <button className="btn" disabled={busy || (!draft.trim() && !imgs.images.length)} onClick={send}>
            Send
          </button>
          {agent.status === "running" && (
            <button
              className="btn warn composer-interrupt-btn"
              disabled={busy || (!draft.trim() && !imgs.images.length)}
              title="Interrupt current turn and send (Ctrl+Enter)"
              data-testid="composer-interrupt-btn"
              onClick={() => void sendInterrupt()}
            >
              ⚡ Interrupt &amp; send
            </button>
          )}
        </div>
      </footer>
    </aside>
  );
});
