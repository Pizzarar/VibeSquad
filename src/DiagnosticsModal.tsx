import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "./TeamActions";
import { daemonClient, usePaseo } from "./paseo";
import "./ResponsiveSmallWindow.css";

type AnyClient = Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined>;
const dc = daemonClient as unknown as AnyClient;

export type DiagnosticsBundle = {
  generatedAt: string;
  connection: string;
  environment: { userAgent: string; viewport: string; zoom: number };
  agents: { id: string; status: string; provider?: string }[];
  recentErrors: string[];
  daemon: unknown;
  provider: unknown;
  pluginLogs: unknown;
};

async function tryCall(name: string): Promise<unknown> {
  try {
    const fn = dc[name];
    if (typeof fn !== "function") return null;
    const result = fn();
    if (!result || typeof (result as any).then !== "function") return result ?? null;
    const timeout = new Promise<{ error: string }>((resolve) =>
      setTimeout(() => resolve({ error: "timeout" }), 1500),
    );
    return await Promise.race([result, timeout]);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function buildBundle(conn: string, agents: Iterable<{ id: string; status?: string; provider?: string }>): Promise<DiagnosticsBundle> {
  const list = [...agents].map((a) => ({ id: a.id, status: String(a.status ?? "unknown"), provider: a.provider }));
  const [daemon, provider, pluginLogs] = await Promise.all([tryCall("collectDiagnostics"), tryCall("getProviderDiagnostic"), tryCall("getPluginLogs")]);
  return {
    generatedAt: new Date().toISOString(),
    connection: conn,
    environment: { userAgent: navigator.userAgent, viewport: `${innerWidth}x${innerHeight}`, zoom: Math.round(devicePixelRatio * 100) },
    agents: list,
    recentErrors: list.filter((a) => a.status === "error").map((a) => `${a.id}: status error`),
    daemon,
    provider,
    pluginLogs,
  };
}

export function DaemonStatusBanner() {
  const { conn } = usePaseo();
  const [busy, setBusy] = useState(false);
  const act = useCallback(async (name: string) => {
    setBusy(true);
    try {
      await dc[name]?.();
    } catch {
      /* status stays down; banner remains */
    } finally {
      setBusy(false);
    }
  }, []);
  if (conn === "connected") return null;
  return (
    <div className="daemon-down-banner" data-testid="daemon-down-banner" role="alert">
      <b>{conn === "connecting" ? "Connecting to Paseo daemon…" : "Paseo daemon is down."}</b>
      <span>Data shown may be stale.</span>
      <span className="spacer" />
      <button className="btn small" disabled={busy} onClick={() => void act("getDaemonStatus")}>↻ Retry Connection</button>
      <button className="btn small" disabled={busy} onClick={() => void act("restartServer")}>⚡ Restart Daemon Server</button>
    </div>
  );
}

export function DiagnosticsModal({ onClose }: { onClose: () => void }) {
  const { conn, agents } = usePaseo();
  const connRef = useRef(conn);
  const agentsRef = useRef(agents);
  connRef.current = conn;
  agentsRef.current = agents;

  const [bundle, setBundle] = useState<DiagnosticsBundle | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [copied, setCopied] = useState(false);

  const collect = useCallback(async () => {
    setCollecting(true);
    setBundle(null);
    try {
      const b = await buildBundle(
        connRef.current,
        agentsRef.current.values() as Iterable<{ id: string; status?: string; provider?: string }>,
      );
      setBundle(b);
    } finally {
      setCollecting(false);
    }
  }, []);

  useEffect(() => {
    void collect();
    // Intentionally empty deps: collect once on modal open, Refresh button re-triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const text = collecting ? "Collecting…" : bundle ? JSON.stringify(bundle, null, 2) : "Collecting…";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "vibesquad-diagnostics.json";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Modal title="Diagnostics & Logs" onClose={onClose} wide>
      <div data-testid="diagnostics-modal">
        <div className="diag-actions">
          <button className="btn small" data-testid="diagnostics-copy-btn" onClick={() => void copy()}>{copied ? "✓ Copied" : "📋 Copy Diagnostics Bundle"}</button>
          <button className="btn small" data-testid="diagnostics-download-btn" onClick={download}>⬇ Download .json</button>
          <button className="btn small" data-testid="diagnostics-refresh-btn" disabled={collecting} onClick={() => void collect()}>↻ Refresh</button>
        </div>
        <pre className="diag-log" data-testid="diagnostics-log-viewer">{text}</pre>
      </div>
    </Modal>
  );
}

export function HelpModal({ onClose, onTour }: { onClose: () => void; onTour: () => void }) {
  return (
    <Modal title="Help & Docs" onClose={onClose} wide>
      <div data-testid="help-docs-modal">
        <div className="help-section">
          <h4>Quick architecture</h4>
          <ul>
            <li><b>Buddy</b> — brainstorm partner; talk here to shape the idea.</li>
            <li><b>Lead</b> — plans and dispatches the work.</li>
            <li><b>Workers</b> — implement blocks on task branches.</li>
            <li><b>Right Dock</b> — files, changes, terminal and scripts for the selected agent.</li>
          </ul>
        </div>
        <div className="help-section">
          <h4>Keyboard shortcuts</h4>
          <p>Ctrl+. focus mode · Ctrl+J top NEEDS YOU · Ctrl+1..9 tabs · Ctrl+= / Ctrl+- / Ctrl+0 UI scale · Esc closes dialogs.</p>
        </div>
        <p>Full documentation lives in the repo <code>docs/</code> folder.</p>
        <button className="btn small" data-testid="help-start-tour-btn" onClick={onTour}>Start Quick Tour</button>
      </div>
    </Modal>
  );
}

export type UpdateCheck = { state: "idle" | "checking" | "ok" | "error" };
export function updateLabel(state: UpdateCheck["state"], version: string): string {
  if (state === "checking") return "Checking…";
  if (state === "ok") return `✓ Up to date (v${version})`;
  if (state === "error") return "Could not check for updates";
  return "Check for updates";
}
export async function checkForUpdates(): Promise<boolean> {
  try {
    return (await fetch("/__vibesquad/health", { cache: "no-store" })).ok;
  } catch {
    return false;
  }
}
