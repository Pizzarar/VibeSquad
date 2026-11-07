import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "./TeamActions";
import { daemonClient, reconnectWithDaemonPassword, usePaseo } from "./paseo";
import { decideOverlay, paseoIsDown, pillText, usesPaseoBackend } from "./daemonOverlay";
import { getRunnerStatus } from "./runnerBridge";
import { clearSession, isAndroidUserAgent, isLocalHost, isRemote } from "./remoteSession";
import { getStaleBuild, loadUpdaterStatus, setStaleBuild, triggerUpdateInstall, useStaleBuild, useUpdaterStatus } from "./userName";
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
  staleBuild: { built: string; head: string; behind: number } | null;
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
  const [daemon, provider, pluginLogs] = await Promise.all([
    tryCall("collectDiagnostics"),
    tryCall("getProviderDiagnostic"),
    tryCall("getPluginLogs"),
    refreshStaleFromHealth(),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    connection: conn,
    environment: { userAgent: navigator.userAgent, viewport: `${innerWidth}x${innerHeight}`, zoom: Math.round(devicePixelRatio * 100) },
    agents: list,
    recentErrors: list.filter((a) => a.status === "error").map((a) => `${a.id}: status error`),
    daemon,
    provider,
    pluginLogs,
    staleBuild: getStaleBuild(),
  };
}

/** A blip shorter than this shows nothing: the scrim only appears once the daemon has been away this long. */
export const DISCONNECT_DEBOUNCE_MS = 2000;
const RETRY_TIMEOUT_MS = 10_000;

export function shouldShowDisconnectOverlay(conn: string, disconnectedSinceMs: number | null, nowMs: number, debounceMs = DISCONNECT_DEBOUNCE_MS): boolean {
  return conn !== "connected" && disconnectedSinceMs !== null && nowMs - disconnectedSinceMs >= debounceMs;
}

/**
 * Local: a non-blocking header pill that opens Diagnostics. Remote relay only: a centered card over a dimmed scrim
 * (position: fixed and not a role="alert" child of .app, so the layout underneath never changes).
 */
