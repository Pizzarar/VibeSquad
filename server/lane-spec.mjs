import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { briefRootFor } from "./brief-path.mjs";
import { writeFileAtomic } from "./brief-write.mjs";
import { updateJsonFileSync, withFileLockSync } from "./file-lock.mjs";
import { readJsonFileWithBom } from "./user-settings.mjs";

// Durable per-lane source of truth (docs/lanes/<lane>/SPEC.md + TASKS.json) that survives
// restarts and provider switches, replacing fragile chat-history handoffs. Shared by the
// server (renders the artifact block into prompts) and the CLI (vs spec / vs task / vs cap).

const UNIT_STATUSES = new Set(["todo", "running", "done", "blocked"]);

function safeLaneId(laneId) {
  return String(laneId || "vibesquad").trim().replace(/[^A-Za-z0-9_-]+/g, "-") || "vibesquad";
}

function artifactDir(teamId, laneId, rootDir) {
  const safeLane = safeLaneId(laneId);
  return join(briefRootFor(teamId, safeLane, rootDir), "docs", "lanes", safeLane);
}

/**
 * Folder holding a lane's durable SPEC.md + TASKS.json artifacts. Safe-slugs the lane id and
 * resolves the lane's project dir (or rootDir in dev, when no project dir resolves).
 */
export function laneArtifactDir(teamId, laneId, rootDir) {
  const safeLane = safeLaneId(laneId);
  return join(briefRootFor(teamId, safeLane, rootDir), "docs", "lanes", safeLane);
}

/** Reads docs/lanes/<lane>/SPEC.md. Never throws: a missing or unreadable file yields exists: false. */
export function readLaneSpec(teamId, laneId, rootDir) {
  const safeLane = safeLaneId(laneId);
  const fullPath = join(artifactDir(teamId, laneId, rootDir), "SPEC.md");
  const exists = existsSync(fullPath);
  let content = "";
  if (exists) {
    try {
      content = readFileSync(fullPath, "utf8");
    } catch {
      content = "";
    }
  }
  return { laneId: safeLane, path: `docs/lanes/${safeLane}/SPEC.md`, fullPath, exists, content };
}

/** Writes docs/lanes/<lane>/SPEC.md (UTF-8, no BOM), creating the folder as needed. */
export function writeLaneSpec(teamId, laneId, content, rootDir) {
  const safeLane = safeLaneId(laneId);
  const dir = artifactDir(teamId, laneId, rootDir);
  mkdirSync(dir, { recursive: true });
  const fullPath = join(dir, "SPEC.md");
  const text = String(content ?? "");
  withFileLockSync(fullPath, () => writeFileAtomic(fullPath, text));
  return { laneId: safeLane, path: `docs/lanes/${safeLane}/SPEC.md`, fullPath, bytes: Buffer.byteLength(text, "utf8") };
}

/**
 * Reads docs/lanes/<lane>/TASKS.json. A missing or malformed file yields an empty units list
 * rather than throwing, so callers can treat it as a fresh board.
 */
export function readLaneTasks(teamId, laneId, rootDir) {
  const safeLane = safeLaneId(laneId);
  const fullPath = join(artifactDir(teamId, laneId, rootDir), "TASKS.json");
  const exists = existsSync(fullPath);
  let units = [];
  let updatedAt = "";
  let unreadable = false;
  if (exists) {
    const res = readJsonFileWithBom(fullPath, { label: "TASKS.json", fallback: null });
    if (res.ok && res.data && typeof res.data === "object" && Array.isArray(res.data.units)) {
      units = res.data.units;
      updatedAt = typeof res.data.updatedAt === "string" ? res.data.updatedAt : "";
    } else {
      unreadable = true;
    }
  }
  return { laneId: safeLane, path: `docs/lanes/${safeLane}/TASKS.json`, fullPath, exists, units, updatedAt, unreadable };
}

