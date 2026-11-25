import { useEffect, useRef, useState } from "react";
import type { PaseoAgent } from "./agentTypes";
import { archiveAgent, markAgentRead, markAgentUnread, sendMessage, stopAgent } from "./paseo";
import { DEMO } from "./demoFlag";
import { isLocallyHidden, isMarkedUnread } from "./attentionLocal";
import { runnerReloadTimeline } from "./runnerBridge";
import { AgentTitleEdit } from "./QuickWinsUi";
import { isImeComposing, shouldComposerSubmit } from "./IdeaInbox";
import { ConfirmButton, ago, shortPath, useTick } from "./ui";
import { LEGACY_NEEDS_LABEL } from "./userName";
import { AGENT_TYPE_LABEL, TEAMS, isHubLaneId, kindOf } from "./teams";
import { findLaneInRegistry, formatDisplayTitle, isRetiredAgent } from "./identity";
import type { AgentType } from "./teams";
import { laneCode, laneDisplayName } from "./boringLocation";
import { providerSpec } from "./pixel";
import { boringStateGlyph } from "./BoringAde";
import { AttachFiles, HardeningBar, NeedsYouControls, SessionActions, formatCostUsd, type ProviderSwitchTarget } from "./DrawerHeader";
import { useAgentConfig } from "./useAgentConfig";
import { FeaturesMenu } from "./FeaturesMenu";
import { SandboxView } from "./SandboxView";
import { CANCEL_AND_RESUME_PROMPT, auditAntigravityAgent } from "./antigravity";
import { openBriefEditor } from "./pinActions";
import type { Entry } from "./Timeline";
import { BORING_CTX_WARN_PCT, boringHeaderStrip, boringNeedsYouStall, formatToolMinutes, shortToolName } from "./boringHeaderStrip";
import { openToolOf } from "./attentionItems";
import { roleNameFor, shortModel, useProfiles } from "./profiles";

export type BoringAgentHeaderProps = {
  agent: PaseoAgent;
  agentType: AgentType;
  used: number;
  budget: number | undefined;
  entriesCount?: number;
  isBs: boolean;
  bsPct: number;
  warnTokens: number;
  bsUsedTokens: number;
  restarting: boolean;
  planHandedOff: boolean;
  doRestart: (reason: string) => Promise<unknown>;
  onSuccessor?: () => void;
  toggleSummary: () => void;
  summaryOpen: boolean;
  setInboxPopoverOpen: React.Dispatch<React.SetStateAction<boolean>>;
  inboxPopoverOpen: boolean;
  inboxDumpText: string;
  setInboxDumpText: (v: string) => void;
  inboxParking: boolean;
  inboxToast: string;
  parkToInbox: (text: string, fromComposer: boolean) => void;
  summaryText: string;
  setSummaryText: (v: string) => void;
  summaryPath: string;
  summaryLoading: boolean;
  summarySaving: boolean;
  saveSummary: () => Promise<void>;
  laneId: string;
  att: { tone: string; reason: string } | null;
  dockOpen: boolean;
  onToggleDock: () => void;
  onClose: () => void;
  chatOnly?: boolean;
  entries: Entry[];
  active: boolean;
  stagedSwitch?: ProviderSwitchTarget | null;
  onStageSwitch?: (target: ProviderSwitchTarget | null) => void;
  /** B16: shared config lifted into AgentDrawer (also feeds the composer bar). Omitted in standalone use: the header then owns its own. */
  cfg?: ReturnType<typeof useAgentConfig>;
  restartedFrom: string;
  feedbackDismissed: boolean;
  onFeedback: (verdict: "good" | "lost") => Promise<void>;
};

const sentenceCase = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);
const GLYPH_CHAR: Record<string, string> = { run: "●", idle: "○", attn: "!", stalled: "◌", err: "✕", done: "✓" };

