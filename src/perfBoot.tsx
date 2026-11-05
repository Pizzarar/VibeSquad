import { createRoot } from "react-dom/client";
import { PerfOverlay } from "./PerfOverlay";
import { perfEnabled, perfRecord } from "./perf";

// ?perf=1 only: mount the overlay in its own root and report main-thread long tasks (render/commit stalls).
if (perfEnabled()) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  createRoot(host).render(<PerfOverlay />);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) perfRecord("longtask", e.duration, `agents=n/a start=${Math.round(e.startTime)}`);
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    /* longtask not supported */
  }
}
