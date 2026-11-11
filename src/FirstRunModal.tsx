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
  display: "flex", flexDirection: "column", gap: 12, padding: 20, textAlign: "left", cursor: "pointer",
  background: "var(--bg-card, var(--panel-hi, #181e2b))", color: "var(--text, #eef1f7)", borderRadius: 10,
  border: on ? "3px solid var(--accent, var(--cyan, #2563eb))" : "2px solid var(--border-strong, var(--line, #455370))",
  boxShadow: on ? "0 0 0 3px rgba(37, 99, 235, 0.28)" : "none",
});

const previewSvgStyle: React.CSSProperties = { width: "100%", height: "auto", minHeight: 195, borderRadius: 6, display: "block" };

const NormalPreview = () => (
  <svg viewBox="0 0 320 180" width="100%" style={previewSvgStyle} aria-hidden="true">
    <rect width="320" height="180" fill="#f1f5f9" />
    <rect width="76" height="180" fill="#e2e8f0" />
    <rect x="10" y="12" width="56" height="16" rx="4" fill="#2563eb" />
    <rect x="10" y="40" width="56" height="8" rx="2" fill="#94a3b8" />
    <rect x="10" y="56" width="56" height="8" rx="2" fill="#94a3b8" />
    <rect x="10" y="72" width="56" height="8" rx="2" fill="#94a3b8" />
    <rect x="10" y="88" width="40" height="8" rx="2" fill="#cbd5e1" />
    <rect x="96" y="16" width="208" height="28" rx="6" fill="#ffffff" />
    <rect x="106" y="26" width="90" height="8" rx="2" fill="#cbd5e1" />
    <rect x="96" y="56" width="208" height="28" rx="6" fill="#ffffff" />
    <rect x="106" y="66" width="120" height="8" rx="2" fill="#cbd5e1" />
    <rect x="96" y="96" width="96" height="60" rx="6" fill="#ffffff" />
    <rect x="204" y="96" width="100" height="60" rx="6" fill="#ffffff" />
    <rect x="262" y="164" width="42" height="10" rx="3" fill="#2563eb" />
  </svg>
);

const PsychoPreview = () => (
  <svg viewBox="0 0 320 180" width="100%" style={previewSvgStyle} aria-hidden="true">
    <rect width="320" height="180" fill="#1b1040" />
    <rect x="16" y="12" width="68" height="44" fill="#0b0d12" stroke="#7df9ff" strokeWidth="3" />
    <rect x="100" y="12" width="68" height="44" fill="#0b0d12" stroke="#ff6ad5" strokeWidth="3" />
    <rect x="184" y="12" width="68" height="44" fill="#0b0d12" stroke="#c4a1ff" strokeWidth="3" />
    <rect x="268" y="12" width="36" height="44" fill="#0b0d12" stroke="#ffd166" strokeWidth="3" />
    <rect x="120" y="72" width="80" height="20" fill="#7df9ff" />
    <rect x="112" y="96" width="96" height="20" fill="#ff6ad5" />
    <rect x="104" y="120" width="112" height="20" fill="#c4a1ff" />
    <rect x="0" y="156" width="320" height="24" fill="#3a2a70" />
  </svg>
);

const SelectPill = ({ on }: { on: boolean }) => (
  <span
    data-testid={on ? "first-run-vibe-selected" : undefined}
    style={{
      alignSelf: "flex-start", fontSize: 13, fontWeight: 600, padding: "3px 12px", borderRadius: 999,
      background: on ? "var(--accent, var(--cyan, #2563eb))" : "transparent", color: on ? "#ffffff" : "inherit",
      border: on ? "1px solid var(--accent, var(--cyan, #2563eb))" : "1px solid var(--border-strong, var(--line, #455370))",
    }}
  >
    {on ? "\u2713 Selected" : "Select"}
  </span>
);

const cardTitle: React.CSSProperties = { fontSize: 22, fontWeight: 700, lineHeight: 1.2 };
const cardCaption: React.CSSProperties = { fontSize: 15, lineHeight: 1.45, opacity: 0.9 };

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
    <div data-testid="first-run-vibe-picker" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 20, marginBottom: 16 }}>
      <button type="button" autoFocus data-testid="first-run-vibe-normal" aria-pressed={vibe === "boring"} style={cardStyle(vibe === "boring")} onClick={() => pick("boring")}>
        <NormalPreview />
        <strong style={cardTitle}>Normal</strong>
        <span style={cardCaption}>Clean corporate ADE — left sidebar, centered chat &amp; project cards</span>
        <SelectPill on={vibe === "boring"} />
      </button>
      <button type="button" data-testid="first-run-vibe-psycho" aria-pressed={vibe === "fun"} style={cardStyle(vibe === "fun")} onClick={() => pick("fun")}>
        <PsychoPreview />
        <strong style={cardTitle}>Psycho</strong>
        <span style={cardCaption}>Full retro sky CRTs, pixel tower &amp; animated sprites</span>
        <SelectPill on={vibe === "fun"} />
      </button>
    </div>
  );
}

/** Standalone first-launch picker for desktop, web and phone; stays open after a pick (so the selection is visible) until Continue or Escape. */
export function FirstLaunchVibePicker() {
  const [open, setOpen] = useState(() => shouldShowFirstLaunchVibePicker());
  const close = useCallback(() => {
    try {
      localStorage.setItem(VIBE_PICKED_KEY, "1");
    } catch {
      /* ignore */
    }
    setOpen(false);
  }, []);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, close]);
  if (!open) return null;
  const sans = "var(--sans, system-ui, sans-serif)";
  return (
    <div className="modal-back" onMouseDown={close}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label="Choose your layout" data-testid="first-run-vibe-modal" style={{ width: "min(860px, 92vw)", maxWidth: "92vw" }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
          <span data-testid="first-run-vibe-title" style={{ fontSize: 22, fontWeight: 700, fontFamily: sans, letterSpacing: "normal", textTransform: "none" }}>Choose your layout</span>
          <span style={{ fontSize: 15, fontWeight: 400, fontFamily: sans, letterSpacing: "normal", textTransform: "none", opacity: 0.85 }}>Pick your workspace style. You can switch anytime in Settings or the sidebar.</span>
        </div>
        <div className="modal-body">
          <VibePickerCards />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 16px 16px" }}>
          <button
            type="button"
            data-testid="first-run-vibe-continue"
            style={{ minHeight: 42, padding: "8px 24px", fontSize: 15, fontWeight: 600, background: "var(--accent, #2563eb)", backgroundImage: "none", color: "#ffffff", border: "1px solid var(--accent, #2563eb)", borderRadius: 6, cursor: "pointer" }}
            onClick={close}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
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
      wide
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