/** R3.4: a lead's header/tab reads "Main Game · Lead 75" (formatDisplayTitle readable) from its labels, never from title text; null for anything else. */
export function readableLeadTitle(a: PaseoAgent): string | null {
  if (kindOf(a) !== "lead") return null;
  const l = (a.labels ?? {}) as Record<string, string>;
  const laneKey = (l.lane ?? l.lead ?? "").trim();
  if (!l.ord || !laneKey) return null;
  const found = findLaneInRegistry(laneKey, TEAMS);
  return formatDisplayTitle({ role: "lead", laneName: found ? laneDisplayName(found.team, found.lane.id) : laneDisplayName({ id: "", lanes: [] }, laneKey), laneId: found?.lane.id ?? laneKey, ord: l.ord, hub: isHubLaneId(laneKey), readable: true });
}

/** The header's lane code comes from the same helper as the tree (R4-2). */
function headerLaneCode(laneKey: string): string {
  const found = findLaneInRegistry(laneKey, TEAMS);
  return found ? laneCode(found.team, found.lane.id) : `@${laneKey.replace(/^@/, "")}`;
}

export function BoringAgentHeader(p: BoringAgentHeaderProps) {
  return p.cfg ? <BoringAgentHeaderBody p={p} cfg={p.cfg} /> : <BoringAgentHeaderOwnCfg {...p} />;
}

function BoringAgentHeaderOwnCfg(p: BoringAgentHeaderProps) {
  const cfg = useAgentConfig({ agent: p.agent, active: p.active, isBs: p.isBs, onSuccessor: p.onSuccessor, doRestart: p.doRestart, stagedSwitch: p.stagedSwitch, onStageSwitch: p.onStageSwitch });
  return <BoringAgentHeaderBody p={p} cfg={cfg} />;
}

