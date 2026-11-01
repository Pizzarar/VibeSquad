import type { PaseoAgent } from "@getpaseo/client";

export function ChangesPanel({ agent }: { agent: PaseoAgent }) {
  return (
    <div className="right-dock-placeholder" data-testid="changes-panel">
      <span className="muted">Changes panel ({agent.cwd ?? "workspace"})</span>
      <span className="muted small">Wave 1 · Batch D</span>
    </div>
  );
}
