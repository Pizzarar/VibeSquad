import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendVsLogEntry } from "./brainstorm.mjs";

/** Appends `metric server-start` (pid, version, reason) to the team log so lag reports can be matched to restarts. */
export function logServerStart({ rootDir, env = process.env, pid = process.pid } = {}) {
  try {
    let version = "unknown";
    try {
      version = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")).version || version;
    } catch {}
    const reason = String(env.VIBESQUAD_START_REASON || "").trim();
    const text = `server-start: pid=${pid} version=${version}${reason ? ` reason=${reason}` : ""}`;
    return appendVsLogEntry({ teamId: env.VIBESQUAD_TEAM || "vibesquad", agent: "server", type: "metric", text });
  } catch {
    return null; // never block boot on logging
  }
}
