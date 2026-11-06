import { useCallback, useEffect, useRef, useState } from "react";
import { Field } from "./TeamActions";
import { PaseoOpsPanel } from "./PaseoOpsPanel";
import { McpPanel } from "./McpPanel";
import { SkillsPanel } from "./SkillsPanel";
import { listAvailableProviders, listProviderModels, listProviderModes, loadRunnerSettings, saveRunnerSettings, loadRunnerUsage, type RunnerProviderSettings, type RunnerUsage } from "./paseoProviders";
import { sortProviders, providerState, describeModel, type CatalogProvider, type CatalogModel, type CatalogMode } from "./paseoProvidersLogic";
import { previewPluginUpdates, applyPluginUpdates, type PluginUpdatePreviewRow, type PluginUpdateResultRow } from "./paseoPluginUpdates";
import { isTakeable, toggleSelection, selectedProposals, describeTarget, outcomeLabel, resultNote, summarizeResults } from "./paseoPluginUpdatesLogic";

export type PaseoSettingsTab =
  | "daemon"
  | "network"
  | "providers"
  | "plugins"
  | "behaviour"
  | "usage"
  | "profiles"
  | "raw"
  | "ops"
  | "mcp"
  | "skills"
  | "catalog"
  | "runner";

export interface PaseoDaemonStatus {
  ok: boolean;
  home: string;
  running: boolean;
  version: string | null;
  pid: number | null;
  startedAt: string | null;
  uptimeMs: number | null;
  listen: string;
  configuredListen: string;
  restartRequired: boolean;
  serverId: string | null;
  hostname: string | null;
  ownership: "vibesquad-managed" | "external" | "stopped";
  managedByVibeSquad: boolean;
  liveAgentCount: number;
  busyAgentCount: number;
  busyAgents: { id: string; name: string }[];
  keepPaseoRunningOnQuit: boolean;
  startPaseoWithVibeSquad: boolean;
  backupsCount: number;
  providerWarning?: string | null;
  erroredProviders?: { id: string; label?: string; status: string; error?: string; detail?: string }[];
}

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

interface PaseoProviderRow {
  id: string;
  label: string;
  description: string;
  status: string;
  enabled: boolean;
  defaultMode: string;
  modes: string;
  extends: string | null;
  isCustomAcp: boolean;
  command: string[];
  envKeys: string[];
  envMasked: Record<string, string>;
}

interface PaseoPluginRow {
  id: string;
  name: string;
  status: string;
  enabled: boolean;
  source: string;
  path: string;
  error: string | null;
  isVibeSquad: boolean;
}

interface PaseoSurfaceState {
  configPath: string;
  network: {
    listen: string;
    activeListen: string;
    restartRequired: boolean;
    corsAllowedOrigins: string[];
    relayEnabled: boolean;
    appBaseUrl: string;
    hub: {
      state: string;
      hub: string | null;
      daemonId: string | null;
      permissions: string;
      connectedAt: string | null;
      error: string | null;
    };
  };
  behaviour: {
    mcpInjectIntoAgents: boolean;
    browserToolsEnabled: boolean;
    autoArchiveAfterMerge: boolean;
    enableTerminalAgentHooks: boolean;
    suppressDesktopFinishedNotifications: boolean;
  };
  skills: unknown;
  profileCount: number;
  maskedConfig: unknown;
  backups: { name: string; ts: number }[];
}

