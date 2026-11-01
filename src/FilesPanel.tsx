import type { PaseoAgent } from "@getpaseo/client";

export function FilesPanel({
  agent,
  targetFile,
  targetLine,
}: {
  agent: PaseoAgent;
  targetFile?: string | null;
  targetLine?: number | null;
}) {
  return (
    <div className="right-dock-placeholder" data-testid="files-panel">
      <span className="muted">Files panel ({agent.cwd ?? "workspace"})</span>
      {targetFile && (
        <span className="muted small">
          {targetFile}
          {targetLine ? `:${targetLine}` : ""}
        </span>
      )}
    </div>
  );
}
