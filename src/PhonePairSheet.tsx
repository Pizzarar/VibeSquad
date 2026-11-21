import { useCallback, useEffect, useRef, useState } from "react";
import {
  OWNER_ROLE_LABEL,
  TESTER_ROLE_LABEL,
  agoLabel,
  cascadeWarning,
  defaultTesterTeams,
  descendantsOf,
  formatDeviceRoleBadge,
  formatPairCode,
  mintedByLabel,
  pairStartInit,
  secondsLeft,
  type DeviceRole,
  type PendingPair,
  type PhoneDevice,
} from "./phonePairLogic";

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
  // E6c: DEVICE ACCESS ROLE. Switching role or toggling a Squad clears the shown code, so an owner code is never handed out as a tester invite.
  const [role, setRole] = useState<DeviceRole>("owner");
  const [squads, setSquads] = useState<Array<{ id: string; name?: string }>>([]);
  const [testerTeams, setTesterTeams] = useState<string[]>([]);
  const isOwnerRole = role === "owner";
  const isTesterRole = role === "bug-tester";
  // Monotonic mint id: a role switch / Squad toggle / newer mint drops any pair/start still in flight (no stale owner code under Alpha Tester).
  const mintSeqRef = useRef(0);
  const testerBlocked = role === "bug-tester" && testerTeams.length === 0;

  const loadSquads = useCallback(async () => {
    try {
      const r = await fetch("/api/teams", { cache: "no-store" });
      if (!r.ok) return;
      const data = await json<{ teams?: Array<{ id: string; name?: string }> }>(r);
      const list = (data.teams ?? []).filter((t) => t && typeof t.id === "string");
      setSquads(list);
      setTesterTeams((cur) => (cur.length ? cur : defaultTesterTeams(list, null)));
    } catch {
      /* no squads list: tester invites stay blocked */
    }
  }, []);

  const changeRole = (next: DeviceRole) => {
    if (next === role) return;
    mintSeqRef.current++;
    setBusy(false);
    setRole(next);
    setPair(null);
    setErr("");
  };

  const toggleSquad = (id: string) => {
    mintSeqRef.current++;
    setBusy(false);
    setTesterTeams((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
    setPair(null);
  };

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
    void loadSquads();
    const poll = setInterval(() => void loadPending(), 2000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [open, loadDevices, loadPending, loadSquads]);

  const mint = async () => {
    const seq = ++mintSeqRef.current;
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/__vibesquad/pair/start", pairStartInit(role, testerTeams));
      const data = await json<PairStart>(r);
      if (seq !== mintSeqRef.current) return;
      if (!r.ok) {
        setErr(data.error ?? `HTTP ${r.status}`);
        return;
      }
      setPair(data);
    } catch (e) {
      if (seq === mintSeqRef.current) setErr(String((e as Error)?.message ?? e));
    } finally {
      if (seq === mintSeqRef.current) setBusy(false);
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
          <div className="phone-pair-devices" data-testid="phone-pair-role">
            <div className="field-label">DEVICE ACCESS ROLE</div>
            <div className="seg">
              <button type="button" className={isOwnerRole ? "on" : ""} data-testid="phone-pair-role-owner" onClick={() => changeRole("owner")}>
                {OWNER_ROLE_LABEL}
              </button>
              <button type="button" className={isTesterRole ? "on" : ""} data-testid="phone-pair-role-tester" onClick={() => changeRole("bug-tester")}>
                {TESTER_ROLE_LABEL}
              </button>
            </div>
            {role === "bug-tester" && (
              <div data-testid="phone-pair-tester-squads">
                <div className="muted small">Squads this tester may report bugs to:</div>
                {squads.map((t) => (
                  <label key={t.id} className="small" style={{ display: "block" }}>
                    <input type="checkbox" data-testid={`phone-pair-squad-${t.id}`} checked={testerTeams.includes(t.id)} onChange={() => toggleSquad(t.id)} /> {t.name || t.id}
                  </label>
                ))}
                {squads.length === 0 && <div className="muted small">No Squads found.</div>}
                {testerBlocked && <div className="small">Check at least one Squad to generate a tester invite.</div>}
              </div>
            )}
          </div>
          <button type="button" className="btn phone-pair-mint" data-testid="phone-pair-mint" disabled={busy || testerBlocked} onClick={() => void mint()}>
            {busy ? "Minting…" : pair ? "New code" : role === "bug-tester" ? "Generate tester invite" : "Pair another device"}
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
                    {formatDeviceRoleBadge(p) && <span className="badge" data-testid="phone-pair-role-badge">{formatDeviceRoleBadge(p)}</span>}
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
                    {formatDeviceRoleBadge(d) && <span className="badge" data-testid="phone-pair-role-badge">{formatDeviceRoleBadge(d)}</span>}
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
