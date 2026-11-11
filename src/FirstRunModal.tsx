import { useCallback, useEffect, useState } from "react";
import { setPref, usePref } from "./prefs";
import { Modal } from "./TeamActions";

export type FirstRunStatus = {
  claude: { installed: boolean; loggedIn: boolean; version: string | null; installUrl: string };
  gemini: { installed: boolean; loggedIn: boolean; version: string | null; installUrl: string };
  git: { installed: boolean; version: string | null; installUrl: string };
  ready: boolean;
};

export const FIRST_RUN_DONE_KEY = "vs.firstRunDone";
export const VIBE_PICKED_KEY = "vs.vibePicked";

/** Fresh installs only: never for automation (unless forced), nor anyone who already finished setup, picked, or set app.vibe. */
export function shouldShowFirstLaunchVibePicker(opts?: { getItem?: (k: string) => string | null; webdriver?: boolean }): boolean {
  const getItem = opts?.getItem ?? ((k: string) => (typeof localStorage === "undefined" ? null : localStorage.getItem(k)));
  const webdriver = opts?.webdriver ?? (typeof navigator !== "undefined" && Boolean(navigator.webdriver));
  if (getItem("vs.forceVibePicker") === "1") return true;
  if (webdriver) return false;
  if (getItem(VIBE_PICKED_KEY) || getItem(FIRST_RUN_DONE_KEY)) return false;
  try {
    const parsed = JSON.parse(getItem("vs.prefs.v1") ?? "null");
    if (parsed && typeof parsed === "object" && "app.vibe" in parsed) return false;
  } catch {
    /* unreadable prefs blob: treat as unset */
  }
  return true;
}

const cardStyle = (on: boolean): React.CSSProperties => ({
  flex: "1 1 220px", display: "flex", flexDirection: "column", gap: 6, padding: 12, textAlign: "left", cursor: "pointer",
  background: "var(--bg-card, var(--panel-hi, #181e2b))", color: "var(--text, #eef1f7)", borderRadius: 8,
  border: `2px solid ${on ? "var(--accent, var(--cyan, #2563eb))" : "var(--border-strong, var(--line, #455370))"}`,
});

const NormalPreview = () => (
  <svg viewBox="0 0 160 90" width="100%" aria-hidden="true">
    <rect width="160" height="90" fill="#f1f5f9" />
    <rect width="38" height="90" fill="#e2e8f0" />
    <rect x="5" y="6" width="28" height="8" rx="2" fill="#2563eb" />
    <rect x="5" y="20" width="28" height="4" rx="1" fill="#94a3b8" />
    <rect x="5" y="28" width="28" height="4" rx="1" fill="#94a3b8" />
    <rect x="5" y="36" width="28" height="4" rx="1" fill="#94a3b8" />
    <rect x="48" y="8" width="104" height="14" rx="3" fill="#ffffff" />
    <rect x="48" y="28" width="104" height="14" rx="3" fill="#ffffff" />
    <rect x="48" y="48" width="48" height="30" rx="3" fill="#ffffff" />
    <rect x="102" y="48" width="50" height="30" rx="3" fill="#ffffff" />
  </svg>
);

const PsychoPreview = () => (
  <svg viewBox="0 0 160 90" width="100%" aria-hidden="true">
    <rect width="160" height="90" fill="#1b1040" />
    <rect x="8" y="6" width="34" height="22" fill="#0b0d12" stroke="#7df9ff" strokeWidth="2" />
    <rect x="50" y="6" width="34" height="22" fill="#0b0d12" stroke="#ff6ad5" strokeWidth="2" />
    <rect x="92" y="6" width="34" height="22" fill="#0b0d12" stroke="#c4a1ff" strokeWidth="2" />
    <rect x="60" y="36" width="40" height="10" fill="#7df9ff" />
    <rect x="56" y="48" width="48" height="10" fill="#ff6ad5" />
    <rect x="52" y="60" width="56" height="10" fill="#c4a1ff" />
    <rect x="0" y="78" width="160" height="12" fill="#3a2a70" />
  </svg>
);

/** Two big Normal vs Psycho cards. Picking one sets app.vibe, records VIBE_PICKED_KEY and tells the parent. */
export function VibePickerCards({ onPicked }: { onPicked?: () => void }) {
  const [vibe] = usePref("app.vibe");
  const pick = (v: "boring" | "fun") => {
    setPref("app.vibe", v);
    try {
      localStorage.setItem(VIBE_PICKED_KEY, "1");
    } catch {
      /* storage blocked: the picker just shows again next launch */
    }
    onPicked?.();
  };
  return (
    <div data-testid="first-run-vibe-picker" style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
      <button type="button" data-testid="first-run-vibe-normal" aria-pressed={vibe === "boring"} style={cardStyle(vibe === "boring")} onClick={() => pick("boring")}>
        <NormalPreview />
        <strong style={{ fontSize: 16 }}>Normal</strong>
        <span style={{ fontSize: 12, opacity: 0.8 }}>Clean corporate ADE — left sidebar, centered chat &amp; project cards</span>
      </button>
      <button type="button" data-testid="first-run-vibe-psycho" aria-pressed={vibe === "fun"} style={cardStyle(vibe === "fun")} onClick={() => pick("fun")}>
        <PsychoPreview />
        <strong style={{ fontSize: 16 }}>Psycho</strong>
        <span style={{ fontSize: 12, opacity: 0.8 }}>Full retro sky CRTs, pixel tower &amp; animated sprites</span>
      </button>
    </div>
  );
}

/** Standalone first-launch picker for desktop, web and phone; shows once until a card is picked or it is dismissed. */
export function FirstLaunchVibePicker() {
  const [open, setOpen] = useState(() => shouldShowFirstLaunchVibePicker());
  if (!open) return null;
  const close = () => {
    try {
      localStorage.setItem(VIBE_PICKED_KEY, "1");
    } catch {
      /* ignore */
    }
    setOpen(false);
  };
  return (
    <Modal title="Choose your layout" onClose={close}>
      <VibePickerCards onPicked={close} />
    </Modal>
  );
}


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
    localStorage.setItem(VIBE_PICKED_KEY, "1");
    onClose();
  };

  return (
    <Modal
      title="Setup Checklist"
      onClose={() => { localStorage.setItem(FIRST_RUN_DONE_KEY, "1"); localStorage.setItem(VIBE_PICKED_KEY, "1"); onClose(); }}
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
        <VibePickerCards />
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
