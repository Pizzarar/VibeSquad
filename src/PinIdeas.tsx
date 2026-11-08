// Pinned teams step 6 (docs/PLAN_PINNED_FEATURES.md §5): idea capture. The misroute card
// ("Send to <Team> ↗ · Dismiss") on a tile and above the focused drawer, the overview "+" idea box,
// and the toast both report to. Side effects live in src/pinActions.ts.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { bestOverlap, DEFAULT_PIN_PROFILE, findPinInViews, hubPinForSquad, looksDoneFor, nameFromIdea, sendToFrom, spinOffCardId, pinsForSquad, describeSpinOff, isSpinOffRunning, spinOffFrom, spinOffRemaining, spinOffVersion, subscribeSpinOff, type Pin } from "./pins";
import { createPin, dismissedVersion, subscribeDismissed, createSpinOffPins, dismissSendTo, dismissSpinOff, isSpinOffDismissed, getLastBrainstormProfile, isSendToDismissed, sendIdeaToTeam, setLastBrainstormProfile } from "./pinActions";
import { spinUpPin } from "./pinFocus";
import { getTeams, type TeamView } from "./teams";
import { useLooksDoneId, type PinHandler } from "./PinGrid";
import { LooksDoneCard } from "./PinDone";
import { derived } from "./ui";
import { useProfiles } from "./profiles";

// ── Toast ──────────────────────────────────────────────────────────────────
let toast = "";
let toastTimer: ReturnType<typeof setTimeout> | null = null;
const toastListeners = new Set<() => void>();

/** The server saved a brief in its runtime folder (lane folder not found); say so instead of silently losing it. */
export const briefFallbackWarning = (laneIds: string[]) =>
  laneIds.length ? `Brief for ${laneIds.join(", ")} was saved in the app folder, not the project. Check the lane path.` : "";

/** A plain toast plus the fallback warning, so the later "Pinned ..." toast can't hide it. */
export const withBriefWarning = (msg: string, laneIds: string[]) => [msg, briefFallbackWarning(laneIds)].filter(Boolean).join(" · ");

export function showPinToast(msg: string) {
  toast = msg;
  toastListeners.forEach((l) => l());
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast = "";
    toastListeners.forEach((l) => l());
  }, 4000);
}

/** Mounted once (App). */
export function PinToast() {
  const msg = useSyncExternalStore(
    (l) => {
      toastListeners.add(l);
      return () => toastListeners.delete(l);
    },
    () => toast,
  );
  if (!msg) return null;
  return (
    <div className="pin-toast" role="status" data-testid="pin-toast">
      {msg}
    </div>
  );
}

// ── Misroute offer (vs:send-to marker in the newest Brainstorm message) ───────
export type SendToOffer = { id: string; laneId: string; text: string; legacyIds?: string[] };
type TimelineEntry = { item: any; seqStart?: number; timestamp?: string };

// Offer per Brainstorm, fed by PinGrid's usePreview loads (tiles and rail) so nothing fetches twice.
const offers = new Map<string, SendToOffer | null>();
const offerListeners = new Set<() => void>();

export function noteSendTo(agentId: string, entries: TimelineEntry[]) {
  noteSpinOff(agentId, entries);
  const next = sendToFrom(agentId, entries);
  const cur = offers.get(agentId) ?? null;
  if (cur?.id === next?.id && cur?.text === next?.text) return;
  offers.set(agentId, next);
  offerListeners.forEach((l) => l());
}

export function useSendTo(agentId: string | null): SendToOffer | null {
  return useSyncExternalStore(
    (l) => {
      offerListeners.add(l);
      return () => offerListeners.delete(l);
    },
    () => (agentId ? (offers.get(agentId) ?? null) : null),
  );
}

// ── Spin-off offer (vs:spin-off fence in the newest Brainstorm message) ───────
export type SpinOffOffer = { id: string; teams: { name: string; brief: string }[] };
const spinOffs = new Map<string, SpinOffOffer | null>();

