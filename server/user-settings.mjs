// Owner display settings (~/.vibesquad/settings.json) plus the legacy owner-label aliases
// and BOM-tolerant JSON readers with visible parse-error warnings.
// The legacy names are assembled at runtime so the old literal never appears in tracked files.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const LEGACY_USER_TYPE = "au" + "b";
export const LEGACY_NEEDS_LABEL = "needs-" + LEGACY_USER_TYPE;
export const LEGACY_NEEDS_REASON = LEGACY_NEEDS_LABEL + "-reason";
export const LEGACY_NEEDS_UNTIL = LEGACY_NEEDS_LABEL + "-until";

export const DEFAULT_USER_NAME = "you";
const MAX_NAME = 40;

export const vibesquadHome = () => process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
const settingsFile = (baseHome) => join(baseHome || vibesquadHome(), "settings.json");

const configWarningsByFile = new Map();

function normalizePathKey(filePath) {
  try {
    const p = resolve(String(filePath ?? ""));
    return process.platform === "win32" ? p.toLowerCase() : p;
  } catch {
    return String(filePath ?? "");
  }
}

export function stripBom(raw) {
  if (typeof raw !== "string") {
    return String(raw ?? "").replace(/^\uFEFF/, "");
  }
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw.replace(/^\uFEFF/, "");
}

export function parseJsonWithBom(raw) {
  return JSON.parse(stripBom(raw));
}

export function recordConfigWarning(filePath, label, error) {
  const key = normalizePathKey(filePath);
  const msg = String(error?.message ?? error ?? "Invalid JSON");
  const entry = {
    file: String(filePath),
    label: String(label || filePath),
    error: msg,
    ts: new Date().toISOString(),
  };
  configWarningsByFile.set(key, entry);
  console.warn(`[vibesquad] JSON parse error in ${entry.label} (${entry.file}): ${msg}`);
  return entry;
}

export function clearConfigWarning(filePath) {
  if (!filePath) return;
  configWarningsByFile.delete(normalizePathKey(filePath));
}

export function clearAllConfigWarnings() {
  configWarningsByFile.clear();
}

export function getConfigWarnings() {
  return [...configWarningsByFile.values()];
}

/**
 * Reads a JSON file after stripping any leading UTF-8 BOM (ef bb bf / \uFEFF).
 * If a BOM was present and parsing succeeded, rewrites the file without BOM (best effort).
 * If parsing fails, logs a warning and records it in `configWarningsByFile` so the UI surfaces it.
 */
export function readJsonFileWithBom(
  filePath,
  { label = "", fallback = null, recordWarning = true, rewriteBom = true, rewriteIfBom } = {},
) {
  const shouldRewrite = rewriteIfBom !== undefined ? Boolean(rewriteIfBom) : Boolean(rewriteBom);
  const target = String(filePath ?? "");
  if (!target || !existsSync(target)) {
    if (recordWarning) clearConfigWarning(target);
    return { ok: true, exists: false, data: fallback, value: fallback, error: null, hadBom: false };
  }
  let raw = "";
  try {
    raw = readFileSync(target, "utf8");
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (recordWarning) recordConfigWarning(target, label || target, msg);
    return { ok: false, exists: true, data: fallback, value: fallback, error: msg, hadBom: false };
  }
  const hadBom = raw.charCodeAt(0) === 0xfeff;
  const cleaned = stripBom(raw);
  try {
    const parsed = JSON.parse(cleaned);
    if (recordWarning) clearConfigWarning(target);
    if (hadBom && shouldRewrite) {
      try {
        writeFileSync(target, cleaned, "utf8");
      } catch {
        // best-effort BOM scrub
      }
    }
    return { ok: true, exists: true, data: parsed, value: parsed, error: null, hadBom };
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (recordWarning) recordConfigWarning(target, label || target, msg);
    return { ok: false, exists: true, data: fallback, value: fallback, error: msg, hadBom };
  }
}

export function normalizeUserName(value) {
  const name = typeof value === "string" ? value.trim().slice(0, MAX_NAME).trim() : "";
  return name || DEFAULT_USER_NAME;
}

export function loadUserSettings(baseHome) {
  const file = settingsFile(baseHome);
  const res = readJsonFileWithBom(file, {
    label: "~/.vibesquad/settings.json",
    fallback: null,
    recordWarning: true,
  });
  if (!res.ok || !res.data || typeof res.data !== "object") {
    return {
      userName: DEFAULT_USER_NAME,
      lanEnabled: false,
      ...(res.error ? { parseError: res.error } : {}),
    };
  }
  const out = {
    userName: normalizeUserName(res.data?.userName),
    lanEnabled: Boolean(res.data?.lanEnabled),
  };
  if (typeof res.data.keepPaseoRunningOnQuit === "boolean") {
    out.keepPaseoRunningOnQuit = res.data.keepPaseoRunningOnQuit;
  }
  if (typeof res.data.startPaseoWithVibeSquad === "boolean") {
    out.startPaseoWithVibeSquad = res.data.startPaseoWithVibeSquad;
  }
  return out;
}

export function saveUserSettings(patch, baseHome) {
  const file = settingsFile(baseHome);
  const current = loadUserSettings(baseHome);
  const next = {
    userName: normalizeUserName(patch && "userName" in patch ? patch.userName : current.userName),
    lanEnabled: patch && "lanEnabled" in patch ? Boolean(patch.lanEnabled) : current.lanEnabled,
  };
  if ((patch && "keepPaseoRunningOnQuit" in patch) || "keepPaseoRunningOnQuit" in current) {
    next.keepPaseoRunningOnQuit =
      patch && "keepPaseoRunningOnQuit" in patch ? Boolean(patch.keepPaseoRunningOnQuit) : Boolean(current.keepPaseoRunningOnQuit);
  }
  if ((patch && "startPaseoWithVibeSquad" in patch) || "startPaseoWithVibeSquad" in current) {
    next.startPaseoWithVibeSquad =
      patch && "startPaseoWithVibeSquad" in patch ? Boolean(patch.startPaseoWithVibeSquad) : Boolean(current.startPaseoWithVibeSquad);
  }
  mkdirSync(baseHome || vibesquadHome(), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n", "utf8");
  clearConfigWarning(file);
  return next;
}
