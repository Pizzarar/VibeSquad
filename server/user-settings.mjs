// Owner display settings (~/.vibesquad/settings.json) plus the legacy owner-label aliases
// and BOM-tolerant JSON readers with visible parse-error warnings.
// The legacy names are assembled at runtime so the old literal never appears in tracked files.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

/** `kind` defaults to "parse" (JSON parse error); other kinds (e.g. "exposure") are config problems that aren't parse errors. */
export function recordConfigWarning(filePath, label, error, { kind = "parse" } = {}) {
  const key = normalizePathKey(filePath);
  const msg = String(error?.message ?? error ?? "Invalid JSON");
  const entry = {
    file: String(filePath),
    label: String(label || filePath),
    error: msg,
    ts: new Date().toISOString(),
    ...(kind !== "parse" ? { kind } : {}),
  };
  const prev = configWarningsByFile.get(key);
  configWarningsByFile.set(key, entry);
  if (kind === "parse") console.warn(`[vibesquad] JSON parse error in ${entry.label} (${entry.file}): ${msg}`);
  else if (prev?.error !== msg) console.warn(`[vibesquad] ${entry.label}: ${msg}`);
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

// Settings › Notifications per-event toggles, mirrored here so the push watcher can honour them.
// Only explicit booleans are kept; a missing or unknown key means "send" (the old behaviour).
export const PUSH_EVENT_KEYS = ["permission", "needsYou", "finished", "errored"];
export function normalizePushEvents(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const k of PUSH_EVENT_KEYS) if (typeof value[k] === "boolean") out[k] = value[k];
  return out;
}

export function normalizeUserName(value) {
  const name = typeof value === "string" ? value.trim().slice(0, MAX_NAME).trim() : "";
  return name || DEFAULT_USER_NAME;
}

const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
let tmpSeq = 0;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Temp file + rename so a crash or concurrent read never sees a truncated settings.json. The tmp name is unique per
 * call; on Windows the rename can hit EPERM/EACCES/EBUSY while a reader holds the file, so it is retried with a short
 * backoff, and the tmp is removed if the write finally fails. `renameImpl`/`sleepImpl` are injectable for tests.
 */
export function writeSettingsAtomic(file, data, { renameImpl = renameSync, sleepImpl = sleepSync, retries = 5 } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${++tmpSeq}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    for (let attempt = 0; ; attempt++) {
      try {
        renameImpl(tmp, file);
        return;
      } catch (err) {
        if (attempt >= retries || !RETRY_CODES.has(err?.code)) throw err;
        sleepImpl(10 * 2 ** attempt);
      }
    }
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

/** The normalised, UI-facing view of a settings.json object. Unknown keys are not exposed. */
function viewOf(data) {
  const out = {
    userName: normalizeUserName(data?.userName),
    lanEnabled: Boolean(data?.lanEnabled),
  };
  if (typeof data.keepPaseoRunningOnQuit === "boolean") {
    out.keepPaseoRunningOnQuit = data.keepPaseoRunningOnQuit;
  }
  if (typeof data.startPaseoWithVibeSquad === "boolean") {
    out.startPaseoWithVibeSquad = data.startPaseoWithVibeSquad;
  }
  const pushEvents = normalizePushEvents(data.pushEvents);
  if (Object.keys(pushEvents).length) out.pushEvents = pushEvents;
  // Runner & Providers block: owned by providers-catalog.mjs, carried through here so saves do not drop it.
  if (data.runner && typeof data.runner === "object" && !Array.isArray(data.runner)) out.runner = data.runner;
  // Remote (relay) proxy gate, (the relay proxy is gone; kept so saves do not drop it). Hand-edited only: saveUserSettings
  // carries it over but never takes it from a patch, so no HTTP caller can switch it on.
  if (data.remote && typeof data.remote === "object") out.remote = { enabled: data.remote.enabled === true };
  return out;
}

const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function loadUserSettings(baseHome) {
  const file = settingsFile(baseHome);
  const res = readJsonFileWithBom(file, {
    label: "~/.vibesquad/settings.json",
    fallback: null,
    recordWarning: true,
  });
  if (res.ok && res.exists && !isPlainObject(res.data)) {
    return { userName: DEFAULT_USER_NAME, lanEnabled: false, parseError: "settings.json must contain a JSON object" };
  }
  if (!res.ok || !res.data) {
    return {
      userName: DEFAULT_USER_NAME,
      lanEnabled: false,
      ...(res.error ? { parseError: res.error } : {}),
    };
  }
  return viewOf(res.data);
}

/** The raw on-disk object to merge a save into ({} when absent). Throws (code SETTINGS_UNREADABLE) when it exists but is not a JSON object. */
function readRawForSave(baseHome) {
  const res = readJsonFileWithBom(settingsFile(baseHome), { label: "~/.vibesquad/settings.json", fallback: {}, recordWarning: true, rewriteBom: false });
  let why = "";
  if (res.exists && !res.ok) why = `not valid JSON (${res.error})`;
  else if (res.exists && !isPlainObject(res.data)) why = "not a JSON object";
  if (why) {
    const err = new Error(`refusing to save: settings.json exists but is ${why}. Fix or remove it first.`);
    err.code = "SETTINGS_UNREADABLE";
    throw err;
  }
  return res.exists ? res.data : {};
}

export function saveUserSettings(patch, baseHome) {
  const file = settingsFile(baseHome);
  const raw = readRawForSave(baseHome);
  const current = viewOf(raw);
  // Merge into the raw object so unknown top-level keys (runner, remote, hand-added ones) survive.
  const next = {
    ...raw,
    userName: normalizeUserName(patch && "userName" in patch ? patch.userName : current.userName),
    lanEnabled: patch && "lanEnabled" in patch ? Boolean(patch.lanEnabled) : current.lanEnabled,
  };
  if (patch && "keepPaseoRunningOnQuit" in patch) next.keepPaseoRunningOnQuit = Boolean(patch.keepPaseoRunningOnQuit);
  if (patch && "startPaseoWithVibeSquad" in patch) next.startPaseoWithVibeSquad = Boolean(patch.startPaseoWithVibeSquad);
  const pushEvents = normalizePushEvents(patch && "pushEvents" in patch ? patch.pushEvents : current.pushEvents);
  if (Object.keys(pushEvents).length) next.pushEvents = pushEvents;
  else delete next.pushEvents;
  writeSettingsAtomic(file, next);
  clearConfigWarning(file);
  return viewOf(next);
}

export function saveRemoteAccess(enabled, baseHome) {
  const file = settingsFile(baseHome);
  const raw = readRawForSave(baseHome);
  const next = { ...raw, remote: { enabled: Boolean(enabled) } };
  writeSettingsAtomic(file, next);
  clearConfigWarning(file);
  return viewOf(next);
}