function noteSpinOff(agentId: string, entries: TimelineEntry[]) {
  const next = spinOffFrom(agentId, entries) as SpinOffOffer | null;
  const cur = spinOffs.get(agentId) ?? null;
  if (cur?.id === next?.id && JSON.stringify(cur?.teams) === JSON.stringify(next?.teams)) return;
  spinOffs.set(agentId, next);
  offerListeners.forEach((l) => l());
}

export function useSpinOff(agentId: string | null): SpinOffOffer | null {
  return useSyncExternalStore(
    (l) => {
      offerListeners.add(l);
      return () => offerListeners.delete(l);
    },
    () => (agentId ? (spinOffs.get(agentId) ?? null) : null),
  );
}

/** "Spin up 3 Teams: A, B, C · Not yet". One click pins them all in this Squad; no Buddies start. */
export function SpinOffCard({ pin, offer, variant = "tile" }: { pin: Pin; offer: SpinOffOffer; variant?: "tile" | "bar" }) {
  const [hidden, setHidden] = useState(() => isSpinOffDismissed(offer.id));
  const dv = useSyncExternalStore(subscribeDismissed, dismissedVersion);
  useEffect(() => setHidden(isSpinOffDismissed(offer.id)), [offer.id, dv]);
  useSyncExternalStore(subscribeSpinOff, spinOffVersion);
  const busy = isSpinOffRunning(offer.id);
  const teams = spinOffRemaining(offer.id, offer.teams);
  if (hidden || !teams.length) return null;
  const n = teams.length;
  const go = async () => {
    const fellBack: string[] = [];
    const results = await createSpinOffPins(offer.id, pin.squad.id, offer.teams, { onBriefFallback: (id) => fellBack.push(id) }); // the full list: runSpinOffOnce skips the rows already created
    if (!results) return; // already running (double click, or the other card)
    showPinToast(withBriefWarning(describeSpinOff(results), fellBack));
    if (results.every((r) => r.pin)) {
      dismissSpinOff(offer.id);
      setHidden(true);
    }
  };
  return (
    <div className={`pin-send-to ${variant}`} data-testid={`pin-spin-off-${pin.lane.id}`} onClick={(e) => e.stopPropagation()}>
      <span className="pin-send-to-text" title={teams.map((t) => `${t.name}: ${t.brief}`).join("\n")}>
        Spin up {n} Team{n === 1 ? "" : "s"}: {teams.map((t) => t.name).join(", ")}
      </span>
      <button type="button" className="btn ok small" disabled={busy} data-testid={`pin-spin-off-go-${pin.lane.id}`} onClick={() => void go()}>
        {busy ? "…" : `Spin up ${n} ↗`}
      </button>
      <button
        type="button"
        className="btn ghost small"
        data-testid={`pin-spin-off-no-${pin.lane.id}`}
        onClick={() => {
          dismissSpinOff(offer.id);
          setHidden(true);
        }}
      >
        Not yet
      </button>
    </div>
  );
}

const laneName = (laneId: string): string | null => {
  const needle = laneId.trim().toLowerCase();
  for (const t of getTeams())
    for (const l of t.lanes)
      if (l.id.toLowerCase() === needle || (l.aliases ?? []).some((a) => a.toLowerCase() === needle)) return l.name;
  return null;
};

/**
 * "<idea> · Send to <Team> ↗ · Dismiss". A one-line idea sends on one click; a longer one opens the full text
 * first, so what gets sent to B's Brainstorm (or parked in B's inbox) is always what you saw.
 */
