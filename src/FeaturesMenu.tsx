import { useEffect, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { applyConfig, describeError, featureChange, featureRows, setFeature, turnNote } from "./paseoFeatures";

const CTRL = { background: "var(--panel-alt)", color: "var(--fg)", border: "1px solid var(--line)", fontSize: 10, padding: "1px 4px" } as const;

// Provider features (setAgentFeature) plus a model + thinking bundle (applyAgentConfig) for the running agent.
// Values always come from the agent snapshot, so the menu reflects the daemon's state after each change.
export function FeaturesMenu({ agent }: { agent: PaseoAgent }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const rows = featureRows((agent as any).features);
  const [model, setModel] = useState(agent.model ?? "");
  const [thinking, setThinking] = useState(agent.thinkingOptionId ?? "");
  useEffect(() => setModel(agent.model ?? ""), [agent.model]);
  useEffect(() => setThinking(agent.thinkingOptionId ?? ""), [agent.thinkingOptionId]);

  const run = async (key: string, fn: () => Promise<string | void>, after: string) => {
    setBusy(key);
    setError("");
    setNote("");
    try {
      const notice = await fn();
      setNote([notice, after].filter(Boolean).join(" ") || "Applied.");
    } catch (e) {
      setError(`Change failed: ${describeError(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const bundle = {
    ...(model.trim() && model.trim() !== (agent.model ?? "") ? { modelId: model.trim() } : {}),
    ...(thinking !== (agent.thinkingOptionId ?? "") ? { thinkingOptionId: thinking || null } : {}),
  };
  const dirty = Object.keys(bundle).length > 0;

  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button
        data-testid="drawer-features-btn"
        className="btn ghost small drawer-features-btn"
        style={{ padding: "0 5px", fontSize: 10, height: 20 }}
        title="Provider features, model and thinking"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ⚙ Features{rows.length ? ` (${rows.length})` : ""}
      </button>
      {open && (
        <div
          data-testid="drawer-features-menu"
          className="drawer-features-menu"
          style={{ position: "absolute", top: 22, left: 0, zIndex: 30, minWidth: 220, maxWidth: "min(300px, 90vw)", background: "var(--panel)", border: "1px solid var(--line)", padding: 8, display: "grid", gap: 6, fontSize: 11 }}
        >
          {rows.length === 0 && <div className="muted small" data-testid="drawer-features-empty">This provider exposes no live features.</div>}
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
                    if (next !== null) void run(r.id, () => setFeature(agent, r.id, next), turnNote(agent.status, "feature"));
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
                    if (next !== null) void run(r.id, () => setFeature(agent, r.id, next), turnNote(agent.status, "feature"));
                  }}
                >
                  {r.value === null && <option value="">(default)</option>}
                  {r.options.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              )}
            </label>
          ))}
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 6, display: "grid", gap: 4 }}>
            <input data-testid="drawer-features-model" style={CTRL} value={model} placeholder="model" onChange={(e) => setModel(e.target.value)} />
            <select data-testid="drawer-features-thinking" style={CTRL} value={thinking} onChange={(e) => setThinking(e.target.value)}>
              <option value="">(default thinking)</option>
              {["low", "medium", "high"].map((o) => <option key={o} value={o}>{o}</option>)}
              {thinking && !["low", "medium", "high"].includes(thinking) && <option value={thinking}>{thinking}</option>}
            </select>
            <button
              data-testid="drawer-features-apply"
              className="btn small"
              disabled={!dirty || busy !== null}
              onClick={() => void run("config", () => applyConfig(agent, bundle), turnNote(agent.status, "modelId" in bundle ? "model" : "thinking"))}
            >
              Apply model / thinking
            </button>
          </div>
          {error && <div data-testid="drawer-features-error" style={{ color: "var(--bad, #f66)" }} role="alert">{error}</div>}
          {note && <div data-testid="drawer-features-note" className="muted small">{note}</div>}
        </div>
      )}
    </span>
  );
}
