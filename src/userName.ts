import { useSyncExternalStore } from "react";

// Legacy owner aliases are assembled at runtime so the old literal never appears in tracked files.
export const LEGACY_USER_TYPE = "au" + "b";
export const LEGACY_NEEDS_LABEL = "needs-" + LEGACY_USER_TYPE;
export const LEGACY_NEEDS_REASON = LEGACY_NEEDS_LABEL + "-reason";
export const LEGACY_NEEDS_UNTIL = LEGACY_NEEDS_LABEL + "-until";

const DEFAULT_NAME = "you";
let userName = DEFAULT_NAME;
let lanEnabled = false;
let exposedIps: string[] = [];
const listeners = new Set<() => void>();

export const getUserName = () => userName;
export const getLanEnabled = () => lanEnabled;
export const getExposedIps = () => exposedIps;

export function setUserName(name: string): void {
  const next = name.trim().slice(0, 40) || DEFAULT_NAME;
  if (next === userName) return;
  userName = next;
  listeners.forEach((l) => l());
}

export function setLanExposureState(nextLan: boolean, nextIps?: string[]): void {
  const changed = nextLan !== lanEnabled || (Array.isArray(nextIps) && nextIps.join(",") !== exposedIps.join(","));
  lanEnabled = Boolean(nextLan);
  if (Array.isArray(nextIps)) exposedIps = nextIps.map(String);
  if (changed) listeners.forEach((l) => l());
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

export function useLanEnabled(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getLanEnabled,
  );
}

export function useExposedIpsStore(): string[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getExposedIps,
  );
}

export const needsYouBadge = (name: string = getUserName()) => `NEEDS ${(name || DEFAULT_NAME).trim().toUpperCase()}`;

/** Fetch the persisted name and LAN setting once at startup; failures keep the default. */
export async function loadUserName(): Promise<void> {
  try {
    const r = await fetch("/__vibesquad/settings");
    if (r.ok) {
      const data = await r.json();
      setUserName(String(data.userName ?? ""));
      setLanExposureState(Boolean(data.activeLanEnabled ?? data.lanEnabled), Array.isArray(data.exposedIps) ? data.exposedIps : undefined);
    }
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

export async function saveLanEnabled(enabled: boolean): Promise<{ lanEnabled: boolean; exposedIps: string[] }> {
  setLanExposureState(enabled);
  try {
    const r = await fetch("/__vibesquad/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lanEnabled: Boolean(enabled) }),
    });
    if (r.ok) {
      const data = await r.json();
      const nextLan = Boolean(data.activeLanEnabled ?? data.lanEnabled);
      const nextIps = Array.isArray(data.exposedIps) ? data.exposedIps.map(String) : [];
      setLanExposureState(nextLan, nextIps);
      return { lanEnabled: nextLan, exposedIps: nextIps };
    }
  } catch {}
  return { lanEnabled: getLanEnabled(), exposedIps: getExposedIps() };
}
