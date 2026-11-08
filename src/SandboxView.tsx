import { useEffect, useRef, useState } from "react";
import type { PaseoAgent } from "./agentTypes";
import { missingLine, sandboxPosture, sourceLabel } from "./paseoSandboxLogic";
import { getWorkspacePorts, subscribeWorkspacePorts, type DetectedPort } from "./portsDetect";

// Read-only sandbox / permission posture for the running agent. Changes stay in the Features menu.
export function SandboxView({
  agent,
  detectedPorts: detectedPortsProp,
}: {
  agent: PaseoAgent;
  detectedPorts?: DetectedPort[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const portsKey = agent.cwd || agent.id || "default";
  const [storePorts, setStorePorts] = useState<DetectedPort[]>(() => getWorkspacePorts(portsKey));
  useEffect(() => {
    setStorePorts(getWorkspacePorts(portsKey));
    return subscribeWorkspacePorts(() => {
      setStorePorts(getWorkspacePorts(portsKey));
    });
  }, [portsKey]);
  const ports = detectedPortsProp ?? storePorts;
  useEffect(() => setOpen(false), [agent.id]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Mark handled: PinRail and App skip defaultPrevented Esc, so this press closes only the popover.
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const posture = sandboxPosture(agent as any);
  const missing = missingLine(posture);
  return (
    <span ref={ref} className="drawer-sandbox">
      <button
        data-testid="drawer-sandbox-btn"
        className="btn ghost small"
        style={{ padding: "0 5px", fontSize: 10, height: 20 }}
        title="Sandbox and permission posture (read-only)"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Sandbox
      </button>
      {open && (
        <div data-testid="drawer-sandbox-panel" className="drawer-sandbox-panel">
          {posture.rows.map((r) => (
            <div key={r.key} className="drawer-sandbox-row">
              <span className="drawer-sandbox-label">{r.label}</span>
              <span className="drawer-sandbox-val" title={r.full}>{r.value}</span>
              <span className="drawer-sandbox-src">{sourceLabel(r.source)}</span>
            </div>
          ))}
          <div data-testid="sandbox-listening-ports" className="drawer-sandbox-row">
            <span className="drawer-sandbox-label">Listening ports</span>
            <span className="drawer-sandbox-val" style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
              {ports.length > 0 ? (
                ports.map((p) => (
                  <a
                    key={p.port}
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid={`port-pill-${p.port}`}
                    title={`Open ${p.url}`}
                    style={{
                      padding: "0 5px",
                      borderRadius: 999,
                      background: "rgba(0, 245, 212, 0.12)",
                      border: "1px solid rgba(0, 245, 212, 0.35)",
                      color: "var(--cyan-t)",
                      textDecoration: "none",
                      fontFamily: "monospace",
                      fontSize: 11,
                    }}
                  >
                    :{p.port}
                  </a>
                ))
              ) : (
                <span className="muted">None detected in terminal</span>
              )}
            </span>
            <span className="drawer-sandbox-src">terminal</span>
          </div>
          {missing && <div className="drawer-sandbox-note">{missing}</div>}
          <div className="drawer-sandbox-note">Read-only. Change features in the Features menu.</div>
        </div>
      )}
    </span>
  );
}
