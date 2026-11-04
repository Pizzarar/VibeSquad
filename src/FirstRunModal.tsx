import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "./TeamActions";
import { reconnectWithDaemonPassword } from "./paseo";
import { submitDaemonPassword } from "./paseoDaemonAuth";

export type FirstRunStatus = {
  pinnedPaseoVersion: string;
  paseo: {
    installed: boolean;
    running: boolean;
    daemonReachable?: boolean;
    source: "existing" | "managed" | "none";
    version: string | null;
    installing: boolean;
    progress: string;
    error: string | null;
    installDurationMs: number | null;
    passwordRequired?: boolean;
    passwordConfigured?: boolean;
    passwordSource?: "env" | "file" | "local-credential" | "none";
  };
  claude: { installed: boolean; loggedIn: boolean; version: string | null; installUrl: string };
  gemini: { installed: boolean; loggedIn: boolean; version: string | null; installUrl: string };
  git: { installed: boolean; version: string | null; installUrl: string };
  ready: boolean;
};

export const FIRST_RUN_DONE_KEY = "vs.firstRunDone";

export async function fetchFirstRunStatus(): Promise<FirstRunStatus | null> {
  try {
    const r = await fetch("/__vibesquad/first-run/status");
    return r.ok ? ((await r.json()) as FirstRunStatus) : null;
  } catch {
    return null;
  }
}

const Row = ({ id, name, children }: { id: string; name: string; children: React.ReactNode }) => (
  <div data-testid={`checklist-row-${id}`} style={{ padding: "8px 0", borderBottom: "1px solid #282644" }}>
    <strong>{name}</strong>
    <div style={{ marginTop: 4, fontSize: 12 }}>{children}</div>
  </div>
);

const Ext = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer noopener">
    {children}
  </a>
);

