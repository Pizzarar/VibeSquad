import { useCallback, useEffect, useRef, useState } from "react";
import { DEMO, usePaseo } from "./paseo";
import { fetchDaemonConfig, fetchUsageReports, measureRtt, patchAndReloadDaemonConfig, reloadDaemonConfig, type DaemonReloadResult } from "./paseoOps";
import { EDITABLE_CONFIG_FIELDS, LOCKED_CONFIG_SECTIONS, LOCKED_NOTE, buildConfigDiff, buildConfigPatch, configChangeWarnings, formatDiffValue, readConfigPath, validateFieldValue, formatConfigJson, formatLatency, formatMaskedJson, latencyTone, summarizeUsageReport, type UsageReportLike } from "./paseoOpsLogic";

const KEEP_AWAKE_STORAGE_KEY = "vs:keep-host-awake";

function readInitialKeepAwake(): boolean {
  try {
    const raw = localStorage.getItem(KEEP_AWAKE_STORAGE_KEY);
    if (raw === "false" || raw === "0") return false;
    if (raw === "true" || raw === "1") return true;
  } catch {}
  return true;
}

export function PaseoOpsPanel() {
  const { agents } = usePaseo();
  const [keepAwake, setKeepAwake] = useState<boolean>(readInitialKeepAwake);
  const [config, setConfig] = useState<unknown>(null);
  const [reload, setReload] = useState<DaemonReloadResult | null>(null);
  const [reports, setReports] = useState<UsageReportLike[]>([]);
  const [openReport, setOpenReport] = useState<string | null>(null);
  const [rtt, setRtt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Several requests run at once: busy stays true until the last one settles.
  const run = useCallback(async (fn: () => Promise<void>) => {
    pending.current += 1;
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      if (mounted.current) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      pending.current -= 1;
      if (mounted.current && pending.current === 0) setBusy(false);
    }
  }, []);

  const ping = useCallback(() => run(async () => { const v = await measureRtt(); if (mounted.current) setRtt(v); }), [run]);
  const loadConfig = useCallback(() => run(async () => { const v = await fetchDaemonConfig(); if (mounted.current) setConfig(v); }), [run]);
  const loadReports = useCallback((force: boolean) => run(async () => { const v = await fetchUsageReports(force); if (mounted.current) setReports(v); }), [run]);

  useEffect(() => {
    void ping();
    void loadConfig();
    void loadReports(false);
  }, [ping, loadConfig, loadReports]);

  let runningAgentCount = 0;
  for (const a of agents.values()) {
    if (a && !a.archivedAt && a.status === "running") runningAgentCount += 1;
  }
  const holdingWakeLock = keepAwake && runningAgentCount > 0;
  const keepAwakeStatusText = !keepAwake
    ? "OFF"
    : holdingWakeLock
      ? `ACTIVE (holding wake lock · ${runningAgentCount} running)`
      : "ARMED (waiting for running agents)";
  const keepAwakeTone = !keepAwake ? "none" : holdingWakeLock ? "ok" : "warn";

  useEffect(() => {
    try {
      localStorage.setItem(KEEP_AWAKE_STORAGE_KEY, keepAwake ? "true" : "false");
    } catch {}
    if (DEMO) return;
    const payload = {
      enabled: keepAwake,
      agents: Array.from(agents.values()).map((a) => ({ id: a.id, status: a.status, archivedAt: a.archivedAt })),
    };
    fetch("/__vibesquad/keep-awake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }, [keepAwake, runningAgentCount, agents]);

  const diff = config ? buildConfigDiff(config, draft) : [];
  const fieldValue = (f: (typeof EDITABLE_CONFIG_FIELDS)[number]) => {
    if (f.path in draft) return draft[f.path];
    const cur = readConfigPath(config, f.path);
    return cur === undefined ? f.fallback : cur;
  };
  const closeEdit = () => { setEditing(false); setConfirming(false); setDraft({}); };
  const applyEdit = () =>
    run(async () => {
      const { reload: r, config: c } = await patchAndReloadDaemonConfig(buildConfigPatch(diff), (saved) => { if (mounted.current) setConfig(saved); });
      if (!mounted.current) return;
      setReload(r);
      setConfig(c);
      closeEdit();
    });

  return (
    <div className="paseo-ops" data-testid="paseo-panel-ops">
      {err && <div className="paseo-ops-err" data-testid="paseo-ops-error">{err}</div>}

      <div className="paseo-ops-block">
        <div className="field-label">CONNECTION LATENCY</div>
        <div className="paseo-ops-row">
          <span className={`pill diag ${latencyTone(rtt)}`} data-testid="paseo-ops-rtt">RTT {formatLatency(rtt)}</span>
          <button type="button" className="btn ghost small" disabled={busy} data-testid="paseo-ops-rtt-btn" onClick={() => void ping()}>Measure</button>
        </div>
      </div>

      <div className="paseo-ops-block">
        <div className="field-label">KEEP HOST AWAKE</div>
        <div className="paseo-ops-row">
          <label className="paseo-ops-field">
            <input
              type="checkbox"
              data-testid="paseo-ops-keep-awake-toggle"
              checked={keepAwake}
              onChange={(e) => setKeepAwake(e.target.checked)}
            />{" "}
            <span>Keep host awake while agents run</span>
          </label>
          <span className={`pill diag ${keepAwakeTone}`} data-testid="paseo-ops-keep-awake-status">
            {keepAwakeStatusText}
          </span>
        </div>
      </div>

      <div className="paseo-ops-block">
        <div className="field-label">DAEMON CONFIG (SECRETS REDACTED)</div>
        <div className="paseo-ops-row">
          <button
            type="button"
            className="btn small"
            disabled={busy}
            data-testid="paseo-ops-reload-btn"
            onClick={() => void run(async () => { const r = await reloadDaemonConfig(); if (mounted.current) setReload(r); const c = await fetchDaemonConfig(); if (mounted.current) setConfig(c); })}
          >
            Reload config
          </button>
          {reload && (
            <span className="muted small" data-testid="paseo-ops-reload-result">
              applied {reload.appliedPaths.length} · restart needed {reload.restartRequiredPaths.length} · overridden {reload.overrideControlledPaths.length}
            </span>
          )}
        </div>
        {reload && reload.appliedPaths.length > 0 && <div className="muted small">Applied: {reload.appliedPaths.join(", ")}</div>}
        {reload && reload.restartRequiredPaths.length > 0 && <div className="muted small">Restart required for: {reload.restartRequiredPaths.join(", ")}</div>}
        {reload && reload.overrideControlledPaths.length > 0 && <div className="muted small">Overridden: {reload.overrideControlledPaths.join(", ")}</div>}
        <div className="paseo-ops-row">
          {!editing ? (
            <button type="button" className="btn ghost small" disabled={busy || !config} data-testid="paseo-ops-edit-btn" onClick={() => setEditing(true)}>Edit settings</button>
          ) : (
            <button type="button" className="btn ghost small" disabled={busy} data-testid="paseo-ops-edit-cancel" onClick={closeEdit}>Cancel edit</button>
          )}
        </div>
        {editing && (
          <div className="paseo-ops-edit" data-testid="paseo-ops-edit">
            {EDITABLE_CONFIG_FIELDS.map((f) => {
              const val = fieldValue(f);
              const check = validateFieldValue(f, val);
              const id = `paseo-ops-field-${f.path}`;
              return (
                <div key={f.path} className="paseo-ops-field">
                  <label htmlFor={id}><b>{f.label}</b> <span className="muted small">{f.path}</span></label>
                  {f.kind === "boolean" && <input id={id} type="checkbox" data-testid={id} checked={val === true} disabled={busy || confirming} onChange={(e) => setDraft({ ...draft, [f.path]: e.target.checked })} />}
                  {f.kind === "enum" && (
                    <select id={id} data-testid={id} value={String(val)} disabled={busy || confirming} onChange={(e) => setDraft({ ...draft, [f.path]: e.target.value })}>
                      {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  )}
                  {f.kind === "number" && <input id={id} type="number" data-testid={id} min={f.min} max={f.max} value={String(val)} disabled={busy || confirming} onChange={(e) => setDraft({ ...draft, [f.path]: e.target.value })} />}
                  {f.kind === "string" && <input id={id} type="text" data-testid={id} maxLength={f.maxLength} value={String(val)} disabled={busy || confirming} onChange={(e) => setDraft({ ...draft, [f.path]: e.target.value })} />}
                  <div className="muted small">{f.help}</div>
                  {!check.ok && <div className="paseo-ops-err">{check.error}</div>}
                </div>
              );
            })}
            {!confirming ? (
              <button type="button" className="btn small" disabled={busy || diff.length === 0} data-testid="paseo-ops-edit-review" onClick={() => setConfirming(true)}>
                Review changes{diff.length ? ` (${diff.length})` : ""}
              </button>
            ) : (
              <div className="paseo-ops-diff" data-testid="paseo-ops-diff">
                <div className="field-label">CONFIRM CHANGES</div>
                {diff.map((d) => (
                  <div key={d.path} className="paseo-ops-diff-row" data-testid={`paseo-ops-diff-${d.path}`}>
                    <code>{d.path}</code>: <span className="paseo-ops-old">{formatDiffValue(d.from)}</span> → <span className="paseo-ops-new">{formatDiffValue(d.to)}</span>
                  </div>
                ))}
                {configChangeWarnings(diff).map((w) => (
                  <div key={w.path} className={w.level === "warn" ? "paseo-ops-err" : "muted small"} data-testid={`paseo-ops-warn-${w.path}`}>{w.level === "warn" ? "Warning: " : "Note: "}{w.text}</div>
                ))}
                <div className="muted small">Saved to the daemon, then the config is reloaded.</div>
                <div className="paseo-ops-row">
                  <button type="button" className="btn small" disabled={busy || diff.length === 0} data-testid="paseo-ops-edit-apply" onClick={() => void applyEdit()}>Apply and reload</button>
                  <button type="button" className="btn ghost small" disabled={busy} data-testid="paseo-ops-edit-back" onClick={() => setConfirming(false)}>Back</button>
                </div>
              </div>
            )}
          </div>
        )}
        <div className="paseo-ops-locked" data-testid="paseo-ops-locked">
          <div className="muted small">Read-only here ({LOCKED_NOTE}):</div>
          <ul>
            {LOCKED_CONFIG_SECTIONS.map((l) => <li key={l.path}><span>{l.label}</span> <code className="muted small">{l.path}</code></li>)}
          </ul>
        </div>
        <pre className="paseo-ops-pre" data-testid="paseo-ops-config">{config ? formatConfigJson(config) : busy ? "(loading…)" : "(unavailable)"}</pre>
      </div>

      <div className="paseo-ops-block">
        <div className="field-label">USAGE REPORTS</div>
        <div className="paseo-ops-row">
          <button type="button" className="btn ghost small" disabled={busy} data-testid="paseo-ops-usage-refresh" onClick={() => void loadReports(true)}>Refresh</button>
          <span className="muted small">{reports.length} report(s)</span>
        </div>
        {reports.map((entry) => {
          const row = summarizeUsageReport(entry);
          const open = openReport === row.id;
          return (
            <div key={row.id} className="paseo-ops-report" data-testid={`paseo-ops-report-${row.id}`}>
              <button type="button" className="paseo-ops-report-head" onClick={() => setOpenReport(open ? null : row.id)} aria-expanded={open}>
                <b>{row.title}</b>
                <span className={`pill diag ${row.status === "available" ? "ok" : "warn"}`}>{row.status}</span>
              </button>
              <div className="muted small">{row.summary}</div>
              {open && <pre className="paseo-ops-pre">{formatMaskedJson(entry)}</pre>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
