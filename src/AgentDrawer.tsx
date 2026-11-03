import { memo, useCallback, useEffect, useRef, useState } from "react";
import { expandFolderMentions } from "./projectContext";
import { appendContext, useCtxSources } from "./contextSources";
import type { PaseoAgent } from "@getpaseo/client";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import { daemonClient, DEMO, removeLocalAgent, sendMessage, upsertLocalAgent } from "./paseo";
import { useDraft } from "./drafts";
import { isRemote } from "./remoteSession";
import { createSendLock, guardedSend, restoredDraft } from "./sendGuard";
import { blobsToPaseoImages, rememberSent, useImageDraft } from "./imageDrafts";
import {
  attentionOf,
  brainstormUsedTokens,
  budgetFor,
  classifyAgent,
  getBrainstormThresholds,
  isBrainstormAgent,
  isTopicBrainstorm,
  teamForAgent,
  topicOfBrainstorm,
  usedTokens,
  useTeams,
} from "./teams";
import { titleFor } from "./teams";
import { handoffTopicBrainstormClient, parkIdeasInInbox, parkTopicBrainstormClient } from "./IdeaInbox";
import { providerSpec } from "./pixel";
import { openAgentInTab, paneOfAgent } from "./panes";
import { useTimeline, Timeline, TimelineErrorBoundary } from "./Timeline";
import { PermissionCard } from "./PermissionCard";
import { Composer, stageFiles } from "./Composer";
import { composeMessage, setAgentCwd, useAttachments } from "./attachments";
import { DrawerHeader } from "./DrawerHeader";
import { useWorkingMembers, WorkingBar } from "./WorkingBar";
import { RightDock } from "./RightDock";

export { localImageSrc } from "./Timeline";
export type { Entry } from "./Timeline";

const PLAN_HANDOFF_RE = /\b(handed off|plan handoff|sent to lead|PLAN_[A-Z0-9_]+\.md)\b/i;

async function postVsLog(payload: {
  team?: string;
  lane?: string;
  type: string;
  text: string;
  agent?: string;
  refs?: string[];
}) {
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
}): Promise<{ newAgentId: string | null; title?: string; retired?: boolean; pendingPrompt?: string }> {
  const { agent, teamId, laneId, reason, usedTokens: ut, pendingPrompt, summaryUpdate } = opts;
  const pane = paneOfAgent(agent.id);
  const res = await fetch("/__vibesquad/brainstorm-restart", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentId: agent.id,
      teamId,
      laneId,
      reason,
      usedTokens: ut,
      // Prompt and brief text never cross the remote relay (REMOTE_FORBIDDEN_BODY_KEYS).
      ...(pendingPrompt && !isRemote() ? { pendingPrompt } : {}),
      ...(summaryUpdate && !isRemote() ? { summaryUpdate } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if ((!res.ok || body.ok === false) && !DEMO) {
    throw new Error(body.error ?? `brainstorm-restart failed (${res.status})`);
  }
  if (body.retired) {
    removeLocalAgent(agent.id);
    return { newAgentId: null, retired: true, pendingPrompt: body.pendingPrompt ?? pendingPrompt };
  }
  const newAgentId: string = body.newAgentId || `demo-bs-${Date.now().toString(36)}`;
  const title: string = body.title || titleFor("brainstorm", laneId, { laneId });
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
        "vs.restart-tokens": String(ut),
        "vs.restart-reason": reason,
        "vs.mock-tokens": "",
      },
    } as unknown as PaseoAgent);
  upsertLocalAgent(createdAgent, agent.id);
  openAgentInTab(newAgentId, pane, agent.id);
  // Remotely the server never saw pendingPrompt, so hand it to the fresh Buddy over the relay instead.
  if (pendingPrompt && isRemote() && body.newAgentId) {
    await sendMessage(newAgentId, pendingPrompt).catch(() => undefined);
  }
  return { newAgentId, title };
}

type DrawerProps = { agent: PaseoAgent; onClose: () => void; onSuccessor?: () => void; active?: boolean };

