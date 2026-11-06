import { useCallback, useEffect, useState } from "react";
import { daemonClient, updateAgent, usePaseo } from "./paseo";
import { DEMO } from "./demoFlag";
import { createSchedule, deleteSchedule, inspectSchedule, listSchedules, scheduleAction, scheduleLogs, updateSchedule } from "./paseoSchedules";
import {
  EMPTY_FORM, cadenceLabel, formFromSchedule, isHeartbeat, toCreateRequest, toUpdateRequest, validateForm,
  type IntervalUnit, type ScheduleForm,
} from "./scheduleForm";
import { ConfirmButton } from "./ui";
import { openAgent } from "./panes";
import { nextScheduleStatus, scheduleActionsFor, type ScheduleAction } from "./sessionLifecycle";
import { TEAMS, assignAgentToLane, shownLanesOf } from "./teams";

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
  const [inspected, setInspected] = useState<any | null>(null);
  const [editing, setEditing] = useState<any | "new" | null>(null);

  const refresh = useCallback(async () => {
    if (DEMO) return;
    try {
      const r = await listSchedules();
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
      await scheduleAction(row, action);
      await refresh();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };

  const showLogs = async (row: any) => {
    try {
      const r = DEMO ? { logs: [{ message: "demo run ok" }] } : await scheduleLogs(row);
      const lines = (r.logs ?? r.runs ?? []).map((l: any) => (typeof l === "string" ? l : (l.message ?? JSON.stringify(l))));
      setLogs({ id: row.id, text: lines.join("\n") || "(no runs yet)" });
    } catch (e) {
      setLogs({ id: row.id, text: String((e as Error).message ?? e) });
    }
  };

  const inspect = async (row: any) => {
    setErr(null);
    try {
      const full = DEMO ? row : await inspectSchedule(row.id, row);
      setInspected(full ?? row);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };

  const remove = async (row: any) => {
    setErr(null);
    try {
      if (DEMO) setRows((rs) => rs.filter((r) => r.id !== row.id));
      else {
        await deleteSchedule(row.id, row);
        await refresh();
      }
      if (inspected?.id === row.id) setInspected(null);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };

  const saved = async () => {
    setEditing(null);
    await refresh();
  };

  if (editing)
    return (
      <ScheduleFormModal
        schedule={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={() => void saved()}
        onDemoSaved={(s) => {
          setRows((rs) => (rs.some((r) => r.id === s.id) ? rs.map((r) => (r.id === s.id ? s : r)) : [...rs, s]));
          setEditing(null);
        }}
      />
    );

  return (
    <Modal title="📅 SCHEDULES" onClose={onClose} testid="schedules-panel">
      {err && <div className="banner warn">{err}</div>}
      <div style={{ marginBottom: 8 }}>
        <button className="btn small ok" data-testid="schedule-new" onClick={() => setEditing("new")}>
          + New schedule
        </button>
      </div>
      {rows.length === 0 && <div className="pane-empty">No schedules.</div>}
      {rows.map((r) => (
        <div key={r.id} className="chip sched-row" data-testid="schedule-row">
          <span className="sched-main">
            {r.name ?? r.id} <code>{cadenceLabel(r.cadence)}</code> · {r.status}
            {isHeartbeat(r) && <span className="muted"> · 💓 heartbeat</span>}
          </span>
          {scheduleActionsFor(r.status).map((a) => (
            <button key={a} className="btn small" data-testid={`schedule-${a}`} onClick={() => void act(r, a)}>
              {a === "run" ? "▶ Run once" : a === "pause" ? "⏸ Pause" : "⏵ Resume"}
            </button>
          ))}
          <button className="btn ghost small" data-testid="schedule-inspect" onClick={() => void inspect(r)}>
            Inspect
          </button>
          <button className="btn ghost small" data-testid="schedule-edit" onClick={() => setEditing(r)}>
            Edit
          </button>
          <button className="btn ghost small" data-testid="schedule-logs" onClick={() => void showLogs(r)}>
            Logs
          </button>
          <ConfirmButton
            label="Delete"
            armedLabel="Tap to delete"
            busyLabel="Deleting…"
            tone="danger"
            className="small"
            onConfirm={() => remove(r)}
          />
        </div>
      ))}
      {inspected && (
        <div className="sched-inspect" data-testid="schedule-inspect-view">
          <div className="modal-head" style={{ padding: "4px 0" }}>
            <span>{inspected.name ?? inspected.id}</span>
            <button className="btn ghost small" aria-label="Close inspect" onClick={() => setInspected(null)}>
              ×
            </button>
          </div>
          <dl>
            <dt>ID</dt>
            <dd><code>{inspected.id}</code></dd>
            <dt>Status</dt>
            <dd>{inspected.status}{isHeartbeat(inspected) ? " · heartbeat" : ""}</dd>
            <dt>Cadence</dt>
            <dd><code>{cadenceLabel(inspected.cadence)}</code>{inspected.cadence?.timezone ? ` (${inspected.cadence.timezone})` : ""}</dd>
            <dt>Target</dt>
            <dd>{targetLabel(inspected.target)}</dd>
            <dt>Next run</dt>
            <dd>{inspected.nextRunAt ?? "-"}</dd>
            <dt>Last run</dt>
            <dd>{inspected.lastRunAt ?? "-"}</dd>
            <dt>Runs</dt>
            <dd>{inspected.runCount ?? inspected.runs?.length ?? 0}{inspected.maxRuns ? ` / ${inspected.maxRuns}` : ""}</dd>
            {inspected.expiresAt && (
              <>
                <dt>Expires</dt>
                <dd>{inspected.expiresAt}</dd>
              </>
            )}
            <dt>Prompt</dt>
            <dd><pre className="sched-prompt">{inspected.prompt}</pre></dd>
          </dl>
        </div>
      )}
      {logs && (
        <pre data-testid="schedule-log-text" style={{ maxHeight: 200, overflow: "auto" }}>
          {logs.text}
        </pre>
      )}
    </Modal>
  );
}

function targetLabel(t: any): string {
  if (!t) return "-";
  if (t.type === "new-agent") return `new ${t.config?.provider ?? "agent"} in ${t.config?.cwd ?? "?"}`;
  return `${t.type === "self" ? "self (heartbeat)" : "agent"} ${t.agentId}`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="sched-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function ScheduleFormModal({
  schedule, onClose, onSaved, onDemoSaved,
}: {
  schedule: any | null;
  onClose: () => void;
  onSaved: () => void;
  onDemoSaved: (s: any) => void;
}) {
  const edit = schedule !== null;
  const [form, setForm] = useState<ScheduleForm>(() => (edit ? formFromSchedule(schedule) : EMPTY_FORM));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const agents = [...usePaseo().agents.values()].filter((a) => !a.archivedAt);
  const set = <K extends keyof ScheduleForm>(k: K, v: ScheduleForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const problems = validateForm(form, edit ? "edit" : "create");

  const submit = async () => {
    setTouched(true);
    if (problems.length) return;
    setBusy(true);
    setErr(null);
    try {
      if (DEMO) {
        const req: any = toCreateRequest(form);
        onDemoSaved({ ...(schedule ?? {}), ...req, id: schedule?.id ?? `demo-${Date.now()}`, status: schedule?.status ?? "active" });
        return;
      }
      if (edit) await updateSchedule(toUpdateRequest(schedule.id, form), schedule);
      else await createSchedule(toCreateRequest(form));
      onSaved();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={edit ? "📅 EDIT SCHEDULE" : "📅 NEW SCHEDULE"} onClose={onClose} testid="schedule-form">
      {err && <div className="banner warn">{err}</div>}
      <Field label="Name (optional)">
        <input data-testid="sched-name" value={form.name} onChange={(e) => set("name", e.target.value)} />
      </Field>
      <Field label="Prompt">
        <textarea data-testid="sched-prompt" rows={3} value={form.prompt} onChange={(e) => set("prompt", e.target.value)} />
      </Field>
      <Field label="Cadence">
        <select data-testid="sched-cadence-kind" value={form.cadenceKind} onChange={(e) => set("cadenceKind", e.target.value as ScheduleForm["cadenceKind"])}>
          <option value="cron">Cron expression</option>
          <option value="every">Every interval</option>
        </select>
      </Field>
      {form.cadenceKind === "cron" ? (
        <>
          <Field label="Cron (min hour day month weekday)">
            <input data-testid="sched-cron" value={form.cron} onChange={(e) => set("cron", e.target.value)} />
          </Field>
          <Field label="Timezone (optional, e.g. Europe/London)">
            <input data-testid="sched-tz" value={form.timezone} onChange={(e) => set("timezone", e.target.value)} />
          </Field>
        </>
      ) : (
        <Field label="Every">
          <span className="sched-pair">
            <input data-testid="sched-interval" inputMode="decimal" value={form.intervalValue} onChange={(e) => set("intervalValue", e.target.value)} />
            <select value={form.intervalUnit} onChange={(e) => set("intervalUnit", e.target.value as IntervalUnit)}>
              <option value="s">seconds</option>
              <option value="m">minutes</option>
              <option value="h">hours</option>
              <option value="d">days</option>
            </select>
          </span>
        </Field>
      )}
      {!edit && (
        <>
          <Field label="Runs on">
            <select data-testid="sched-target-kind" value={form.targetKind} onChange={(e) => set("targetKind", e.target.value as ScheduleForm["targetKind"])}>
              <option value="new-agent">A new agent each run</option>
              <option value="agent">An existing agent</option>
              <option value="self">💓 Heartbeat (agent prompts itself)</option>
            </select>
          </Field>
          {form.targetKind === "new-agent" ? (
            <>
              <Field label="Provider">
                <input data-testid="sched-provider" value={form.provider} onChange={(e) => set("provider", e.target.value)} />
              </Field>
              <Field label="Working directory">
                <input data-testid="sched-cwd" value={form.cwd} onChange={(e) => set("cwd", e.target.value)} />
              </Field>
              <Field label="Model (optional)">
                <input data-testid="sched-model" value={form.model} onChange={(e) => set("model", e.target.value)} />
              </Field>
            </>
          ) : (
            <Field label="Agent">
              <select data-testid="sched-agent" value={form.agentId} onChange={(e) => set("agentId", e.target.value)}>
                <option value="">Pick an agent…</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.title || a.id}</option>
                ))}
              </select>
            </Field>
          )}
        </>
      )}
      <Field label="Max runs (optional)">
        <input data-testid="sched-maxruns" inputMode="numeric" value={form.maxRuns} onChange={(e) => set("maxRuns", e.target.value)} />
      </Field>
      <Field label="Expires (optional)">
        <input data-testid="sched-expires" type="datetime-local" value={form.expiresAt} onChange={(e) => set("expiresAt", e.target.value)} />
      </Field>
      {!edit && (
        <label className="sched-check">
          <input type="checkbox" checked={form.runOnCreate} onChange={(e) => set("runOnCreate", e.target.checked)} /> Run once right away
        </label>
      )}
      {touched && problems.length > 0 && (
        <div className="banner warn" data-testid="sched-problems">
          {problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      )}
      <div className="modal-foot" style={{ margin: "10px -14px -14px" }}>
        <button className="btn ghost small" onClick={onClose}>
          Cancel
        </button>
        <button className="btn small ok" data-testid="sched-submit" disabled={busy} onClick={() => void submit()}>
          {busy ? "Saving…" : edit ? "Save" : "Create"}
        </button>
      </div>
    </Modal>
  );
}

const allImportLanes = TEAMS.flatMap((t) =>
  shownLanesOf(t).map((l) => ({ teamId: t.id, laneId: l.id, label: `${t.name} / ${l.name}` })),
);
const DEFAULT_IMPORT_LANE = allImportLanes[0]?.laneId ?? "vibesquad";

export function ImportSessionModal({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chosenLaneId, setChosenLaneId] = useState(DEFAULT_IMPORT_LANE);

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
      const laneEntry = allImportLanes.find((l) => l.laneId === chosenLaneId) ?? allImportLanes[0];
      const chosenTeamId = laneEntry?.teamId ?? "";
      const chosenLane = laneEntry?.laneId ?? chosenLaneId;
      const input = {
        ...(row.providerHandleId
          ? { providerId: row.providerId ?? row.provider, providerHandleId: row.providerHandleId, cwd: row.cwd }
          : { provider: row.provider, sessionId: row.sessionId, cwd: row.cwd }),
        labels: { team: chosenTeamId, lane: chosenLane, role: "worker" },
      };
      const snap = await call("importAgent", input);
      const id = snap?.agent?.id ?? snap?.id;
      if (id) {
        await updateAgent(id, { labels: { team: chosenTeamId, lane: chosenLane, role: "worker" } }).catch(() => {});
        openAgent(id);
      }
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
      <div style={{ marginBottom: 8 }}>
        <label style={{ marginRight: 6 }}>Import into lane:</label>
        <select data-testid="import-session-lane-select" value={chosenLaneId} onChange={(e) => setChosenLaneId(e.target.value)}>
          {allImportLanes.map((opt) => (
            <option key={opt.laneId} value={opt.laneId}>{opt.label}</option>
          ))}
        </select>
      </div>
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
