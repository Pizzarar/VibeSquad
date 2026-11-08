// RS-b shot harness: the real SkyZones + styles.css over a fake Squad view; the chat body (DrawerSlot) is a stub (see vite.config.mjs).
import { createRoot } from "react-dom/client";
import "../../src/styles.css";
import { SkyZones } from "../../src/SkyZones";

const member = (id: string, kind: string) => ({
  agent: { id, title: id, status: "idle", updatedAt: "2026-11-07T00:00:00Z", archivedAt: null, labels: { lane: "sq1" }, createdAt: "2026-11-07T00:00:00Z" },
  attention: null,
  kind,
  agentType: kind === "brainstorm" ? "brainstorm" : "lead",
  laneId: "sq1",
});
const view: any = { team: { id: "sq1", name: "Squad One", color: "#fff", lanes: [] }, lanes: [], members: [member("buddy", "brainstorm"), member("boss", "lead")] };
const q = new URLSearchParams(location.search);
document.documentElement.setAttribute("data-theme", q.get("theme") === "light" ? "light" : "dark");
document.documentElement.setAttribute("data-theme-set", "1");
createRoot(document.getElementById("root")!).render(
  <div className="hub-body" style={{ ["--h" as string]: q.get("h") ?? "44vh" }}>
    <div />
    <SkyZones view={view} onSuccessor={() => {}} />
  </div>,
);
