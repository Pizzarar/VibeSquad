import { useEffect, useMemo, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { daemonClient, DEMO, usePaseo } from "./paseo";
import { workspaceIdForAgent } from "./workspaceLogic";
import { NoWorkspaceBanner } from "./NoWorkspaceBanner";

type PkgScript = { scriptName: string; command: string; source: "package.json" };

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
  const [pkgScripts, setPkgScripts] = useState<PkgScript[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [savingPkg, setSavingPkg] = useState<Set<string>>(new Set());
  const [err, setErr] = useState("");

  const [addedWs, setAddedWs] = useState<{ cwd: string; id: string } | null>(null);
  const agentCwd = agent.cwd ?? "";
  const workspaceId = useMemo(() => workspaceIdForAgent(agent, workspaces) ?? (addedWs?.cwd === agentCwd ? addedWs.id : null), [agent, workspaces, addedWs, agentCwd]);

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
    async function loadPkgScripts() {
      const cwd = agent.cwd ?? "";
      if (DEMO || !cwd) return;
      try {
        const res = await fetch(`/__vibesquad/workspace-package-scripts?cwd=${encodeURIComponent(cwd)}`);
        const body = await res.json().catch(() => ({}));
        if (!cancelled && body.ok && body.scripts && typeof body.scripts === "object") {
          const parsed: PkgScript[] = Object.entries(body.scripts as Record<string, string>).map(([name, cmd]) => ({
            scriptName: name,
            command: String(cmd),
            source: "package.json" as const,
          }));
          setPkgScripts(parsed);
        }
      } catch {
        // best-effort: ignore
      }
    }
    load();
    loadPkgScripts();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, agent.cwd]);

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

  const saveScriptToConfig = async (s: PkgScript) => {
    if (!workspaceId) return;
    setSavingPkg((prev) => new Set([...prev, s.scriptName]));
    try {
      const dc = daemonClient as any;
      if (typeof dc.writeProjectConfig === "function") {
        const cwd = agent.cwd ?? "";
        const existing = await dc.readProjectConfig(cwd).catch(() => null);
        const curConfig = existing?.config ?? existing?.payload?.config ?? {};
        const curScripts = curConfig.scripts ?? {};
        const newConfig = {
          ...curConfig,
          scripts: {
            ...curScripts,
            [s.scriptName]: { command: `npm run ${s.scriptName}` },
          },
        };
        await dc.writeProjectConfig({
          repoRoot: cwd,
          config: newConfig,
          expectedRevision: existing?.revision ?? existing?.payload?.revision ?? null,
        });
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setSavingPkg((prev) => {
        const next = new Set(prev);
        next.delete(s.scriptName);
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
        <NoWorkspaceBanner cwd={agentCwd} onReady={(id) => setAddedWs({ cwd: agentCwd, id })} />
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
      {pkgScripts
        .filter((ps) => !scripts.some((s) => s.scriptName === ps.scriptName))
        .map((ps) => {
          const isSaving = savingPkg.has(ps.scriptName);
          return (
            <div key={`pkg-${ps.scriptName}`} className="script-row script-row--pkg" data-testid="script-row">
              <span className="script-name">{ps.scriptName}</span>
              <span className="script-source muted small">package.json</span>
              <button
                className="btn ok small"
                data-testid="save-scripts-config-btn"
                disabled={isSaving || !workspaceId}
                onClick={() => void saveScriptToConfig(ps)}
              >
                {isSaving ? "Saving…" : "Save to project config"}
              </button>
            </div>
          );
        })}
    </div>
  );
}
