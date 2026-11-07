import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PaseoAgent } from "./agentTypes";
import { attachFiles, clearNeedsYou, markAgentRead, markAgentUnread, sendMessage, setNeedsYou, snoozeNeedsYou, stopAgent, updateAgent, upsertLocalAgent } from "./paseo";
import { DEMO } from "./demoFlag";
import { isLocallyHidden, isMarkedUnread } from "./attentionLocal";
import { listProviderModels } from "./paseoProviders";
import { runnerReloadTimeline, runnerResume, runnerSetConfig, runnerSpawn, runnerUnarchive } from "./runnerBridge";
import {
  auditAntigravityAgent,
  CANCEL_AND_RESUME_PROMPT,
  PROMISED_RUN_NUDGE_PROMPT,
  scratchInputDirFor,
  TRANSIENT_RETRY_PROMPT,
} from "./antigravity";
import { useDraft } from "./drafts";
import { AgentTitleEdit } from "./QuickWinsUi";
import { isImeComposing, shouldComposerSubmit, TOPIC_SOFT_CAP, TopicCapBanner } from "./IdeaInbox";
import { Avatar, TokenMeter, providerSpec } from "./pixel";
import { AgentActions, StatusDot, ago, shortPath, useTick } from "./ui";
import { LEGACY_NEEDS_LABEL, LEGACY_NEEDS_REASON, LEGACY_NEEDS_UNTIL, needsYouBadge, useUserName } from "./userName";
import { AGENT_TYPE_LABEL, kindOf, leadLadderFor, leadVariant } from "./teams";
import type { AgentType, Member } from "./teams";
import type { Entry } from "./Timeline";
import { openAgent, openAgentInTab, usePanes } from "./panes";
import { exportFileName, forkSummaryPrompt, forkTitle, transcriptToJson, transcriptToMarkdown } from "./sessionLifecycle";
import { openBriefEditor, setLastBrainstormProfile } from "./pinActions";
import { useInFocusedLane, usePinFocus } from "./pinFocus";
import { WorkingChip } from "./WorkingBar";
import { usePinSlot, useRailCardVisible } from "./pinSlots";
import { FeaturesMenu } from "./FeaturesMenu";
import { SandboxView } from "./SandboxView";

const REQUEST_REPORT_PROMPT =
  "Your last turn produced no report. Reply now with your final report as a normal message (what you did, files changed, done-check result). Do not use SendMessage or ListAgents.";

