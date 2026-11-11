import { useCallback, useEffect, useState } from "react";
import { agoLabel, cascadeWarning, descendantsOf, formatPairCode, mintedByLabel, secondsLeft, type PendingPair, type PhoneDevice } from "./phonePairLogic";

// E4b (docs/PLAN_ANDROID_END_STATE.md): the phone `⋯` drawer's "Pair another device / Devices" sheet. Mounted by App.tsx
// through PhoneCockpit's pairSlot. Same routes as the desktop PairDeviceModal, plus the two-step confirm: a code minted
// here lands the new device in pending-approval until this device taps Approve (GET pair/pending, POST pair/approve).

type PairStart = {
  code: string;
  pairUrl: string;
  lanPairUrl?: string | null;
  qrSvg: string;
  lanQrSvg?: string | null;
  expiresAt: number;
  requiresApproval?: boolean;
  error?: string;
};

const json = async <T,>(r: Response): Promise<T> => (await r.json().catch(() => ({ error: `HTTP ${r.status}` }))) as T;

export function PhonePairSheet() {
  const [open, setOpen] = useState(false);
  const [pair, setPair] = useState<PairStart | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [devices, setDevices] = useState<PhoneDevice[]>([]);
  const [pending, setPending] = useState<PendingPair[]>([]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const loadDevices = useCallback(async () => {
    try {
      const r = await fetch("/__vibesquad/devices");
      const data = await json<{ devices?: PhoneDevice[]; error?: string }>(r);
      if (!r.ok) {
        setErr(data.error ?? `HTTP ${r.status}`);
        return;
      }
      setDevices(data.devices ?? []);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  }, []);

  const loadPending = useCallback(async () => {
    try {
      const r = await fetch("/__vibesquad/pair/pending");
      const data = await json<{ pending?: PendingPair[] }>(r);
      if (r.ok) setPending(data.pending ?? []);
    } catch {
      /* next tick */
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadDevices();
    void loadPending();
    const poll = setInterval(() => void loadPending(), 2000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [open, loadDevices, loadPending]);

  const mint = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/__vibesquad/pair/start", { method: "POST" });
      const data = await json<PairStart>(r);
      if (!r.ok) {
        setErr(data.error ?? `HTTP ${r.status}`);
        return;
      }
      setPair(data);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (pendingId: string, approve: boolean) => {
    setErr("");
    try {
      const r = await fetch("/__vibesquad/pair/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pendingId, approve }),
      });
      const data = await json<{ pending?: PendingPair[]; error?: string }>(r);
      if (!r.ok) setErr(data.error ?? `HTTP ${r.status}`);
      if (Array.isArray(data.pending)) setPending(data.pending);
      if (approve && r.ok) void loadDevices();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  };

  const revoke = async (id: string) => {
    setErr("");
    setConfirm(null);
    try {
      const r = await fetch("/__vibesquad/devices/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await json<{ devices?: PhoneDevice[]; error?: string }>(r);
      if (!r.ok) {
        setErr(data.error ?? `HTTP ${r.status}`);
        return;
      }
      if (Array.isArray(data.devices)) setDevices(data.devices);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* no clipboard */
    }
  };

  const expired = pair ? secondsLeft(pair.expiresAt, now) === 0 : false;
  const link = pair?.lanPairUrl || pair?.pairUrl || "";
  const qr = pair?.lanQrSvg || pair?.qrSvg || "";

  return (
    <div className="phone-pair" data-testid="phone-pair">
      <button type="button" className="btn ghost phone-pair-open" data-testid="phone-pair-open" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "Close devices" : "Pair another device / Devices"}
      </button>
      {open && (
        <div className="phone-pair-sheet" data-testid="phone-pair-sheet">
          <button type="button" className="btn phone-pair-mint" data-testid="phone-pair-mint" disabled={busy} onClick={() => void mint()}>
            {busy ? "Minting…" : pair ? "New code" : "Pair another device"}
          </button>
          {pair && !expired && (
            <div className="phone-pair-code-card" data-testid="phone-pair-code-card">
              <div className="phone-pair-code" data-testid="phone-pair-code">{formatPairCode(pair.code)}</div>
              <div className="muted small">
                Expires in {secondsLeft(pair.expiresAt, now)} s. Scan or open the link on the new device, then tap <b>Approve</b> here when it appears.
              </div>
              {qr && <div className="phone-pair-qr" data-testid="phone-pair-qr" dangerouslySetInnerHTML={{ __html: qr }} />}
              <div className="phone-pair-link-row">
                <code className="phone-pair-link" data-testid="phone-pair-link">{link}</code>
                <button type="button" className="btn ghost small" onClick={() => void copy(link)}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}
          {pair && expired && (
            <div className="muted small" data-testid="phone-pair-expired">
              That code expired. Mint a new one.
            </div>
          )}
          {pending.length > 0 && (
            <div className="phone-pair-pending" data-testid="phone-pair-pending">
              <div className="field-label">WAITING FOR YOUR APPROVAL</div>
              {pending.map((p) => (
                <div key={p.pendingId} className="phone-pair-pending-item" data-testid="phone-pair-pending-item">
                  <div className="phone-pair-pending-who">
                    <b>{p.name}</b>
                    <span className="muted small">
                      {" "}
                      from {p.ip} · {Math.ceil(p.expiresInMs / 1000)} s left
                    </span>
                  </div>
                  <div className="phone-pair-pending-actions">
                    <button type="button" className="btn small" data-testid="phone-pair-approve" onClick={() => void decide(p.pendingId, true)}>
                      Approve
                    </button>
                    <button type="button" className="btn ghost small" data-testid="phone-pair-deny" onClick={() => void decide(p.pendingId, false)}>
                      Deny
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="phone-pair-devices" data-testid="phone-pair-devices">
            <div className="phone-pair-devices-head">
              <span className="field-label">PAIRED DEVICES ({devices.length})</span>
              <button type="button" className="btn ghost small" onClick={() => void loadDevices()}>
                ↻
              </button>
            </div>
            {devices.length === 0 && <div className="muted small">No paired devices.</div>}
            {devices.map((d) => {
              const via = mintedByLabel(devices, d);
              const warning = cascadeWarning(devices, d.id);
              const total = 1 + descendantsOf(devices, d.id).length;
              return (
                <div key={d.id} className={`phone-pair-device ${d.current ? "current" : ""}`} data-testid="phone-pair-device">
                  <div className="phone-pair-device-main">
                    <b>{d.name}</b>
                    {d.current && <span className="badge">THIS DEVICE</span>}
                    <span className="muted small"> seen {agoLabel(d.lastSeenAt, now)}</span>
                    {via && <span className="muted small phone-pair-via"> · via {via}</span>}
                  </div>
                  {confirm === d.id ? (
                    <div className="phone-pair-cascade" data-testid="phone-pair-cascade">
                      <div className="small">
                        {d.current ? "This is the device you are using: it loses access at once. " : ""}
                        {warning ?? "Its next request is refused."}
                      </div>
                      <button type="button" className="btn warn small" data-testid="phone-pair-revoke-confirm" onClick={() => void revoke(d.id)}>
                        {total > 1 ? `Revoke ${total}` : "Revoke"}
                      </button>
                      <button type="button" className="btn ghost small" onClick={() => setConfirm(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="btn warn small" data-testid="phone-pair-revoke" onClick={() => setConfirm(d.id)}>
                      Revoke
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {err && (
            <div className="phone-pair-err" role="alert" data-testid="phone-pair-err">
              {err}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