export function FirstRunModal({ initial, onClose }: { initial?: FirstRunStatus | null; onClose: () => void }) {
  const [status, setStatus] = useState<FirstRunStatus | null>(initial ?? null);
  const [daemonBusy, setDaemonBusy] = useState(false);
  const [pw, setPw] = useState("");
  const [editingPw, setEditingPw] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const triggered = useRef(false);

  const refresh = useCallback(async () => {
    const s = await fetchFirstRunStatus();
    if (s) setStatus(s);
    return s;
  }, []);
  const refreshStatus = refresh;

  const install = useCallback(async () => {
    try {
      await fetch("/__vibesquad/first-run/install-paseo", { method: "POST" });
    } catch {}
    await refresh();
  }, [refresh]);

  const p = status?.paseo;

  const onStartOrRestartDaemon = useCallback(async () => {
    setDaemonBusy(true);
    try {
      await fetch("/__vibesquad/paseo/daemon", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: (p?.daemonReachable ?? p?.running) ? "restart" : "start" }),
      });
    } catch {}
    await refreshStatus();
    setDaemonBusy(false);
  }, [p?.daemonReachable, p?.running, refreshStatus]);

  const onSavePassword = useCallback(async () => {
    const trimmed = pw.trim();
    if (!trimmed || pwBusy) return;
    setPwBusy(true);
    setPwMsg(null);
    try {
      const res = await submitDaemonPassword(trimmed);
      if (!res.ok) {
        setPwMsg(res.error || "Password rejected");
        return;
      }
      setPw("");
      setPwMsg("✓ Saved & verified");
      await reconnectWithDaemonPassword(trimmed);
      await refreshStatus();
    } catch (e) {
      setPwMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setPwBusy(false);
    }
  }, [pw, pwBusy, refreshStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!status || triggered.current) return;
    const p = status.paseo;
    if (!p.installed && !p.installing && !p.error) {
      triggered.current = true;
      void install();
    }
  }, [status, install]);

  const installing = status?.paseo.installing ?? false;
  useEffect(() => {
    if (!installing) return;
    const t = setInterval(() => void refresh(), 1500);
    return () => clearInterval(t);
  }, [installing, refresh]);

  const canContinue = Boolean(status?.paseo.installed && (status.claude.installed || status.gemini.installed));
  const done = () => {
    localStorage.setItem(FIRST_RUN_DONE_KEY, "1");
    onClose();
  };

  return (
    <Modal
      title="Setup Checklist"
      onClose={() => { localStorage.setItem(FIRST_RUN_DONE_KEY, "1"); onClose(); }}
      footer={
        <>
          <button className="btn ghost" data-testid="first-run-check-again-btn" onClick={() => void refresh()}>
            Check again
          </button>
          <button className="btn ok" data-testid="first-run-continue-btn" disabled={!canContinue} onClick={done}>
            Continue
          </button>
        </>
      }
    >
      <div data-testid="first-run-checklist-modal">
        {!status ? (
          <p>Checking your machine…</p>
        ) : (
          <>
            <Row id="paseo" name="1. Paseo CLI & Daemon">
              <div>
                {status.paseo.installed ? (
                  <span>
                    ✓ Paseo {status.paseo.version ? `v${status.paseo.version}` : ""} ({status.paseo.source === "existing" ? "found existing" : "bundled/managed"}){" "}
                  </span>
                ) : status.paseo.installing ? (
                  <span>
                    <span className="spinner">⏳</span> {status.paseo.progress || `Installing @getpaseo/cli@${status.pinnedPaseoVersion} from npm...`}{" "}
                  </span>
                ) : status.paseo.error ? (
                  <span>
                    <span role="alert" style={{ color: "#ff2a85" }}>
                      {status.paseo.error}
                    </span>{" "}
                    <button className="btn small" data-testid="paseo-retry-btn" onClick={() => void install()}>
                      Retry
                    </button>{" "}
                  </span>
                ) : (
                  <span>Starting install… </span>
                )}
                <button
                  type="button"
                  className="btn ghost small"
                  data-testid="first-run-daemon-start-btn"
                  disabled={daemonBusy || status.paseo.installing}
                  onClick={() => void onStartOrRestartDaemon()}
                >
                  {daemonBusy ? "Working…" : (p?.daemonReachable ?? p?.running) ? "Restart Daemon" : "Start Daemon"}
                </button>
              </div>
              {(p?.passwordRequired || p?.passwordConfigured) && (
                <div style={{ marginTop: 6 }}>
                  <div className="muted small">
                    {p?.passwordRequired ? "Daemon password required" : "Daemon password optional"} ·{" "}
                    {p?.passwordConfigured ? `Configured (${p?.passwordSource ?? "file"})` : "Not configured"}
                  </div>
                  {p?.passwordSource === "local-credential" && !editingPw ? (
                    <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
                      <span>✓ Local Paseo credential active</span>
                      <button type="button" className="btn ghost small" onClick={() => setEditingPw(true)}>
                        Change password
                      </button>
                    </div>
                  ) : (
                  <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
                    <input
                      type="password"
                      data-testid="first-run-password-input"
                      value={pw}
                      onChange={(e) => setPw(e.target.value)}
                      placeholder="Daemon password…"
                    />
                    <button
                      type="button"
                      className="btn small"
                      data-testid="first-run-password-save-btn"
                      disabled={pwBusy || !pw.trim()}
                      onClick={() => void onSavePassword()}
                    >
                      {pwBusy ? "Saving…" : "Save & Test"}
                    </button>
                    {pwMsg && <span className="muted small">{pwMsg}</span>}
                  </div>
                  )}
                </div>
              )}
            </Row>
            <Row id="claude" name="Claude Code">
              {status.claude.installed ? (
                <span>✓ Installed {status.claude.loggedIn ? "· Logged in" : "· Run 'claude' once to log in"}</span>
              ) : (
                <span>
                  Not detected · <Ext href={status.claude.installUrl}>Install Claude Code ↗</Ext>
                </span>
              )}
            </Row>
            <Row id="gemini" name="Gemini / Antigravity">
              {status.gemini.installed ? (
                <span>✓ Installed {status.gemini.loggedIn ? "· Logged in" : ""}</span>
              ) : (
                <span>
                  Not detected · <Ext href={status.gemini.installUrl}>Install Gemini CLI ↗</Ext>
                </span>
              )}
            </Row>
            <Row id="git" name="Git (optional)">
              {status.git.installed ? (
                <span>✓ Installed{status.git.version ? ` (${status.git.version})` : ""}</span>
              ) : (
                <span>
                  Optional — <Ext href={status.git.installUrl}>Install Git ↗</Ext>
                </span>
              )}
            </Row>
            <p style={{ fontSize: 11, opacity: 0.7 }}>You need Paseo plus at least one of Claude Code or Gemini to continue.</p>
          </>
        )}
      </div>
    </Modal>
  );
}
