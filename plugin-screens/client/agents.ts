import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";

/** Live, non-archived agents on the selected host. `null` until the first snapshot. */
export function useLiveAgents(enabled: boolean): PaseoAgent[] | null {
  const paseo = usePaseo();
  const [agents, setAgents] = useState<PaseoAgent[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const lifetime = new AbortController();
    const byId = new Map<string, PaseoAgent>();
    const publish = () => setAgents([...byId.values()]);
    let release: (() => void) | undefined;
    void paseo.agents
      .list({ subscribe: {}, filter: { includeArchived: false }, signal: lifetime.signal } as any)
      .then(({ entries, subscription }) => {
        if (lifetime.signal.aborted) return void subscription.release();
        release = () => void subscription.release();
        const replace = (next: typeof entries) => {
          byId.clear();
          for (const { agent } of next) if (!agent.archivedAt) byId.set(agent.id, agent);
          publish();
        };
        // The first snapshot arrives with the list result; a late observer is not guaranteed to get
        // it again, so seed from it. Later snapshots (after a reconnect) replace the map.
        replace(entries);
        subscription.subscribe({
          snapshot: ({ entries: next }) => replace(next),
          update: (message) => {
            if (message.type !== "agent_update") return;
            const u = message.payload;
            if (u.kind === "upsert" && !u.agent.archivedAt) byId.set(u.agent.id, u.agent);
            else byId.delete(u.kind === "upsert" ? u.agent.id : u.agentId);
            publish();
          },
        });
      })
      .catch((err) => {
        if (!lifetime.signal.aborted) console.error("[vibesquad-screens] agent list failed", err);
      });
    return () => {
      lifetime.abort();
      release?.();
    };
  }, [paseo, enabled]);
  return agents;
}
