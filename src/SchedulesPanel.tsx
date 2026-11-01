import { useCallback, useEffect, useState } from "react";
import { daemonClient, DEMO } from "./paseo";
import { openAgent } from "./panes";
import { nextScheduleStatus, scheduleActionsFor, type ScheduleAction } from "./sessionLifecycle";

const call = (name: string, ...args: any[]): Promise<any> => {
  const fn = (daemonClient as any)[name];
  if (typeof fn !== "function") return Promise.reject(new Error(`daemon has no ${name}`));
  return fn.apply(daemonClient, args);
};

const DEMO_SCHEDULES = [
  { id: "demo-nightly", name: "Nightly build check", cadence: "0 2 * * *", status: "active" },
  { id: "demo-weekly", name: "Weekly dependency audit", cadence: "0 9 * * 1", status: "paused" },
];

function Modal({ title, onClose, children, testid }: { title: string; onClose: () => void; children: React.ReactNode; testid: string }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" data-testid={testid} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{title}</span>
          <button className="btn ghost small" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function SchedulesPanel({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [logs, setLogs] = useState<{ id: string; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (DEMO) return;
    try {
      const r = await call("scheduleList");
      setRows(r.schedules ?? []);
      setErr(r.error ? String(r.error) : null);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => {
    if (DEMO) setRows(DEMO_SCHEDULES);
    else void refresh();
  }, [refresh]);

  const act = async (row: any, action: ScheduleAction) => {
    setErr(null);
    try {
      if (DEMO) {
        setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, status: nextScheduleStatus(r.status, action) } : r)));
        return;
      }
      const method = action === "pause" ? "schedulePause" : action === "resume" ? "scheduleResume" : "scheduleRunOnce";
      await call(method, { id: row.id });
      await refresh();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };

  const showLogs = async (row: any) => {
    try {
      const r = DEMO ? { logs: [{ message: "demo run ok" }] } : await call("scheduleLogs", { id: row.id });
      const lines = (r.logs ?? r.runs ?? []).map((l: any) => (typeof l === "string" ? l : (l.message ?? JSON.stringify(l))));
      setLogs({ id: row.id, text: lines.join("\n") || "(no runs yet)" });
    } catch (e) {
      setLogs({ id: row.id, text: String((e as Error).message ?? e) });
    }
  };

  return (
    <Modal title="📅 SCHEDULES" onClose={onClose} testid="schedules-panel">
      {err && <div className="banner warn">{err}</div>}
      {rows.length === 0 && <div className="pane-empty">No schedules.</div>}
      {rows.map((r) => (
        <div key={r.id} className="chip" style={{ display: "flex", gap: 8, alignItems: "center", margin: "4px 0" }} data-testid="schedule-row">
          <span style={{ flex: 1 }}>
            {r.name ?? r.id} <code>{typeof r.cadence === "string" ? r.cadence : (r.cadence?.expression ?? "")}</code> · {r.status}
          </span>
          {scheduleActionsFor(r.status).map((a) => (
            <button key={a} className="btn small" data-testid={`schedule-${a}`} onClick={() => void act(r, a)}>
              {a === "run" ? "▶ Run once" : a === "pause" ? "⏸ Pause" : "⏵ Resume"}
            </button>
          ))}
          <button className="btn ghost small" data-testid="schedule-logs" onClick={() => void showLogs(r)}>
            Logs
          </button>
        </div>
      ))}
      {logs && (
        <pre data-testid="schedule-log-text" style={{ maxHeight: 200, overflow: "auto" }}>
          {logs.text}
        </pre>
      )}
    </Modal>
  );
}

export function ImportSessionModal({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (DEMO) {
      setRows([{ provider: "claude", sessionId: "demo-session-1", title: "Demo CLI session", cwd: "~/demo" }]);
      return;
    }
    call("fetchRecentProviderSessions", {})
      .then((r) => setRows(r.entries ?? []))
      .catch((e) => setErr(String(e?.message ?? e)));
  }, []);

  const doImport = async (row: any) => {
    setBusy(true);
    setErr(null);
    try {
      if (DEMO) return onClose();
      const input = row.providerHandleId
        ? { providerId: row.providerId ?? row.provider, providerHandleId: row.providerHandleId, cwd: row.cwd }
        : { provider: row.provider, sessionId: row.sessionId, cwd: row.cwd };
      const snap = await call("importAgent", input);
      const id = snap?.agent?.id ?? snap?.id;
      if (id) openAgent(id);
      onClose();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="📥 IMPORT CLI SESSION" onClose={onClose} testid="import-session-modal">
      {err && <div className="banner warn">{err}</div>}
      {rows.length === 0 && !err && <div className="pane-empty">No recent sessions.</div>}
      {rows.map((r) => (
        <div key={r.sessionId ?? r.providerHandleId} className="chip" style={{ display: "flex", gap: 8, margin: "4px 0" }} data-testid="import-session-row">
          <span style={{ flex: 1 }}>
            {r.title ?? r.sessionId} <code>{r.provider}</code> {r.cwd}
          </span>
          <button className="btn small" disabled={busy} onClick={() => void doImport(r)}>
            Import
          </button>
        </div>
      ))}
    </Modal>
  );
}
