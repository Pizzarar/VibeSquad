import { useEffect, useRef, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { sandboxPosture, sourceLabel } from "./paseoSandboxLogic";

// Read-only sandbox / permission posture for the running agent. Changes stay in the Features menu.
export function SandboxView({ agent }: { agent: PaseoAgent }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => setOpen(false), [agent.id]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
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
  const rows = sandboxPosture(agent as any);
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
          {rows.map((r) => (
            <div key={r.key} className="drawer-sandbox-row">
              <span className="drawer-sandbox-label">{r.label}</span>
              <span className={r.source === "none" ? "drawer-sandbox-val missing" : "drawer-sandbox-val"}>{r.value}</span>
              {r.source !== "none" && <span className="drawer-sandbox-src">{sourceLabel(r.source)}</span>}
            </div>
          ))}
          <div className="drawer-sandbox-note">Read-only. Change features in the Features menu.</div>
        </div>
      )}
    </span>
  );
}
