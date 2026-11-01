import { useEffect, useRef, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";

type Tab = "Changes" | "Files" | "Terminal" | "Scripts";
const TABS: Tab[] = ["Changes", "Files", "Terminal", "Scripts"];

type RightDockProps = {
  agent: PaseoAgent;
};

export function RightDock({ agent: _agent }: RightDockProps) {
  const [activeTab, setActiveTab] = useState<Tab>(
    () => (localStorage.getItem("vs.right-dock.tab") as Tab | null) ?? "Changes",
  );
  const [width, setWidth] = useState(() => Number(localStorage.getItem("vs.right-dock.width")) || 320);
  const resizing = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  useEffect(() => {
    localStorage.setItem("vs.right-dock.tab", activeTab);
  }, [activeTab]);

  useEffect(() => {
    localStorage.setItem("vs.right-dock.width", String(width));
  }, [width]);

  const onMouseDown = (e: React.MouseEvent) => {
    resizing.current = true;
    startX.current = e.clientX;
    startW.current = width;
    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const delta = startX.current - ev.clientX;
      setWidth(Math.max(200, Math.min(700, startW.current + delta)));
    };
    const onUp = () => {
      resizing.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className="right-dock" style={{ width }}>
      <div className="right-dock-resize-handle" onMouseDown={onMouseDown} title="Drag to resize" />
      <div className="right-dock-tabs">
        {TABS.map((tab) => (
          <button
            key={tab}
            className={`right-dock-tab${activeTab === tab ? " active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="right-dock-body">
        <div className="right-dock-placeholder">
          <span className="muted">{activeTab} panel</span>
          <span className="muted small">Coming in Wave 1 · {activeTab === "Changes" ? "Batch D" : "Batch E"}</span>
        </div>
      </div>
    </div>
  );
}
