import { useEffect, useRef, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { ChangesPanel } from "./ChangesPanel";
import { FilesPanel } from "./FilesPanel";
import { TerminalPanel } from "./TerminalPanel";
import { ScriptsPanel } from "./ScriptsPanel";
import { ProjectPanel } from "./ProjectPanel";
import { claimPending, makePending, type PendingOpen } from "./fileLinks";

export type DockTab = "Changes" | "Files" | "Terminal" | "Scripts" | "Project";
const TABS: DockTab[] = ["Changes", "Files", "Terminal", "Scripts", "Project"];

export type OpenRightDockDetail = {
  tab: DockTab;
  filePath?: string;
  line?: number;
  nonce?: number; // bumps on every request so re-clicking the same link re-opens it
};

// The dock isn't mounted while closed, so an event fired by a click would be lost: keep the
// request here and let the dock claim it on mount.
let dockMounted = 0;
let pendingOpen: PendingOpen | null = null;
let openNonce = 0;

export function openRightDockTab(tab: DockTab, opts?: { filePath?: string; line?: number }) {
  const nonce = ++openNonce;
  if (!dockMounted) pendingOpen = makePending(tab, opts, nonce); // non-Files / empty requests are not kept
  localStorage.setItem("vs.right-dock.open", "true");
  localStorage.setItem("vs.right-dock.tab", tab);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<OpenRightDockDetail>("vs:open-right-dock", {
        detail: { tab, ...opts, nonce },
      }),
    );
  }
}

type RightDockProps = {
  agent: PaseoAgent;
};

export function RightDock({ agent }: RightDockProps) {
  const [activeTab, setActiveTab] = useState<DockTab>(
    () => (localStorage.getItem("vs.right-dock.tab") as DockTab | null) ?? "Changes",
  );
  const [width, setWidth] = useState(() => Number(localStorage.getItem("vs.right-dock.width")) || 320);
  const [targetFile, setTargetFile] = useState<string | null>(null);
  const [targetLine, setTargetLine] = useState<number | null>(null);
  const [targetNonce, setTargetNonce] = useState(0);
  const resizing = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  useEffect(() => {
    localStorage.setItem("vs.right-dock.tab", activeTab);
  }, [activeTab]);

  useEffect(() => {
    localStorage.setItem("vs.right-dock.width", String(width));
  }, [width]);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenRightDockDetail>).detail;
      if (!detail) return;
      pendingOpen = null;
      if (detail.tab) setActiveTab(detail.tab);
      if (detail.filePath !== undefined) {
        setTargetFile(detail.filePath);
        setTargetNonce(detail.nonce ?? 0);
      }
      if (detail.filePath !== undefined) setTargetLine(detail.line ?? null);
      else if (detail.line !== undefined) setTargetLine(detail.line);
    };
    window.addEventListener("vs:open-right-dock", onOpen);
    dockMounted++;
    const p = claimPending(pendingOpen);
    pendingOpen = null;
    if (p) onOpen(new CustomEvent("vs:open-right-dock", { detail: p }));
    return () => {
      dockMounted--;
      window.removeEventListener("vs:open-right-dock", onOpen);
    };
  }, []);

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
    <div className="right-dock" data-testid="right-dock" style={{ width }}>
      <div className="right-dock-resize-handle" onMouseDown={onMouseDown} title="Drag to resize" />
      <div className="right-dock-tabs">
        {TABS.map((tab) => (
          <button
            key={tab}
            data-testid={`right-dock-tab-${tab.toLowerCase()}`}
            className={`right-dock-tab${activeTab === tab ? " active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="right-dock-body">
        {activeTab === "Changes" && <ChangesPanel agent={agent} />}
        {activeTab === "Files" && <FilesPanel agent={agent} targetFile={targetFile} targetLine={targetLine} targetNonce={targetNonce} />}
        {activeTab === "Terminal" && <TerminalPanel agent={agent} />}
        {activeTab === "Scripts" && <ScriptsPanel agent={agent} />}
        {activeTab === "Project" && <ProjectPanel agent={agent} />}
      </div>
    </div>
  );
}
