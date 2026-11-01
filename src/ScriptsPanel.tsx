import type { PaseoAgent } from "@getpaseo/client";

export function ScriptsPanel({ agent }: { agent: PaseoAgent }) {
  return (
    <div className="right-dock-placeholder" data-testid="scripts-panel">
      <span className="muted">Scripts panel ({agent.cwd ?? "workspace"})</span>
      <span className="muted small">Wave 1 · Batch E</span>
    </div>
  );
}
