// Paseo archives an agent's children with it: every unarchived agent whose parent label points at the
// archived one (agent-manager cascadeArchiveChildren). A Buddy spawns its lead
// through MCP create_agent, so the lead (and nothing else) carries the Buddy as parent. Retiring and
// archiving the Buddy then archived the lead too, and the lead's workers with it
// (docs/PLAN_BUGS_BATCH1.md block 0: Basic ADE ord1 + 5 workers, 2026-11-02 04:25Z).
// Detach first, archive second.

import { getBackend } from "./backend/index.mjs";

// The runner's one parent key (server/identity.mjs, RunnerBackend.toAgent); X1c dropped paseo.parent-agent-id. A Paseo snapshot
// still carries its parent as `parentAgentId`, which parentOf falls back to.
export const PARENT_LABEL = "vs.parent";

/** The parent id an agent is chained to, or "". */
export const parentOf = (a) => String(a?.labels?.[PARENT_LABEL] || a?.parentAgentId || "");

/**
 * Every non-archived agent from a DaemonClient. DaemonClient has `fetchAgents` (paged, max 200 a page),
 * not `listAgents`. Returns [] when the daemon can't be read.
 */
export async function listDaemonAgents(client, { maxPages = 10 } = {}) {
  const backend = getBackend(client);
  if (!backend || typeof backend.fetchAgents !== "function") return [];
  const out = [];
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    const res = await backend
      .fetchAgents({ filter: { includeArchived: false }, page: { limit: 200, ...(cursor ? { cursor } : {}) } })
      .catch(() => null);
    if (!res) break;
    const entries = Array.isArray(res) ? res : Array.isArray(res.entries) ? res.entries : [];
    for (const e of entries) out.push(e?.agent ?? e);
    cursor = res.pageInfo?.hasMore ? res.pageInfo.nextCursor : null;
    if (!cursor) break;
  }
  return out;
}

/**
 * Detach every live (not archived, not closed) child of `parentId` so archiving the parent can't reach it.
 * `list()` returns agent snapshots; `detach(id)` makes one independent (Paseo clears the parent label).
 * Closed children are left alone: they go with the parent, as before. Returns the detached ids; a failed
 * detach is reported in `failed` and never throws, so the caller can decide whether to archive at all.
 */
export async function detachLiveChildren(parentId, { list, detach }) {
  const detached = [];
  const failed = [];
  if (!parentId || typeof list !== "function" || typeof detach !== "function") return { detached, failed };
  const agents = (await Promise.resolve().then(list).catch(() => null)) ?? [];
  for (const a of agents) {
    if (!a || a.id === parentId || a.archivedAt || a.status === "closed") continue;
    if (parentOf(a) !== parentId) continue;
    try {
      await detach(a.id);
      detached.push(a.id);
    } catch (e) {
      failed.push({ id: a.id, error: String(e?.message ?? e) });
    }
  }
  return { detached, failed };
}

/** detachLiveChildren wired to a DaemonClient (server/brainstorm.mjs retire paths). */
export const detachLiveChildrenViaClient = (client, parentId) => {
  const backend = getBackend(client);
  return detachLiveChildren(parentId, { list: () => listDaemonAgents(backend), detach: (id) => backend.detachAgent(id) });
};
