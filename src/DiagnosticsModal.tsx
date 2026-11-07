import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "./TeamActions";
import { usePaseo } from "./paseo";
import { decideOverlay, pillText } from "./daemonOverlay";
import { isAndroidUserAgent } from "./remoteSession";
import { getStaleBuild, loadUpdaterStatus, setStaleBuild, useStaleBuild, useUpdaterStatus } from "./userName";
import "./ResponsiveSmallWindow.css";

export type DiagnosticsBundle = {
  generatedAt: string;
  connection: string;
  environment: { userAgent: string; viewport: string; zoom: number };
  agents: { id: string; status: string; provider?: string }[];
  recentErrors: string[];
  staleBuild: { built: string; head: string; behind: number } | null;
};

async function refreshStaleFromHealth(): Promise<void> {
  if (typeof fetch !== "function") return;
  try {
    const r = await fetch("/__vibesquad/health", { cache: "no-store" });
    if (!r.ok) return;
    const h = await r.json();
    if (h && typeof h === "object" && "stale" in h) {
      setStaleBuild(h.stale);
    }
  } catch {}
}

export async function buildBundle(conn: string, agents: Iterable<{ id: string; status?: string; provider?: string }>): Promise<DiagnosticsBundle> {
  const list = [...agents].map((a) => ({ id: a.id, status: String(a.status ?? "unknown"), provider: a.provider }));
  await refreshStaleFromHealth();
  return {
    generatedAt: new Date().toISOString(),
    connection: conn,
    environment: { userAgent: navigator.userAgent, viewport: `${innerWidth}x${innerHeight}`, zoom: Math.round(devicePixelRatio * 100) },
    agents: list,
    recentErrors: list.filter((a) => a.status === "error").map((a) => `${a.id}: status error`),
    staleBuild: getStaleBuild(),
  };
}

/** A blip shorter than this shows nothing: the pill only appears once the runner stream has been away this long. */
export const DISCONNECT_DEBOUNCE_MS = 2000;

export function shouldShowDisconnectOverlay(conn: string, disconnectedSinceMs: number | null, nowMs: number, debounceMs = DISCONNECT_DEBOUNCE_MS): boolean {
  return conn !== "connected" && disconnectedSinceMs !== null && nowMs - disconnectedSinceMs >= debounceMs;
}

/** A non-blocking header pill that opens Diagnostics while the runner stream is down (nothing underneath is covered or disabled). */
export const DaemonStatusBanner = memo(function DaemonStatusBanner(props: { onOpenDiagnostics?: () => void }) {
  const { runnerConn } = usePaseo();
  const kind = decideOverlay({ runnerConn });
  const [visible, setVisible] = useState(false);
  const down = kind !== "none";

  useEffect(() => {
    if (!down) {
      setVisible(false);
      return;
    }
    const since = Date.now();
    const t = setTimeout(() => {
      if (shouldShowDisconnectOverlay("disconnected", since, Date.now())) setVisible(true);
    }, DISCONNECT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [down]);

  if (!down || !visible) return null;
  return (
    <button type="button" className="daemon-status-pill" data-testid="daemon-status-pill" role="status" onClick={props.onOpenDiagnostics} title="Open Diagnostics">
      {pillText({ runnerConn })}
    </button>
  );
});

/** Connection status in Diagnostics: the header pill links here. The runner stream reconnects on its own. */
function RunnerConnectionSection() {
  const { runnerConn } = usePaseo();
  if (runnerConn !== "down") return null;
  return (
    <div className="diag-build-status stale" data-testid="diagnostics-runner-section">
      <div>Runner disconnected · reconnecting automatically.</div>
    </div>
  );
}

export function DiagnosticsModal({ onClose }: { onClose: () => void }) {
  const { conn, agents } = usePaseo();
  const connRef = useRef(conn);
  const agentsRef = useRef(agents);
  connRef.current = conn;
  agentsRef.current = agents;

  const staleBuild = useStaleBuild();
  const updaterStatus = useUpdaterStatus();
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
        <div
          className={`diag-build-status ${staleBuild ? "stale" : "ok"}`}
          data-testid="diagnostics-build-status"
        >
          {staleBuild ? (
            <span>
              {`⚠ Runtime build is ${staleBuild.behind} commit${staleBuild.behind === 1 ? "" : "s"} behind local repo (${staleBuild.built} → ${staleBuild.head}) — run npm run build / rebuild installer to sync.`}
            </span>
          ) : (
            <span>
              {`✓ Runtime build is up to date (v${updaterStatus.currentVersion})`}
            </span>
          )}
        </div>
        <RunnerConnectionSection />
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
export function updateLabel(state: UpdateCheck["state"], version: string, availableVersion?: string): string {
  if (state === "checking") return "Checking…";
  if (availableVersion) return `⬇ Update to v${availableVersion}`;
  if (state === "ok") return `✓ Up to date (v${version})`;
  if (state === "error") return "Could not check for updates";
  return "Check for updates";
}
export async function checkForUpdates(): Promise<boolean> {
  await refreshStaleFromHealth();
  if (isAndroidUserAgent()) {
    await loadUpdaterStatus();
    return true;
  }
  let sawDesktopEndpoint = false;
  try {
    const r = await fetch("/__desktop/updater/check", { method: "POST", cache: "no-store" });
    sawDesktopEndpoint = r.status !== 404;
    const st = await loadUpdaterStatus();
    if (r.ok || st.updateAvailable) {
      return true;
    }
    if (sawDesktopEndpoint) {
      return false;
    }
  } catch {}
  try {
    const r = await fetch("/__vibesquad/health", { cache: "no-store" });
    const ok = r.ok;
    if (ok) {
      const h = await r.json().catch(() => null);
      if (h && typeof h === "object" && "stale" in h) setStaleBuild(h.stale);
    }
    await loadUpdaterStatus();
    return ok;
  } catch {
    return false;
  }
}
