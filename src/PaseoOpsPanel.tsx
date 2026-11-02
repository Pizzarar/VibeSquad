import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDaemonConfig, fetchUsageReports, measureRtt, reloadDaemonConfig, type DaemonReloadResult } from "./paseoOps";
import { formatConfigJson, formatLatency, formatMaskedJson, latencyTone, summarizeUsageReport, type UsageReportLike } from "./paseoOpsLogic";

export function PaseoOpsPanel() {
  const [config, setConfig] = useState<unknown>(null);
  const [reload, setReload] = useState<DaemonReloadResult | null>(null);
  const [reports, setReports] = useState<UsageReportLike[]>([]);
  const [openReport, setOpenReport] = useState<string | null>(null);
  const [rtt, setRtt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
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
        <div className="field-label">DAEMON CONFIG (READ-ONLY · SECRETS REDACTED)</div>
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
