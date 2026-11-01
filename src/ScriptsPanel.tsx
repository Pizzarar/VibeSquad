import { useEffect, useMemo, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { daemonClient, DEMO, usePaseo } from "./paseo";

type ScriptInfo = {
  scriptName: string;
  type: "script" | "service";
  lifecycle: "running" | "stopped";
  port: number | null;
  proxyUrl?: string | null;
};

const DEMO_SCRIPTS: ScriptInfo[] = [
  { scriptName: "dev", type: "service", lifecycle: "stopped", port: 5173, proxyUrl: null },
  { scriptName: "test", type: "script", lifecycle: "stopped", port: null, proxyUrl: null },
  { scriptName: "build", type: "script", lifecycle: "stopped", port: null, proxyUrl: null },
  { scriptName: "typecheck", type: "script", lifecycle: "stopped", port: null, proxyUrl: null },
];

export function ScriptsPanel({ agent }: { agent: PaseoAgent }) {
  const { workspaces } = usePaseo();
  const [scripts, setScripts] = useState<ScriptInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [err, setErr] = useState("");

  const workspaceId = useMemo(() => {
    if ((agent as { workspaceId?: string }).workspaceId) {
      return (agent as { workspaceId?: string }).workspaceId!;
    }
    const cwd = (agent.cwd ?? "").toLowerCase();
    for (const [id, ws] of workspaces) {
      const dir =
        ((ws as { workspaceDirectory?: string }).workspaceDirectory ??
          (ws as { directory?: string }).directory ??
          "").toLowerCase();
      if (dir && cwd.startsWith(dir)) return id;
    }
    return null;
  }, [agent, workspaces]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (DEMO) {
        setScripts(DEMO_SCRIPTS);
        return;
      }
      if (!workspaceId) {
        setScripts([]);
        return;
      }
      setLoading(true);
      setErr("");
      try {
        const result = await daemonClient.listWorkspaceScripts(workspaceId);
        if (!cancelled) {
          const list = (result.scripts ?? []) as ScriptInfo[];
          setScripts(list);
        }
      } catch (e) {
        if (!cancelled) setErr(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const startScript = async (scriptName: string) => {
    if (DEMO) {
      setScripts((prev) =>
        prev.map((s) => (s.scriptName === scriptName ? { ...s, lifecycle: "running" } : s)),
      );
      return;
    }
    if (!workspaceId) return;
    setBusy((prev) => new Set([...prev, scriptName]));
    try {
      await daemonClient.startWorkspaceScriptWithStatus(workspaceId, scriptName);
      setScripts((prev) =>
        prev.map((s) => (s.scriptName === scriptName ? { ...s, lifecycle: "running" } : s)),
      );
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(scriptName);
        return next;
      });
    }
  };

  const stopScript = async (scriptName: string) => {
    if (DEMO) {
      setScripts((prev) =>
        prev.map((s) => (s.scriptName === scriptName ? { ...s, lifecycle: "stopped" } : s)),
      );
      return;
    }
    if (!workspaceId) return;
    setBusy((prev) => new Set([...prev, scriptName]));
    try {
      await daemonClient.stopWorkspaceScript(workspaceId, scriptName);
      setScripts((prev) =>
        prev.map((s) => (s.scriptName === scriptName ? { ...s, lifecycle: "stopped" } : s)),
      );
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(scriptName);
        return next;
      });
    }
  };

  return (
    <div className="scripts-panel" data-testid="scripts-panel">
      {err && <div className="stat-alert small">{err}</div>}
      {loading && <div className="muted small">Loading scripts…</div>}
      {!loading && !workspaceId && !DEMO && (
        <div className="muted small">No workspace found for this agent.</div>
      )}
      {scripts.length === 0 && !loading && (workspaceId || DEMO) && !err && (
        <div className="muted small">No scripts configured.</div>
      )}
      {scripts.map((s) => {
        const isRunning = s.lifecycle === "running";
        const isBusy = busy.has(s.scriptName);
        return (
          <div key={s.scriptName} className="script-row" data-testid="script-row">
            <span className="script-name">{s.scriptName}</span>
            {s.type === "service" && s.port && (
              <span className="script-port muted small">:{s.port}</span>
            )}
            {s.proxyUrl && (
              <a
                className="script-proxy muted small"
                href={s.proxyUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open
              </a>
            )}
            <span className={`script-status small ${isRunning ? "ok" : "muted"}`}>
              {isRunning ? "● running" : "○ stopped"}
            </span>
            {isRunning ? (
              <button
                className="btn ghost small"
                data-testid="script-stop-btn"
                disabled={isBusy}
                onClick={() => void stopScript(s.scriptName)}
              >
                ■ Stop
              </button>
            ) : (
              <button
                className="btn ok small"
                data-testid="script-start-btn"
                disabled={isBusy}
                onClick={() => void startScript(s.scriptName)}
              >
                ▶ Start
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
