import { memo, useCallback, useEffect, useRef, useState } from "react";
import { expandFolderMentions } from "./projectContext";
import { appendContext, useCtxSources } from "./contextSources";
import type { PaseoAgent } from "./agentTypes";
import type { ActiveTurnBehavior } from "./agentTypes";
import { removeLocalAgent, sendMessage, updateAgent, upsertLocalAgent } from "./paseo";
import { runnerSpawn } from "./runnerBridge";
import { vsListDirectory } from "./vsFiles";
import { DEMO } from "./demoFlag";
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
  kindOf,
  teamForAgent,
  topicOfBrainstorm,
  usedTokens,
  useTeams,
} from "./teams";
import { titleFor } from "./teams";
import { handoffTopicBrainstormClient, parkIdeasInInbox, parkTopicBrainstormClient } from "./IdeaInbox";
import { providerSpec } from "./pixel";
import { openAgentInTab, paneOfAgent } from "./panes";
import { setLastBrainstormProfile } from "./pinActions";
import { useTimeline, Timeline, TimelineErrorBoundary, stripBootPreamble } from "./Timeline";
import { PermissionCard } from "./PermissionCard";
import { Composer, formatBtwPrompt, shouldQueueOnSend, type QueuedTurnItem } from "./Composer";
import { composeMessage, setAgentCwd, stageFiles, useAttachments } from "./attachments";
import { DrawerHeader, normalizeProviderId, type ProviderSwitchTarget } from "./DrawerHeader";
import { useWorkingMembers } from "./WorkingBar";
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
  profileName?: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string | null;
}): Promise<{ newAgentId: string | null; title?: string; retired?: boolean; pendingPrompt?: string }> {
  const { agent, teamId, laneId, reason, usedTokens: ut, pendingPrompt, summaryUpdate, profileName, model, modeId, thinkingOptionId } = opts;
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
      // profileName / model / modeId / thinkingOptionId are whitelisted body keys: safe across the remote relay.
      ...(profileName ? { profileName } : {}),
      ...(model ? { model } : {}),
      ...(modeId ? { modeId } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
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

/** `chatOnly` (sky-gods zones): messages + composer only. The right dock (Changes/Files/Terminal) is never rendered, never read from or written to the shared `vs.right-dock.open` key, and `vs:open-right-dock` is ignored. */
type DrawerProps = { agent: PaseoAgent; onClose: () => void; onSuccessor?: () => void; active?: boolean; chatOnly?: boolean };

async function flushQueued(agentId: string, text: string, images: Array<{ blob: Blob }>) {
  if (images.length) {
    await sendMessage(agentId, text, await blobsToPaseoImages(images), { activeTurnBehavior: "steer" });
    rememberSent(agentId, text, images);
  } else {
    await sendMessage(agentId, text, undefined, { activeTurnBehavior: "steer" });
  }
}

export const AgentDrawer = memo(function AgentDrawer({ agent, onClose, onSuccessor, active = true, chatOnly = false }: DrawerProps) {
  useTeams();
  const labels = (agent.labels ?? {}) as Record<string, string>;
  const prov = providerSpec(agent.provider);
  const restartedFrom = labels["vs.restarted-from"] || "";
  const predecessorId = restartedFrom && restartedFrom !== "start-brainstorm" ? restartedFrom : undefined;
  const switchLabel = `${prov.symbol} ${prov.name}${agent.model ? ` (${agent.model})` : ""}`;
  const { entries, error, hasMore, loadingMore, loadMore, loaded } = useTimeline(agent.id, agent.status, active, predecessorId, switchLabel);
  const [stagedSwitch, setStagedSwitch] = useState<ProviderSwitchTarget | null>(null);
  const [draft, setDraft, clearDraft] = useDraft(`${agent.id}:draft`);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryText, setSummaryText] = useState<string>("");
  const [summaryPath, setSummaryPath] = useState<string>("");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summarySaving, setSummarySaving] = useState(false);
  const [inboxPopoverOpen, setInboxPopoverOpen] = useState(false);
  const [inboxDumpText, setInboxDumpText] = useState("");
  const [inboxParking, setInboxParking] = useState(false);
  const [inboxToast, setInboxToast] = useState("");
  const [topicHandingOff, setTopicHandingOff] = useState(false);
  const [topicParking, setTopicParking] = useState(false);
  const feedbackKey = `vs.restart-feedback.${agent.id}`;
  const [feedbackDismissed, setFeedbackDismissed] = useState(() => localStorage.getItem(feedbackKey) === "1");
  const [lastSteered, setLastSteered] = useState<string | null>(null);
  const [queuedByAgent, setQueuedByAgent] = useState<Record<string, QueuedTurnItem[]>>({});
  const queuedItems = queuedByAgent[agent.id] ?? [];
  const [permInputs, setPermInputs] = useState<Record<string, string>>({});
  const [dockOpen, setDockOpen] = useState(() => !chatOnly && localStorage.getItem("vs.right-dock.open") === "true");

  const imgs = useImageDraft(`${agent.id}:images`);
  const atts = useAttachments(`${agent.id}:files`);
  const ctxSrc = useCtxSources(agent.id);
  const [paneDrop, setPaneDrop] = useState(false);
  setAgentCwd(agent.id, agent.cwd);

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
  const teamId = labels.team || team.id || "vibesquad";
  const laneId = (labels.lane || labels.lead || resolvedLaneId || team.lanes?.[0]?.id || "vibesquad").toLowerCase();
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
  const planHandedOff = isBs && PLAN_HANDOFF_RE.test(lastAssistantMsg);

  const usedK = Math.round(bsUsedTokens / 1000);
  const warnK = Math.round(warnTokens / 1000);
  const restartK = Math.round(restartTokens / 1000);
  const bsPct = Math.min(100, Math.max(0, (bsUsedTokens / Math.max(1, restartTokens)) * 100));
  const warnPct = Math.min(100, Math.max(0, (warnTokens / Math.max(1, restartTokens)) * 100));
  const bsTone = bsUsedTokens >= restartTokens ? "red" : bsUsedTokens >= warnTokens ? "amber" : "ok";

  useEffect(() => {
    setFeedbackDismissed(localStorage.getItem(feedbackKey) === "1");
  }, [feedbackKey]);

  // A staged (not-yet-committed) provider switch is specific to one agent: drop it when the drawer changes agent.
  useEffect(() => {
    setStagedSwitch(null);
  }, [agent.id]);

  useEffect(() => {
    if (agent.status !== "running") setLastSteered(null);
  }, [agent.status]);

  useEffect(() => {
    if (!chatOnly) localStorage.setItem("vs.right-dock.open", String(dockOpen));
  }, [dockOpen, chatOnly]);

  useEffect(() => {
    if (agent.status !== "running" && agent.status !== "closed" && queuedItems.length > 0) {
      const combinedText = queuedItems.map((q) => q.text).join("\n\n");
      const queuedBlobs = queuedItems.flatMap((q) => q.images ?? []);
      setQueuedByAgent((prev) => {
        const next = { ...prev };
        delete next[agent.id];
        return next;
      });
      void flushQueued(agent.id, combinedText, queuedBlobs);
    }
  }, [agent.id, agent.status, queuedItems.length]);

  useEffect(() => {
    if (chatOnly) return;
    const onOpenDock = () => setDockOpen(true);
    window.addEventListener("vs:open-right-dock", onOpenDock);
    return () => window.removeEventListener("vs:open-right-dock", onOpenDock);
  }, [chatOnly]);

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
    async (reason: string, pendingPrompt?: string, profileName?: string, model?: string, modeId?: string, thinkingOptionId?: string | null) => {
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
          profileName,
          model,
          modeId,
          thinkingOptionId,
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

  const sendWithBehavior = async (behavior: ActiveTurnBehavior, overrideText?: string, forceImmediate = false) => {
    if (!draft.trim() && !imgs.images.length && !atts.items.length && !ctxSrc.items.length && overrideText === undefined) return;
    if (sendLock.current.held) return;
    const sentFiles = atts.items;
    const sentCtx = ctxSrc.items;
    const base = overrideText !== undefined ? overrideText : draft.trim() ? draft : imgs.images.length ? "(image)" : "";
    const formattedBase = formatBtwPrompt(base);
    const typed = draft;
    setSendError(null);
    lastBehavior.current = behavior;

    if (behavior === "steer" && shouldQueueOnSend(agent.status, forceImmediate) && !stagedSwitch && overrideText === undefined) {
      // Attachments queue like text: snapshot the composed text + image blobs now, the idle flush sends both.
      try {
        const composed = await composeMessage(formattedBase, sentFiles);
        const expanded = await expandFolderMentions(composed, agent.provider, async (dir) => {
          const res = await vsListDirectory(agent.cwd ?? "", dir);
          return res.entries.map((e) => ({ path: e.path, kind: e.kind }));
        });
        const queuedText = appendContext(expanded, sentCtx);
        const queuedImages = imgs.images.map((im) => ({ name: im.name, mimeType: im.mimeType, blob: im.blob }));
        setQueuedByAgent((prev) => ({
          ...prev,
          [agent.id]: [
            ...(prev[agent.id] ?? []),
            {
              id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              text: queuedText,
              createdAt: Date.now(),
              ...(queuedImages.length ? { images: queuedImages } : {}),
            },
          ],
        }));
        clearDraft();
        imgs.clear();
        atts.clear();
        ctxSrc.clear();
      } catch (e) {
        setSendError(`Queue failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    await guardedSend({
      lock: sendLock.current,
      clear: () => {
        setBusy(true);
        clearDraft();
      },
      restore: () => setDraft(restoredDraft(typed, draftRef.current)),
      onError: (e) => setSendError(`Send failed: ${e instanceof Error ? e.message : String(e)}`),
      run: async () => {
        // Small text files are inlined; large/binary files were rejected at drop time (no upload route).
        const composed = await composeMessage(formattedBase, sentFiles);
        // Providers that ignore `@dir/` (Gemini) get a time-boxed "Folder: …" listing line appended.
        const expanded = await expandFolderMentions(composed, agent.provider, async (dir) => {
          const res = await vsListDirectory(agent.cwd ?? "", dir);
          return res.entries.map((e) => ({ path: e.path, kind: e.kind }));
        });
        // @git / @terminal / @chat pills expand into fenced blocks for every provider.
        const text = appendContext(expanded, sentCtx);

        // Seamless provider switch: the user staged a new provider in the top bar, so hand the message to it now.
        if (stagedSwitch && normalizeProviderId(stagedSwitch.provider) !== normalizeProviderId(agent.provider)) {
          const switchTarget = stagedSwitch;
          const turnsText = entries
            .slice(-12)
            .map((e) => {
              const it = e.item;
              if (it?.type === "user_message" && typeof it.text === "string") return `User: ${stripBootPreamble(it.text)}`;
              if (it?.type === "assistant_message" && typeof it.text === "string") return `Assistant: ${it.text}`;
              return null;
            })
            .filter((line): line is string => typeof line === "string")
            .join("\n");
          const recentTurnsAndMessage = turnsText
            ? `Recent conversation before provider switch:\n\n${turnsText}\n\nUser message to answer now:\n${text}`
            : text;
          setStagedSwitch(null);
          const nextLabels = {
            ...labels,
            ...(switchTarget.profile ? { profile: switchTarget.profile } : {}),
          };
          // A Lead's live labels.profile must stay intact: the successor is spawned, this agent isn't flipped in place.
          if (kindOf(agent) !== "lead") await updateAgent(agent.id, { labels: nextLabels });
          if (isBs) {
            if (switchTarget.profile) setLastBrainstormProfile(switchTarget.profile);
            await doRestart("provider-switch", recentTurnsAndMessage, switchTarget.profile, switchTarget.model, switchTarget.modeId, switchTarget.thinkingOptionId);
          } else if (kindOf(agent) === "lead" && onSuccessor) {
            onSuccessor();
          } else {
            const spawned = await runnerSpawn({
              config: {
                provider: switchTarget.provider,
                model: switchTarget.model,
                modeId: switchTarget.modeId,
                ...(switchTarget.thinkingOptionId ? { thinkingOptionId: switchTarget.thinkingOptionId } : {}),
                cwd: agent.cwd,
                title: agent.title ?? agent.id,
              },
              initialPrompt: recentTurnsAndMessage,
              labels: { ...nextLabels, "vs.restarted-from": agent.id, "vs.restart-reason": "provider-switch", "profile-override": "1" },
              // Keep the staged model/mode/thinking against the plugin's profile enforcement.
              env: { VS_PROFILE_OVERRIDE: "1" },
            });
            const newId = spawned.id;
            if (spawned) upsertLocalAgent(spawned);
            if (newId) openAgentInTab(newId, paneOfAgent(agent.id), agent.id);
          }
          imgs.clear();
          atts.clear();
          ctxSrc.clear();
          return true;
        }

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

  const sendQueuedNow = async () => {
    const items = queuedByAgent[agent.id] ?? [];
    if (!items.length) return;
    const combinedText = items.map((q) => q.text).join("\n\n");
    const queuedBlobs = items.flatMap((q) => q.images ?? []);
    setQueuedByAgent((prev) => {
      const next = { ...prev };
      delete next[agent.id];
      return next;
    });
    await flushQueued(agent.id, combinedText, queuedBlobs);
    setLastSteered(combinedText);
  };

  const cancelQueued = (id?: string) => {
    const items = queuedByAgent[agent.id] ?? [];
    const removed = id ? items.find((q) => q.id === id) : items[0];
    setQueuedByAgent((prev) => {
      const list = prev[agent.id] ?? [];
      const rest = id ? list.filter((q) => q.id !== id) : list.slice(1);
      return { ...prev, [agent.id]: rest };
    });
    if (removed && !draft.trim()) setDraft(removed.text);
    if (removed?.images?.length) imgs.add(removed.images.map((im) => new File([im.blob], im.name, { type: im.mimeType })));
  };

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
        void stageFiles(Array.from(e.dataTransfer?.files ?? []), imgs, atts).then((note) => atts.setNotice(note));
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
        stagedSwitch={stagedSwitch}
        onStageSwitch={setStagedSwitch}
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
        topicHandingOff={topicHandingOff}
        handleTopicHandoff={handleTopicHandoff}
        topicParking={topicParking}
        handleTopicPark={handleTopicPark}
        restartedFrom={restartedFrom}
        feedbackDismissed={feedbackDismissed}
        onFeedback={onFeedback}
        att={att}
        dockOpen={dockOpen}
        onToggleDock={() => !chatOnly && setDockOpen((v) => !v)}
        chatOnly={chatOnly}
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
            agentStatus={agent.status}
            queuedAhead={(agent as { queued?: { ahead: number } }).queued?.ahead}
            agentTitle={agent.title}
            entries={entries}
            error={error}
            hasMore={hasMore}
            loadingMore={loadingMore}
            loaded={loaded}
            loadMore={loadMore}
            onParkText={(txt) => void parkToInbox(txt, false)}
          />
        </TimelineErrorBoundary>
        {dockOpen && !chatOnly && (
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
        queuedItems={queuedItems}
        onSendQueuedNow={() => void sendQueuedNow()}
        onCancelQueued={cancelQueued}
      />
    </aside>
  );
});