export const DaemonStatusBanner = memo(function DaemonStatusBanner(props: {
  onOpenDiagnostics?: () => void;
  onOpenSetup?: () => void;
  onRePair?: () => void;
}) {
  const { conn, status, error, authFailureReason, runnerConn, agents, paseoConn } = usePaseo();
  const updaterStatus = useUpdaterStatus();
  const [updateChecking, setUpdateChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  const paseoDown = paseoIsDown({ remote: isRemote(), conn, status, paseoConn });
  const kind = decideOverlay({
    remote: isRemote(),
    runnerConn,
    paseoDown,
    authFailureReason,
    usesPaseo: usesPaseoBackend(getRunnerStatus(), agents.keys()),
  });
  const down = kind !== "none";

  useEffect(() => {
    if (!down) {
      setVisible(false);
      return;
    }
    if (authFailureReason && kind === "scrim") {
      setVisible(true);
      return;
    }
    const since = Date.now();
    const t = setTimeout(() => {
      if (shouldShowDisconnectOverlay("disconnected", since, Date.now())) setVisible(true);
    }, DISCONNECT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [down, kind, authFailureReason]);

  const inFlight = useRef(false);
  const retry = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // connect() may never settle on a dead socket; cap the wait so RETRY NOW re-enables
      const attempt = (async () => {
        await reconnectWithDaemonPassword();
        await dc.getDaemonStatus?.();
      })();
      await Promise.race([attempt, new Promise((r) => { timer = setTimeout(r, RETRY_TIMEOUT_MS); })]);
    } catch {
      /* still down; the scrim stays */
    } finally {
      clearTimeout(timer);
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  if (!down || !visible) return null;
  if (kind === "pill") {
    // Non-blocking: a small header pill, no scrim; nothing underneath is covered or disabled.
    return (
      <button type="button" className="daemon-status-pill" data-testid="daemon-status-pill" role="status" onClick={props.onOpenDiagnostics} title="Open Diagnostics">
        {pillText({ runnerConn, authFailureReason })}
      </button>
    );
  }
  const onRetryNow = () => {
    void retry();
  };
  const onRePairClick = () => {
    if (isRemote()) {
      clearSession();
      location.replace(location.pathname + "?remote=1");
      return;
    }
    if ((window as any).__VIBESQUAD_DESKTOP_BRIDGE__) {
      window.location.href = "/__desktop/setup";
      return;
    }
    if (props.onRePair) {
      props.onRePair();
      return;
    }
    if (isLocalHost(location.hostname)) {
      props.onOpenSetup?.();
      return;
    }
    window.location.href = "/?remote=1";
  };
  const onFirstTimeSetupClick = () => {
    if ((window as any).__VIBESQUAD_DESKTOP_BRIDGE__) {
      window.location.href = "/__desktop/mode";
      return;
    }
    try {
      localStorage.removeItem("vs.firstRunDone");
    } catch {}
    props.onOpenSetup?.();
  };
  return (
    <div className="daemon-disconnect-scrim" data-testid="daemon-disconnect-scrim">
      <div className="daemon-disconnect-card" data-testid="daemon-down-banner" role="alert">
        <div className="daemon-disconnect-title" data-testid="daemon-disconnect-text">
          Daemon disconnected · reconnecting automatically
        </div>
        {error ? <div className="daemon-disconnect-subtext">{error}</div> : null}
        <div className="daemon-disconnect-actions">
          <button type="button" className="btn ok small" data-testid="daemon-banner-retry" disabled={busy} onClick={onRetryNow}>
            RETRY NOW
          </button>
          <button type="button" className="btn ghost small" data-testid="daemon-banner-repair" onClick={onRePairClick}>
            RE-PAIR / CHANGE SERVER
          </button>
          <button type="button" className="btn ghost small" data-testid="daemon-banner-first-time" onClick={onFirstTimeSetupClick}>
            FIRST-TIME SETUP
          </button>
          <button type="button" className="btn ghost small" data-testid="daemon-banner-diagnostics" onClick={props.onOpenDiagnostics}>
            OPEN DIAGNOSTICS
          </button>
          {updaterStatus.updateAvailable && updaterStatus.downloaded ? (
            <button
              type="button"
              className="btn ok small"
              data-testid="daemon-banner-update"
              onClick={() => void triggerUpdateInstall()}
            >
              RESTART &amp; UPDATE (v{updaterStatus.availableVersion})
            </button>
          ) : (
            <button
              type="button"
              className="btn ghost small"
              data-testid="daemon-banner-update"
              disabled={updateChecking}
              onClick={() => {
                setUpdateChecking(true);
                void checkForUpdates().finally(() => setUpdateChecking(false));
              }}
            >
              {updateChecking ? "CHECKING UPDATES…" : "CHECK FOR UPDATES"}
            </button>
          )}
          {props.onOpenSetup && (
            <button type="button" className="btn ghost small" data-testid="daemon-banner-setup" onClick={props.onOpenSetup}>
              SETUP
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

/** Connection status in Diagnostics: the header pill links here, so Retry stays reachable without a scrim. */
function PaseoConnectionSection() {
  const { conn, status, paseoConn, agents } = usePaseo();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const remote = isRemote();
  if (!paseoIsDown({ remote, conn, status, paseoConn })) return null;
  if (!remote && !usesPaseoBackend(getRunnerStatus(), agents.keys())) return null;
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([fn(), new Promise((r) => { timer = setTimeout(r, RETRY_TIMEOUT_MS); })]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  };
  return (
    <div className="diag-build-status stale" data-testid="diagnostics-paseo-section">
      <div>Connection lost · reconnecting automatically. VibeSquad keeps working on its own runner.</div>
      <button type="button" className="btn ok small" data-testid="diagnostics-paseo-retry" disabled={busy} onClick={() => void run(async () => { await reconnectWithDaemonPassword(); await dc.getDaemonStatus?.(); })}>
        RETRY NOW
      </button>
      {err && <div className="daemon-disconnect-error" data-testid="diagnostics-connection-error">{err}</div>}
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
        <PaseoConnectionSection />
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
