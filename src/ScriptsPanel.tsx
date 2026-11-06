import { useEffect, useMemo, useRef, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { daemonClient, usePaseo } from "./paseo";
import { DEMO } from "./demoFlag";
import { workspaceIdForAgent } from "./workspaceLogic";
import { NoWorkspaceBanner } from "./NoWorkspaceBanner";
import { usesVsShells, vsListScripts, vsScriptLogsUrl, vsStartScript, vsStopScript, vsStream } from "./vsShells";

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
  const vs = !DEMO && usesVsShells(agent.id); // runner agents: scripts over /__vibesquad/workspace-scripts, keyed by folder
  const [logs, setLogs] = useState<{ name: string; text: string } | null>(null);
  const [stopping, setStopping] = useState<Set<string>>(new Set()); // stop requested, process not yet confirmed exited
  const stopLogs = useRef<(() => void) | null>(null);
  const closeLogs = () => { stopLogs.current?.(); stopLogs.current = null; setLogs(null); };
  const openLogs = (name: string) => {
    stopLogs.current?.();
    setLogs({ name, text: "" });
    stopLogs.current = vsStream(vsScriptLogsUrl(agentCwd, name), (d) => setLogs((l) => (l && l.name === name ? { ...l, text: l.text + d } : l)));
  };
  useEffect(() => closeLogs, [agent.id, agentCwd]); // eslint-disable-line react-hooks/exhaustive-deps
  const workspaceId = useMemo(() => workspaceIdForAgent(agent, workspaces) ?? (addedWs?.cwd === agentCwd ? addedWs.id : null), [agent, workspaces, addedWs, agentCwd]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (DEMO) {
        setScripts(DEMO_SCRIPTS);
        return;
      }
      if (!vs && !workspaceId) {
        setScripts([]);
        return;
      }
      setLoading(true);
      setErr("");
      try {
        const list = vs
          ? ((await vsListScripts(agentCwd)) as ScriptInfo[])
          : (((await daemonClient.listWorkspaceScripts(workspaceId!)).scripts ?? []) as ScriptInfo[]);
        if (!cancelled) setScripts(list);
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
    if (!vs) loadPkgScripts(); // the VS route already lists package.json scripts
    const poll = vs ? setInterval(() => { vsListScripts(agentCwd).then((l) => { if (!cancelled) { setScripts(l as ScriptInfo[]); setStopping((prev) => (prev.size ? new Set([...prev].filter((n) => l.some((s) => s.scriptName === n && s.lifecycle === "running"))) : prev)); } }).catch(() => {}); }, 2500) : undefined;
    return () => {
      cancelled = true;
      if (poll) clearInterval(poll);
    };
  }, [workspaceId, agent.cwd, vs, agentCwd]);

  const startScript = async (scriptName: string) => {
    if (DEMO) {
      setScripts((prev) =>
        prev.map((s) => (s.scriptName === scriptName ? { ...s, lifecycle: "running" } : s)),
      );
      return;
    }
    if (!vs && !workspaceId) return;
    setBusy((prev) => new Set([...prev, scriptName]));
    try {
      if (vs) await vsStartScript(agentCwd, scriptName);
      else await daemonClient.startWorkspaceScriptWithStatus(workspaceId!, scriptName);
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
    if (!vs && !workspaceId) return;
    setBusy((prev) => new Set([...prev, scriptName]));
    try {
      if (vs) {
        setStopping((prev) => new Set([...prev, scriptName]));
        // The server waits for the process to exit; if it hasn't yet, keep showing "stopping" until the poll reports it stopped.
        const r = (await vsStopScript(agentCwd, scriptName)) as { lifecycle?: string };
        if (r?.lifecycle === "stopping") return;
      } else await daemonClient.stopWorkspaceScript(workspaceId!, scriptName);
      setScripts((prev) =>
        prev.map((s) => (s.scriptName === scriptName ? { ...s, lifecycle: "stopped" } : s)),
      );
      setStopping((prev) => { const next = new Set(prev); next.delete(scriptName); return next; });
    } catch (e) {
      setErr(String(e));
      setStopping((prev) => { const next = new Set(prev); next.delete(scriptName); return next; });
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
      {!loading && !vs && !workspaceId && !DEMO && (
        <NoWorkspaceBanner cwd={agentCwd} onReady={(id) => setAddedWs({ cwd: agentCwd, id })} />
      )}
      {scripts.length === 0 && !loading && (vs || workspaceId || DEMO) && !err && (
        <div className="muted small">No scripts configured.</div>
      )}
      {scripts.map((s) => {
        const isRunning = s.lifecycle === "running";
        const isStopping = stopping.has(s.scriptName);
        const isBusy = busy.has(s.scriptName) || isStopping;
        return (
          <div key={s.scriptName} className="script-row" data-testid="script-row">
            <span className="script-name">{s.scriptName}</span>
            {vs && (
              <button
                className="btn ghost small"
                data-testid="script-logs-btn"
                onClick={() => openLogs(s.scriptName)}
              >
                Logs
              </button>
            )}
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
            <span className={`script-status small ${isRunning && !isStopping ? "ok" : "muted"}`}>
              {isStopping ? "◌ stopping…" : isRunning ? "● running" : "○ stopped"}
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
      {logs && (
        <div data-testid="script-logs">
          <div className="muted small">
            Logs · {logs.name} <button className="btn ghost small" onClick={closeLogs}>Close</button>
          </div>
          <pre className="terminal-capture-text">{logs.text || "(no output yet)"}</pre>
        </div>
      )}
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
