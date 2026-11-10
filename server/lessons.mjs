// Durable engineering/workflow lessons store (~/.vibesquad/lessons.jsonl by default).
// Lessons are logged one per JSONL line (UTF-8, no BOM), read newest-first, and can be
// searched by `category` or a case-insensitive `query` across the lesson's text fields.
//
// The canonical human-readable catalog lives in docs/LESSONS.md. This module is the
// machine-readable counterpart: appendLesson / readLessons / renderLessonsDigest.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const LESSONS_BEGIN = "<!-- vibesquad:lessons:begin -->";
export const LESSONS_END = "<!-- vibesquad:lessons:end -->";

export const vibesquadHome = () =>
  resolve(process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad"));

/**
 * Where lessons are persisted. With an explicit `rootDir` (as in tests and repo-scoped use)
 * it resolves to `<rootDir>/docs/LESSONS.jsonl`; otherwise it lives in the VibeSquad home
 * directory as `lessons.jsonl` so it survives repo moves and restarts.
 */
export function resolveLessonsStorePath(rootDir) {
  if (rootDir) {
    return join(resolve(String(rootDir)), "docs", "LESSONS.jsonl");
  }
  return join(vibesquadHome(), "lessons.jsonl");
}

function pickStore({ storePath, rootDir } = {}) {
  if (storePath) return resolve(String(storePath));
  return resolveLessonsStorePath(rootDir);
}

/** Strips a leading UTF-8 BOM (ef bb bf / \uFEFF) from a string or buffer content. */
export function stripBom(raw) {
  const s = typeof raw === "string" ? raw : String(raw ?? "");
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s.replace(/^\uFEFF/, "");
}

const REQUIRED_FIELDS = ["category", "title", "cause", "rule"];

function asStringArray(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`lesson.${field} must be an array of strings`);
  }
  return value.map((v) => {
    if (typeof v !== "string") throw new Error(`lesson.${field} entries must be strings`);
    return v.trim();
  }).filter(Boolean);
}

/**
 * Validates and normalizes a lesson entry. Throws on a missing/invalid required field so a
 * malformed lesson never reaches the store. Returns the normalized, persisted shape.
 */
export function normalizeLesson(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("lesson must be an object");
  }
  for (const field of REQUIRED_FIELDS) {
    const value = entry[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`lesson.${field} is required`);
    }
  }
  const id = entry.id == null ? randomUUID() : String(entry.id).trim();
  if (!id) throw new Error("lesson.id must be a non-empty string");
  const createdAt = entry.createdAt == null ? new Date().toISOString() : String(entry.createdAt).trim();
  if (!createdAt) throw new Error("lesson.createdAt must be a non-empty string");

  const normalized = {
    id,
    category: String(entry.category).trim(),
    title: String(entry.title).trim(),
    cause: String(entry.cause).trim(),
    rule: String(entry.rule).trim(),
    createdAt,
  };
  const refs = asStringArray(entry.refs, "refs");
  if (refs.length) normalized.refs = refs;
  const tags = asStringArray(entry.tags, "tags");
  if (tags.length) normalized.tags = tags;
  return normalized;
}

/**
 * Appends a lesson to the JSONL store (UTF-8, no BOM) and returns the saved entry.
 * `entry` shape: { id?, category, title, cause, rule, refs?, tags?, createdAt? }.
 */
export function appendLesson(entry, { storePath, rootDir } = {}) {
  const saved = normalizeLesson(entry);
  const store = pickStore({ storePath, rootDir });
  mkdirSync(dirname(store), { recursive: true });
  appendFileSync(store, JSON.stringify(saved) + "\n", "utf8");
  return saved;
}