/** Merges or appends one unit, writes TASKS.json (2-space indent), and returns the unit + full list. */
export function upsertLaneTask(teamId, laneId, unitPatch, rootDir) {
  const safeLane = safeLaneId(laneId);
  const id = String(unitPatch?.id ?? "").trim();
  if (!id) throw new Error("task set needs a unit id");

  const dir = artifactDir(teamId, laneId, rootDir);
  mkdirSync(dir, { recursive: true });
  const fullPath = join(dir, "TASKS.json");

  let merged;
  let units;
  // Locked read-modify-write: server and CLI both upsert, so an unlocked one loses units. A corrupt file throws.
  updateJsonFileSync(
    fullPath,
    (data) => {
      units = Array.isArray(data?.units) ? data.units.slice() : [];
      const idx = units.findIndex((u) => String(u?.id) === id);
      const existing = idx >= 0 ? units[idx] : null;

      const has = (key) => unitPatch && Object.prototype.hasOwnProperty.call(unitPatch, key) && unitPatch[key] !== undefined;
      const val = (key, fallback) => (has(key) ? unitPatch[key] : fallback);

      merged = { id };
      if (has("title") && String(unitPatch.title)) merged.title = String(unitPatch.title);
      else if (existing?.title) merged.title = existing.title;
      merged.goal = String(val("goal", existing?.goal ?? "") ?? "");
      merged.files = Array.isArray(val("files", existing?.files ?? [])) ? val("files", existing?.files ?? []).map(String) : [];
      merged.doneCheck = String(val("doneCheck", existing?.doneCheck ?? "") ?? "");
      const status = String(val("status", existing?.status ?? "todo"));
      merged.status = UNIT_STATUSES.has(status) ? status : "todo";
      if (has("dependsOn")) merged.dependsOn = Array.isArray(unitPatch.dependsOn) ? unitPatch.dependsOn.map(String) : [];
      else if (existing?.dependsOn !== undefined) merged.dependsOn = existing.dependsOn;
      for (const opt of ["branch", "worktreePath", "commit", "agentId"]) {
        const v = val(opt, existing?.[opt]);
        if (v !== undefined && v !== "") merged[opt] = String(v);
      }

      if (idx >= 0) units[idx] = merged;
      else units.push(merged);

      return { laneId: safeLane, updatedAt: new Date().toISOString(), units };
    },
    { fallback: {} },
  );

  return { unit: merged, units };
}

/**
 * Compact, deterministic lane-artifact block for prompts. Returns "" when neither SPEC.md nor
 * TASKS.json exists yet (so it never injects an empty section).
 */
export function renderLaneArtifactBlock(teamId, laneId, rootDir) {
  const safeLane = safeLaneId(laneId);
  const spec = readLaneSpec(teamId, laneId, rootDir);
  const tasks = readLaneTasks(teamId, laneId, rootDir);
  if (!spec.exists && !tasks.exists) return "";

  const lines = [];
  lines.push(`<!-- vibesquad:lane-artifact:begin lane=${safeLane} -->`);
  lines.push(`Lane Artifact (\`docs/lanes/${safeLane}/\` — durable source of truth across restarts & provider switches):`);
  lines.push(`[SPEC.md]`);
  lines.push(spec.exists ? spec.content : "(none)");
  lines.push(`[TASKS.json]`);
  const open = tasks.units.filter((u) => String(u?.status ?? "").trim().toLowerCase() !== "done");
  const doneCount = tasks.units.length - open.length;
  if (tasks.unreadable) {
    lines.push(`TASKS.json unreadable (see docs/lanes/${safeLane}/TASKS.json)`);
  } else if (!open.length) {
    lines.push("(none)");
  } else {
    for (const u of open) {
      const files = Array.isArray(u.files) ? u.files.map(String).join(", ") : "";
      lines.push(`- ${u.id} [${u.status}] goal="${u.goal ?? ""}" files=[${files}] doneCheck="${u.doneCheck ?? ""}"`);
    }
  }
  if (doneCount > 0) lines.push(`${doneCount} done units (full list: docs/lanes/${safeLane}/TASKS.json)`);
  lines.push(`<!-- vibesquad:lane-artifact:end -->`);
  return lines.join("\n");
}