export function SendToCard({ pin, offer, variant = "tile" }: { pin: Pin; offer: SendToOffer; variant?: "tile" | "bar" }) {
  const [hidden, setHidden] = useState(() => isSendToDismissed(offer.id, offer.legacyIds));
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const dv = useSyncExternalStore(subscribeDismissed, dismissedVersion);
  useEffect(() => {
    setHidden(isSendToDismissed(offer.id, offer.legacyIds));
    setPreview(false);
  }, [offer.id, offer.text, dv]);
  if (hidden || !offer.text) return null;
  const target = laneName(offer.laneId);
  const lines = offer.text.split("\n");
  const multiLine = lines.length > 1;
  const sendLabel = target ? `Send to ${target} ↗` : "Park in inbox ↗";
  const send = async () => {
    setPreview(false);
    setBusy(true);
    try {
      showPinToast(await sendIdeaToTeam(offer.laneId, offer.text, pin.lane.name));
      dismissSendTo(offer.id);
      setHidden(true);
    } catch (e) {
      showPinToast(`Could not send: ${(e as Error)?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`pin-send-to ${variant}`} data-testid={`pin-send-to-${pin.lane.id}`} onClick={(e) => e.stopPropagation()}>
      <span className="pin-send-to-text" title={offer.text}>
        {lines[0]}
      </span>
      {multiLine && <span className="muted small pin-send-to-more">+{lines.length - 1} more lines</span>}
      <button
        type="button"
        className="btn ok small"
        disabled={busy}
        data-testid={`pin-send-to-go-${pin.lane.id}`}
        onClick={() => (multiLine ? setPreview(true) : void send())}
      >
        {busy ? "…" : sendLabel}
      </button>
      {preview &&
        createPortal(
        <div className="modal-back" onClick={() => setPreview(false)}>
          <div
            className="modal pin-send-preview"
            role="dialog"
            aria-label="Send idea"
            data-testid={`pin-send-preview-${pin.lane.id}`}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setPreview(false);
              }
            }}
          >
            <div className="modal-head">
              <span>{target ? `SEND TO ${target.toUpperCase()}` : "PARK IN INBOX"}</span>
              <button type="button" className="btn ghost small" onClick={() => setPreview(false)} title="Close (Esc)">
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="muted small">This whole message gets sent:</div>
              <pre className="pin-send-preview-text" data-testid={`pin-send-preview-text-${pin.lane.id}`}>
                {offer.text}
              </pre>
            </div>
            <div className="modal-foot pin-idea-actions">
              <button type="button" className="btn ghost" onClick={() => setPreview(false)}>
                Cancel
              </button>
              <button type="button" className="btn ok" autoFocus data-testid={`pin-send-confirm-${pin.lane.id}`} onClick={() => void send()}>
                {sendLabel}
              </button>
            </div>
          </div>
        </div>,
          document.body,
        )}
      <button
        type="button"
        className="btn ghost small"
        onClick={() => {
          dismissSendTo(offer.id);
          setHidden(true);
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

export const findPinForAgent = (agentId?: string | null): Pin | null => findPinInViews(derived().views, agentId);

/** The card above the focused drawer (rendered in PinFocusHeader). */
export function SendToBar({ pin }: { pin: Pin }) {
  const bsId = pin.brainstorm?.agent.id ?? null;
  const offer = useSendTo(bsId);
  const spin = useSpinOff(bsId);
  const looksDoneId = looksDoneFor(pin, useLooksDoneId(bsId));
  return (
    <>
      {looksDoneId && <LooksDoneCard pin={pin} messageId={looksDoneId} />}
      {offer && <SendToCard pin={pin} offer={offer} variant="bar" />}
      {spin && <SpinOffCard pin={pin} offer={spin} variant="bar" />}
    </>
  );
}

// ── Overview "+": type an idea, pick a team or make a new one ────────────────

export function describeIdeaAction(opts: {
  mode: "new" | "existing";
  teamName: string;
  profile: string;
  targetPin?: { lane: { name: string }; brainstorm: unknown | null } | null;
}): string {
  if (opts.mode === "new") {
    return `Creates "${opts.teamName.trim() || "New team"}", puts your idea in its brief, and starts ${opts.profile || DEFAULT_PIN_PROFILE}. No lead until you approve a plan.`;
  }
  if (opts.targetPin?.brainstorm) {
    return `Goes to ${opts.targetPin.lane.name}'s Buddy.`;
  }
  if (opts.targetPin) {
    return `Wakes ${opts.targetPin.lane.name}'s Buddy and sends your idea.`;
  }
  return `Goes to team's inbox (no Buddy live).`;
}

export function submitButtonLabel(opts: {
  busy: boolean;
  mode: "new" | "existing";
  targetTeamName?: string;
}): string {
  if (opts.busy) return "…";
  if (opts.mode === "new") return "Create team";
  return `Send to ${opts.targetTeamName || "team"}`;
}

export function resolveIdeaTeamName(typedName: string, ideaText: string): string {
  return typedName.trim() || nameFromIdea(ideaText).trim();
}

export function ideaModalFieldOrder(mode: "new" | "existing"): string[] {
  return mode === "new" ? ["tabs", "name", "idea", "buddy"] : ["tabs", "idea", "team"];
}

export function IdeaBox({
  view,
  onClose,
  onQuickStart,
  presetMode,
}: {
  view: TeamView;
  onClose: () => void;
  onQuickStart: PinHandler;
  presetMode?: "new" | "existing";
}) {
  const { pinned } = pinsForSquad(view);
  const [text, setText] = useState("");
  const [name, setName] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const { profiles } = useProfiles();
  const bsProfiles = useMemo(() => {
    const bs = profiles.filter((p) => p.role === "brainstorm");
    return bs.length > 0 ? bs : [{ name: "Brainstorm - Claude" }, { name: "Brainstorm - Gemini" }];
  }, [profiles]);

  const [selectedProfile, setSelectedProfile] = useState(
    () => pinned[0]?.lane.lastProfile ?? getLastBrainstormProfile(DEFAULT_PIN_PROFILE),
  );
  const [existingTargetId, setExistingTargetId] = useState<string>(pinned[0]?.lane.id ?? "");
  const [mode, setMode] = useState<"new" | "existing">(() => presetMode ?? "new");

  const match = useMemo(() => (text.trim() ? bestOverlap(text, pinned.map((p) => p.lane)) : null), [text, pinned]);
  const effectiveTeamName = resolveIdeaTeamName(name, text);
  useEffect(() => {
    if (mode === "new") nameRef.current?.focus();
    else ref.current?.focus();
  }, [mode]);
  const targetPin = pinned.find((p) => p.lane.id === existingTargetId) ?? null;

  const submit = async () => {
    const rawIdea = text.trim() || (mode === "new" ? name.trim() : "");
    if (!rawIdea || busy) return;
    setBusy(true);
    setErr(null);
    try {
      if (mode === "existing" && existingTargetId) {
        showPinToast(await sendIdeaToTeam(existingTargetId, rawIdea));
        onClose();
        return;
      }
      setLastBrainstormProfile(selectedProfile);
      const fellBack: string[] = [];
      const pin = await createPin(view.team.id, resolveIdeaTeamName(name, rawIdea) || "New team", rawIdea, { lastProfile: selectedProfile, onBriefFallback: (id) => fellBack.push(id) });
      onClose();
      showPinToast(withBriefWarning(`Pinned ${pin.lane.name}`, fellBack));
      await onQuickStart(pin);
      await spinUpPin(pin, selectedProfile);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
      setBusy(false);
    }
  };

  const overlapHint = mode === "new" && match ? match.lane : null;
  return (
    <div className="modal-back" onClick={onClose}>
      <div
        className="modal pin-idea-box"
        role="dialog"
        aria-label="New idea"
        data-testid="pin-idea-box"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className="modal-head">
          <span>NEW IDEA</span>
          <button type="button" className="btn ghost small" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="seg pin-idea-seg" data-testid="pin-idea-mode-seg">
            <button
              type="button"
              className={mode === "new" ? "on" : ""}
              data-testid="pin-idea-mode-new"
              onClick={() => setMode("new")}
            >
              ＋ New team
            </button>
            <button
              type="button"
              className={mode === "existing" ? "on" : ""}
              data-testid="pin-idea-mode-existing"
              disabled={pinned.length === 0}
              onClick={() => setMode("existing")}
            >
              Add to existing team ▾
            </button>
          </div>
          {mode === "new" && (
            <div className="pin-idea-field">
              <label className="muted small" htmlFor="pin-idea-name">
                Name
              </label>
              <input
                id="pin-idea-name"
                ref={nameRef}
                data-testid="pin-idea-name"
                style={{ width: "100%", minWidth: 220 }}
                value={name}
                placeholder="Team name (or leave blank to use line 1)"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (text.trim()) void submit();
                    else ref.current?.focus();
                  }
                }}
              />
            </div>
          )}
          <textarea
            ref={ref}
            value={text}
            rows={4}
            placeholder="I just thought of…"
            data-testid="pin-idea-text"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {overlapHint && (
            <div className="pin-idea-hint small" data-testid="pin-idea-overlap">
              Sounds like {overlapHint.name}.{" "}
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  setExistingTargetId(overlapHint.id);
                  setMode("existing");
                }}
              >
                Use it
              </button>
              <span className="muted"> · or make a new team</span>
            </div>
          )}
          {mode === "new" && (
            <div className="pin-idea-field">
              <label className="muted small">Buddy</label>
              <div className="pin-profile-chips" data-testid="pin-idea-profile-chips">
                {bsProfiles.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    data-testid={`pin-profile-chip-${p.name}`}
                    className={`tchip ${selectedProfile === p.name ? "on" : ""}`}
                    aria-pressed={selectedProfile === p.name}
                    onClick={() => setSelectedProfile(p.name)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {mode === "existing" && (
            <div className="pin-idea-field">
              <label className="muted small" htmlFor="pin-idea-team">
                Team
              </label>
              <select
                id="pin-idea-team"
                data-testid="pin-idea-team"
                value={existingTargetId}
                onChange={(e) => setExistingTargetId(e.target.value)}
              >
                {pinned.map((p) => (
                  <option key={p.lane.id} value={p.lane.id}>
                    {p.lane.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="muted small pin-idea-foot" data-testid="pin-idea-live-sentence">
            {describeIdeaAction({ mode, teamName: effectiveTeamName, profile: selectedProfile, targetPin: mode === "existing" ? targetPin : null })}
          </div>
          {err && <div className="stat-alert small">{err}</div>}
        </div>
        <div className="modal-foot pin-idea-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn ok"
            disabled={busy || (mode === "existing" ? !text.trim() : !effectiveTeamName)}
            data-testid="pin-idea-submit"
            onClick={() => void submit()}
          >
            {submitButtonLabel({ busy, mode, targetTeamName: mode === "existing" ? (targetPin?.lane.name ?? "team") : undefined })}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The "+" tile and "New team" tile at the end of the squad grid. */
export function IdeaPlusTile({ view, onQuickStart }: { view: TeamView; onQuickStart: PinHandler }) {
  const [openNew, setOpenNew] = useState(false);
  const [openTeam, setOpenTeam] = useState(false);
  return (
    <>
      <button
        type="button"
        className="pin-tile pin-plus"
        data-testid="pin-plus"
        title="Capture an idea: send it to a team or pin a new one"
        onClick={() => setOpenNew(true)}
      >
        <span className="pin-plus-icon">+</span>
        <span className="muted small">New idea</span>
      </button>
      <button
        type="button"
        className="pin-tile pin-plus pin-new-team"
        data-testid="pin-new-team-tile"
        title="Create a new pinned team with its own Buddy"
        onClick={() => setOpenTeam(true)}
      >
        <span className="pin-plus-icon">＋</span>
        <span className="muted small">New team</span>
      </button>
      {openNew && <IdeaBox view={view} onClose={() => setOpenNew(false)} onQuickStart={onQuickStart} />}
      {openTeam && <IdeaBox view={view} presetMode="new" onClose={() => setOpenTeam(false)} onQuickStart={onQuickStart} />}
    </>
  );
}
