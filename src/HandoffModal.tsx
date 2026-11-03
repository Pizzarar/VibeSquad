import { useEffect, useMemo, useState } from "react";
import { defaultSpawnConfigFor } from "./antigravity";
import { useDraft } from "./drafts";
import { DEMO, sendMessage, spawnTeamAgent, updateAgent } from "./paseo";
import { buildName, Field, Modal, TITLE_LIMIT, findProfile, useProfiles } from "./TeamActions";
import { postLog } from "./TeamFeed";
import { fmtTok, ordOf, retiredLeadTitle, usedTokens, type Member, type TeamView } from "./teams";

const PARENT = "paseo.parent-agent-id";
const labelsOf = (m: Member) => m.agent.labels as Record<string, string>;

type Packet = { exists: boolean; path: string };

async function packetStatus(team: string, lane: string): Promise<Packet> {
  if (DEMO) return { exists: false, path: `~/.vibesquad/teams/${team}/packet-${lane}.md` };
  const res = await fetch(`/__vibesquad/handoff?team=${encodeURIComponent(team)}&lane=${encodeURIComponent(lane)}`);
  if (!res.ok) throw new Error(`packet check failed (${res.status})`);
  return res.json();
}

async function runHandoff(team: string, lane: string, agentId: string): Promise<Packet & { ran?: boolean; note?: string }> {
  if (DEMO) return { exists: true, path: `~/.vibesquad/teams/${team}/packet-${lane}.md`, ran: true };
  const res = await fetch("/__vibesquad/handoff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ team, lane, agentId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `vs handoff failed (${res.status})`);
  return body;
}

/** Spawn the ord+1 lead, retitle the old lead, re-parent its live lane workers, and log the handoff. */
export function HandoffModal({ view, lead, onClose, onCreated }: { view: TeamView; lead: Member; onClose: () => void; onCreated: (id: string) => void }) {
  const { profiles } = useProfiles();
  const team = view.team;
  const laneId = lead.laneId ?? "";
  const lane = view.lanes.find((l) => l.lane.id === laneId)?.lane;
  const laneName = lane?.name ?? laneId;
  const ord = ordOf(lead.agent);
  const fallbackLeadProfile = lead.agent.provider.startsWith("antigravity-cli") ? "Lead - Gemini" : "Lead - Claude";
  const initialLeadProfile =
    labelsOf(lead).profile === "Lead - Gemini" || labelsOf(lead).profile === "Lead - Claude"
      ? labelsOf(lead).profile
      : fallbackLeadProfile;
  const [targetProfileName, setTargetProfileName] = useState<string>(initialLeadProfile);
  const profile = findProfile(targetProfileName, profiles) ?? findProfile(fallbackLeadProfile, profiles);
  const targetProvider = profile?.provider ?? (targetProfileName === "Lead - Gemini" ? "antigravity-cli" : "claude");
  const targetModel = profile?.model ?? (targetProfileName === "Lead - Gemini" ? "gemini-4-argon" : "claude-opus-5-5");
  const defaults = defaultSpawnConfigFor(targetProvider);
  const next = buildName({
    team: team.id,
    laneId,
    laneName,
    role: "lead",
    profile: profile?.name ?? targetProfileName,
    ord: String(ord + 1),
    topic: "",
    task: "",
    job: "",
  });
  const oldTitle = retiredLeadTitle(laneName || laneId, laneId, ord, labelsOf(lead).job);

  const workers = useMemo(
    () =>
      view.members.filter(
        (m) => m.kind === "worker" && m.laneId === lead.laneId && !m.agent.archivedAt && m.agent.status !== "closed" && labelsOf(m)[PARENT] === lead.agent.id,
      ),
    [view, lead],
  );

  const [title, setTitle] = useState(next.title);
  const [packet, setPacket] = useState<Packet | null>(null);
  const [promptDraft, setPrompt, clearPrompt] = useDraft(`handoff:${lead.agent.id}:prompt`);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    packetStatus(team.id, laneId)
      .then(setPacket)
      .catch((e) => setErr(String(e)));
  }, [team.id, laneId]);

  const packetPath = packet?.path ?? `~/.vibesquad/teams/${team.id}/packet-${laneId}.md`;
  const defaultPrompt = `You are the successor lead for the ${laneName} lane (ord${ord + 1}). Read the handoff packet at ${packetPath} first, then continue the lane. The previous lead is now "${oldTitle}"; its live workers have been re-parented to you. Reply confirming takeover so the previous lead can be retired.`;
  const prompt = promptDraft || defaultPrompt;

  const go = async () => {
    setBusy(true);
    setErr("");
    try {
      let p = packet;
      if (!p?.exists) {
        setStep("Running vs handoff…");
        p = await runHandoff(team.id, laneId, lead.agent.id);
        if (!p.exists) throw new Error(`Packet not found at ${p.path}. Run \`vs handoff\` from the lead first.`);
      }
      setStep("Spawning successor…");
      const r = await spawnTeamAgent({
        provider: targetProvider,
        model: targetModel,
        modeId: profile?.modeId ?? defaults.modeId,
        thinkingOptionId: profile?.thinkingOptionId ?? defaults.thinkingOptionId,
        featureValues: profile?.featureValues,
        notes: profile?.notes,
        approvalPolicy: defaults.approvalPolicy,
        sandbox: defaults.sandbox,
        shareMcp: defaults.shareMcp,
        title,
        labels: { ...next.labels, profile: profile?.name ?? targetProfileName },
        prompt,
        cwd: lead.agent.cwd,
      });
      setStep("Retiring old lead…");
      await updateAgent(lead.agent.id, { name: oldTitle, labels: { ...labelsOf(lead), role: "former-lead", ord: String(ord) } });
      setStep(`Re-parenting ${workers.length} worker(s)…`);
      for (const w of workers) {
        await updateAgent(w.agent.id, { labels: { ...labelsOf(w), [PARENT]: r.id } });
        await sendMessage(w.agent.id, `Report to ${title} (${r.id}).`).catch(() => {});
      }
      await postLog(team.id, {
        type: "handoff",
        agent: title,
        lane: laneId,
        text: `ord${ord} -> ord${ord + 1}: successor spawned (trigger=self), ${workers.length} worker(s) re-parented.`.slice(0, 240),
        refs: [packetPath],
      }).catch(() => {});
      clearPrompt();
      onCreated(r.id);
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
      setStep("");
    }
  };

  return (
    <Modal
      title={`SPAWN SUCCESSOR · ${laneName}`}
      onClose={onClose}
      footer={
        <>
          {err ? <span className="stat-alert small">{err}</span> : step ? <span className="muted small">{step}</span> : null}
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn hot" disabled={busy || !title.trim() || title.length > TITLE_LIMIT || !prompt.trim()} onClick={go}>
            {busy ? "Working…" : `Spawn ord${ord + 1}`}
          </button>
        </>
      }
    >
      <div className="muted small" style={{ marginBottom: 8 }}>
        Current lead {lead.agent.title} · {fmtTok(usedTokens(lead))} context
      </div>
      <Field label="New title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <div className="pills" style={{ margin: "8px 0", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <span className="chip">
          {targetProvider}/{targetModel} ({profile?.name ?? targetProfileName})
        </span>
        <button
          type="button"
          className="btn ghost small"
          data-testid="handoff-switch-provider-btn"
          onClick={() => setTargetProfileName((prev) => (prev === "Lead - Gemini" ? "Lead - Claude" : "Lead - Gemini"))}
        >
          ⇄ Switch Provider (Claude ↔ Gemini)
        </button>
        <span className="chip">role=lead ord={ord + 1}</span>
        <span className="chip">old → {oldTitle} (role=former-lead)</span>
        <span className="chip">{workers.length} worker(s) re-parented</span>
      </div>
      <div className={`handoff-packet ${packet?.exists ? "ok" : "warn"}`}>
        {packet?.exists ? "Packet ready" : "No packet yet · confirming runs `vs handoff`"}
        <code>{packetPath}</code>
      </div>
      <Field label="Initial prompt">
        <textarea rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </Field>
    </Modal>
  );
}
