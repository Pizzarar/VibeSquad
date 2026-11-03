import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "./TeamActions";
import { daemonClient, reconnectWithDaemonPassword, usePaseo } from "./paseo";
import { submitDaemonPassword } from "./paseoDaemonAuth";
import { clearSession, isRemote } from "./remoteSession";
import { getStaleBuild, loadUpdaterStatus, triggerUpdateInstall, useStaleBuild, useUpdaterStatus } from "./userName";
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
    staleBuild: getStaleBuild(),
  };
}

/** A blip shorter than this shows nothing: the scrim only appears once the daemon has been away this long. */
export const DISCONNECT_DEBOUNCE_MS = 2000;
const RETRY_SECONDS = 3;
const RETRY_TIMEOUT_MS = 10_000;

export function shouldShowDisconnectOverlay(conn: string, disconnectedSinceMs: number | null, nowMs: number, debounceMs = DISCONNECT_DEBOUNCE_MS): boolean {
  return conn !== "connected" && disconnectedSinceMs !== null && nowMs - disconnectedSinceMs >= debounceMs;
}

/** Centered card over a dimmed scrim. position: fixed and not a role="alert" child of .app, so the layout underneath never changes. */
export const DaemonStatusBanner = memo(function DaemonStatusBanner(props: {
  onOpenDiagnostics?: () => void;
  onOpenSetup?: () => void;
  onOpenPaseoSettings?: () => void;
  onRePair?: () => void;
}) {
  const { conn, status, error, authFailureReason } = usePaseo();
  const updaterStatus = useUpdaterStatus();
  const [updateChecking, setUpdateChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  const [retryIn, setRetryIn] = useState(RETRY_SECONDS);
  const [pw, setPw] = useState("");
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockErr, setUnlockErr] = useState<string | null>(null);
  const down = conn !== "connected" && status !== "connected";

  useEffect(() => {
    if (!down) {
      setVisible(false);
      return;
    }
    if (authFailureReason) {
      setVisible(true);
      return;
    }
    const since = Date.now();
    const t = setTimeout(() => {
      if (shouldShowDisconnectOverlay("disconnected", since, Date.now())) setVisible(true);
    }, DISCONNECT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [down, authFailureReason]);

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

  useEffect(() => {
    if (!visible || authFailureReason) {
      setRetryIn(RETRY_SECONDS);
      return;
    }
    const iv = setInterval(() => {
      setRetryIn((n) => {
        if (n > 1) return n - 1;
        void retry();
        return RETRY_SECONDS;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [visible, authFailureReason, retry]);

  if (!down || !visible) return null;
  const onRetryNow = () => {
    setRetryIn(RETRY_SECONDS);
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
    window.location.href = "/?remote=1";
  };
  const onPaseoLinkClick = () => {
    clearSession();
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
  const onUnlockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = pw.trim();
    if (!trimmed || unlockBusy) return;
    setUnlockBusy(true);
    setUnlockErr(null);
    try {
      const res = await submitDaemonPassword(trimmed);
      if (!res.ok) {
        setUnlockErr(res.error || "Failed to verify password");
        return;
      }
      setPw("");
      setUnlockErr(null);
      await reconnectWithDaemonPassword(trimmed);
    } catch (err) {
      setUnlockErr(err instanceof Error ? err.message : String(err));
    } finally {
      setUnlockBusy(false);
    }
  };
  return (
    <div className="daemon-disconnect-scrim" data-testid="daemon-disconnect-scrim">
      <div className="daemon-disconnect-card" data-testid="daemon-down-banner" role="alert">
        <div className="daemon-disconnect-title" data-testid="daemon-disconnect-text">
          {authFailureReason ? "PASEO DAEMON LOCKED" : <>Daemon disconnected · retrying in {retryIn}s</>}
        </div>
        {authFailureReason ? (
          <>
            <div className="daemon-disconnect-subtext">
              {authFailureReason === "password_required"
                ? "The local Paseo daemon requires a password (daemon.auth.password is set in ~/.paseo/config.json)."
                : "The stored daemon password was rejected by the local Paseo daemon."}
            </div>
            <form className="daemon-banner-auth-form" data-testid="daemon-banner-auth-form" onSubmit={(e) => void onUnlockSubmit(e)}>
              <input
                type="password"
                data-testid="daemon-banner-password-input"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder="Enter Paseo daemon password…"
              />
              <button type="submit" className="btn small" data-testid="daemon-banner-unlock-btn" disabled={unlockBusy || !pw.trim()}>
                {unlockBusy ? "VERIFYING…" : "UNLOCK & SAVE"}
              </button>
            </form>
            {unlockErr && (
              <div className="daemon-disconnect-error" data-testid="daemon-banner-auth-error">
                {unlockErr}
              </div>
            )}
          </>
        ) : error ? (
          <div className="daemon-disconnect-subtext">{error}</div>
        ) : null}
        <div className="daemon-disconnect-actions">
          <button type="button" className="btn ok small" data-testid="daemon-banner-retry" disabled={busy} onClick={onRetryNow}>
            RETRY NOW
          </button>
          <button type="button" className="btn ghost small" data-testid="daemon-banner-repair" onClick={onRePairClick}>
            RE-PAIR / CHANGE SERVER
          </button>
          <button type="button" className="btn ghost small" data-testid="daemon-banner-paseo-link" onClick={onPaseoLinkClick}>
            PAIR WITH PASEO LINK
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
              SETUP / DAEMON
            </button>
          )}
          {props.onOpenPaseoSettings && (
            <button type="button" className="btn ghost small" data-testid="daemon-banner-paseo-settings" onClick={props.onOpenPaseoSettings}>
              PASEO SETTINGS
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

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
    const r = await fetch("/__desktop/updater/check", { method: "POST", cache: "no-store" });
    if (r.ok) {
      await loadUpdaterStatus();
      return true;
    }
  } catch {}
  try {
    return (await fetch("/__vibesquad/health", { cache: "no-store" })).ok;
  } catch {
    return false;
  }
}
