import { useEffect, useRef, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { describeError, featureChange, featureRows, setFeature, turnNote } from "./paseoFeatures";

const CTRL = { background: "var(--panel-alt)", color: "var(--fg)", border: "1px solid var(--line)", fontSize: 10, padding: "1px 4px" } as const;

// Provider features (setAgentFeature) for the running agent. Model, thinking and mode live in the header
// selects, which use the single-field setters (applyAgentConfig hangs on model changes). Values always come from the agent snapshot, so the menu
// reflects the daemon's state after each change. Hidden when the provider exposes no features.
export function FeaturesMenu({ agent }: { agent: PaseoAgent }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const rows = featureRows(agent.features);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const agentIdRef = useRef(agent.id);
  agentIdRef.current = agent.id;
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    setOpen(false);
    setBusy(null);
    setError("");
    setNote("");
  }, [agent.id]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = async (key: string, value: boolean | string) => {
    const targetId = agent.id;
    const live = () => mountedRef.current && agentIdRef.current === targetId;
    setBusy(key);
    setError("");
    setNote("");
    try {
      await setFeature(agent, key, value);
      if (live()) setNote(turnNote(agent.status) || "Applied.");
    } catch (e) {
      if (live()) setError(`Change failed: ${describeError(e)}`);
    } finally {
      if (live()) setBusy(null);
    }
  };

  if (rows.length === 0) return null;

  return (
    <span ref={wrapRef} style={{ display: "inline-block", position: "relative" }}>
      <button
        data-testid="drawer-features-btn"
        className="btn ghost small drawer-features-btn"
        style={{ padding: "0 5px", fontSize: 10, height: 20 }}
        title="Provider features"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ⚙ Features ({rows.length})
      </button>
      {open && (
        <div data-testid="drawer-features-menu" className="drawer-features-menu">
          {rows.map((r) => (
            <label key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }} title={r.hint}>
              <span>{r.label}</span>
              {r.kind === "toggle" ? (
                <input
                  type="checkbox"
                  data-testid={`drawer-feature-${r.id}`}
                  checked={!!r.value}
                  disabled={busy !== null}
                  onChange={(e) => {
                    const next = featureChange(r, e.target.checked);
                    if (next !== null) void run(r.id, next);
                  }}
                />
              ) : (
                <select
                  data-testid={`drawer-feature-${r.id}`}
                  style={CTRL}
                  value={(r.value as string | null) ?? ""}
                  disabled={busy !== null || r.options.length === 0}
                  onChange={(e) => {
                    const next = featureChange(r, e.target.value);
                    if (next !== null) void run(r.id, next);
                  }}
                >
                  {r.value === null && <option value="">(default)</option>}
                  {typeof r.value === "string" && r.value && !r.options.some((o) => o.id === r.value) && <option value={r.value}>{r.value}</option>}
                  {r.options.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              )}
            </label>
          ))}
          {error && <div data-testid="drawer-features-error" style={{ color: "var(--bad, #f66)" }} role="alert">{error}</div>}
          {note && <div data-testid="drawer-features-note" className="muted small">{note}</div>}
        </div>
      )}
    </span>
  );
}
