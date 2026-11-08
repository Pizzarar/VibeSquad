import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, copyFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { appendVsLogEntry, NO_BRIEF_LINE } from "./brainstorm.mjs";
import { laneWorkingDir } from "./brief-path.mjs";

// One-time, idempotent cleanup of pin briefs saved under rootDir/docs/brainstorm before their lane was in
// teams.json (PLAN_PIN_BRIEF_HOME B3). Moves an orphan to its lane's project dir when nothing real is there; never overwrites.

const norm = (p) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));

function moveFile(from, to) {
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

const isPlaceholder = (file) => {
  try {
    const text = readFileSync(file, "utf8").trim();
    return text === "" || text === NO_BRIEF_LINE;
  } catch {
    return false;
  }
};

export function sweepBriefOrphans(rootDir, { log = appendVsLogEntry } = {}) {
  const result = { moved: 0, conflicts: 0, skipped: 0 };
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
    const projectDir = laneWorkingDir("", lane, rootDir);
    if (!projectDir || norm(projectDir) === norm(rootDir)) {
      result.skipped++;
      continue;
    }
    const destDir = join(projectDir, "docs", "brainstorm");
    const to = join(destDir, f);
    if (!existsSync(to) || isPlaceholder(to)) {
      mkdirSync(destDir, { recursive: true });
      moveFile(from, to);
      result.moved++;
    } else {
      result.conflicts++;
      log({ type: "metric", text: `brief-orphan-conflict lane=${lane} orphan=${from} project=${to}`, laneId: lane });
    }
  }
  return result;
}

/** Server-start entry point: never throws. */
export function runBriefOrphanSweep(rootDir, opts = {}) {
  const log = opts.log ?? appendVsLogEntry;
  try {
    const r = sweepBriefOrphans(rootDir, { log });
    if (r.moved || r.conflicts) log({ type: "metric", text: `brief-orphan-sweep moved=${r.moved} conflicts=${r.conflicts} skipped=${r.skipped}` });
    return r;
  } catch (err) {
    try {
      log({ type: "metric", text: `brief-orphan-sweep failed: ${err?.message ?? err}` });
    } catch {}
    return null;
  }
}
