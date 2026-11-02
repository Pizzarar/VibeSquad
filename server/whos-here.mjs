// "## Who's here" section of a lane brief: written by VibeSquad, never by the agent.
// Live Brainstorm + Lead titles and a worker count. No IDs, no (old) rows.
import { briefRootFor } from "./brief-path.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { effectiveAgentRole, isDigestAgent, isRetiredAgent } from "./identity.mjs";
import { writeBriefFile } from "./brief-write.mjs";

export const WHOS_HERE_HEADING = "## Who's here";

function laneOf(agent) {
  const l = agent?.labels ?? {};
  return String(l.lane || l.lead || "").trim().toLowerCase();
}

export function whosHereBody(agents, laneId) {
  const want = String(laneId ?? "").trim().toLowerCase();
  const live = (Array.isArray(agents) ? agents : [])
    .map((a) => a?.agent ?? a)
    .filter((a) => a && !a.archivedAt && !a.internal && a.status !== "closed")
    .filter((a) => !isRetiredAgent(a) && !isDigestAgent(a))
    .filter((a) => laneOf(a) === want);
  const titles = (role) =>
    live
      .filter((a) => effectiveAgentRole(a) === role)
      .map((a) => String(a.title || "").trim())
      .filter(Boolean);
  const workers = live.filter((a) => effectiveAgentRole(a) === "worker").length;
  const bs = titles("brainstorm");
  const lead = titles("lead");
  return [
    `- Brainstorm: ${bs.length ? bs.join("; ") : "none running (click the pin to start one)"}`,
    `- Lead: ${lead.length ? lead.join("; ") : "none"}`,
    `- Workers: ${workers}`,
  ].join("\n");
}

/** Replace (or insert before `## Decided`) the Who's here section. Pure. */
export function applyWhosHere(content, body) {
  const section = `${WHOS_HERE_HEADING}\n${body}\n`;
  const text = String(content ?? "");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === WHOS_HERE_HEADING);
  if (start >= 0) {
    let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
    if (end < 0) end = lines.length;
    const tail = lines.slice(end).join("\n");
    return [...lines.slice(0, start), ...section.split("\n").slice(0, -1), "", ...(tail ? [tail] : [])].join("\n");
  }
  const decided = lines.findIndex((l) => /^## Decided/.test(l));
  if (decided >= 0) {
    return [...lines.slice(0, decided), ...section.split("\n").slice(0, -1), "", ...lines.slice(decided)].join("\n");
  }
  return `${text.replace(/\s*$/, "")}\n\n${section}`;
}

/** True when `content` is a real brief: some `## ` section besides Who's here. */
export function looksLikeBrief(content) {
  return String(content ?? "")
    .split("\n")
    .some((l) => /^## /.test(l) && l.trim() !== WHOS_HERE_HEADING);
}

/**
 * Refresh the brief on disk if it exists and the section changed. Returns { changed, body, path, skipped? }.
 * Skips (never writes) when the agent list is unknown (not an array) or the read came back empty or headless:
 * a reader racing a truncate-then-write sees 0 bytes, and writing Who's here into that wiped
 * docs/brainstorm/vibesquad.md to 80 bytes (2026-11-02). Writes go through writeBriefFile (backup + shrink guard).
 */
export function refreshWhosHere({ laneId, agents, rootDir }) {
  const path = join(briefRootFor("", laneId, rootDir), "docs", "brainstorm", `${laneId}.md`);
  if (!Array.isArray(agents)) return { changed: false, body: "", path, skipped: "agents-unknown" };
  const body = whosHereBody(agents, laneId);
  if (!existsSync(path)) return { changed: false, body, path };
  const before = readFileSync(path, "utf8");
  if (!looksLikeBrief(before)) return { changed: false, body, path, skipped: "not-a-brief" };
  const after = applyWhosHere(before, body);
  if (after === before) return { changed: false, body, path };
  writeBriefFile(path, laneId, after);
  return { changed: true, body, path };
}