export const AgentDrawer = memo(function AgentDrawer({ agent, onClose, onSuccessor, active = true }: DrawerProps) {
  useTeams();
  const { entries, error, hasMore, loadingMore, loadMore, loaded } = useTimeline(agent.id, agent.status, active);
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
  const [lastSteered, setLastSteered] = useState<string | null>(null);
  const [permInputs, setPermInputs] = useState<Record<string, string>>({});
  const [dockOpen, setDockOpen] = useState(() => localStorage.getItem("vs.right-dock.open") === "true");

  const imgs = useImageDraft(`${agent.id}:images`);
  const atts = useAttachments(`${agent.id}:files`);
  const ctxSrc = useCtxSources(agent.id);
  const [paneDrop, setPaneDrop] = useState(false);
  setAgentCwd(agent.id, agent.cwd);

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
  const att = attentionOf(agent);

  const runningSubs = entries.filter(
    (e) => e.item?.type === "tool_call" && e.item?.detail?.type === "sub_agent" && e.item?.status === "running",
  ).length;

  const working = useWorkingMembers(agent.id, isBs, team.id, laneId);
  // A sub_agent call that names a running child agent (detail.subAgentId / agentId) is already a chip: count it once.
  // Calls carrying no id can't be matched to a child agent, so they stay counted.
  const workingIds = new Set(working.map((m) => m.agent.id));
  const extraSubs = entries.filter((e) => {
    const d = e.item?.detail;
    return e.item?.type === "tool_call" && d?.type === "sub_agent" && e.item?.status === "running" && !workingIds.has(d.subAgentId ?? d.agentId);
  }).length;

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

  const usedK = Math.round(bsUsedTokens / 1000);
  const warnK = Math.round(warnTokens / 1000);
  const restartK = Math.round(restartTokens / 1000);
  const bsPct = Math.min(100, Math.max(0, (bsUsedTokens / Math.max(1, restartTokens)) * 100));
  const warnPct = Math.min(100, Math.max(0, (warnTokens / Math.max(1, restartTokens)) * 100));
  const bsTone = bsUsedTokens >= restartTokens ? "red" : bsUsedTokens >= warnTokens ? "amber" : "ok";

  useEffect(() => {
    setFeedbackDismissed(localStorage.getItem(feedbackKey) === "1");
  }, [feedbackKey]);

  useEffect(() => {
    if (agent.status !== "running") setLastSteered(null);
  }, [agent.status]);

  useEffect(() => {
    localStorage.setItem("vs.right-dock.open", String(dockOpen));
  }, [dockOpen]);

  useEffect(() => {
    const onOpenDock = () => setDockOpen(true);
    window.addEventListener("vs:open-right-dock", onOpenDock);
    return () => window.removeEventListener("vs:open-right-dock", onOpenDock);
  }, []);

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
      if (restarting) return undefined;
      setRestarting(true);
      try {
        const r = await triggerBrainstormRestart({
          agent,
          teamId,
          laneId,
          reason,
          usedTokens: bsUsedTokens,
          pendingPrompt,
        });
        if (pendingPrompt !== undefined && !r.retired) clearDraft();
        return r;
      } catch (err) {
        alert(`Brainstorm restart failed: ${err}`);
        return undefined;
      } finally {
        setRestarting(false);
      }
    },
    [agent, bsUsedTokens, clearDraft, laneId, restarting, teamId],
  );

  const sendLock = useRef(createSendLock());
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [sendError, setSendError] = useState<string | null>(null);
  const lastBehavior = useRef<ActiveTurnBehavior | null>(null);

  const sendWithBehavior = async (behavior: ActiveTurnBehavior) => {
    if (!draft.trim() && !imgs.images.length && !atts.items.length && !ctxSrc.items.length) return;
    if (sendLock.current.held) return;
    const sentFiles = atts.items;
    const sentCtx = ctxSrc.items;
    const base = draft.trim() ? draft : imgs.images.length ? "(image)" : "";
    const typed = draft;
    setSendError(null);
    lastBehavior.current = behavior;

    await guardedSend({
      lock: sendLock.current,
      clear: () => {
        setBusy(true);
        clearDraft();
      },
      restore: () => setDraft(restoredDraft(typed, draftRef.current)),
      onError: (e) => setSendError(`Send failed: ${e instanceof Error ? e.message : String(e)}`),
      run: async () => {
        const composed = await composeMessage(base, sentFiles, async ({ name, file }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const up = await (daemonClient as any).uploadFile?.({ cwd: agent.cwd, name, file });
          if (!up?.path) throw new Error(`upload of ${name} failed`);
          return up.path as string;
        });
        // Providers that ignore `@dir/` (Gemini) get a time-boxed "Folder: …" listing line appended.
        const expanded = await expandFolderMentions(composed, agent.provider, async (dir) => {
          const res = await daemonClient.listDirectory(agent.cwd ?? "", dir);
          return res.entries.map((e) => ({ path: e.path, kind: e.kind }));
        });
        // @git / @terminal / @chat pills expand into fenced blocks for every provider.
        const text = appendContext(expanded, sentCtx);
        if (imgs.images.length) {
          await sendMessage(agent.id, text, await blobsToPaseoImages(imgs.images), { activeTurnBehavior: behavior });
          rememberSent(agent.id, text, imgs.images);
          imgs.clear();
        } else {
          await sendMessage(agent.id, text, undefined, { activeTurnBehavior: behavior });
        }
        atts.clear();
        ctxSrc.clear();
        if (agent.status === "running" && behavior === "steer") setLastSteered(base || "(files)");
        return true;
      },
    });
    setBusy(false);
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

  return (
    <aside
      className="drawer"
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
          e.preventDefault();
          setPaneDrop(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaneDrop(false);
      }}
      onDrop={(e) => {
        setPaneDrop(false);
        if (e.defaultPrevented) return; // the composer already took it
        e.preventDefault();
        stageFiles(Array.from(e.dataTransfer?.files ?? []), imgs, atts);
      }}
    >
      {paneDrop && (
        <div className="drop-overlay" data-testid="drop-overlay">
          Drop to attach
        </div>
      )}
      <DrawerHeader
        agent={agent}
        agentType={agentType}
        prov={prov}
        used={used}
        budget={budget}
        team={team}
        runningSubs={runningSubs}
        working={working}
        extraSubs={extraSubs}
        laneId={laneId}
        entries={entries}
        active={active}
        onClose={onClose}
        onSuccessor={onSuccessor}
        isBs={isBs}
        isTopicBs={isTopicBs}
        topicName={topicName}
        topicCardId={topicCardId}
        bsUsedTokens={bsUsedTokens}
        warnTokens={warnTokens}
        restartTokens={restartTokens}
        bsTone={bsTone}
        bsPct={bsPct}
        warnPct={warnPct}
        usedK={usedK}
        warnK={warnK}
        restartK={restartK}
        restarting={restarting}
        planHandedOff={planHandedOff}
        doRestart={doRestart}
        summaryOpen={summaryOpen}
        toggleSummary={toggleSummary}
        summaryText={summaryText}
        setSummaryText={setSummaryText}
        summaryPath={summaryPath}
        summaryLoading={summaryLoading}
        summarySaving={summarySaving}
        saveSummary={saveSummary}
        inboxPopoverOpen={inboxPopoverOpen}
        setInboxPopoverOpen={setInboxPopoverOpen}
        inboxDumpText={inboxDumpText}
        setInboxDumpText={setInboxDumpText}
        inboxParking={inboxParking}
        inboxToast={inboxToast}
        parkToInbox={parkToInbox}
        handoffMarked={handoffMarked}
        setHandoffMarked={setHandoffMarked}
        topicHandingOff={topicHandingOff}
        handleTopicHandoff={handleTopicHandoff}
        topicParking={topicParking}
        handleTopicPark={handleTopicPark}
        restartedFrom={restartedFrom}
        feedbackDismissed={feedbackDismissed}
        onFeedback={onFeedback}
        att={att}
        dockOpen={dockOpen}
        onToggleDock={() => setDockOpen((v) => !v)}
      />

      {agent.pendingPermissions?.map((p) => (
        <PermissionCard
          key={p.id}
          p={p}
          agentId={agent.id}
          agentName={agent.title ?? agent.id.slice(0, 8)}
          permInputs={permInputs}
          setPermInputs={setPermInputs}
        />
      ))}

      <div className="drawer-shell">
        <TimelineErrorBoundary fallbackLabel="timeline">
          <Timeline
            agentId={agent.id}
            entries={entries}
            error={error}
            hasMore={hasMore}
            loadingMore={loadingMore}
            loaded={loaded}
            loadMore={loadMore}
            onParkText={(txt) => void parkToInbox(txt, false)}
          />
        </TimelineErrorBoundary>
        {dockOpen && (
          <TimelineErrorBoundary fallbackLabel="dock">
            <RightDock key={agent.id} agent={agent} />
          </TimelineErrorBoundary>
        )}
      </div>

      {!isBs && inboxToast && (
        <div className="brainstorm-inbox-toast" role="status" data-testid="brainstorm-inbox-toast">
          <span>📥 {inboxToast}</span>
        </div>
      )}

      {sendError && (
        <div className="send-error" role="alert" data-testid="send-error">
          {sendError}
          <button className="btn small" data-testid="send-retry" style={{ marginLeft: 8 }} onClick={() => lastBehavior.current && void sendWithBehavior(lastBehavior.current)}>
            Retry
          </button>
        </div>
      )}

      <WorkingBar members={working} subs={extraSubs} />

      <Composer
        agent={agent}
        draft={draft}
        setDraft={setDraft}
        busy={busy}
        isBs={isBs}
        inboxParking={inboxParking}
        lastSteered={lastSteered}
        imgs={imgs}
        atts={atts}
        onSend={send}
        onInterrupt={sendInterrupt}
        onParkToInbox={parkToInbox}
        onToggleInboxPopover={() => setInboxPopoverOpen((v) => !v)}
      />
    </aside>
  );
});