function readRawLines(store) {
  if (!store || !existsSync(store)) return [];
  const raw = stripBom(readFileSync(store, "utf8"));
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function parseLessonLine(line) {
  try {
    return JSON.parse(stripBom(line));
  } catch {
    return null;
  }
}

function matchesCategory(entry, category) {
  if (category == null || category === "") return true;
  return String(entry.category || "").toLowerCase() === String(category).trim().toLowerCase();
}

function matchesQuery(entry, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  const haystacks = [entry.category, entry.title, entry.cause, entry.rule]
    .concat(Array.isArray(entry.refs) ? entry.refs : [])
    .concat(Array.isArray(entry.tags) ? entry.tags : []);
  return haystacks.some((s) => String(s ?? "").toLowerCase().includes(q));
}

const byTime = (x) => {
  const t = Date.parse(x.entry?.createdAt);
  return Number.isFinite(t) ? t : 0;
};

/**
 * Reads lessons newest-first, optionally filtered by `category` (exact, case-insensitive) or
 * a case-insensitive `query` substring matched across category/title/cause/rule/refs/tags.
 * `limit` caps the returned count (default 50).
 */
export function readLessons({ category, query, limit = 50, storePath, rootDir } = {}) {
  const store = pickStore({ storePath, rootDir });
  const lines = readRawLines(store).map((line, index) => ({ line, index }));
  const parsed = [];
  for (const { line, index } of lines) {
    const entry = parseLessonLine(line);
    if (entry) parsed.push({ entry, index });
  }
  const filtered = parsed.filter(
    (x) => matchesCategory(x.entry, category) && matchesQuery(x.entry, query),
  );
  const cap = typeof limit === "number" && Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : 50;
  filtered.sort((a, b) => byTime(b) - byTime(a) || b.index - a.index);
  return filtered.slice(0, cap).map((x) => x.entry);
}

// Core standing rules, kept short so the digest stays cheap on prompt tokens. These mirror the
// top rules of docs/LESSONS.md and are injected verbatim; the detailed symptom/cause/evidence
// lives in the catalog, not in the prompt.
export const STANDING_RULES = [
  "Find the lead with `vs who lead` (labels role/lane/ord), never agent-list JSON scraping or title-prefix regex.",
  "Run unit work in `%LOCALAPPDATA%\\VibeSquad\\worktrees\\<repo>\\<unit>`; never `git worktree add ../<repo>-<unit>` into `projects/`.",
  "Write JSON with node `fs.writeFileSync(..., 'utf8')`, never PowerShell `Set-Content`/`Out-File` (UTF-8 BOM breaks parsers).",
  "Never end a turn on a background task with nothing armed: leads/Buddies arm `vs watch add ...`; workers use `vs wait <id> --timeout <s>`.",
  "Route by Role + Tier with automatic provider failover (Claude -> Gemini -> DeepSeek); never pin every profile to one provider.",
  "Detach live children before archiving a Paseo-backed agent (Paseo cascades archives to its children; the runner has no such cascade, so this applies only to Paseo-backed lanes).",
  "Treat durable lane artifacts (`docs/lanes/<lane>/SPEC.md` + `docs/brainstorm/<lane>.md`) as the source of truth, not chat history.",
  "Every master merge commit carries Live-Needs: none|frontend-reload|build|server-restart|runner-restart; sync-runtime reads it.",
];

/**
 * Returns a compact `<!-- vibesquad:lessons:begin --> ... <!-- vibesquad:lessons:end -->` block
 * for prompt injection: the standing rules plus the most recent logged lessons (up to `limit`).
 */
export function renderLessonsDigest({ limit = 10, storePath, rootDir } = {}) {
  const recent = readLessons({ limit, storePath, rootDir });
  const rules = STANDING_RULES.map((r) => `- ${r}`);
  const lessonLines = recent.map((l) => {
    const tag = `[${l.category}]`;
    const title = l.title;
    return `- ${tag} ${title} — ${l.rule}`;
  });
  const body = [
    "## VibeSquad standing rules",
    ...rules,
    "",
    "## Recent lessons",
    ...(lessonLines.length ? lessonLines : ["- (none logged yet)"]),
  ].join("\n");
  return `${LESSONS_BEGIN}\n${body}\n${LESSONS_END}`;
}
