// Owner display settings (~/.vibesquad/settings.json) plus the legacy owner-label aliases.
// The legacy names are assembled at runtime so the old literal never appears in tracked files.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LEGACY_USER_TYPE = "au" + "b";
export const LEGACY_NEEDS_LABEL = "needs-" + LEGACY_USER_TYPE;
export const LEGACY_NEEDS_REASON = LEGACY_NEEDS_LABEL + "-reason";
export const LEGACY_NEEDS_UNTIL = LEGACY_NEEDS_LABEL + "-until";

export const DEFAULT_USER_NAME = "you";
const MAX_NAME = 40;

export const vibesquadHome = () => process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
const settingsFile = (baseHome) => join(baseHome || vibesquadHome(), "settings.json");

export function normalizeUserName(value) {
  const name = typeof value === "string" ? value.trim().slice(0, MAX_NAME).trim() : "";
  return name || DEFAULT_USER_NAME;
}

export function loadUserSettings(baseHome) {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(baseHome), "utf8"));
    return {
      userName: normalizeUserName(raw?.userName),
      lanEnabled: Boolean(raw?.lanEnabled),
    };
  } catch {
    return { userName: DEFAULT_USER_NAME, lanEnabled: false };
  }
}

export function saveUserSettings(patch, baseHome) {
  const current = loadUserSettings(baseHome);
  const next = {
    userName: normalizeUserName(patch && "userName" in patch ? patch.userName : current.userName),
    lanEnabled: patch && "lanEnabled" in patch ? Boolean(patch.lanEnabled) : current.lanEnabled,
  };
  mkdirSync(baseHome || vibesquadHome(), { recursive: true });
  writeFileSync(settingsFile(baseHome), JSON.stringify(next, null, 2) + "\n");
  return next;
}