function BoringAgentHeaderBody({ p, cfg }: { p: BoringAgentHeaderProps; cfg: ReturnType<typeof useAgentConfig> }) {
  const { agent } = p;
  const now = useTick();
  const [menuOpen, setMenuOpen] = useState(false);
  const [reloadBusy, setReloadBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const [flagOpen, setFlagOpen] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const audit = auditAntigravityAgent(agent, p.entries);
  const attachBlocked = !!audit.a5ReadBlocked;
  const hung = audit.a3HungTool;
  const labels = (agent.labels ?? {}) as Record<string, string>;
  const kind = kindOf(agent);
  const prov = providerSpec(agent.provider);

  useEffect(() => { setMenuOpen(false); setFlagOpen(false); }, [agent.id]);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && e.target instanceof Node && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menuOpen]);

  const needsYouFlagged =
    (!!labels["needs-you"] && labels["needs-you"] !== "cleared") ||
    (!!labels[LEGACY_NEEDS_LABEL] && labels[LEGACY_NEEDS_LABEL] !== "cleared");
  const isUnreadOrAttention =
    isMarkedUnread(agent.id) ||
    needsYouFlagged ||
    Boolean(p.att && p.att.tone !== "finished") ||
    Boolean(agent.requiresAttention && !isLocallyHidden(agent.id, agent.attentionReason ?? "attention"));

  const ctxPct = p.isBs ? p.bsPct : p.budget && p.budget > 0 ? Math.min(100, (p.used / p.budget) * 100) : null;
  const showMeter = ctxPct != null && ctxPct >= BORING_CTX_WARN_PCT;
  const canHandoff = !agent.archivedAt && ((kind === "lead" && !!p.onSuccessor) || p.isBs);
  const strip = boringHeaderStrip({
    status: agent.status,
    updatedAt: agent.updatedAt,
    hasPendingPermission: (agent.pendingPermissions?.length ?? 0) > 0,
    ctxPct,
    planHandedOff: p.planHandedOff,
    nowMs: now,
    meterShown: showMeter,
    canHandoff,
  });
  // R5-5: same open-tool source + ceiling rule as Needs you.
  const openTool = openToolOf(agent, now);
  const toolStall = boringNeedsYouStall({
    status: agent.status,
    hasPendingPermission: (agent.pendingPermissions?.length ?? 0) > 0,
    idleSeconds: 0,
    toolRunningSeconds: openTool?.seconds ?? null,
    toolCeilingSeconds: openTool?.timeoutMs != null ? openTool.timeoutMs / 1000 : null,
  });
  const hungTool = toolStall?.kind === "tool" ? { name: shortToolName(openTool?.name ?? hung?.name) || "tool", ageSeconds: toolStall.toolSeconds } : null;
  const hungText = hungTool ? `Tool "${hungTool.name}" running ${formatToolMinutes(hungTool.ageSeconds)}` : "";
  const stripItems = strip.map((s) => (s.kind === "stalled" ? { ...s, text: hungTool && p.active ? hungText : s.text.replace(/^Stalled: no update for /, "No update for ") } : s));
  if (hungTool && p.active && !stripItems.some((s) => s.kind === "stalled")) stripItems.unshift({ kind: "stalled", text: hungText });
  const glyph = boringStateGlyph(stripItems.some((s) => s.kind === "stalled") ? "stalled" : agent.status, p.att?.tone);
  const cancelResume = async () => {
    if (!hungTool) return;
    setResumeBusy(true);
    try {
      await stopAgent(agent.id);
      await sendMessage(agent.id, CANCEL_AND_RESUME_PROMPT(hungTool.name), undefined, { activeTurnBehavior: "interrupt" });
    } catch (e) {
      alert(`Cancel & resume failed: ${e}`);
    } finally {
      setResumeBusy(false);
    }
  };
  const running = agent.status === "running" && !agent.archivedAt;
  const roleLine = [sentenceCase(AGENT_TYPE_LABEL[p.agentType]), labels.lane ? headerLaneCode(labels.lane) : ""].filter(Boolean).join(" · ");
  const { roles: storedRoles } = useProfiles();
  const roleModelName = roleNameFor(labels.profile, storedRoles) ?? roleNameFor(labels.role, storedRoles) ?? roleNameFor(agent.title, storedRoles);
  const roleModelModel = shortModel(cfg.staged?.model ?? agent.model);
  const roleModel = roleModelName && roleModelModel ? `${roleModelName} · ${roleModelModel}` : roleModelName || roleModelModel || "";
  // UX r2: the chip truncates in narrow headers, so the hover shows the full role and untruncated model id.
  const roleModelFull = cfg.staged?.model ?? agent.model ?? "";
  const roleModelTitle = `${roleModelName ? `${roleModelName} · ` : ""}${roleModelFull || roleModelModel}${cfg.staged ? " (staged switch)" : ""}`;
  const close = () => setMenuOpen(false);
  const cost = (agent.lastUsage as any)?.totalCostUsd ?? (agent as any)?.usage?.totalCostUsd;
  // R6-2: a closed/retired agent shows no Needs-you banner (it cannot be acted on).
  const showNeedsYou = !isRetiredAgent(agent) && (needsYouFlagged || isMarkedUnread(agent.id) || flagOpen);
  const copy = (what: string, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(what);
    setTimeout(() => setCopied(""), 1200);
  };

  return (
    <>
      <header className="boring-agent-header" data-testid="boring-agent-header" data-agent-id={agent.id} data-glyph={glyph}>
        <span className={`boring-agent-glyph st-${glyph}`} data-testid="boring-agent-glyph" title={p.att?.reason ?? agent.status} aria-label={glyph}>{GLYPH_CHAR[glyph] ?? "○"}</span>
        <span className="boring-agent-name" data-testid="boring-agent-name">
          <AgentTitleEdit agent={agent}>{readableLeadTitle(agent) ?? agent.title ?? agent.id.slice(0, 8)}</AgentTitleEdit>
        </span>
        <span className="boring-agent-role muted" data-testid="boring-agent-role" title={`${prov.name}${agent.model ? ` · ${agent.model}` : ""}`}>
          {roleLine}
        </span>
        {roleModel && <span className="role-model-chip" data-testid="drawer-role-model" title={roleModelTitle}>{roleModel}</span>}
        {showMeter && (
          <span
            className={`boring-ctx-meter${ctxPct! >= 90 ? " crit" : ""}`}
            data-testid="boring-ctx-meter"
            title={`Context ${Math.round(ctxPct!)}% used`}
          >
            <span className="boring-ctx-meter-track"><i style={{ width: `${Math.min(100, ctxPct!)}%` }} /></span>
            <span className="boring-ctx-meter-pct">{Math.round(ctxPct!)}%</span>
          </span>
        )}
        <span className="boring-agent-spacer" />
        {running && (
          <button
            type="button"
            className="boring-hdr-btn"
            data-testid="boring-interrupt-btn"
            title="Stop the current turn (keeps the agent)"
            onClick={() => void stopAgent(agent.id).catch(() => {})}
          >
            Interrupt
          </button>
        )}
        {!p.chatOnly && (
          <button
            type="button"
            className={`boring-hdr-btn${p.dockOpen ? " on" : ""}`}
            data-testid="boring-dock-toggle"
            title={p.dockOpen ? "Close context panel" : "Open context panel: Workers / Changes / Plan / Feed / Files / Terminal"}
            onClick={p.onToggleDock}
          >
            Dock {p.dockOpen ? "▶" : "◀"}
          </button>
        )}
        <div className="boring-agent-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className={`boring-hdr-btn boring-hdr-more${menuOpen ? " on" : ""}`}
            data-testid="boring-agent-menu-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="More actions"
            title="More actions"
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="boring-agent-menu" role="menu" data-testid="boring-agent-menu">
              {isUnreadOrAttention ? (
                <button type="button" role="menuitem" data-testid="mark-read" title="Mark this chat read and clear attention" onClick={() => { void markAgentRead(agent); close(); }}>
                  Mark read
                </button>
              ) : (
                <button type="button" role="menuitem" data-testid="mark-unread" title="Put this chat back in the team's needs-you list" onClick={() => { void markAgentUnread(agent); close(); }}>
                  Mark unread
                </button>
              )}
              <button type="button" role="menuitem" data-testid="boring-flag-btn" title="Flag this chat as needing you" onClick={() => { setFlagOpen((v) => !v); close(); }}>
                {flagOpen ? "Hide flag bar" : "Flag needs you…"}
              </button>
              <button type="button" role="menuitem" data-testid="drawer-search-btn" title="Search transcript, jump between prompts, filter the timeline" onClick={() => { window.dispatchEvent(new CustomEvent("vs:timeline-search", { detail: { agentId: agent.id } })); close(); }}>
                Search transcript
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="drawer-reload-agent-btn"
                title="Reload / refresh agent session"
                disabled={reloadBusy}
                onClick={() => {
                  close();
                  if (DEMO) return;
                  setReloadBusy(true);
                  cfg.setReloadError("");
                  try { runnerReloadTimeline(agent.id); } catch (e) { cfg.setReloadError(String(e)); } finally { setReloadBusy(false); }
                }}
              >
                Reload session
              </button>
              {canHandoff && (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="boring-handoff-btn"
                  className="btn-brainstorm-restart"
                  disabled={p.restarting}
                  title={p.isBs ? "Hand off to a fresh Buddy from the brief" : "Initiate Handoff / Spawn Successor"}
                  onClick={() => {
                    close();
                    if (p.isBs) void p.doRestart(p.planHandedOff ? "handoff" : p.bsUsedTokens >= p.warnTokens ? "warn-80k" : "manual");
                    else p.onSuccessor?.();
                  }}
                >
                  {p.restarting ? "Handing off…" : p.isBs ? "Handoff to fresh Buddy" : "Spawn successor"}
                </button>
              )}
              {p.isBs && (
                <>
                  <button type="button" role="menuitem" data-testid="boring-summary-btn" onClick={() => { p.toggleSummary(); close(); }}>
                    {p.summaryOpen ? "Hide summary" : "Summary"}
                  </button>
                  <button type="button" role="menuitem" data-testid="brainstorm-park-inbox-btn" title="Dump ideas straight into the Idea Inbox (0 tokens)" onClick={() => { p.setInboxPopoverOpen((v) => !v); close(); }}>
                    Park in Inbox
                  </button>
                </>
              )}
              <div className="boring-agent-menu-sep" role="separator" />
              <div className="boring-agent-menu-section" data-testid="boring-config-section" role="group" aria-label="Session">
                <div className="boring-agent-menu-title muted">Session</div>
                <div className="boring-cfg-chips">
                  <FeaturesMenu agent={agent} />
                  <SandboxView agent={agent} />
                  {typeof cost === "number" && cost >= 0 && (
                    <span data-testid="drawer-cost-readout" className="chip">{formatCostUsd(cost)}</span>
                  )}
                </div>
              </div>
              <div className="boring-agent-menu-sep" role="separator" />
              <SessionActions agent={agent} entries={p.entries} />
              <div className="labels drawer-labels-list boring-agent-labels">
                {Object.entries(labels).map(([k, v]) => (
                  <span key={k} className="chip">{k}={v}</span>
                ))}
              </div>
              {(attachBlocked || menuOpen) ? <AttachFiles agent={agent} entries={p.entries} /> : null}
              <div className="boring-agent-menu-sep" role="separator" />
              <button type="button" role="menuitem" data-testid="drawer-copy-id-btn" onClick={() => copy("id", agent.id)}>
                {copied === "id" ? "✓ ID copied" : `Copy ID (${agent.id.slice(0, 8)})`}
              </button>
              <button type="button" role="menuitem" data-testid="drawer-copy-cwd-btn" title={agent.cwd} onClick={() => copy("cwd", agent.cwd)}>
                {copied === "cwd" ? "✓ Path copied" : `Copy path (${shortPath(agent.cwd)})`}
              </button>
              <div className="boring-agent-menu-meta muted">{prov.name}{agent.model ? ` · ${agent.model}` : ""} · {ago(agent.updatedAt)}</div>
              {!running && !agent.archivedAt && (
                <div className="boring-agent-menu-archive" role="none">
                  <ConfirmButton label="Archive" armedLabel="Tap to archive" busyLabel="Archiving…" tone="warn" onConfirm={async () => void (await archiveAgent(agent.id))} />
                </div>
              )}
              {!p.chatOnly && (
                <button type="button" role="menuitem" data-testid="boring-close-btn" onClick={() => { close(); p.onClose(); }}>
                  Close chat
                </button>
              )}
            </div>
          )}
        </div>
      </header>
      {p.isBs && p.inboxPopoverOpen && (
        <div className="boring-agent-panel" data-testid="brainstorm-inbox-popover">
          <div className="boring-agent-panel-head">
            <span className="muted small">One idea per line → Idea Inbox (0 tokens)</span>
            <button type="button" className="boring-hdr-btn" disabled={p.inboxParking || !p.inboxDumpText.trim()} onClick={() => void p.parkToInbox(p.inboxDumpText, false)}>
              {p.inboxParking ? "Parking…" : "Park in Inbox"}
            </button>
          </div>
          <textarea
            rows={3}
            value={p.inboxDumpText}
            onChange={(e) => p.setInboxDumpText(e.target.value)}
            placeholder="One idea per line (Enter to park · Shift+Enter for newline)"
            onKeyDown={(e) => {
              if (shouldComposerSubmit(e) && p.inboxDumpText.trim()) {
                e.preventDefault();
                void p.parkToInbox(p.inboxDumpText, false);
              }
            }}
          />
        </div>
      )}
      {p.isBs && p.inboxToast && (
        <div className="boring-agent-panel" role="status" data-testid="brainstorm-inbox-toast">{p.inboxToast}</div>
      )}
      {p.isBs && p.summaryOpen && (
        <div className="boring-agent-panel" data-testid="boring-summary-panel">
          <div className="boring-agent-panel-head">
            <code>{p.summaryPath || `docs/brainstorm/${p.laneId}.md`}</code>
            <span className="muted small">{p.summaryText.length} / 20000 chars</span>
            <button type="button" className="boring-hdr-btn" disabled={p.summarySaving || p.summaryLoading} onClick={() => void p.saveSummary()}>
              {p.summarySaving ? "Saving…" : "Save summary"}
            </button>
          </div>
          {p.summaryLoading ? (
            <div className="muted small">Loading summary…</div>
          ) : (
            <textarea
              rows={6}
              value={p.summaryText}
              onChange={(e) => p.setSummaryText(e.target.value)}
              placeholder="# Brainstorm Summary (Decided / Open / In flight)"
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.code === "Enter" || e.code === "NumpadEnter") && !isImeComposing(e) && (e.ctrlKey || e.metaKey) && !p.summarySaving && !p.summaryLoading) {
                  e.preventDefault();
                  void p.saveSummary();
                }
              }}
            />
          )}
        </div>
      )}
      {cfg.staged && (
        <div className="boring-status-strip" data-testid="boring-staged-switch" role="status">
          <span className="boring-strip-item strip-staged">Switching to {cfg.effectiveProv.name} on your next message</span>
        </div>
      )}
      {(cfg.modelError || cfg.reloadError) && (
        <div className="boring-status-strip" role="alert">
          <span className="boring-strip-item strip-error">{cfg.modelError || cfg.reloadError}</span>
        </div>
      )}
      {!p.chatOnly && labels["vs.fresh-session"] === "brief" && (
        <div className="brainstorm-fresh-divider" role="separator">
          ── Fresh session · from brief
          <button className="btn ghost small" aria-label="Edit brief" onClick={() => openBriefEditor({ laneId: p.laneId })}>⋯</button>
          ──
        </div>
      )}
      {p.restartedFrom && !p.feedbackDismissed && labels["vs.fresh-session"] !== "brief" && (
        <div className="brainstorm-feedback-bar" role="status">
          <span>Fresh start from <code>docs/brainstorm/{p.laneId}.md</code> · Did the restart lose something?</span>
          <div className="brainstorm-feedback-actions">
            <button className="btn ghost small" onClick={() => void p.onFeedback("good")}>👍 Nothing lost</button>
            <button className="btn ghost small" onClick={() => void p.onFeedback("lost")}>⚠ Lost context</button>
          </div>
        </div>
      )}
      {p.att && p.att.tone !== "needs-you" && p.att.tone !== "finished" && <div className={`banner ${p.att.tone}`}>{p.att.reason}</div>}
      {showNeedsYou ? <div className="boring-needs-you-wrap"><NeedsYouControls agent={agent} /></div> : null}
      {p.active && <HardeningBar agent={agent} entries={p.entries} hideHungTool />}
      {stripItems.length > 0 && (
        <div className="boring-status-strip" data-testid="boring-status-strip" role="status">
          {stripItems.map((s, i) => (
            <span key={s.kind} className={`boring-strip-item strip-${s.kind}`} data-strip={s.kind}>
              {i > 0 && <span className="boring-strip-sep" aria-hidden="true">·</span>}
              {s.kind === "stalled" && <span className="boring-strip-glyph" aria-hidden="true">◌</span>}
              {s.text}
              {s.kind === "stalled" && hungTool && p.active && (
                <button type="button" className="boring-strip-btn" data-testid="boring-strip-resume" disabled={resumeBusy} onClick={() => void cancelResume()}>
                  {resumeBusy ? "…" : "Cancel & resume"}
                </button>
              )}
              {s.kind === "context" && canHandoff && (
                <button
                  type="button"
                  className="boring-strip-btn"
                  data-testid="boring-strip-handoff"
                  disabled={p.restarting}
                  onClick={() => {
                    if (p.isBs) void p.doRestart(p.planHandedOff ? "handoff" : p.bsUsedTokens >= p.warnTokens ? "warn-80k" : "manual");
                    else p.onSuccessor?.();
                  }}
                >
                  Hand off ▸
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