function NeedsYouControls({ agent }: { agent: PaseoAgent }) {
  const [reason, setReason, clearReason] = useDraft(`${agent.id}:reason`);
  const [busy, setBusy] = useState(false);
  const labels = (agent.labels ?? {}) as Record<string, string>;
  const userName = useUserName();
  const needsValue = labels["needs-you"] || labels[LEGACY_NEEDS_LABEL];
  const unread = isMarkedUnread(agent.id);
  const hasNeedsLabel = !!needsValue && needsValue !== "cleared";
  const flagged = hasNeedsLabel || unread;
  const until = Date.parse(labels["needs-you-until"] || labels[LEGACY_NEEDS_UNTIL] || "");
  const snoozed = hasNeedsLabel && !Number.isNaN(until) && until > Date.now();
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
        <span className="you-tag">{snoozed ? "SNOOZED" : unread && !hasNeedsLabel ? "UNREAD" : needsYouBadge(userName)}</span>
        <span className="you-reason">
          {labels["needs-you-reason"] || labels[LEGACY_NEEDS_REASON] || (hasNeedsLabel ? needsValue : "marked unread")}
          {snoozed && (
            <span className="muted">
              {" "}
              · until {new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </span>
        <button className="btn ok" disabled={busy} onClick={() => run(() => markAgentRead(agent))}>
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

export const FALLBACK_MODES = [
  { id: "default", label: "Default" },
  { id: "plan", label: "Plan" },
  { id: "acceptEdits", label: "Accept Edits" },
  { id: "auto", label: "Auto" },
  { id: "bypassPermissions", label: "Bypass Perms" },
];

// Runner agents carry their provider's real modes (toAgent.availableModes); the Claude-flavoured FALLBACK_MODES are only for DEMO
// and for a staged provider switch (the target is not running yet). A live agent with none known yet offers no mode picker.
export function modesFor(agent: { availableModes?: ReadonlyArray<{ id: string }> | null }, useFallback: boolean) {
  return useFallback ? FALLBACK_MODES : ((agent.availableModes ?? []) as Array<{ id: string; label?: string }>);
}

/** Thinking levels the agent's provider accepts (toAgent.thinkingOptions); empty = no thinking picker. */
export function thinkingLevelsFor(agent: { thinkingOptions?: ReadonlyArray<{ id: string }> | null }, useFallback: boolean): string[] {
  return useFallback ? ["low", "medium", "high"] : (agent.thinkingOptions ?? []).map((o) => o.id);
}

export function nextModeInCycle(modes: Array<{ id: string }>, currentId: string | null): string {
  if (!modes.length) return "default";
  const idx = modes.findIndex((m) => m.id === currentId);
  return modes[(idx + 1) % modes.length].id;
}

export function formatCostUsd(usd: number): string {
  if (usd < 0.001) return `$${usd.toFixed(4)}`;
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

// Live model / mode / thinking change on a runner agent: stored as a meta patch the NEXT turn's process reads.
// `busy` = a turn is running now and keeps its old settings; the header says so (CONFIG_NEXT_TURN).
export const CONFIG_NEXT_TURN = "Applies from the next turn.";
export const configNote = (r: { busy: boolean } | void): string => (r && r.busy ? CONFIG_NEXT_TURN : "");

export async function setModeHelper(agent: PaseoAgent, modeId: string): Promise<{ busy: boolean } | void> {
  if (DEMO) { upsertLocalAgent({ ...agent, currentModeId: modeId }); return; }
  return runnerSetConfig(agent.id, { modeId });
}

export async function setModelHelper(agent: PaseoAgent, modelId: string): Promise<{ busy: boolean } | void> {
  if (DEMO) { upsertLocalAgent({ ...agent, model: modelId }); return; }
  return runnerSetConfig(agent.id, { model: modelId });
}

export async function setThinkingHelper(agent: PaseoAgent, optionId: string | null): Promise<{ busy: boolean } | void> {
  if (DEMO) { upsertLocalAgent({ ...agent, thinkingOptionId: optionId }); return; }
  return runnerSetConfig(agent.id, { thinkingOptionId: optionId });
}

export const PROVIDER_MODEL_HINTS: Record<string, string[]> = {
  claude: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-sonnet-4-6", "claude-haiku-5-5", "claude-haiku-4-5"],
  "antigravity-cli": ["gemini-4-argon", "gemini-3.8-flash", "gemini-2.5-pro", "gemini-2.5-flash"],
  antigravity: ["gemini-4-argon", "gemini-3.8-flash", "gemini-2.5-pro", "gemini-2.5-flash"],
  gemini: ["gemini-4-argon", "gemini-3.8-flash", "gemini-2.5-pro", "gemini-2.5-flash"],
  codex: ["gpt-5.4", "gpt-5.3-codex", "gpt-4o", "gpt-4o-mini"],
  openai: ["gpt-5.4", "gpt-4o", "gpt-4o-mini"],
  opencode: ["deepseek/deepseek-v4-pro", "deepseek/deepseek-flash"],
  codewhale: ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-5.4"],
};

export function buildProviderModelOptions(
  provider: string,
  currentModel?: string | null,
  liveModels?: Array<{ id: string }>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (val?: string | null) => {
    const trimmed = typeof val === "string" ? val.trim() : "";
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  };
  add(currentModel);
  if (Array.isArray(liveModels)) {
    for (const m of liveModels) {
      add(m?.id);
    }
  }
  const normProvider = String(provider ?? "").trim();
  const hints =
    PROVIDER_MODEL_HINTS[normProvider] ??
    PROVIDER_MODEL_HINTS[normProvider.toLowerCase().split("/")[0]] ??
    [];
  for (const h of hints) {
    add(h);
  }
  return out;
}

const providerModelsCache = new Map<string, Array<{ id: string }>>();

const COUNTERPART_PROFILE_MAP: Record<string, string> = {
  "Lead - Claude": "Lead - Gemini",
  "Lead - Gemini": "Lead - Claude",
  "Brainstorm - Claude": "Brainstorm - Gemini",
  "Brainstorm - Gemini": "Brainstorm - Claude",
  "Review - Sonnet": "Review - Gemini",
  "Review - Gemini": "Review - Sonnet",
  "Check - Haiku": "Pre-check - Flash",
  "Pre-check - Flash": "Check - Haiku",
  "Art Painter - Opus": "Art Director - Gemini",
  "Art Director - Gemini": "Art Painter - Opus",
  "Implement - Sonnet": "Lead - Gemini",
  "Implement - Opus": "Lead - Gemini",
  "Planner - Sonnet": "Lead - Gemini",
  "Spec - Opus": "Lead - Gemini",
};

export type OppositeProviderTarget = {
  provider: "claude" | "antigravity-cli";
  model: string;
  providerSpec: string;
  modeId: string;
  label: "⇄ Switch to Gemini" | "⇄ Switch to Claude";
  profile?: string;
};

export function oppositeProviderTarget(provider: string, profileName?: string): OppositeProviderTarget | null {
  const norm = String(provider ?? "").trim().toLowerCase().split("/")[0];
  const rawProf = String(profileName ?? "").trim();
  const resolveSwitchedProfile = (toGemini: boolean): string | undefined => {
    if (!rawProf) return undefined;
    if (COUNTERPART_PROFILE_MAP[rawProf]) return COUNTERPART_PROFILE_MAP[rawProf];
    if (toGemini && /(?:\s*-\s*)Claude$/i.test(rawProf)) {
      return rawProf.replace(/(-\s*)Claude$/i, "$1Gemini");
    }
    if (!toGemini && /(?:\s*-\s*)Gemini$/i.test(rawProf)) {
      return rawProf.replace(/(-\s*)Gemini$/i, "$1Claude");
    }
    return undefined;
  };
  if (norm === "claude" || norm === "anthropic" || norm.startsWith("claude-")) {
    return {
      provider: "antigravity-cli",
      model: "gemini-4-argon",
      providerSpec: "antigravity-cli/gemini-4-argon",
      modeId: "accept-edits",
      label: "⇄ Switch to Gemini",
      profile: resolveSwitchedProfile(true),
    };
  }
  if (norm === "antigravity-cli" || norm === "antigravity" || norm === "gemini" || norm.startsWith("gemini-")) {
    return {
      provider: "claude",
      model: "claude-opus-5-5",
      providerSpec: "claude/claude-opus-5-5",
      modeId: "auto",
      label: "⇄ Switch to Claude",
      profile: resolveSwitchedProfile(false),
    };
  }
  return null;
}

export type ProviderOption = { id: string; label: string; model: string; modeId: string };

export const PROVIDER_OPTIONS: ProviderOption[] = [
  { id: "antigravity-cli", label: "◆ Gemini", model: "gemini-4-argon", modeId: "accept-edits" },
  { id: "claude", label: "✶ Claude", model: "claude-opus-5-5", modeId: "auto" },
  { id: "opencode", label: "▲ OpenCode", model: "deepseek/deepseek-v4-pro", modeId: "auto" },
  { id: "codex", label: "● Codex", model: "gpt-5.4", modeId: "auto" },
];

export function normalizeProviderId(provider: string): string {
  const norm = String(provider ?? "").trim().toLowerCase().split("/")[0];
  if (norm === "antigravity" || norm === "gemini" || norm === "antigravity-cli" || norm.startsWith("gemini-")) return "antigravity-cli";
  if (norm === "claude" || norm === "anthropic" || norm.startsWith("claude-")) return "claude";
  if (norm === "codex" || norm === "openai") return "codex";
  return norm;
}

export type ProviderSwitchTarget = { provider: string; model: string; modeId: string; profile?: string; thinkingOptionId?: string | null };

/** Where choosing `targetProviderId` in the provider dropdown lands; null when it is the current provider or unknown. */
export function resolveProviderSwitchTarget(currentProvider: string, targetProviderId: string, profileName?: string, role?: string): ProviderSwitchTarget | null {
  const targetId = normalizeProviderId(targetProviderId);
  if (targetId === normalizeProviderId(currentProvider)) return null;
  const opt = PROVIDER_OPTIONS.find((o) => o.id === targetId);
  if (!opt) return null;
  let profile: string | undefined;
  if (targetId === "claude" || targetId === "antigravity-cli") {
    if (role === "brainstorm") {
      profile = targetId === "claude" ? "Brainstorm - Claude" : "Brainstorm - Gemini";
    } else if (role === "lead") {
      profile = targetId === "claude" ? "Lead - Claude" : "Lead - Gemini";
    } else {
      const rawProf = String(profileName ?? "").trim();
      if (rawProf) {
        // Only flip to the counterpart profile if `profileName` does NOT already point at the target provider,
        // otherwise an earlier switch leaves us inverting right back to the provider we're leaving.
        const alreadyTarget =
          targetId === "antigravity-cli"
            ? /(?:Gemini|Flash)$/i.test(rawProf)
            : /(?:Claude|Sonnet|Opus|Haiku)$/i.test(rawProf);
        profile = alreadyTarget ? rawProf : oppositeProviderTarget(currentProvider, profileName)?.profile;
      }
    }
  }
  return { provider: opt.id, model: opt.model, modeId: opt.modeId, profile };
}

export type DrawerHeaderProps = {
  agent: PaseoAgent;
  agentType: AgentType;
  prov: ReturnType<typeof providerSpec>;
  used: number;
  budget: number | undefined;
  team: any;
  runningSubs: number;
  working: Member[];
  extraSubs: number;
  laneId: string;
  entries: Entry[];
  active: boolean;
  onClose: () => void;
  onSuccessor?: () => void;
  /** Staged (not-yet-committed) provider switch from the top-bar dropdown; null when none is pending. */
  stagedSwitch?: ProviderSwitchTarget | null;
  /** Controlled setter for stagedSwitch; when omitted DrawerHeader keeps its own internal fallback state. */
  onStageSwitch?: (target: ProviderSwitchTarget | null) => void;
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
  doRestart: (reason: string, pendingPrompt?: string, profileName?: string, model?: string, modeId?: string, thinkingOptionId?: string | null) => Promise<unknown>;
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

function download(name: string, mime: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  void navigator.clipboard?.writeText(body).catch(() => {});
}

function SessionActions({ agent, entries }: { agent: PaseoAgent; entries: Entry[] }) {
  const [exportOpen, setExportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const title = agent.title ?? agent.id;

  const fork = async () => {
    setBusy(true);
    setMsg("");
    try {
      if (DEMO) return setMsg("Fork (demo): would open a new agent with this context.");
      const prompt = forkSummaryPrompt(title, entries);
      const lb = (agent.labels ?? {}) as Record<string, string>;
      const forked = await runnerSpawn({
        config: { provider: agent.provider, model: agent.model ?? undefined, cwd: agent.cwd, title: forkTitle(title) },
        initialPrompt: prompt,
        labels: { ...(lb.lane ? { lane: lb.lane } : {}), ...(lb.team ? { team: lb.team } : {}) },
      });
      const id = forked?.id;
      if (forked) upsertLocalAgent(forked);
      if (id) openAgentInTab(id);
    } catch (e) {
      setMsg(`Fork failed: ${(e as Error).message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    setBusy(true);
    setMsg("");
    try {
      if (DEMO) return setMsg("Resume (demo)");
      if (agent.archivedAt) await runnerUnarchive(agent.id);
      // Unarchive only restores the record; a closed (lost/parked) agent needs the resume route to actually reopen.
      const after = await runnerResume(agent.id);
      if (after?.status === "closed" && !agent.archivedAt) throw new Error("it can't be resumed; use Spin Up to start a new one");
      if (after) upsertLocalAgent(after);
      openAgent(agent.id);
    } catch (e) {
      setMsg(`Resume failed: ${(e as Error).message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  const exportAs = (ext: "md" | "json") => {
    if (ext === "md") download(exportFileName(title, "md"), "text/markdown", transcriptToMarkdown(title, entries));
    else download(exportFileName(title, "json"), "application/json", transcriptToJson(agent.id, title, entries));
    setExportOpen(false);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 10px", flexWrap: "wrap" }}>
      <button className="btn ghost small" data-testid="drawer-fork-btn" disabled={busy} onClick={() => void fork()}>
        ⑂ Fork
      </button>
      <button className="btn ghost small" data-testid="drawer-export-btn" onClick={() => setExportOpen((v) => !v)}>
        ⬇ Export
      </button>
      {exportOpen && (
        <>
          <button className="btn small" data-testid="drawer-export-md" onClick={() => exportAs("md")}>
            .md
          </button>
          <button className="btn small" data-testid="drawer-export-json" onClick={() => exportAs("json")}>
            .json
          </button>
        </>
      )}
      {(agent.archivedAt || agent.status === "closed") && (
        <button className="btn ok small" data-testid="drawer-resume-btn" disabled={busy} onClick={() => void resume()}>
          ▶ Resume / Un-archive
        </button>
      )}
      {msg && <span className="chip">{msg}</span>}
    </div>
  );
}

export function DrawerHeader({
  agent,
  agentType,
  prov,
  used,
  budget,
  team,
  runningSubs,
  working,
  extraSubs,
  laneId,
  entries,
  active,
  onClose,
  onSuccessor,
  stagedSwitch,
  onStageSwitch,
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
  const [modeBusy, setModeBusy] = useState(false);
  const [modelValue, setModelValue] = useState(agent.model ?? "");
  const [customModelMode, setCustomModelMode] = useState(false);
  const [liveModels, setLiveModels] = useState<Array<{ id: string }>>(
    () => providerModelsCache.get(agent.provider) ?? [],
  );
  const modelSubmittedRef = useRef<string | null>(null);
  const [modelError, setModelError] = useState("");
  const [internalStagedSwitch, setInternalStagedSwitch] = useState<ProviderSwitchTarget | null>(null);
  const staged = stagedSwitch !== undefined ? stagedSwitch : internalStagedSwitch;
  const stageSwitch = (target: ProviderSwitchTarget | null) => {
    if (onStageSwitch) onStageSwitch(target);
    else setInternalStagedSwitch(target);
  };
  const effectiveProvider = staged ? staged.provider : agent.provider;
  const effectiveProv = providerSpec(effectiveProvider);
  const submitModel = (next: string) => {
    modelSubmittedRef.current = next;
    setModelError("");
    if (staged) {
      // Staging: pick the model for the *target* provider without touching the old agent.
      setModelValue(next);
      stageSwitch({ ...staged, model: next });
      return;
    }
    setModelHelper(agent, next).then((r) => setReloadError(configNote(r))).catch((e) => {
      modelSubmittedRef.current = null;
      setModelValue(agent.model ?? "");
      setModelError(`Model change failed: ${e instanceof Error ? e.message : e}`);
    });
  };
  const [thinkingBusy, setThinkingBusy] = useState(false);
  const [reloadBusy, setReloadBusy] = useState(false);
  const [reloadError, setReloadError] = useState("");
  const [switchBusy, setSwitchBusy] = useState(false);
  const [copyIdFlash, setCopyIdFlash] = useState(false);
  const [copyCwdFlash, setCopyCwdFlash] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    setModelValue(agent.model ?? "");
    modelSubmittedRef.current = null;
  }, [agent.model]);

  // The internal fallback staging state must not leak into the next agent when this drawer re-renders for a new id.
  useEffect(() => {
    setInternalStagedSwitch(null);
  }, [agent.id]);

  useEffect(() => {
    const cacheKey = effectiveProvider;
    const cached = providerModelsCache.get(cacheKey);
    if (cached && cached.length > 0) {
      setLiveModels(cached);
      return;
    }
    setLiveModels([]);
    if (DEMO || !effectiveProvider) return;
    let cancelled = false;
    listProviderModels(effectiveProvider)
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.models)
          ? res.models.filter((m) => typeof m?.id === "string" && m.id.trim().length > 0)
          : [];
        if (list.length > 0) {
          providerModelsCache.set(cacheKey, list);
        }
        setLiveModels(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [effectiveProvider, agent.id]);

  const modelOptions = buildProviderModelOptions(effectiveProvider, modelValue || staged?.model || agent.model, liveModels);
  const modelListId = `drawer-model-list-${agent.id}`;

  const agentLabels = (agent.labels ?? {}) as Record<string, string>;
  const switchTarget = oppositeProviderTarget(agent.provider, agentLabels.profile);
  const needsYouFlagged =
    (!!agentLabels["needs-you"] && agentLabels["needs-you"] !== "cleared") ||
    (!!agentLabels[LEGACY_NEEDS_LABEL] && agentLabels[LEGACY_NEEDS_LABEL] !== "cleared");
  const isUnreadOrAttention =
    isMarkedUnread(agent.id) ||
    needsYouFlagged ||
    Boolean(att && att.tone !== "finished") ||
    Boolean(agent.requiresAttention && !isLocallyHidden(agent.id, agent.attentionReason ?? "attention"));
  const attachBlocked = !!auditAntigravityAgent(agent, entries).a5ReadBlocked;

  // Pin-focus (single ~44px bar): the focused Brainstorm's compact controls go into PinFocusBar and its inspector
  // into the PinRail's Active Buddy Card. Same component, same state — only where it renders changes.
  const pinFocus = usePinFocus();
  const barSlot = usePinSlot("bar");
  const cardSlot = usePinSlot("card");
  // Whichever lane drawer (Buddy, Lead, worker, topic Buddy) is the left-pane tab owns the slots, so exactly one portals.
  // Not at <=900px where the rail hides the Active Buddy Card: there the full inline inspector comes back.
  const shownHere = usePanes().leftActiveId === agent.id;
  const inLane = useInFocusedLane(agent.id);
  const railCardVisible = useRailCardVisible();
  const compact = !!pinFocus?.agentId && shownHere && inLane && railCardVisible && !!barSlot && !!cardSlot;

  // Provider switch: one handler shared by the dropdown and the legacy ⇄ button (compact bar + full drawer).
  const switchToProvider = async (targetProviderId: string) => {
    const role = kindOf(agent);
    const target = resolveProviderSwitchTarget(agent.provider, targetProviderId, agentLabels.profile, role === "lead" || isBs ? (role === "lead" ? "lead" : "brainstorm") : undefined);
    if (!target) return;
    const nextProfile = target.profile;
    setSwitchBusy(true);
    setReloadError("");
    try {
      const nextLabels = {
        ...agentLabels,
        ...(nextProfile ? { profile: nextProfile } : {}),
      };
      if (DEMO) {
        upsertLocalAgent({
          ...agent,
          provider: target.provider,
          model: target.model,
          currentModeId: target.modeId,
          labels: nextLabels,
        });
        return;
      }
      if (isBs && nextProfile) setLastBrainstormProfile(nextProfile);
      // A Lead's live labels.profile must stay intact: the successor is spawned, this agent isn't flipped in place.
      if (kindOf(agent) !== "lead") await updateAgent(agent.id, { labels: nextLabels });
      if (kindOf(agent) === "lead" && onSuccessor) {
        onSuccessor();
      } else if (isBs) {
        await doRestart("provider-switch", undefined, nextProfile);
      } else {
        const spawned = await runnerSpawn({
          config: {
            provider: target.provider,
            model: target.model,
            modeId: target.modeId,
            cwd: agent.cwd,
            title: agent.title ?? agent.id,
          },
          labels: nextLabels,
        });
        const newId = spawned?.id;
        if (spawned) upsertLocalAgent(spawned);
        if (newId) openAgentInTab(newId);
      }
    } catch (e) {
      setReloadError(`Switch provider failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSwitchBusy(false);
    }
  };
  const providerSwitchBtn = switchTarget && !agent.archivedAt ? (
    <button
      data-testid="drawer-switch-provider-btn"
      className="btn ghost small"
      title={`Switch this ${kindOf(agent) || "agent"} from ${agent.provider} to ${switchTarget.label.replace("⇄ Switch to ", "")}`}
      disabled={switchBusy}
      onClick={() => void switchToProvider(switchTarget.provider)}
    >
      {switchBusy ? "…" : switchTarget.label}
    </button>
  ) : null;
  const currentProviderId = normalizeProviderId(agent.provider);
  const providerKnown = PROVIDER_OPTIONS.some((o) => o.id === currentProviderId);
  // A Buddy/Lead picks its provider through its profile, which only exists for Claude/Gemini.
  const profileBound = isBs || kindOf(agent) === "lead";
  const providerSelect = (
    <select
      data-testid="drawer-provider-select"
      className="drawer-provider-select"
      style={{ color: effectiveProv.color, borderColor: effectiveProv.color }}
      value={providerKnown ? normalizeProviderId(effectiveProvider) : effectiveProvider}
      disabled={switchBusy || !!agent.archivedAt}
      title={`Provider: ${effectiveProvider}`}
      onChange={(e) => {
        const val = e.target.value;
        // Choosing the current provider again just clears any pending staged switch.
        if (normalizeProviderId(val) === normalizeProviderId(agent.provider)) {
          stageSwitch(null);
          setModelValue(agent.model ?? "");
          return;
        }
        // Stage the switch in the top bar only; the actual restart/creation happens on the next send.
        const role = kindOf(agent);
        const target = resolveProviderSwitchTarget(
          agent.provider,
          val,
          agentLabels.profile,
          role === "lead" || isBs ? (role === "lead" ? "lead" : "brainstorm") : undefined,
        );
        if (!target) return;
        stageSwitch(target);
        setModelValue(target.model);
        if (isBs && target.profile) setLastBrainstormProfile(target.profile);
      }}
    >
      {!providerKnown && <option value={effectiveProvider}>{effectiveProvider}</option>}
      {PROVIDER_OPTIONS.map((o) => (
        <option key={o.id} value={o.id} disabled={profileBound && o.id !== "claude" && o.id !== "antigravity-cli" && o.id !== normalizeProviderId(effectiveProvider)}>
          {o.label}
        </option>
      ))}
    </select>
  );

  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === "Tab") {
        e.preventDefault();
        const modes = modesFor(agent, DEMO || !!staged);
        if (!modes.length) return;
        const currentMode = staged ? staged.modeId ?? agent.currentModeId ?? null : agent.currentModeId ?? null;
        const next = nextModeInCycle(modes, currentMode);
        if (staged) {
          // Cycle the staged switch's mode, never the old provider's daemon session.
          stageSwitch({ ...staged, modeId: next });
        } else if (!modeBusy) {
          setModeBusy(true);
          setModeHelper(agent, next).then((r) => setReloadError(configNote(r))).catch((e) => setReloadError(String(e instanceof Error ? e.message : e))).finally(() => setModeBusy(false));
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, agent, modeBusy, staged]);

  const modeSelect = (() => {
              const modes = modesFor(agent, DEMO || !!staged);
              const stagedModeId = staged ? staged.modeId ?? agent.currentModeId ?? "" : agent.currentModeId ?? "";
              if (!modes.length) return null;
              return (
                <select
                  data-testid="drawer-mode-select"
                  className="drawer-mode-select"
                  style={{ background: "var(--panel-alt)", color: "var(--fg)", border: "1px solid var(--line)", fontSize: 10, padding: "1px 4px", height: 20 }}
                  value={stagedModeId}
                  disabled={modeBusy}
                  onChange={(e) => {
                    if (staged) {
                      stageSwitch({ ...staged, modeId: e.target.value });
                      return;
                    }
                    setModeBusy(true);
                    setModeHelper(agent, e.target.value).then((r) => setReloadError(configNote(r))).catch((e2) => setReloadError(String(e2 instanceof Error ? e2.message : e2))).finally(() => setModeBusy(false));
                  }}
                >
                  {modes.map((m) => (
                    <option key={m.id} value={m.id}>
                      {(m as any).label || (m as any).name || m.id}
                    </option>
                  ))}
                </select>
              );
            })();
  const modes = modesFor(agent, DEMO || !!staged);
  const stagedModeId = staged ? staged.modeId ?? agent.currentModeId ?? "" : agent.currentModeId ?? "";
  const activeModeObj = modes.find((m) => m.id === stagedModeId) ?? modes[0];
  const activeModeLabel = activeModeObj ? ((activeModeObj as any).label || (activeModeObj as any).name || activeModeObj.id) : (stagedModeId || "default");
  const stagedThinking = staged ? staged.thinkingOptionId ?? agent.thinkingOptionId ?? "" : agent.thinkingOptionId ?? "";
  const thinkingLevels = thinkingLevelsFor(agent as any, DEMO || !!staged);
  const thinkingSelect = !thinkingLevels.length ? null : (
            <select
              data-testid="drawer-thinking-select"
              className="drawer-thinking-select"
              style={{ background: "var(--panel-alt)", color: "var(--fg)", border: "1px solid var(--line)", fontSize: 10, padding: "1px 4px", height: 20 }}
              value={stagedThinking}
              disabled={thinkingBusy}
              onChange={(e) => {
                if (staged) {
                  stageSwitch({ ...staged, thinkingOptionId: e.target.value || null });
                  return;
                }
                setThinkingBusy(true);
                setThinkingHelper(agent, e.target.value || null).then((r) => setReloadError(configNote(r))).catch((e2) => setReloadError(String(e2 instanceof Error ? e2.message : e2))).finally(() => setThinkingBusy(false));
              }}
            >
              {thinkingLevels.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
              {!thinkingLevels.includes(stagedThinking) && stagedThinking && (
                <option value={stagedThinking}>{stagedThinking}</option>
              )}
            </select>
  );
  const featureChips = (
    <>
            <FeaturesMenu agent={agent} />
            <SandboxView agent={agent} />
            {(() => {
              const cost = (agent.lastUsage as any)?.totalCostUsd ?? (agent as any)?.usage?.totalCostUsd;
              return typeof cost === "number" && cost >= 0 ? (
                <span data-testid="drawer-cost-readout" className="chip" style={{ fontSize: 10, padding: "0 5px" }}>
                  {formatCostUsd(cost)}
                </span>
              ) : null;
            })()}
    </>
  );
  const modelControl = customModelMode ? (
    <>
            <input
              data-testid="drawer-model-input"
              className="drawer-model-input"
              aria-label="Model"
              title={`Custom model (${effectiveProvider})`}
              style={{ background: "var(--panel-alt)", color: "var(--fg)", border: "1px solid var(--line)", fontSize: 10, padding: "1px 4px", width: 120, height: 18 }}
              list={modelListId}
              value={modelValue}
              autoFocus
              onChange={(e) => setModelValue(e.target.value)}
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next && (staged || (next !== (agent.model ?? "") && next !== modelSubmittedRef.current))) {
                  submitModel(next);
                } else if (!next) {
                  setModelValue(staged ? (staged.model ?? "") : (agent.model ?? ""));
                }
                setCustomModelMode(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const next = (e.target as HTMLInputElement).value.trim();
                  if (next && (staged || (next !== (agent.model ?? "") && next !== modelSubmittedRef.current))) {
                    submitModel(next);
                  }
                  setCustomModelMode(false);
                } else if (e.key === "Escape") {
                  setModelValue(staged ? (staged.model ?? "") : (agent.model ?? ""));
                  setCustomModelMode(false);
                }
              }}
            />
            <datalist id={modelListId}>
              {modelOptions.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
    </>
  ) : (
            <select
              data-testid="drawer-model-select"
              className="drawer-model-input"
              aria-label="Model"
              title={`Model (${effectiveProvider})`}
              style={{ background: "var(--panel-alt)", color: "var(--fg)", border: "1px solid var(--line)", fontSize: 10, padding: "1px 4px", width: 120, height: 20 }}
              value={modelValue || modelOptions[0] || ""}
              onChange={(e) => {
                const val = e.target.value;
                if (val === "__custom__") {
                  setCustomModelMode(true);
                  return;
                }
                const next = val.trim();
                setModelValue(next);
                if (staged || (next && next !== (agent.model ?? "") && next !== modelSubmittedRef.current)) {
                  submitModel(next);
                }
              }}
            >
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              <option value="__custom__">Custom model…</option>
            </select>
  );
  const metaRest = (
    <>
            <span>{compact ? "" : "· "}{shortPath(agent.cwd)}</span>
            <button
              data-testid="drawer-copy-cwd-btn"
              className="btn ghost small drawer-copy-btn"
              style={{ padding: "0 4px", fontSize: 10 }}
              title="Copy full working directory path"
              onClick={() => {
                navigator.clipboard.writeText(agent.cwd).catch(() => {});
                setCopyCwdFlash(true);
                setTimeout(() => setCopyCwdFlash(false), 1200);
              }}
            >
              {copyCwdFlash ? "✓ Path" : "⎘"}
            </button>
            <span>· {ago(agent.updatedAt)}</span>
            {runningSubs ? <span>· {runningSubs} sub(s)</span> : null}
            <button
              data-testid="drawer-copy-id-btn"
              className="btn ghost small drawer-copy-btn"
              style={{ padding: "0 4px", fontSize: 10 }}
              title="Copy agent ID"
              onClick={() => {
                navigator.clipboard.writeText(agent.id).catch(() => {});
                setCopyIdFlash(true);
                setTimeout(() => setCopyIdFlash(false), 1200);
              }}
            >
              {copyIdFlash ? "✓ ID" : agent.id.slice(0, 8)}
            </button>
    </>
  );
  const primaryUtils = (
    <>
          <button
            data-testid="drawer-search-btn"
            className="btn ghost small"
            title="Search transcript, jump between prompts, filter the timeline"
            onClick={() => window.dispatchEvent(new CustomEvent("vs:timeline-search", { detail: { agentId: agent.id } }))}
          >
            🔍 Search
          </button>
          <button
            data-testid="drawer-reload-agent-btn"
            className="btn ghost small"
            title="Reload / refresh agent session"
            disabled={reloadBusy}
            onClick={async () => {
              if (DEMO) return;
              setReloadBusy(true);
              setReloadError("");
              try {
                runnerReloadTimeline(agent.id);
              } catch (e) {
                setReloadError(String(e));
              } finally {
                setReloadBusy(false);
              }
            }}
          >
            {reloadBusy ? "…" : "↻ Reload"}
          </button>
          {isUnreadOrAttention ? (
            <button
              data-testid="mark-read"
              className="btn ok small"
              style={{ padding: "1px 6px", fontSize: 10 }}
              title="Mark this chat read and clear attention"
              onClick={() => void markAgentRead(agent)}
            >
              ✓ Mark read
            </button>
          ) : (
            <button
              data-testid="mark-unread"
              className="btn ghost small"
              style={{ padding: "1px 6px", fontSize: 10 }}
              title="Put this chat back in the team's needs-you list"
              onClick={() => void markAgentUnread(agent)}
            >
              Mark unread
            </button>
          )}
          {modelError && <span className="small drawer-reload-error" role="alert" style={{ color: "var(--bad, #e5484d)" }}>{modelError}</span>}
          {reloadError && <span className="small muted drawer-reload-error">{reloadError}</span>}
    </>
  );
  const extraActions = (
    <>
          {!compact && providerSwitchBtn}
          {primaryUtils}
          <AgentActions agent={agent} archive />
    </>
  );

  const secondaryPlumbing = (
    <>
          <span className="role-tag">{AGENT_TYPE_LABEL[agentType]}</span>
          <span className="prov-pill" style={{ color: prov.color, borderColor: prov.color }}>
            {prov.symbol} {prov.name}
          </span>
          {featureChips}
          <AgentActions agent={agent} archive />
    </>
  );
  const dockBtns = (
    <>
          <button
            className={`btn ghost dock-toggle-btn${dockOpen ? " on" : ""}`}
            title={dockOpen ? "Close side dock" : "Open: Changes / Files / Terminal / Scripts"}
            onClick={onToggleDock}
          >
            Dock {dockOpen ? "▶" : "◀"}
          </button>
          {!compact && (
            <button className="btn ghost" onClick={onClose}>
              ✕
            </button>
          )}
    </>
  );
  const inspector = (
    <>

      {isBs && (
        <div className={`brainstorm-ctx-bar tone-${bsTone}`} data-testid="brainstorm-ctx-bar" style={{ padding: "4px 8px", margin: "4px 8px 0" }}>
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
          <div className="brainstorm-ctx-main" style={{ flexWrap: "wrap", gap: 6 }}>
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
            <div className="brainstorm-ctx-actions" style={{ flexWrap: "wrap", gap: 4 }}>
              <button
                className="btn small btn-brainstorm-restart"
                style={{ padding: "2px 6px", fontSize: 10 }}
                disabled={restarting}
                onClick={() =>
                  void doRestart(planHandedOff ? "handoff" : bsUsedTokens >= warnTokens ? "warn-80k" : "manual")
                }
                title="Spawn a fresh brainstorm seeded from docs/brainstorm/<team>.md and archive this one"
              >
                {restarting ? "↻…" : "↻ Restart"}
              </button>
              <button
                className="btn ghost small btn-brainstorm-summary"
                style={{ padding: "2px 6px", fontSize: 10 }}
                onClick={toggleSummary}
                title={`Preview docs/brainstorm/${laneId}.md`}
              >
                📄 Summary
              </button>
              <button
                className={`btn ghost small btn-brainstorm-handoff ${handoffMarked ? "on" : ""}`}
                style={{ padding: "2px 6px", fontSize: 10 }}
                onClick={() => setHandoffMarked(true)}
                title="Mark plan handed off to lead"
              >
                ✓ Handed off
              </button>
              <button
                className={`btn ghost small btn-brainstorm-inbox ${inboxPopoverOpen ? "on" : ""}`}
                style={{ padding: "2px 6px", fontSize: 10 }}
                onClick={() => setInboxPopoverOpen((v) => !v)}
                title="Dump 1 or multiple newline-separated ideas straight into the Idea Inbox (0 tokens)"
                data-testid="brainstorm-park-inbox-btn"
              >
                📥 Inbox
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

          {moreOpen && bsUsedTokens >= warnTokens && (
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

          {moreOpen && planHandedOff && (
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

      {!compact && agent.labels?.["vs.fresh-session"] === "brief" && (
        <div className="brainstorm-fresh-divider" role="separator">
          ── Fresh session · from brief
          <button className="btn ghost small" aria-label="Edit brief" onClick={() => openBriefEditor({ laneId })}>
            ⋯
          </button>
          ──
        </div>
      )}
      {moreOpen && restartedFrom && !feedbackDismissed && agent.labels?.["vs.fresh-session"] !== "brief" && (
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

      {att && att.tone !== "needs-you" && att.tone !== "finished" && <div className={`banner ${att.tone}`}>{att.reason}</div>}
      {(needsYouFlagged || isMarkedUnread(agent.id) || moreOpen) ? <NeedsYouControls agent={agent} /> : null}
      {kindOf(agent) === "lead" && onSuccessor && !agent.archivedAt && (
        <div className="lint-bar successor-bar">
          <span>Lead handoff</span>
          <button className="btn hot" onClick={onSuccessor}>
            Initiate Handoff / Spawn Successor
          </button>
        </div>
      )}
      {active && <HardeningBar agent={agent} entries={entries} />}
      {!compact && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 10px", flexWrap: "wrap" }}>
          <button
            className="btn ghost small drawer-more-toggle"
            style={{ padding: "1px 6px", fontSize: 10 }}
            onClick={() => setMoreOpen((v) => !v)}
          >
            {moreOpen ? "▾ Less" : "⋯ More"}
          </button>
          {moreOpen && (
            <div className="labels drawer-labels-list" style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "2px 4px", border: "none", minWidth: 0, maxWidth: "100%" }}>
              {Object.entries(agentLabels)
                .map(([k, v]) => (
                  <span key={k} className="chip">
                    {k}={v}
                  </span>
                ))}
            </div>
          )}
        </div>
      )}
      {!compact && <SessionActions agent={agent} entries={entries} />}
      {!compact && (attachBlocked || moreOpen) ? <AttachFiles agent={agent} entries={entries} /> : null}
    </>
  );
  const header = (
    <>
      <header className="drawer-head" style={{ flexWrap: "wrap", padding: "8px 12px", gap: 8, alignItems: "center" }}>
        <Avatar id={agent.id} provider={agent.provider} agentType={agentType} variant={leadVariant(agent)} size={40} />
        <div className="drawer-id" style={{ flex: "1 1 240px", minWidth: 0 }}>
          <div className="drawer-role-line" style={{ flexWrap: "wrap", gap: 4 }}>
            <span className="role-tag">{AGENT_TYPE_LABEL[agentType]}</span>
            <span className="prov-pill" style={{ color: prov.color, borderColor: prov.color }}>
              {prov.symbol} {prov.name}
            </span>
            {modeSelect}
            {thinkingSelect}
            {featureChips}
          </div>
          <div className="drawer-title" style={{ fontSize: 15 }}>
            <StatusDot agent={agent} /> <AgentTitleEdit agent={agent}>{agent.title ?? agent.id.slice(0, 8)}</AgentTitleEdit>
          </div>
          <div className="muted small drawer-meta-line" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
            {providerSelect}
            {modelControl}
            {metaRest}
          </div>
          {!isBs && <TokenMeter used={used} budget={budget ?? 0} ladder={kindOf(agent) === "lead" ? leadLadderFor(team) : undefined} />}
        </div>
        <div className="drawer-actions" style={{ flexWrap: "wrap", gap: 4, alignItems: "center" }}>
          {extraActions}
          {dockBtns}
        </div>
      </header>
    </>
  );

  const compactIdentity = isBs && !isTopicBs ? (
    <StatusDot agent={agent} />
  ) : (
    <>
      <Avatar id={agent.id} provider={agent.provider} agentType={agentType} variant={leadVariant(agent)} size={24} />
      <span className="drawer-head-compact-title">
        <StatusDot agent={agent} /> <AgentTitleEdit agent={agent}>{agent.title ?? agent.id.slice(0, 8)}</AgentTitleEdit>
      </span>
    </>
  );

  if (compact)
    return (
      <>
        {createPortal(
          <>
      <div className="drawer-head-compact" data-testid="drawer-head-compact">
        {compactIdentity}
        {providerSelect}
        {modelControl}
        <details className="drawer-config-menu" data-testid="drawer-config-menu">
          <summary className="btn ghost small drawer-config-summary" data-testid="drawer-config-menu-btn" title="Thinking effort & permission mode">
            ⚙ {stagedThinking || "medium"} · {activeModeLabel} ▾
          </summary>
          <div className="drawer-config-popover">
            {thinkingSelect && <label className="drawer-config-row"><span className="muted small">Thinking</span>{thinkingSelect}</label>}
            <label className="drawer-config-row"><span className="muted small">Mode</span>{modeSelect}</label>
          </div>
        </details>
        <WorkingChip members={working} subs={extraSubs} />
        <span className="drawer-head-compact-spacer" />
        {dockBtns}
      </div>
          </>,
          barSlot!,
        )}
        {createPortal(
          <>
      {!isBs && <TokenMeter used={used} budget={budget ?? 0} ladder={kindOf(agent) === "lead" ? leadLadderFor(team) : undefined} />}
            {inspector}
      <div className="drawer-actions pin-rail-buddy-tools" data-testid="pin-rail-buddy-tools" style={{ flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {primaryUtils}
        <button
          className="btn ghost small drawer-more-toggle"
          data-testid="drawer-more-toggle"
          style={{ padding: "1px 6px", fontSize: 10 }}
          onClick={() => setMoreOpen((v) => !v)}
        >
          {moreOpen ? "▾ Less" : "⋯ More"}
        </button>
      </div>
      {moreOpen && (
        <>
      <div className="drawer-actions pin-rail-buddy-tools" style={{ flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {secondaryPlumbing}
      </div>
      <div className="muted small drawer-meta-line" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
        {metaRest}
      </div>
      {agent.labels?.["vs.fresh-session"] === "brief" && (
        <div className="brainstorm-fresh-divider" role="separator">
          ── Fresh session · from brief
          <button className="btn ghost small" aria-label="Edit brief" onClick={() => openBriefEditor({ laneId })}>
            ⋯
          </button>
          ──
        </div>
      )}
      <SessionActions agent={agent} entries={entries} />
      <div className="labels drawer-labels-list" style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "2px 4px", border: "none", minWidth: 0, maxWidth: "100%" }}>
        {Object.entries(agentLabels)
          .map(([k, v]) => (
            <span key={k} className="chip">
              {k}={v}
            </span>
          ))}
      </div>
        </>
      )}
      {(attachBlocked || moreOpen) ? <AttachFiles agent={agent} entries={entries} /> : null}
          </>,
          cardSlot!,
        )}
      </>
    );
  return (
    <>
      {header}
      {inspector}
    </>
  );
}
