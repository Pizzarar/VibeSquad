import { useState, useSyncExternalStore } from "react";
import { perfClear, perfEnabled, perfEntries, perfMedianByLabel, perfReportText, perfSubscribe, perfVersion } from "./perf";

/** Dev-only perf panel. Renders nothing unless the page was opened with ?perf=1. */
export function PerfOverlay() {
  if (!perfEnabled()) return null;
  return <PerfOverlayBody />;
}

function PerfOverlayBody() {
  useSyncExternalStore(perfSubscribe, perfVersion);
  const [copied, setCopied] = useState(false);
  const rows = perfMedianByLabel();
  const recent = perfEntries().slice(-8).reverse();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(perfReportText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <div
      data-testid="perf-overlay"
      style={{
        position: "fixed",
        right: 8,
        bottom: 8,
        zIndex: 99999,
        maxWidth: 360,
        padding: 8,
        font: "11px/1.4 monospace",
        background: "rgba(0,0,0,.85)",
        color: "#9f9",
        border: "1px solid #3a3",
        borderRadius: 4,
      }}
    >
      <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
        <b style={{ flex: 1 }}>perf</b>
        <button onClick={copy}>{copied ? "copied" : "copy"}</button>
        <button onClick={perfClear}>clear</button>
      </div>
      {rows.map((r) => (
        <div key={r.label}>
          {r.label}: n={r.n} med={r.median}ms max={r.max}ms
        </div>
      ))}
      <hr style={{ borderColor: "#252" }} />
      {recent.map((e, i) => (
        <div key={i} style={{ opacity: 0.8 }}>
          {e.label} {e.ms}ms {e.detail ?? ""}
        </div>
      ))}
    </div>
  );
}
