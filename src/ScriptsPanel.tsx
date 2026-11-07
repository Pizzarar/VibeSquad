import { useEffect, useRef, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { DEMO } from "./demoFlag";
import { vsListScripts, vsScriptLogsUrl, vsStartScript, vsStopScript, vsStream } from "./vsShells";

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
  const [scripts, setScripts] = useState<ScriptInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [err, setErr] = useState("");

  const agentCwd = agent.cwd ?? "";
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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (DEMO) {
        setScripts(DEMO_SCRIPTS);
        return;
      }
      setLoading(true);
      setErr("");
      try {
        const list = (await vsListScripts(agentCwd)) as ScriptInfo[];
        if (!cancelled) setScripts(list);
      } catch (e) {
        if (!cancelled) setErr(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const poll = DEMO ? undefined : setInterval(() => { vsListScripts(agentCwd).then((l) => { if (!cancelled) { setScripts(l as ScriptInfo[]); setStopping((prev) => (prev.size ? new Set([...prev].filter((n) => l.some((s) => s.scriptName === n && s.lifecycle === "running"))) : prev)); } }).catch(() => {}); }, 2500);
    return () => {
      cancelled = true;
      if (poll) clearInterval(poll);
    };
  }, [agentCwd]);

  const startScript = async (scriptName: string) => {
    if (DEMO) {
      setScripts((prev) =>
        prev.map((s) => (s.scriptName === scriptName ? { ...s, lifecycle: "running" } : s)),
      );
      return;
    }
    setBusy((prev) => new Set([...prev, scriptName]));
    try {
      await vsStartScript(agentCwd, scriptName);
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
    setBusy((prev) => new Set([...prev, scriptName]));
    try {
      setStopping((prev) => new Set([...prev, scriptName]));
      // The server waits for the process to exit; if it hasn't yet, keep showing "stopping" until the poll reports it stopped.
      const r = (await vsStopScript(agentCwd, scriptName)) as { lifecycle?: string };
      if (r?.lifecycle === "stopping") return;
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
      {scripts.length === 0 && !loading && !err && (
        <div className="muted small">No scripts configured.</div>
      )}
      {scripts.map((s) => {
        const isRunning = s.lifecycle === "running";
        const isStopping = stopping.has(s.scriptName);
        const isBusy = busy.has(s.scriptName) || isStopping;
        return (
          <div key={s.scriptName} className="script-row" data-testid="script-row">
            <span className="script-name">{s.scriptName}</span>
            <button
              className="btn ghost small"
              data-testid="script-logs-btn"
              onClick={() => openLogs(s.scriptName)}
            >
              Logs
            </button>
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
    </div>
  );
}
