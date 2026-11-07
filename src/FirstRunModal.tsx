import { useCallback, useEffect, useState } from "react";
import { Modal } from "./TeamActions";

export type FirstRunStatus = {
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
  <div data-testid={`checklist-row-${id}`} style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
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

  const refresh = useCallback(async () => {
    const s = await fetchFirstRunStatus();
    if (s) setStatus(s);
    return s;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const canContinue = Boolean(status && (status.claude.installed || status.gemini.installed));
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
            <p style={{ fontSize: 11, opacity: 0.7 }}>You need at least one of Claude Code or Gemini to continue.</p>
          </>
        )}
      </div>
    </Modal>
  );
}
