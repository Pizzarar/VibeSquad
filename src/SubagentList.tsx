import { type ReactNode, useEffect, useState } from "react";
import { getPaseoState } from "./paseo";
import { listSubagents } from "./paseoSubagents";
import { mergeSubagents, scrapedSubagents, subagentSignature, subagentStatusLabel, type ApiSubagent } from "./paseoSubagentsLogic";

// "Subagents (N)" strip for the open agent. Loads on open and refetches when a sub_agent
// tool call appears or changes status (no polling). Hidden when empty or unsupported.
export function SubagentList({
  agentId,
  entries,
  isSubAgent,
  renderBody,
}: {
  agentId: string;
  entries: any[];
  isSubAgent: (it: any, d: any) => boolean;
  renderBody: (subagentId: string) => ReactNode;
}) {
  const [api, setApi] = useState<ApiSubagent[] | null>(null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const sig = subagentSignature(entries, isSubAgent);

  useEffect(() => {
    setApi(null);
    setOpen(false);
    setExpanded(null);
  }, [agentId]);

  useEffect(() => {
    const parentStatus = getPaseoState().agents.get(agentId)?.status;
    if (parentStatus === "closed") return;
    let live = true;
    void listSubagents(agentId).then((r) => {
      if (live) setApi(r);
    });
    return () => {
      live = false;
    };
  }, [agentId, sig]);

  if (api === null) return null;
  const rows = mergeSubagents(api, scrapedSubagents(entries, isSubAgent));
  if (!rows.length) return null;

  return (
    <div className="subagent-list" data-testid="subagent-list">
      <button className="subagent-head" data-testid="subagent-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} Subagents ({rows.length})
      </button>
      {open &&
        rows.map((r) => (
          <div key={r.id} className="subagent-item">
            <button className="subagent-row" data-testid="subagent-row" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
              {expanded === r.id ? "▾" : "▸"} {r.title}
              {r.status && <span className={`subagent-status ${r.status}`}> · {subagentStatusLabel(r.status)}</span>}
            </button>
            {expanded === r.id && renderBody(r.id)}
          </div>
        ))}
    </div>
  );
}
