import { useCallback, useEffect, useState } from "react";
import { Field } from "./TeamActions";
import { listAvailableProviders, loadRunnerSettings, saveRunnerSettings, loadRunnerUsage, type RunnerProviderSettings, type RunnerUsage } from "./paseoProviders";
import { sortProviders, providerState, type CatalogProvider } from "./paseoProvidersLogic";

/** Runner & Providers: edits the `runner` block of ~/.vibesquad/settings.json (merged server-side, other keys untouched) and shows usage rollups. */
const csv = (v?: string[]) => (v ?? []).join(", ");
const splitCsv = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
export function RunnerSettingsSection() {
  const [rows, setRows] = useState<(CatalogProvider & { version?: string })[]>([]);
  const [draft, setDraft] = useState<Record<string, RunnerProviderSettings>>({});
  const [path, setPath] = useState("");
  const [usage, setUsage] = useState<RunnerUsage | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr("");
    try {
      const [prov, set, use] = await Promise.all([listAvailableProviders(true), loadRunnerSettings(), loadRunnerUsage()]);
      setRows(sortProviders((prov.providers ?? []) as (CatalogProvider & { version?: string })[]));
      setDraft(set.runner.providers);
      setPath(set.path);
      setUsage(use);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const patch = (id: string, p: RunnerProviderSettings) => setDraft((d) => ({ ...d, [id]: { ...d[id], ...p } }));
  const save = async () => {
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      const saved = await saveRunnerSettings({ providers: draft });
      setDraft(saved.providers);
      setMsg("Saved runner settings.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="paseo-panel-runner" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="muted small">
        Providers the VS runner can start, found by probing the installed CLIs. Extra models and modes are saved to <code>{path || "~/.vibesquad/settings.json"}</code> (other keys are kept).
      </div>
      {err && <div className="stat-alert small" data-testid="runner-settings-error">{err}</div>}
      {msg && <div className="small" data-testid="runner-settings-notice" style={{ color: "#00f0ff" }}>✓ {msg}</div>}
      {rows.map((p) => {
        const st = providerState(p);
        const d = draft[p.provider] ?? {};
        return (
          <div key={p.provider} className="ts-team" data-testid={`runner-provider-${p.provider}`} style={{ padding: "8px 10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <b>{p.provider}</b>
              <span className={`pill diag ${st.tone}`} title={p.error ?? ""}>{st.label}</span>
              {p.version && <span className="muted small">{p.version}</span>}
              <label style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: "auto" }}>
                <input type="checkbox" data-testid={`runner-enabled-${p.provider}`} checked={d.enabled !== false} onChange={(e) => patch(p.provider, { enabled: e.target.checked })} />
                <span className="small">Enabled</span>
              </label>
            </div>
            <div className="row2" style={{ marginTop: 6 }}>
              <Field label="EXTRA MODELS (comma-separated)">
                <input data-testid={`runner-models-${p.provider}`} value={csv(d.models)} onChange={(e) => patch(p.provider, { models: splitCsv(e.target.value) })} />
              </Field>
              <Field label="EXTRA MODES (comma-separated)">
                <input data-testid={`runner-modes-${p.provider}`} value={csv(d.modes)} onChange={(e) => patch(p.provider, { modes: splitCsv(e.target.value) })} />
              </Field>
              <Field label="DEFAULT MODEL">
                <input data-testid={`runner-default-model-${p.provider}`} value={d.defaultModel ?? ""} onChange={(e) => patch(p.provider, { defaultModel: e.target.value })} />
              </Field>
            </div>
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn ok small" data-testid="runner-settings-save" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save runner settings"}
        </button>
        <button type="button" className="btn ghost small" onClick={() => void load()}>Reload</button>
      </div>
      <div className="ts-team" data-testid="runner-usage" style={{ padding: "8px 10px" }}>
        <div className="field-label">RUNNER USAGE ({usage?.files ?? 0} agent logs · {usage?.totals.turns ?? 0} turns · ${(usage?.totals.costUsd ?? 0).toFixed(2)})</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          {(usage?.byModel ?? []).map((m) => (
            <span key={m.model} className="def-badge"><b>{m.model}</b> {m.turns} turns · ${m.costUsd.toFixed(2)}</span>
          ))}
          {(usage?.byLane ?? []).map((l) => (
            <span key={"l" + l.lane} className="def-badge"><b>{l.lane || "(no lane)"}</b> ${l.costUsd.toFixed(2)}</span>
          ))}
        </div>
        {usage && <div className="muted small" style={{ marginTop: 4 }}>{usage.note}</div>}
      </div>
    </div>
  );
}

/** Header usage chip; P4 swaps its source for runner usage. */
export interface PaseoUsageProvider {
  id: string;
  sourceId: string;
  sourceLabel: string;
  account: string | null;
  status: string;
  planLabel: string | null;
  fetchedAt: string | null;
  usedPct: number | null;
  remainingPct: number | null;
  windowLabel: string | null;
  shortLabel: string | null;
  resetsAt: string | null;
  tone: string;
  windows: {
    id: string;
    label: string;
    shortLabel?: string;
    usedPct?: number;
    remainingPct?: number;
    resetsAt?: string;
    tone?: string;
  }[];
  balances: {
    id: string;
    label: string;
    remaining: number;
    unit: string;
    tone?: string;
  }[];
}

export function PaseoUsageHeaderChip({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const [providers, setProviders] = useState<PaseoUsageProvider[]>([]);

  useEffect(() => {
    let alive = true;
    fetch("/__vibesquad/paseo/usage")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && Array.isArray(d?.providers)) {
          setProviders(d.providers);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (providers.length === 0) return null;

  return (
    <button
      type="button"
      className="tchip"
      data-testid="header-paseo-usage-chip"
      onClick={onOpenSettings}
      title="Provider account usage (click to open Settings)"
      style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
    >
      {providers.slice(0, 3).map((p) => {
        const pct = p.usedPct !== null ? `${Math.round(p.usedPct)}%` : p.status;
        const color = p.tone === "danger" ? "#ff2a85" : p.tone === "warning" ? "#ffb000" : "#00f0ff";
        return (
          <span key={p.id} style={{ color, fontWeight: 700 }}>
            {p.sourceLabel}: {pct}
          </span>
        );
      })}
    </button>
  );
}
