import type { PaseoAgent } from "@getpaseo/client";

export function TerminalPanel({ agent }: { agent: PaseoAgent }) {
  return (
    <div className="right-dock-placeholder" data-testid="terminal-panel">
      <span className="muted">Terminal panel ({agent.cwd ?? "workspace"})</span>
      <span className="muted small">Wave 1 · Batch E</span>
    </div>
  );
}