function formatUptime(ms: number | null): string {
  if (ms === null || ms <= 0) return "—";
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
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
      title="Paseo provider account usage (click to open Settings)"
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

/** Read-only catalog: what the daemon reports for each provider (availability, models, modes). */
function ProviderCatalogPanel() {
  const [useRunner, setUseRunner] = useState(false);
  const [rows, setRows] = useState<CatalogProvider[]>([]);
  const [sel, setSel] = useState("");
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [modes, setModes] = useState<CatalogMode[]>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const r = await listAvailableProviders(useRunner);
      setRows(sortProviders((r.providers ?? []) as CatalogProvider[]));
      if (r.error) setErr(r.error);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [useRunner]);
  useEffect(() => {
    setSel("");
    void load();
  }, [load]);

  const seq = useRef(0);
  const pick = async (provider: string) => {
    const my = ++seq.current;
    setSel(provider);
    setModels([]);
    setModes([]);
    setErr("");
    try {
      const [mo, md] = await Promise.all([listProviderModels(provider, useRunner), listProviderModes(provider, useRunner)]);
      if (my !== seq.current) return;
      setModels((mo.models ?? []) as CatalogModel[]);
      setModes((md.modes ?? []) as CatalogMode[]);
      const e = mo.error || md.error;
      if (e) setErr(e);
    } catch (e) {
      if (my !== seq.current) return;
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div data-testid="paseo-panel-catalog" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="muted small">Read-only view of the providers the {useRunner ? "VS runner" : "daemon"} reports.</span>
        <label className="small" style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input type="checkbox" data-testid="paseo-catalog-runner-toggle" checked={useRunner} onChange={(e) => setUseRunner(e.target.checked)} /> Runner
        </label>
        <button type="button" className="btn ghost small" data-testid="paseo-catalog-refresh" disabled={loading} onClick={() => void load()}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      {err && <div className="stat-alert small" data-testid="paseo-catalog-error">{err}</div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {rows.map((p) => {
          const st = providerState(p);
          return (
            <button
              key={p.provider}
              type="button"
              className={`btn small ${sel === p.provider ? "on" : "ghost"}`}
              data-testid={`paseo-catalog-provider-${p.provider}`}
              title={p.error ?? st.label}
              onClick={() => void pick(p.provider)}
            >
              {p.provider} <span className={`pill diag ${st.tone}`}>{st.label}</span>
            </button>
          );
        })}
        {!loading && rows.length === 0 && <span className="muted small">No providers reported.</span>}
      </div>
      {sel && (
        <div className="ts-team" data-testid="paseo-catalog-detail" style={{ padding: "8px 10px" }}>
          <div className="field-label">MODELS · {sel} ({models.length})</div>
          {models.map((m) => (
            <div key={m.id} className="small" data-testid={`paseo-catalog-model-${m.id}`}>
              <b>{m.label}</b> <span className="muted">({m.id})</span> <span className="muted">{describeModel(m)}</span>
              {m.description && <div className="muted small">{m.description}</div>}
            </div>
          ))}
          <div className="field-label" style={{ marginTop: 8 }}>MODES · {sel} ({modes.length})</div>
          {modes.map((m) => (
            <div key={m.id} className="small" data-testid={`paseo-catalog-mode-${m.id}`}>
              <b>{m.label}</b> <span className="muted">({m.id})</span>
              {m.description && <div className="muted small">{m.description}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Runner & Providers: edits the `runner` block of ~/.vibesquad/settings.json (merged server-side, other keys untouched) and shows usage rollups. */
const csv = (v?: string[]) => (v ?? []).join(", ");
const splitCsv = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
function RunnerProvidersPanel() {
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

/** Check all plugins for updates, tick the ones to take, confirm to apply. Per-plugin Update stays in the rows. */
function PluginUpdatesPanel({ onApplied }: { onApplied: () => void }) {
  const [previews, setPreviews] = useState<PluginUpdatePreviewRow[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<PluginUpdateResultRow[] | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const check = async () => {
    setBusy(true);
    setErr("");
    setResults(null);
    setConfirm(false);
    try {
      setPreviews(await previewPluginUpdates());
      setSel(new Set());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!previews) return;
    const proposals = selectedProposals(previews, sel);
    if (proposals.length === 0) return;
    setBusy(true);
    setErr("");
    try {
      setResults(await applyPluginUpdates(proposals));
      setConfirm(false);
      setPreviews(null);
      onApplied();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ts-team" data-testid="paseo-plugin-updates" style={{ padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div className="field-label">PLUGIN UPDATES</div>
        <button type="button" className="btn ghost small" data-testid="paseo-plugin-updates-check" disabled={busy} onClick={() => void check()}>
          {busy && !confirm ? "Checking…" : "Check for updates"}
        </button>
      </div>
      {err && <div className="stat-alert small" data-testid="paseo-plugin-updates-error">{err}</div>}
      {previews && previews.length === 0 && <div className="muted small">No plugins to check.</div>}
      {previews?.map((p) => {
        const o = outcomeLabel(p.outcome);
        return (
          <div key={p.id} data-testid={`paseo-plugin-update-preview-${p.id}`} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
            <input
              type="checkbox"
              data-testid={`paseo-plugin-update-pick-${p.id}`}
              disabled={!isTakeable(p)}
              checked={sel.has(p.id)}
              onChange={() => setSel((s) => toggleSelection(s, p.id))}
            />
            <b>{p.id}</b>
            <span className={`pill diag ${o.tone}`}>{o.label}</span>
            <span className="muted small">{describeTarget(p)}</span>
            {p.error && <span className="muted small">{p.error}</span>}
            {(p.links ?? []).map((l) => (
              <a key={l} className="small" href={l} target="_blank" rel="noreferrer">
                diff
              </a>
            ))}
          </div>
        );
      })}
      {previews && sel.size > 0 && !confirm && (
        <button type="button" className="btn small" style={{ marginTop: 8 }} data-testid="paseo-plugin-updates-apply" disabled={busy} onClick={() => setConfirm(true)}>
          Update {sel.size} selected…
        </button>
      )}
      {confirm && (
        <div className="dup-warning" data-testid="paseo-plugin-updates-confirm" style={{ marginTop: 8 }}>
          <b>⚠ Update {sel.size} plugin(s)? Plugins run unsandboxed; the new code replaces the installed code.</b>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button type="button" className="btn small bad-btn" data-testid="paseo-plugin-updates-confirm-btn" disabled={busy} onClick={() => void apply()}>
              {busy ? "Updating…" : "Confirm update"}
            </button>
            <button type="button" className="btn ghost small" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {results && (
        <div data-testid="paseo-plugin-updates-results" style={{ marginTop: 8 }}>
          <div className="small">
            <b>{summarizeResults(results)}</b>
          </div>
          {results.map((r) => (
            <div key={r.id} className="small">
              <span className={`pill diag ${r.outcome === "updated" ? "ok" : "hot"}`}>{r.outcome}</span> {r.id}
              {resultNote(r) && <span className="muted"> — {resultNote(r)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PaseoSettingsSection({
  onJumpToProfiles,
  lanIpHint,
}: {
  onJumpToProfiles?: () => void;
  lanIpHint?: string;
}) {
  const [tab, setTab] = useState<PaseoSettingsTab>("daemon");
  const [status, setStatus] = useState<PaseoDaemonStatus | null>(null);
  const [surface, setSurface] = useState<PaseoSurfaceState | null>(null);
  const [providers, setProviders] = useState<PaseoProviderRow[]>([]);
  const [plugins, setPlugins] = useState<PaseoPluginRow[]>([]);
  const [usage, setUsage] = useState<PaseoUsageProvider[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [providerWarning, setProviderWarning] = useState("");
  const [confirmDaemonAction, setConfirmDaemonAction] = useState<"stop" | "restart" | null>(null);

  // Provider diagnostics & models state
  const [diagText, setDiagText] = useState<Record<string, string>>({});
  const [modelsByProv, setModelsByProv] = useState<Record<string, { id: string; model: string; description?: string }[]>>({});
  const [acpId, setAcpId] = useState("");
  const [acpLabel, setAcpLabel] = useState("");
  const [acpDescription, setAcpDescription] = useState("");
  const [acpCommand, setAcpCommand] = useState("");
  const [acpEnvRows, setAcpEnvRows] = useState<{ key: string; value: string }[]>([]);

  // Plugins state
  const [pluginLogs, setPluginLogs] = useState<Record<string, string>>({});
  const [installSource, setInstallSource] = useState("");
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [confirmDisableVs, setConfirmDisableVs] = useState(false);

  // Network & Remote state
  const [listenDraft, setListenDraft] = useState("");
  const [corsDraft, setCorsDraft] = useState<string[]>([]);
  const [newOrigin, setNewOrigin] = useState("");
  const [pairOffer, setPairOffer] = useState<{ url: string | null; qr: string; relayEnabled: boolean } | null>(null);
  const [hubOrigin, setHubOrigin] = useState("");

  const loadAll = useCallback(async () => {
    try {
      const [stRes, sfRes] = await Promise.all([
        fetch("/__vibesquad/paseo/status").then((r) => (r.ok ? r.json() : null)),
        fetch("/__vibesquad/paseo/surface").then((r) => (r.ok ? r.json() : null)),
      ]);
      if (stRes?.ok) setStatus(stRes);
      if (sfRes?.ok) {
        setSurface(sfRes);
        setListenDraft(sfRes.network.listen);
        setCorsDraft(sfRes.network.corsAllowedOrigins);
      }
    } catch {}
  }, []);

  const loadTabDetails = useCallback(async (activeTab: PaseoSettingsTab) => {
    try {
      if (activeTab === "providers") {
        const r = await fetch("/__vibesquad/paseo/providers");
        if (r.ok) {
          const d = await r.json();
          if (Array.isArray(d.providers)) setProviders(d.providers);
        }
      } else if (activeTab === "plugins") {
        const r = await fetch("/__vibesquad/paseo/plugins");
        if (r.ok) {
          const d = await r.json();
          if (Array.isArray(d.plugins)) setPlugins(d.plugins);
        }
      } else if (activeTab === "usage") {
        const r = await fetch("/__vibesquad/paseo/usage");
        if (r.ok) {
          const d = await r.json();
          if (Array.isArray(d.providers)) setUsage(d.providers);
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    void loadTabDetails(tab);
  }, [tab, loadTabDetails]);

  const runDaemonAction = async (action: "start" | "stop" | "restart" | "reload", confirmBusy = false) => {
    setBusy(true);
    setErrorMsg("");
    setNotice("");
    setProviderWarning("");
    try {
      const r = await fetch("/__vibesquad/paseo/daemon", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, confirmBusy }),
      });
      const res = await r.json();
      if (r.status === 409 && res.needsConfirmation && (action === "stop" || action === "restart")) {
        setConfirmDaemonAction(action);
        if (res.status) setStatus(res.status);
        return;
      }
      setConfirmDaemonAction(null);
      if (!r.ok || !res.ok) {
        setErrorMsg(res.error || `Daemon ${action} failed`);
      } else {
        let warning: string = res?.providerWarning || res?.status?.providerWarning || "";
        if (!warning && (action === "start" || action === "restart")) {
          const errored = Array.isArray(res?.erroredProviders) && res.erroredProviders.length > 0
            ? res.erroredProviders
            : providers.filter((p) => p.status === "error");
          if (errored.length > 0) {
            warning =
              "Daemon started but providers failed: " +
              errored
                .map((p: { id?: string; label?: string; error?: string; detail?: string }) =>
                  `${p.id || p.label}${p.error || p.detail ? ` (${p.error || p.detail})` : ""}`,
                )
                .join(", ");
          }
        }
        if (warning) {
          setProviderWarning(warning);
          setErrorMsg(warning);
        } else {
          setNotice(`Daemon ${action} complete.`);
        }
        if (res.status) setStatus(res.status);
      }
      await loadAll();
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleSettingFlag = async (field: "keepPaseoRunningOnQuit" | "startPaseoWithVibeSquad", value: boolean) => {
    try {
      const r = await fetch("/__vibesquad/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try {
          const data = await r.json();
          if (data && typeof data.error === "string") msg = data.error;
        } catch {}
        setErrorMsg(msg);
        return;
      }
      setStatus((prev) => (prev ? { ...prev, [field]: value } : prev));
    } catch (e) {
      setErrorMsg(String(e));
    }
  };

  const applySurfacePatch = async (patch: Record<string, unknown>, label = "Updated Paseo config") => {
    setBusy(true);
    setErrorMsg("");
    setNotice("");
    try {
      const r = await fetch("/__vibesquad/paseo/surface", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const d = await r.json();
      if (r.status === 409 && d.needsConfirmation && patch.confirmExposure !== true) {
        if (window.confirm(`${d.warning}\n\nSave anyway?`)) {
          return applySurfacePatch({ ...patch, confirmExposure: true }, label);
        }
        setNotice("Kept the current daemon.listen.");
        return;
      }
      if (!r.ok || !d.ok) {
        setErrorMsg(d.error || "Failed to update Paseo config");
      } else {
        if (d.surface) {
          setSurface(d.surface);
          setListenDraft(d.surface.network.listen);
          setCorsDraft(d.surface.network.corsAllowedOrigins);
        }
        const base = d.restartRequired ? `${label} — restart required to apply new listen address.` : `${label} (reloaded).`;
        setNotice(d.warning ? `${base} ⚠ ${d.warning}` : base);
        await loadAll();
      }
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onToggleProvider = async (id: string, enabled: boolean) => {
    setBusy(true);
    setErrorMsg("");
    setNotice("");
    try {
      const r = await fetch("/__vibesquad/paseo/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, enabled }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setErrorMsg(d.error || `Failed to toggle provider ${id}`);
      } else {
        setNotice(`Provider ${id} ${enabled ? "enabled" : "disabled"} and config reloaded.`);
        await loadTabDetails("providers");
      }
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onLoadDiagnostic = async (id: string) => {
    const r = await fetch(`/__vibesquad/paseo/providers/diagnostic?provider=${encodeURIComponent(id)}`);
    const d = await r.json();
    setDiagText((prev) => ({ ...prev, [id]: d.diagnostic || d.error || "No diagnostic output" }));
  };

  const onLoadModels = async (id: string) => {
    const r = await fetch(`/__vibesquad/paseo/providers/models?provider=${encodeURIComponent(id)}`);
    const d = await r.json();
    if (Array.isArray(d.models)) {
      setModelsByProv((prev) => ({ ...prev, [id]: d.models }));
    }
  };

  const onEditCustomAcp = (p: PaseoProviderRow) => {
    setAcpId(p.id);
    setAcpLabel(p.label);
    setAcpDescription(p.description || "");
    setAcpCommand(p.command.join(" "));
    setAcpEnvRows(Object.entries(p.envMasked || {}).map(([key, value]) => ({ key, value })));
  };

  const onSaveCustomAcp = async () => {
    setBusy(true);
    setErrorMsg("");
    setNotice("");
    try {
      const envObj: Record<string, string> = {};
      for (const row of acpEnvRows) {
        if (row.key.trim()) envObj[row.key.trim()] = row.value;
      }
      const r = await fetch("/__vibesquad/paseo/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "custom-acp",
          id: acpId,
          label: acpLabel || acpId,
          description: acpDescription,
          command: acpCommand,
          env: envObj,
          enabled: true,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setErrorMsg(d.error || "Failed to save custom ACP provider");
      } else {
        setNotice(`Saved custom ACP provider "${acpLabel || acpId}" and reloaded Paseo.`);
        setAcpId("");
        setAcpLabel("");
        setAcpDescription("");
        setAcpCommand("");
        setAcpEnvRows([]);
        await loadTabDetails("providers");
        await loadAll();
      }
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onPluginAction = async (
    action: "enable" | "disable" | "reload" | "logs" | "update" | "remove" | "install",
    payload: Record<string, unknown>,
  ) => {
    setBusy(true);
    setErrorMsg("");
    setNotice("");
    try {
      const r = await fetch("/__vibesquad/paseo/plugins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
      const d = await r.json();
      if (r.status === 409 && d.needsConfirmation) {
        if (action === "disable" && payload.id === "vibesquad") {
          setConfirmDisableVs(true);
        } else if (action === "install") {
          setConfirmInstall(true);
        }
        setErrorMsg(d.warning || "Confirmation required");
        return;
      }
      setConfirmDisableVs(false);
      setConfirmInstall(false);
      if (!r.ok || !d.ok) {
        setErrorMsg(d.error || `Plugin ${action} failed`);
      } else {
        if (action === "logs" && typeof payload.id === "string") {
          setPluginLogs((prev) => ({ ...prev, [payload.id as string]: d.logs || "(empty)" }));
        } else {
          setNotice(`Plugin ${action} complete.`);
          if (Array.isArray(d.plugins)) setPlugins(d.plugins);
          else await loadTabDetails("plugins");
        }
      }
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const TABS: { id: PaseoSettingsTab; label: string }[] = [
    { id: "daemon", label: "1. Daemon" },
    { id: "network", label: "2. Network & Remote" },
    { id: "providers", label: "3. Providers" },
    { id: "plugins", label: "4. Plugins" },
    { id: "behaviour", label: "5. Agent Behaviour" },
    { id: "usage", label: "6. Usage" },
    { id: "profiles", label: "7. Profiles / Skills" },
    { id: "raw", label: "8. Raw Config" },
    { id: "ops", label: "9. Ops" },
    { id: "mcp", label: "10. MCP" },
    { id: "skills", label: "11. Skills" },
    { id: "catalog", label: "12. Providers catalog" },
    { id: "runner", label: "13. Runner & Providers" },
  ];

  const defaultLanListen = lanIpHint ? `${lanIpHint}:6767` : "0.0.0.0:6767";

  return (
    <section className="ts-team" data-testid="paseo-settings-section" style={{ borderLeftColor: "#00f0ff" }}>
      <div className="ts-scale-head" style={{ marginBottom: 8 }}>
        <div>
          <div className="field-label">PASEO SETTINGS (HOST MODE · ~/.paseo/config.json)</div>
          <div className="muted small">
            Edits Paseo&apos;s own config (keeps last 5 backups, no BOM) and runs <code>paseo reload</code> or prompts to restart when required. Secrets are masked.
          </div>
        </div>
        {status && (
          <span className={`pill diag ${status.running ? "ok" : "warn"}`} data-testid="paseo-daemon-pill">
            {status.running ? `RUNNING · v${status.version || "?"}` : "STOPPED"}
          </span>
        )}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }} role="tablist" aria-label="Paseo settings tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-testid={`paseo-tab-${t.id}`}
            data-setting-id={t.id === "daemon" ? "paseo-daemon" : t.id === "providers" ? "paseo-providers" : undefined}
            className={`btn small ${tab === t.id ? "on" : "ghost"}`}
            onClick={() => {
              setTab(t.id);
              setErrorMsg("");
              setNotice("");
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {providerWarning && (
        <div
          className="stat-alert small"
          role="alert"
          data-testid="paseo-provider-health-warning"
          style={{ marginBottom: 8 }}
        >
          ⚠ {providerWarning}
        </div>
      )}
      {errorMsg && errorMsg !== providerWarning && (
        <div className="stat-alert small" role="alert" data-testid="paseo-settings-error" style={{ marginBottom: 8 }}>
          ⚠ {errorMsg}
        </div>
      )}
      {notice && (
        <div className="small" data-testid="paseo-settings-notice" style={{ color: "#00f0ff", marginBottom: 8 }}>
          ✓ {notice}
        </div>
      )}

      {tab === "daemon" && status && (
        <div data-testid="paseo-panel-daemon" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <span className="def-badge" data-testid="paseo-status-version">
              <b>Version</b> {status.version || "—"}
            </span>
            <span className="def-badge" data-testid="paseo-status-listen">
              <b>Listen</b> {status.listen}
            </span>
            <span className="def-badge" data-testid="paseo-status-uptime">
              <b>Uptime</b> {formatUptime(status.uptimeMs)}
            </span>
            <span className="def-badge" data-testid="paseo-status-ownership">
              <b>Managed</b> {status.ownership === "vibesquad-managed" ? "VibeSquad-managed" : status.ownership === "external" ? "External daemon" : "Stopped"}
            </span>
            <span className="def-badge" data-testid="paseo-status-agents">
              <b>Agents</b> {status.liveAgentCount} live · {status.busyAgentCount} busy
            </span>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button
              type="button"
              className="btn ok small"
              disabled={busy || status.running}
              data-testid="paseo-daemon-start-btn"
              onClick={() => void runDaemonAction("start")}
            >
              Start
            </button>
            <button
              type="button"
              className="btn small"
              disabled={busy || !status.running}
              data-testid="paseo-daemon-reload-btn"
              onClick={() => void runDaemonAction("reload")}
            >
              Reload config
            </button>
            <button
              type="button"
              className="btn ghost small"
              disabled={busy || !status.running}
              data-testid="paseo-daemon-restart-btn"
              onClick={() => {
                if (status.busyAgentCount > 0) setConfirmDaemonAction("restart");
                else void runDaemonAction("restart", true);
              }}
            >
              Restart{status.busyAgentCount > 0 ? ` (${status.busyAgentCount} busy)` : ""}
            </button>
            <button
              type="button"
              className="btn ghost small bad-btn"
              disabled={busy || !status.running}
              data-testid="paseo-daemon-stop-btn"
              onClick={() => {
                if (status.busyAgentCount > 0) setConfirmDaemonAction("stop");
                else void runDaemonAction("stop", true);
              }}
            >
              Stop{status.busyAgentCount > 0 ? ` (${status.busyAgentCount} busy)` : ""}
            </button>
          </div>

          {confirmDaemonAction && (
            <div className="dup-warning" data-testid="paseo-busy-confirm-banner" role="alert">
              <b>
                ⚠ {status.busyAgentCount} agent(s) are currently busy. {confirmDaemonAction === "stop" ? "Stopping" : "Restarting"} the daemon will interrupt them.
              </b>
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <button
                  type="button"
                  className="btn small bad-btn"
                  data-testid="paseo-confirm-busy-action-btn"
                  onClick={() => void runDaemonAction(confirmDaemonAction, true)}
                >
                  Confirm {confirmDaemonAction} ({status.busyAgentCount} busy)
                </button>
                <button type="button" className="btn ghost small" onClick={() => setConfirmDaemonAction(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              data-testid="paseo-keep-running-toggle"
              checked={status.keepPaseoRunningOnQuit}
              onChange={(e) => void toggleSettingFlag("keepPaseoRunningOnQuit", e.target.checked)}
            />
            <span>
              <b>Keep Paseo running when VibeSquad quits</b>{" "}
              <span className="muted small">(default ON; an external daemon is never stopped)</span>
            </span>
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              data-testid="paseo-start-with-vs-toggle"
              checked={status.startPaseoWithVibeSquad}
              onChange={(e) => void toggleSettingFlag("startPaseoWithVibeSquad", e.target.checked)}
            />
            <span>
              <b>Start Paseo with VibeSquad</b>{" "}
              <span className="muted small">(automatically starts local daemon on launch if not already running)</span>
            </span>
          </label>
        </div>
      )}

      {tab === "network" && surface && (
        <div data-testid="paseo-panel-network" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div className="field-label">DAEMON LISTEN ADDRESS (daemon.listen · restart required)</div>
            <div className="muted small">Exposes the Paseo daemon WebSocket/HTTP API on the chosen interface.</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
              <button
                type="button"
                className={`btn small ${listenDraft.startsWith("127.0.0.1") ? "on" : "ghost"}`}
                data-testid="paseo-listen-preset-local"
                onClick={() => setListenDraft("127.0.0.1:6767")}
              >
                This PC only (127.0.0.1:6767)
              </button>
              <button
                type="button"
                className={`btn small ${!listenDraft.startsWith("127.0.0.1") ? "on" : "ghost"}`}
                data-testid="paseo-listen-preset-lan"
                onClick={() => setListenDraft(defaultLanListen)}
              >
                LAN ({defaultLanListen})
              </button>
              <input
                data-testid="paseo-listen-input"
                value={listenDraft}
                onChange={(e) => setListenDraft(e.target.value)}
                style={{ width: 220 }}
              />
              <button
                type="button"
                className="btn ok small"
                data-testid="paseo-listen-save-btn"
                onClick={() => void applySurfacePatch({ listen: listenDraft }, "Saved daemon.listen")}
              >
                Save listen
              </button>
            </div>
            {(surface.network.restartRequired || (status && status.restartRequired)) && (
              <div className="stat-alert small" data-testid="paseo-listen-restart-prompt" style={{ marginTop: 6 }}>
                ⚠ Daemon is still listening on <code>{surface.network.activeListen}</code>. Restart the daemon to bind <code>{surface.network.listen}</code>.{" "}
                <button
                  type="button"
                  className="btn small"
                  data-testid="paseo-listen-restart-now-btn"
                  onClick={() => void runDaemonAction("restart", false)}
                >
                  Restart daemon now
                </button>
              </div>
            )}
          </div>

          <div>
            <div className="field-label">CORS ALLOWED ORIGINS (daemon.cors.allowedOrigins)</div>
            <div className="muted small">Exposes the daemon to browser web apps served from these origins.</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
              {corsDraft.map((origin, idx) => (
                <span key={idx} className="def-badge" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {origin}
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => {
                      const next = corsDraft.filter((_, j) => j !== idx);
                      setCorsDraft(next);
                      void applySurfacePatch({ corsAllowedOrigins: next }, "Updated CORS allowed origins");
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <input
                placeholder="https://example.com"
                value={newOrigin}
                data-testid="paseo-cors-new-input"
                onChange={(e) => setNewOrigin(e.target.value)}
              />
              <button
                type="button"
                className="btn small"
                data-testid="paseo-cors-add-btn"
                onClick={() => {
                  const clean = newOrigin.trim();
                  if (!clean) return;
                  const next = [...new Set([...corsDraft, clean])];
                  setCorsDraft(next);
                  setNewOrigin("");
                  void applySurfacePatch({ corsAllowedOrigins: next }, "Added CORS origin");
                }}
              >
                + Add origin
              </button>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div className="field-label">PASEO RELAY (daemon.relay.enabled)</div>
              <div className="muted small">Exposes end-to-end encrypted remote access through app.paseo.sh / relay.paseo.sh.</div>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontWeight: 700 }}>
              <input
                type="checkbox"
                data-testid="paseo-relay-toggle"
                checked={surface.network.relayEnabled}
                onChange={(e) => void applySurfacePatch({ relayEnabled: e.target.checked }, "Updated daemon.relay.enabled")}
              />
              <span>{surface.network.relayEnabled ? "Enabled" : "Disabled"}</span>
            </label>
          </div>

          <div>
            <div className="field-label">PAIRING QR &amp; LINK (paseo pair)</div>
            <div className="muted small">Exposes a pairing offer link/QR so Paseo mobile or web clients can connect to this daemon.</div>
            <div style={{ marginTop: 6 }}>
              <button
                type="button"
                className="btn small"
                data-testid="paseo-pair-show-btn"
                onClick={async () => {
                  const r = await fetch("/__vibesquad/paseo/pair");
                  if (r.ok) setPairOffer(await r.json());
                }}
              >
                Show Paseo Pairing QR
              </button>
              {pairOffer && (
                <div style={{ marginTop: 8 }} data-testid="paseo-pair-output">
                  {pairOffer.url && (
                    <div className="small" style={{ marginBottom: 4, wordBreak: "break-all" }}>
                      <b>Offer URL:</b> <code>{pairOffer.url}</code>
                    </div>
                  )}
                  {pairOffer.qr && (
                    <pre style={{ fontSize: 9, lineHeight: 1.05, overflowX: "auto", background: "#05060d", padding: 8 }}>
                      {pairOffer.qr}
                    </pre>
                  )}
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="field-label">PASEO HUB (paseo hub · state: {surface.network.hub.state})</div>
            <div className="muted small">Enrolls this daemon with a Paseo Hub organization so Hub triggers can run agents here.</div>
            <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
              <input
                placeholder="https://hub.paseo.sh (optional)"
                value={hubOrigin}
                data-testid="paseo-hub-origin-input"
                onChange={(e) => setHubOrigin(e.target.value)}
              />
              <button
                type="button"
                className="btn small"
                data-testid="paseo-hub-connect-btn"
                onClick={async () => {
                  const r = await fetch("/__vibesquad/paseo/hub", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ action: "connect", origin: hubOrigin }),
                  });
                  const d = await r.json();
                  if (!d.ok) setErrorMsg(d.error || "Hub connect failed");
                  else setNotice(d.output || "Connected to Hub");
                  await loadAll();
                }}
              >
                Connect
              </button>
              <button
                type="button"
                className="btn ghost small"
                data-testid="paseo-hub-disconnect-btn"
                onClick={async () => {
                  const r = await fetch("/__vibesquad/paseo/hub", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ action: "disconnect" }),
                  });
                  const d = await r.json();
                  if (!d.ok) setErrorMsg(d.error || "Hub disconnect failed");
                  else setNotice(d.output || "Disconnected from Hub");
                  await loadAll();
                }}
              >
                Disconnect
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === "providers" && (
        <div data-testid="paseo-panel-providers" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {providers.map((p) => (
            <div key={p.id} className="ts-team" data-testid={`paseo-provider-row-${p.id}`} style={{ padding: "8px 10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <b>{p.label}</b>
                  <span className="muted small">({p.id})</span>
                  <span className={`pill diag ${p.status === "available" ? "ok" : p.status === "error" ? "hot" : "warn"}`}>
                    {p.status}
                  </span>
                  {p.isCustomAcp && <span className="chip">ACP: {p.command.join(" ")}</span>}
                  {p.envKeys.length > 0 && (
                    <span className="muted small" data-testid={`paseo-provider-env-${p.id}`}>
                      env: {p.envKeys.map((k) => `${k}=${p.envMasked[k]}`).join(", ")}
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      data-testid={`paseo-provider-toggle-${p.id}`}
                      checked={p.enabled}
                      onChange={(e) => void onToggleProvider(p.id, e.target.checked)}
                    />
                    <span>{p.enabled ? "Enabled" : "Disabled"}</span>
                  </label>
                  <button
                    type="button"
                    className="btn ghost small"
                    data-testid={`paseo-provider-diag-btn-${p.id}`}
                    onClick={() => void onLoadDiagnostic(p.id)}
                  >
                    Diagnostics
                  </button>
                  <button
                    type="button"
                    className="btn ghost small"
                    data-testid={`paseo-provider-models-btn-${p.id}`}
                    onClick={() => void onLoadModels(p.id)}
                  >
                    Models
                  </button>
                  {p.isCustomAcp && (
                    <button
                      type="button"
                      className="btn ghost small"
                      data-testid={`paseo-provider-edit-acp-${p.id}`}
                      onClick={() => onEditCustomAcp(p)}
                    >
                      Edit ACP
                    </button>
                  )}
                </div>
              </div>
              {diagText[p.id] && (
                <pre
                  data-testid={`paseo-provider-diag-out-${p.id}`}
                  style={{ marginTop: 6, fontSize: 11, maxHeight: 160, overflow: "auto", whiteSpace: "pre-wrap" }}
                >
                  {diagText[p.id]}
                </pre>
              )}
              {modelsByProv[p.id] && (
                <div data-testid={`paseo-provider-models-out-${p.id}`} style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                  {modelsByProv[p.id].map((m) => (
                    <span key={m.id} className="def-badge" title={m.description || ""}>
                      <b>{m.model}</b> ({m.id})
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}

          <div className="ts-team" data-testid="paseo-custom-acp-editor" style={{ padding: "10px 12px" }}>
            <div className="field-label">ADD / EDIT CUSTOM ACP PROVIDER (extends: &quot;acp&quot; · env values masked)</div>
            <div className="row2" style={{ marginTop: 6 }}>
              <Field label="PROVIDER ID">
                <input
                  placeholder="my-agent"
                  value={acpId}
                  data-testid="acp-provider-id-input"
                  onChange={(e) => setAcpId(e.target.value)}
                />
              </Field>
              <Field label="LABEL">
                <input
                  placeholder="My Custom Agent"
                  value={acpLabel}
                  data-testid="acp-provider-label-input"
                  onChange={(e) => setAcpLabel(e.target.value)}
                />
              </Field>
              <Field label="COMMAND (space-separated)">
                <input
                  placeholder="my-agent serve --acp"
                  value={acpCommand}
                  data-testid="acp-provider-command-input"
                  onChange={(e) => setAcpCommand(e.target.value)}
                />
              </Field>
            </div>
            <div style={{ marginTop: 6 }}>
              <div className="muted small">Environment variables (values are masked in the UI):</div>
              {acpEnvRows.map((row, idx) => (
                <div key={idx} style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  <input
                    placeholder="API_KEY"
                    value={row.key}
                    data-testid={`acp-env-key-${idx}`}
                    onChange={(e) =>
                      setAcpEnvRows((rows) => rows.map((r, j) => (j === idx ? { ...r, key: e.target.value } : r)))
                    }
                  />
                  <input
                    type="password"
                    placeholder="••••••••"
                    value={row.value}
                    data-testid={`acp-env-val-${idx}`}
                    onChange={(e) =>
                      setAcpEnvRows((rows) => rows.map((r, j) => (j === idx ? { ...r, value: e.target.value } : r)))
                    }
                  />
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => setAcpEnvRows((rows) => rows.filter((_, j) => j !== idx))}
                  >
                    −
                  </button>
                </div>
              ))}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  className="btn ghost small"
                  data-testid="acp-add-env-btn"
                  onClick={() => setAcpEnvRows((rows) => [...rows, { key: "", value: "" }])}
                >
                  + env variable
                </button>
                <button
                  type="button"
                  className="btn ok small"
                  data-testid="acp-save-provider-btn"
                  disabled={busy || !acpId.trim() || !acpCommand.trim()}
                  onClick={() => void onSaveCustomAcp()}
                >
                  Save Custom ACP Provider
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "plugins" && (
        <div data-testid="paseo-panel-plugins" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {plugins.map((pl) => (
            <div key={pl.id} className="ts-team" data-testid={`paseo-plugin-row-${pl.id}`} style={{ padding: "8px 10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <b>{pl.name}</b>
                  <span className="muted small">({pl.id})</span>
                  <span className={`pill diag ${pl.status === "running" ? "ok" : "warn"}`}>{pl.status}</span>
                  <span className="muted small">{pl.path}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      data-testid={`paseo-plugin-toggle-${pl.id}`}
                      checked={pl.enabled}
                      onChange={(e) =>
                        void onPluginAction(e.target.checked ? "enable" : "disable", { id: pl.id })
                      }
                    />
                    <span>{pl.enabled ? "Enabled" : "Disabled"}</span>
                  </label>
                  <button
                    type="button"
                    className="btn ghost small"
                    data-testid={`paseo-plugin-reload-${pl.id}`}
                    onClick={() => void onPluginAction("reload", { id: pl.id })}
                  >
                    Reload
                  </button>
                  <button
                    type="button"
                    className="btn ghost small"
                    data-testid={`paseo-plugin-logs-${pl.id}`}
                    onClick={() => void onPluginAction("logs", { id: pl.id })}
                  >
                    Logs
                  </button>
                  <button
                    type="button"
                    className="btn ghost small"
                    data-testid={`paseo-plugin-update-${pl.id}`}
                    onClick={() => void onPluginAction("update", { id: pl.id })}
                  >
                    Update
                  </button>
                  {!pl.isVibeSquad && (
                    <button
                      type="button"
                      className="btn ghost small bad-btn"
                      data-testid={`paseo-plugin-remove-${pl.id}`}
                      onClick={() => void onPluginAction("remove", { id: pl.id })}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
              {pl.isVibeSquad && confirmDisableVs && (
                <div className="dup-warning" data-testid="paseo-vibesquad-disable-warning" style={{ marginTop: 6 }}>
                  <b>⚠ Disabling the vibesquad plugin stops role packs and roster guards.</b>
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <button
                      type="button"
                      className="btn small bad-btn"
                      data-testid="paseo-confirm-disable-vibesquad-btn"
                      onClick={() => void onPluginAction("disable", { id: "vibesquad", confirmDisableVibeSquad: true })}
                    >
                      Disable vibesquad anyway
                    </button>
                    <button type="button" className="btn ghost small" onClick={() => setConfirmDisableVs(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {pluginLogs[pl.id] && (
                <pre style={{ marginTop: 6, fontSize: 11, maxHeight: 150, overflow: "auto", whiteSpace: "pre-wrap" }}>
                  {pluginLogs[pl.id]}
                </pre>
              )}
            </div>
          ))}

          <PluginUpdatesPanel onApplied={() => void loadTabDetails("plugins")} />

          <div className="ts-team" style={{ padding: "10px 12px" }}>
            <div className="field-label">INSTALL PLUGIN (directory, git repository, or npm package)</div>
            <div className="stat-alert small" style={{ marginBottom: 6 }}>
              ⚠ Paseo plugins are unsandboxed and run with full access to this PC.
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                placeholder="C:\path\to\plugin or git:https://... or npm-pkg"
                value={installSource}
                data-testid="paseo-plugin-install-input"
                onChange={(e) => setInstallSource(e.target.value)}
                style={{ flex: 1, minWidth: 240 }}
              />
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  data-testid="paseo-plugin-unsandboxed-ack"
                  checked={confirmInstall}
                  onChange={(e) => setConfirmInstall(e.target.checked)}
                />
                <span className="small">I understand this plugin runs unsandboxed with full access</span>
              </label>
              <button
                type="button"
                className="btn small"
                data-testid="paseo-plugin-install-btn"
                disabled={busy || !installSource.trim() || !confirmInstall}
                onClick={() => void onPluginAction("install", { source: installSource, confirmUnsandboxed: true })}
              >
                Install Plugin
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === "behaviour" && surface && (
        <div data-testid="paseo-panel-behaviour" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
            <div>
              <b>MCP injection into agents</b> (<code>daemon.mcp.injectIntoAgents</code>)
              <div className="muted small">Automatically injects Paseo&apos;s MCP tools into spawned coding agents.</div>
            </div>
            <input
              type="checkbox"
              data-testid="paseo-behaviour-mcp-toggle"
              checked={surface.behaviour.mcpInjectIntoAgents}
              onChange={(e) => void applySurfacePatch({ mcpInjectIntoAgents: e.target.checked }, "Updated daemon.mcp.injectIntoAgents")}
            />
          </label>

          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
            <div>
              <b>Browser tools</b> (<code>daemon.browserTools.enabled</code>)
              <div className="muted small">Enables Paseo&apos;s built-in browser inspection and automation tools for agents.</div>
            </div>
            <input
              type="checkbox"
              data-testid="paseo-behaviour-browser-toggle"
              checked={surface.behaviour.browserToolsEnabled}
              onChange={(e) => void applySurfacePatch({ browserToolsEnabled: e.target.checked }, "Updated daemon.browserTools.enabled")}
            />
          </label>

          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
            <div>
              <b>Auto-archive after merge</b> (<code>daemon.autoArchiveAfterMerge</code>)
              <div className="muted small">Automatically archives an agent once its worktree branch is merged.</div>
            </div>
            <input
              type="checkbox"
              data-testid="paseo-behaviour-autoarchive-toggle"
              checked={surface.behaviour.autoArchiveAfterMerge}
              onChange={(e) => void applySurfacePatch({ autoArchiveAfterMerge: e.target.checked }, "Updated daemon.autoArchiveAfterMerge")}
            />
          </label>

          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
            <div>
              <b>Terminal agent hooks</b> (<code>daemon.enableTerminalAgentHooks</code>)
              <div className="muted small">Records activity hooks for agents started inside workspace terminals.</div>
            </div>
            <input
              type="checkbox"
              data-testid="paseo-behaviour-hooks-toggle"
              checked={surface.behaviour.enableTerminalAgentHooks}
              onChange={(e) => void applySurfacePatch({ enableTerminalAgentHooks: e.target.checked }, "Updated daemon.enableTerminalAgentHooks")}
            />
          </label>

          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
            <div>
              <b>Turn off Paseo&apos;s own finished notifications</b>
              <div className="muted small">VibeSquad sends them now — disable Paseo&apos;s duplicate toasts.</div>
            </div>
            <input
              type="checkbox"
              data-testid="toggle-paseo-finished-notifications"
              checked={surface.behaviour.suppressDesktopFinishedNotifications}
              onChange={(e) => void applySurfacePatch({ suppressDesktopFinishedNotifications: e.target.checked }, "Updated daemon.suppressDesktopFinishedNotifications")}
            />
          </label>
        </div>
      )}

      {tab === "usage" && (
        <div data-testid="paseo-panel-usage" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="muted small">Provider account quotas and balances from <code>paseo usage ls</code>.</div>
            <button
              type="button"
              className="btn ghost small"
              data-testid="paseo-usage-refresh-btn"
              onClick={async () => {
                const r = await fetch("/__vibesquad/paseo/usage?refresh=1");
                if (r.ok) {
                  const d = await r.json();
                  if (Array.isArray(d.providers)) setUsage(d.providers);
                }
              }}
            >
              Refresh usage
            </button>
          </div>
          {usage.length === 0 ? (
            <div className="muted small">No usage reports available.</div>
          ) : (
            usage.map((u) => (
              <div key={u.id} className="ts-team" data-testid={`paseo-usage-row-${u.sourceId}`} style={{ padding: "8px 10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <b>{u.sourceLabel}</b> {u.planLabel && <span className="chip">{u.planLabel}</span>}{" "}
                    {u.account && <span className="muted small">({u.account})</span>}
                  </div>
                  <span className={`pill diag ${u.status === "available" ? "ok" : "warn"}`}>{u.status}</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
                  {u.windows.map((w) => (
                    <span key={w.id} className="def-badge">
                      <b>{w.label}:</b> {w.usedPct ?? 0}% used ({w.remainingPct ?? 100}% left)
                    </span>
                  ))}
                  {u.balances.map((b) => (
                    <span key={b.id} className="def-badge">
                      <b>{b.label}:</b> {b.remaining} {b.unit}
                    </span>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === "profiles" && surface && (
        <div data-testid="paseo-panel-profiles" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <div className="field-label">AGENT PROFILES ({surface.profileCount} in daemon.agentProfiles)</div>
            <div className="muted small">
              VibeSquad owns <code>daemon.agentProfiles</code> via its Profiles section below and syncs changes to Paseo.
            </div>
            {onJumpToProfiles && (
              <button
                type="button"
                className="btn small"
                data-testid="paseo-jump-profiles-btn"
                style={{ marginTop: 6 }}
                onClick={onJumpToProfiles}
              >
                Jump to VibeSquad Agent Profiles ↓
              </button>
            )}
          </div>
          <div>
            <div className="field-label">SKILLS (agents.skills · read-only)</div>
            <pre style={{ fontSize: 11, background: "#05060d", padding: 8 }}>
              {JSON.stringify(surface.skills, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {tab === "ops" && <PaseoOpsPanel />}
      {tab === "mcp" && <McpPanel />}
      {tab === "skills" && <SkillsPanel />}
      {tab === "catalog" && <ProviderCatalogPanel />}
      {tab === "runner" && <RunnerProvidersPanel />}

      {tab === "raw" && surface && (
        <div data-testid="paseo-panel-raw" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              className="btn small"
              data-testid="paseo-raw-open-btn"
              onClick={async () => {
                const r = await fetch("/__vibesquad/paseo/raw/open", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({}),
                });
                const d = await r.json();
                if (d.ok) setNotice(`Opened ${d.path}`);
                else setErrorMsg(d.error || "Could not open config.json");
              }}
            >
              Open config.json ({surface.configPath})
            </button>
            <button
              type="button"
              className="btn ghost small"
              data-testid="paseo-raw-restore-btn"
              disabled={busy || surface.backups.length === 0}
              onClick={async () => {
                setBusy(true);
                setErrorMsg("");
                setNotice("");
                try {
                  const r = await fetch("/__vibesquad/paseo/raw/restore", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({}),
                  });
                  const d = await r.json();
                  if (!r.ok || !d.ok) setErrorMsg(d.error || "Restore failed");
                  else {
                    setNotice(`Restored config.json from ${d.restoredFrom} and reloaded.`);
                    await loadAll();
                  }
                } catch (e) {
                  setErrorMsg(String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Restore last backup ({surface.backups.length} saved, max 5)
            </button>
          </div>
          <pre
            data-testid="paseo-raw-masked-json"
            style={{ fontSize: 11, maxHeight: 240, overflow: "auto", background: "#05060d", padding: 8 }}
          >
            {JSON.stringify(surface.maskedConfig, null, 2)}
          </pre>
        </div>
      )}
    </section>
  );
}
