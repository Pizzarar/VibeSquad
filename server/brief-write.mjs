// Brief file writes with durability (docs/PLAN_SPAWN_HYGIENE.md block 6): every replace is backed up to
// <VIBESQUAD_HOME>/brief-history/<lane>/<ts>.md (newest 20 kept) and a big brief is never replaced by a near-empty one.
// Kept free of daemon imports so the Paseo plugin can use it too.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { newPinBrief } from "./pin-ideas.mjs";

export const BRIEF_HISTORY_KEEP = 20;
export const BRIEF_SHRINK_FROM = 1000;
export const BRIEF_SHRINK_TO = 300;
export const SEED_IDEA_MAX_CHARS = 2000;

// No fallback: an empty slug must never be routed to some other lane's file.
const slug = (v) =>
  String(v ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
const RESERVED_LANES = new Set(["unassigned", "unknown"]);

/** Copy the current brief to brief-history and keep the newest BRIEF_HISTORY_KEEP. */
export function backupBrief(laneId, fullPath) {
  if (!existsSync(fullPath)) return null;
  const dir = join(process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad"), "brief-history", slug(laneId) || "_unnamed");
  mkdirSync(dir, { recursive: true });
  let ts = new Date().toISOString().replace(/[:.]/g, "-");
  while (existsSync(join(dir, ts + ".md"))) ts += "x";
  const dest = join(dir, ts + ".md");
  writeFileSync(dest, readFileSync(fullPath));
  const old = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  for (const f of old.slice(0, Math.max(0, old.length - BRIEF_HISTORY_KEEP))) rmSync(join(dir, f), { force: true });
  return dest;
}

/** Guarded write of a brief file. Throws (old content kept) on a big-to-near-empty replace. */
export function writeBriefFile(fullPath, laneId, text) {
  mkdirSync(dirname(fullPath), { recursive: true });
  if (existsSync(fullPath)) {
    const before = readFileSync(fullPath);
    if (before.length > BRIEF_SHRINK_FROM && Buffer.byteLength(text) < BRIEF_SHRINK_TO) {
      backupBrief(laneId, fullPath);
      throw new Error(`Refusing to replace a ${before.length}-byte brief with ${Buffer.byteLength(text)} bytes (the old one is kept and backed up).`);
    }
    if (!before.equals(Buffer.from(text, "utf8"))) backupBrief(laneId, fullPath);
  }
  writeFileSync(fullPath, text, "utf8");
}

/**
 * A Buddy spawned for a lane whose brief file is missing: write the brief from the spawn's idea text so
 * it survives the first prompt. Never overwrites. Returns the path written, or null.
 */
export function seedBriefIfMissing({ root, lane, idea }) {
  const text = String(idea ?? "").trim().slice(0, SEED_IDEA_MAX_CHARS);
  const laneSlug = slug(lane);
  if (!text || !laneSlug || RESERVED_LANES.has(laneSlug.toLowerCase())) return null;
  const fullPath = join(root, "docs", "brainstorm", `${laneSlug}.md`);
  if (existsSync(fullPath)) return null;
  writeBriefFile(fullPath, laneSlug, newPinBrief(laneSlug, laneSlug, text));
  return fullPath;
}
