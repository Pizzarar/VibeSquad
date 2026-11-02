import { useCallback, useEffect, useState } from "react";
import { fetchDaemonConfig, fetchUsageReports, measureRtt, reloadDaemonConfig, type DaemonReloadResult } from "./paseoOps";
import { formatConfigJson, formatLatency, latencyTone, summarizeUsageReport, type UsageReportLike } from "./paseoOpsLogic";

export function PaseoOpsPanel() {
  const [config, setConfig] = useState<unknown>(null);
  const [reload, setReload] = useState<DaemonReloadResult | null>(null);
  const [reports, setReports] = useState<UsageReportLike[]>([]);
  const [openReport, setOpenReport] = useState<string | null>(null);
  const [rtt, setRtt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const ping = useCallback(() => run(async () => setRtt(await measureRtt())), [run]);
  const loadConfig = useCallback(() => run(async () => setConfig(await fetchDaemonConfig())), [run]);
  const loadReports = useCallback((force: boolean) => run(async () => setReports(await fetchUsageReports(force))), [run]);

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
            onClick={() => void run(async () => { setReload(await reloadDaemonConfig()); setConfig(await fetchDaemonConfig()); })}
          >
            Reload config
          </button>
          {reload && (
            <span className="muted small" data-testid="paseo-ops-reload-result">
              applied {reload.appliedPaths.length} · restart needed {reload.restartRequiredPaths.length} · overridden {reload.overrideControlledPaths.length}
            </span>
          )}
        </div>
        {reload && reload.restartRequiredPaths.length > 0 && (
          <div className="muted small">Restart required for: {reload.restartRequiredPaths.join(", ")}</div>
        )}
        <pre className="paseo-ops-pre" data-testid="paseo-ops-config">{config ? formatConfigJson(config) : "(loading…)"}</pre>
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
              {open && <pre className="paseo-ops-pre">{formatConfigJson(entry)}</pre>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
