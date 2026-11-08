import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { appendVsLogEntry, isInstalledRuntime, NO_BRIEF_LINE } from "./brainstorm.mjs";
import { laneWorkingDir } from "./brief-path.mjs";
import { findLaneInRegistry } from "./identity.mjs";
import { resolveTeamsFilePath } from "./teams-file.mjs";
import { readJsonFileWithBom } from "./user-settings.mjs";

// One-time, idempotent cleanup of pin briefs saved under rootDir/docs/brainstorm before their lane was in
// teams.json (PLAN_PIN_BRIEF_HOME B3). Moves an orphan to its lane's project dir when nothing real is there; never overwrites.

const norm = (p) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));

const isPlaceholder = (file) => {
  try {
    const text = readFileSync(file, "utf8").trim();
    return text === "" || text === NO_BRIEF_LINE;
  } catch {
    return false;
  }
};

const squadsWithLane = (lane, rootDir) => {
  const res = readJsonFileWithBom(resolveTeamsFilePath(rootDir), { label: "teams.json", fallback: { teams: [] } });
  const teams = (res.data ?? { teams: [] }).teams ?? [];
  return teams.filter((t) => findLaneInRegistry(lane, [t])).length;
};

/** Copy (exclusive when the target is missing), then unlink the source only after the copy succeeded. */
function moveBrief(from, to) {
  if (existsSync(to)) {
    if (!isPlaceholder(to)) return false; // re-checked right before the write
    copyFileSync(from, to);
  } else {
    copyFileSync(from, to, constants.COPYFILE_EXCL);
  }
  unlinkSync(from);
  return true;
}

export function sweepBriefOrphans(rootDir, { log = appendVsLogEntry } = {}) {
  const result = { moved: 0, conflicts: 0, skipped: 0, failed: 0 };
  if (!isInstalledRuntime(rootDir)) return result;
  const orphanDir = join(rootDir, "docs", "brainstorm");
  let files = [];
  try {
    files = readdirSync(orphanDir).filter((f) => f.toLowerCase().endsWith(".md"));
  } catch {
    return result;
  }
  for (const f of files) {
    const lane = f.slice(0, -3);
    const from = join(orphanDir, f);
    try {
      const projectDir = laneWorkingDir("", lane, rootDir);
      if (!projectDir || norm(projectDir) === norm(rootDir) || isPlaceholder(from)) {
        result.skipped++;
        continue;
      }
      const destDir = join(projectDir, "docs", "brainstorm");
      const to = join(destDir, f);
      if (squadsWithLane(lane, rootDir) > 1) {
        result.conflicts++;
        log({ type: "metric", text: `brief-orphan-conflict lane=${lane} reason=ambiguous orphan=${from}`, laneId: lane });
        continue;
      }
      mkdirSync(destDir, { recursive: true });
      if (moveBrief(from, to)) {
        result.moved++;
      } else {
        result.conflicts++;
        log({ type: "metric", text: `brief-orphan-conflict lane=${lane} orphan=${from} project=${to}`, laneId: lane });
      }
    } catch {
      result.failed++;
    }
  }
  return result;
}

export function runBriefOrphanSweep(rootDir, opts = {}) {
  const log = opts.log ?? appendVsLogEntry;
  try {
    const r = sweepBriefOrphans(rootDir, { log });
    if (r.moved || r.conflicts || r.failed) log({ type: "metric", text: `brief-orphan-sweep moved=${r.moved} conflicts=${r.conflicts} skipped=${r.skipped} failed=${r.failed}` });
    return r;
  } catch (err) {
    try {
      log({ type: "metric", text: `brief-orphan-sweep failed: ${err?.message ?? err}` });
    } catch {}
    return null;
  }
}
