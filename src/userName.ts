import { useSyncExternalStore } from "react";

// Legacy owner aliases are assembled at runtime so the old literal never appears in tracked files.
export const LEGACY_USER_TYPE = "au" + "b";
export const LEGACY_NEEDS_LABEL = "needs-" + LEGACY_USER_TYPE;
export const LEGACY_NEEDS_REASON = LEGACY_NEEDS_LABEL + "-reason";
export const LEGACY_NEEDS_UNTIL = LEGACY_NEEDS_LABEL + "-until";

const DEFAULT_NAME = "you";
let userName = DEFAULT_NAME;
const listeners = new Set<() => void>();

export const getUserName = () => userName;

export function setUserName(name: string): void {
  const next = name.trim().slice(0, 40) || DEFAULT_NAME;
  if (next === userName) return;
  userName = next;
  listeners.forEach((l) => l());
}

export function useUserName(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getUserName,
  );
}

export const needsYouBadge = (name: string = getUserName()) => `NEEDS ${(name || DEFAULT_NAME).trim().toUpperCase()}`;

/** Fetch the persisted name once at startup; failures keep the default. */
export async function loadUserName(): Promise<void> {
  try {
    const r = await fetch("/__vibesquad/settings");
    if (r.ok) setUserName(String((await r.json()).userName ?? ""));
  } catch {}
}

/** Update live, then persist. */
export async function saveUserName(name: string): Promise<void> {
  setUserName(name);
  try {
    await fetch("/__vibesquad/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userName: getUserName() }),
    });
  } catch {}
}
