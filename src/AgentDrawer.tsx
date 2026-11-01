import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import { DEMO, sendMessage, upsertLocalAgent } from "./paseo";
import { useDraft } from "./drafts";
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
import { handoffTopicBrainstormClient, parkIdeasInInbox, parkTopicBrainstormClient } from "./IdeaInbox";
import { providerSpec } from "./pixel";
import { openAgentInTab, paneOfAgent } from "./panes";
import { useTimeline, Timeline } from "./Timeline";
import { PermissionCard } from "./PermissionCard";
import { Composer } from "./Composer";
import { DrawerHeader } from "./DrawerHeader";
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
}): Promise<{ newAgentId: string; title?: string }> {
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
        "vs.restart-tokens": String(ut),
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
  const [dockOpen, setDockOpen] = useState(() => localStorage.getItem("vs.right-dock.open") === "true");

  const imgs = useImageDraft(`${agent.id}:images`);

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

  return (
    <aside className="drawer">
      <DrawerHeader
        agent={agent}
        agentType={agentType}
        prov={prov}
        used={used}
        budget={budget}
        team={team}
        runningSubs={runningSubs}
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
          permInputs={permInputs}
          setPermInputs={setPermInputs}
        />
      ))}

      <div className="labels">
        {Object.entries(labels)
          .filter(([k]) => !k.startsWith("paseo.open-agent-tab"))
          .map(([k, v]) => (
            <span key={k} className="chip">
              {k}={v}
            </span>
          ))}
      </div>

      <div className="drawer-shell">
        <Timeline
          agentId={agent.id}
          entries={entries}
          error={error}
          onParkText={(txt) => void parkToInbox(txt, false)}
        />
        {dockOpen && <RightDock agent={agent} />}
      </div>

      {!isBs && inboxToast && (
        <div className="brainstorm-inbox-toast" role="status" data-testid="brainstorm-inbox-toast">
          <span>📥 {inboxToast}</span>
        </div>
      )}

      <Composer
        agent={agent}
        draft={draft}
        setDraft={setDraft}
        busy={busy}
        isBs={isBs}
        inboxParking={inboxParking}
        lastSteered={lastSteered}
        imgs={imgs}
        onSend={send}
        onInterrupt={sendInterrupt}
        onParkToInbox={parkToInbox}
        onToggleInboxPopover={() => setInboxPopoverOpen((v) => !v)}
      />
    </aside>
  );
});
