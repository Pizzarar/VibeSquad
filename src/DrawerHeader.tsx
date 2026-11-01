import { useEffect, useRef, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { buildAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
import {
  attachFiles,
  clearNeedsYou,
  SERVER_ID,
  sendMessage,
  setNeedsYou,
  snoozeNeedsYou,
  stopAgent,
  updateAgent,
} from "./paseo";
import {
  auditAntigravityAgent,
  CANCEL_AND_RESUME_PROMPT,
  PROMISED_RUN_NUDGE_PROMPT,
  scratchInputDirFor,
  TRANSIENT_RETRY_PROMPT,
} from "./antigravity";
import { useDraft } from "./drafts";
import { isImeComposing, shouldComposerSubmit, TOPIC_SOFT_CAP, TopicCapBanner } from "./IdeaInbox";
import { Avatar, TokenMeter, providerSpec } from "./pixel";
import { AgentActions, StatusDot, ago, shortPath, useTick } from "./ui";
import { LEGACY_NEEDS_LABEL, LEGACY_NEEDS_REASON, LEGACY_NEEDS_UNTIL, needsYouBadge, useUserName } from "./userName";
import { AGENT_TYPE_LABEL, expectedTitleFor, kindOf, leadLadderFor, leadVariant } from "./teams";
import type { AgentType } from "./teams";
import type { Entry } from "./Timeline";
import { openBriefEditor } from "./pinActions";

const REQUEST_REPORT_PROMPT =
  "Your last turn produced no report. Reply now with your final report as a normal message (what you did, files changed, done-check result). Do not use SendMessage or ListAgents.";

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
          {snoozed && (
            <span className="muted">
              {" "}
              · until {new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
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

function HardeningBanner(props: {
  tone: "warn" | "hot";
  text: React.ReactNode;
  action: string;
  onAction: () => Promise<void>;
}) {
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
          text={
            <>
              Turn ended after promising an action{" "}
              <span className="muted">"{a.a2PromisedIdle.excerpt}"</span>
            </>
          }
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
            await sendMessage(agent.id, CANCEL_AND_RESUME_PROMPT(a.a3HungTool!.name), undefined, {
              activeTurnBehavior: "interrupt",
            });
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
        <HardeningBanner
          tone="warn"
          text={`Silent turn: ${a.a8SilentTurn.reason}`}
          action="Request report"
          onAction={nudge(REQUEST_REPORT_PROMPT)}
        />
      )}
      {a.a11MisroutedReport && (
        <HardeningBanner
          tone="warn"
          text={a.a11MisroutedReport.excerpt}
          action="Request report"
          onAction={nudge(REQUEST_REPORT_PROMPT)}
        />
      )}
    </>
  );
}

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

  const files = paths
    .split(/\r?\n|;/)
    .map((p) => p.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const run = async () => {
    setBusy(true);
    setMsg("");
    try {
      const copied = await attachFiles(agent.cwd, files);
      if (tell)
        await sendMessage(
          agent.id,
          `I copied the file(s) into your workspace: ${copied.join(", ")}. You can read them there now.`,
        );
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
          <textarea
            rows={2}
            value={paths}
            placeholder="Source file path(s), one per line"
            onChange={(e) => setPaths(e.target.value)}
          />
          <div className="attach-row">
            <label className="small muted">
              <input type="checkbox" checked={tell} onChange={(e) => setTell(e.target.checked)} /> tell the agent the
              copied path
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

export type DrawerHeaderProps = {
  agent: PaseoAgent;
  agentType: AgentType;
  prov: ReturnType<typeof providerSpec>;
  used: number;
  budget: number | undefined;
  team: any;
  runningSubs: number;
  laneId: string;
  entries: Entry[];
  active: boolean;
  onClose: () => void;
  onSuccessor?: () => void;
  isBs: boolean;
  isTopicBs: boolean;
  topicName: string;
  topicCardId: string;
  bsUsedTokens: number;
  warnTokens: number;
  restartTokens: number;
  bsTone: string;
  bsPct: number;
  warnPct: number;
  usedK: number;
  warnK: number;
  restartK: number;
  restarting: boolean;
  planHandedOff: boolean;
  doRestart: (reason: string, pendingPrompt?: string) => Promise<unknown>;
  summaryOpen: boolean;
  toggleSummary: () => void;
  summaryText: string;
  setSummaryText: (v: string) => void;
  summaryPath: string;
  summaryLoading: boolean;
  summarySaving: boolean;
  saveSummary: () => Promise<void>;
  inboxPopoverOpen: boolean;
  setInboxPopoverOpen: React.Dispatch<React.SetStateAction<boolean>>;
  inboxDumpText: string;
  setInboxDumpText: (v: string) => void;
  inboxParking: boolean;
  inboxToast: string;
  parkToInbox: (text: string, fromComposer: boolean) => void;
  handoffMarked: boolean;
  setHandoffMarked: (v: boolean) => void;
  topicHandingOff: boolean;
  handleTopicHandoff: () => Promise<void>;
  topicParking: boolean;
  handleTopicPark: () => Promise<void>;
  restartedFrom: string;
  feedbackDismissed: boolean;
  onFeedback: (verdict: "good" | "lost") => Promise<void>;
  att: { tone: string; reason: string } | null;
  dockOpen: boolean;
  onToggleDock: () => void;
};

export function DrawerHeader({
  agent,
  agentType,
  prov,
  used,
  budget,
  team,
  runningSubs,
  laneId,
  entries,
  active,
  onClose,
  onSuccessor,
  isBs,
  isTopicBs,
  topicName,
  topicCardId,
  bsUsedTokens,
  warnTokens,
  restartTokens,
  bsTone,
  bsPct,
  warnPct,
  usedK,
  warnK,
  restartK,
  restarting,
  planHandedOff,
  doRestart,
  summaryOpen,
  toggleSummary,
  summaryText,
  setSummaryText,
  summaryPath,
  summaryLoading,
  summarySaving,
  saveSummary,
  inboxPopoverOpen,
  setInboxPopoverOpen,
  inboxDumpText,
  setInboxDumpText,
  inboxParking,
  inboxToast,
  parkToInbox,
  handoffMarked,
  setHandoffMarked,
  topicHandingOff,
  handleTopicHandoff,
  topicParking,
  handleTopicPark,
  restartedFrom,
  feedbackDismissed,
  onFeedback,
  att,
  dockOpen,
  onToggleDock,
}: DrawerHeaderProps) {
  return (
    <>
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
          <TokenMeter used={used} budget={budget ?? 0} ladder={kindOf(agent) === "lead" ? leadLadderFor(team) : undefined} />
        </div>
        <div className="drawer-actions">
          <AgentActions agent={agent} archive />
          <button
            className={`btn ghost dock-toggle-btn${dockOpen ? " on" : ""}`}
            title={dockOpen ? "Close side dock" : "Open: Changes / Files / Terminal / Scripts"}
            onClick={onToggleDock}
          >
            Dock {dockOpen ? "▶" : "◀"}
          </button>
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
                onClick={() =>
                  void doRestart(planHandedOff ? "handoff" : bsUsedTokens >= warnTokens ? "warn-80k" : "manual")
                }
                title="Spawn a fresh brainstorm seeded from docs/brainstorm/<team>.md and archive this one"
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
                <span className="muted small">
                  Dump 1 or multiple newline-separated ideas → Idea Inbox (0 tokens at rest)
                </span>
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
                placeholder="One idea per line (Enter to park · Shift+Enter for newline · Cheap Sorter tags team + scope and checks 'goes with card X')…"
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
                <button
                  className="btn small ok"
                  disabled={summarySaving || summaryLoading}
                  onClick={saveSummary}
                >
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
                    if (
                      (e.key === "Enter" || e.code === "Enter" || e.code === "NumpadEnter") &&
                      !isImeComposing(e) &&
                      (e.ctrlKey || e.metaKey) &&
                      !summarySaving &&
                      !summaryLoading
                    ) {
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

      {agent.labels?.["vs.fresh-session"] === "brief" && (
        <div className="brainstorm-fresh-divider" role="separator">
          ── Fresh session · from brief
          <button className="btn ghost small" aria-label="Edit brief" onClick={() => openBriefEditor({ laneId })}>
            ⋯
          </button>
          ──
        </div>
      )}
      {restartedFrom && !feedbackDismissed && agent.labels?.["vs.fresh-session"] !== "brief" && (
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
    </>
  );
}
