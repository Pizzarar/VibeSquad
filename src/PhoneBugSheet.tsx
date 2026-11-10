// E3: phone fast bug capture. A bottom sheet (autofocus text, optional mic, 1-tap screenshot/camera/gallery) that
// parks a card in the Squad's bug lane and delivers it straight away. PhoneBugPill is the drop-in trigger for
// PhoneCockpit (E1): it reuses BugButton's unread count + pulse.
import { useEffect, useRef, useState } from "react";
import { useBugPill } from "./BugButton";
import type { TeamView } from "./teams";
import { PHONE_BUG_MAX_BYTES, PHONE_BUG_MAX_SHOTS, PHONE_BUG_MIMES, submitPhoneBug, type PhoneBugContext } from "./phoneBugCapture";

type Recognizer = { lang: string; interimResults: boolean; onresult: ((e: any) => void) | null; onend: (() => void) | null; start(): void; stop(): void };
type SpeechCtor = new () => Recognizer;
const speechCtor = (): SpeechCtor | null => {
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

export function PhoneBugSheet({ teamId, bugLaneId, ctx, onClose, onSent }: { teamId: string; bugLaneId: string; ctx: PhoneBugContext; onClose: () => void; onSent?: (cardId: string) => void }) {
  const [text, setText] = useState("");
  const [shots, setShots] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognizer | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const canSpeak = typeof window !== "undefined" && speechCtor() !== null;
  useEffect(() => {
    area.current?.focus();
    return () => rec.current?.stop();
  }, []);
  const addFiles = (list: FileList | null) => {
    const all = Array.from(list ?? []);
    const ok = all.filter((f) => PHONE_BUG_MIMES.includes(f.type) && f.size <= PHONE_BUG_MAX_BYTES);
    if (ok.length < all.length) setErr("Screenshots must be PNG/JPEG/WebP under 8 MB");
    setShots((s) => [...s, ...ok].slice(0, PHONE_BUG_MAX_SHOTS));
  };
  const toggleMic = () => {
    if (listening) return rec.current?.stop();
    const C = speechCtor();
    if (!C) return;
    const r = new C();
    r.lang = navigator.language || "en-US";
    r.interimResults = false;
    r.onresult = (e) => {
      const said = Array.from(e.results as ArrayLike<any>).map((x) => x[0].transcript).join(" ");
      setText((t) => `${t}${t && !/\s$/.test(t) ? " " : ""}${said}`);
    };
    r.onend = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  };
  const send = async () => {
    setBusy(true);
    setErr("");
    try {
      const out = await submitPhoneBug({ text, teamId, bugLaneId, ctx, shots });
      if (out.error) setErr(`Parked as #${out.cardId}, not delivered: ${out.error}`);
      else {
        onSent?.(out.cardId);
        onClose();
      }
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="phone-bug-scrim" data-testid="phone-bug-sheet" onClick={onClose}>
      <div
        className="phone-bug-sheet"
        role="dialog"
        aria-label="Report a bug"
        onClick={(e) => e.stopPropagation()}
      >
        <textarea ref={area} value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="What went wrong?" aria-label="Bug description" style={{ width: "100%", fontSize: 16 }} />
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label className="btn" data-testid="phone-bug-attach">
            📷 Camera
            <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          </label>
          <label className="btn" data-testid="phone-bug-gallery">
            🖼 Gallery
            <input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          </label>
          {canSpeak && (
            <button type="button" className="btn" data-testid="phone-bug-mic" aria-pressed={listening} onClick={toggleMic}>
              {listening ? "■ Stop" : "🎤 Dictate"}
            </button>
          )}
          {shots.length > 0 && <span data-testid="phone-bug-shots">{shots.length} attached</span>}
        </div>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>{`${ctx.squad}${ctx.lane ? ` · ${ctx.lane}` : ""} · Android APK`}</div>
        {err && (
          <div role="alert" data-testid="phone-bug-error" style={{ color: "#c0123f" }}>
            {err}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" data-testid="phone-bug-send" disabled={busy || !text.trim()} onClick={send}>
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Drop-in bug pill for PhoneCockpit: unread count + pulse from BugButton, tap opens the capture sheet. */
export function PhoneBugPill({ view, activeLane, hostId }: { view: TeamView; activeLane?: string; hostId?: string }) {
  const { pin, teamId, counts, pulse, markSeen } = useBugPill(view);
  const [open, setOpen] = useState(false);
  if (!pin) return null;
  return (
    <>
      <button
        type="button"
        className={`bug-btn${counts.unseen > 0 ? " has-new" : ""}${pulse ? " pulse" : ""}`}
        data-testid={`phone-bug-pill-${teamId}`}
        aria-label={`Report a bug, ${counts.total} open, ${counts.unseen} new`}
        onClick={() => {
          markSeen();
          setOpen(true);
        }}
      >
        🪲{counts.total > 0 && <span className="bug-btn-n">{counts.total}</span>}
      </button>
      {open && <PhoneBugSheet teamId={teamId} bugLaneId={pin.lane.id} ctx={{ squad: teamId, lane: activeLane, hostId }} onClose={() => setOpen(false)} />}
    </>
  );
}
