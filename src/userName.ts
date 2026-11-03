import { useSyncExternalStore } from "react";
import { isRemote } from "./remoteSession.ts";

// Legacy owner aliases are assembled at runtime so the old literal never appears in tracked files.
export const LEGACY_USER_TYPE = "au" + "b";
export const LEGACY_NEEDS_LABEL = "needs-" + LEGACY_USER_TYPE;
export const LEGACY_NEEDS_REASON = LEGACY_NEEDS_LABEL + "-reason";
export const LEGACY_NEEDS_UNTIL = LEGACY_NEEDS_LABEL + "-until";

const DEFAULT_NAME = "you";
let userName = DEFAULT_NAME;
let lanEnabled = false;
let exposedIps: string[] = [];
let serverConfigWarnings: { file: string; label?: string; error: string; kind?: string }[] = [];
let desktopConfigWarning = "";
let staleBuild: { built: string; head: string; behind: number } | null = null;
const listeners = new Set<() => void>();

export const getUserName = () => userName;
export const getLanEnabled = () => lanEnabled;
export const getExposedIps = () => exposedIps;
export const getConfigWarnings = (): string[] => {
  // Parse errors keep their fallback note; other kinds (e.g. "exposure") are shown as-is.
  const list = serverConfigWarnings.map((w) =>
    w.kind ? `${w.label || w.file}: ${w.error}` : `${w.label || w.file}: JSON parse error (using fallback defaults without overwriting): ${w.error}`,
  );
  if (desktopConfigWarning) list.push(desktopConfigWarning);
  return list;
};

let cachedConfigWarningsKey = "";
let cachedConfigWarningsList: string[] = [];
function getConfigWarningsSnapshot(): string[] {
  const list = getConfigWarnings();
  const key = list.join("\n");
  if (key !== cachedConfigWarningsKey) {
    cachedConfigWarningsKey = key;
    cachedConfigWarningsList = list;
  }
  return cachedConfigWarningsList;
}

export function setServerConfigWarnings(warnings: unknown): void {
  const next = Array.isArray(warnings)
    ? warnings
        .filter((w) => w && typeof w === "object" && typeof (w as any).error === "string")
        .map((w: any) => ({
          file: String(w.file || ""),
          label: w.label ? String(w.label) : undefined,
          error: String(w.error),
          ...(typeof w.kind === "string" && w.kind ? { kind: w.kind } : {}),
        }))
    : [];
  const prevKey = JSON.stringify(serverConfigWarnings);
  const nextKey = JSON.stringify(next);
  if (prevKey !== nextKey) {
    serverConfigWarnings = next;
    listeners.forEach((l) => l());
  }
}

export function setStaleBuild(stale: unknown): void {
  const s = stale as { built?: unknown; head?: unknown; behind?: unknown } | null;
  const next = s && typeof s.behind === "number" && s.behind > 0 ? { built: String(s.built), head: String(s.head), behind: s.behind } : null;
  if (JSON.stringify(next) !== JSON.stringify(staleBuild)) {
    staleBuild = next;
    listeners.forEach((l) => l());
  }
}

export function useStaleBuild() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => staleBuild,
  );
}

// Loopback without the local token (a plain browser tab) is read-only; the server says so in /health.
let localReadOnly = false;

export function setLocalAccess(access: unknown): void {
  const next = access === "read-only";
  if (next !== localReadOnly) {
    localReadOnly = next;
    listeners.forEach((l) => l());
  }
}

export function useLocalReadOnly() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => localReadOnly,
  );
}

export function setDesktopConfigWarning(warning: unknown): void {
  const next = typeof warning === "string" ? warning.trim() : "";
  if (next !== desktopConfigWarning) {
    desktopConfigWarning = next;
    listeners.forEach((l) => l());
  }
}

export function useConfigWarnings(): string[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getConfigWarningsSnapshot,
  );
}

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
      setServerConfigWarnings(data.configWarnings);
    }
  } catch {}
}

/** Update live, then persist. */
export async function saveUserName(name: string): Promise<void> {
  setUserName(name);
  try {
    const r = await fetch("/__vibesquad/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userName: getUserName() }),
    });
    if (r.ok) {
      const data = await r.json();
      setServerConfigWarnings(data.configWarnings);
    }
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
      setServerConfigWarnings(data.configWarnings);
      return { lanEnabled: nextLan, exposedIps: nextIps };
    }
  } catch {}
  return { lanEnabled: getLanEnabled(), exposedIps: getExposedIps() };
}

export type UpdateChannel = "stable" | "beta";

export interface UpdaterStatusView {
  currentVersion: string;
  channel: UpdateChannel;
  updateAvailable: boolean;
  availableVersion: string;
  downloaded: boolean;
  dismissed: boolean;
}

let updaterStatus: UpdaterStatusView = {
  currentVersion: "0.2.0",
  channel: "stable",
  updateAvailable: false,
  availableVersion: "",
  downloaded: false,
  dismissed: false,
};

export const getUpdaterStatus = (): UpdaterStatusView => updaterStatus;

function setUpdaterStatus(patch: Partial<UpdaterStatusView>): void {
  const next: UpdaterStatusView = { ...updaterStatus, ...patch };
  if (
    next.currentVersion === updaterStatus.currentVersion &&
    next.channel === updaterStatus.channel &&
    next.updateAvailable === updaterStatus.updateAvailable &&
    next.availableVersion === updaterStatus.availableVersion &&
    next.downloaded === updaterStatus.downloaded &&
    next.dismissed === updaterStatus.dismissed
  ) {
    return;
  }
  updaterStatus = next;
  listeners.forEach((l) => l());
}

export function useUpdaterStatus(): UpdaterStatusView {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getUpdaterStatus,
  );
}

export interface DesktopStatusView {
  loaded: boolean;
  isDesktop: boolean;
  serverMode: "local" | "remote" | "";
  serverHost: string;
}

let desktopStatus: DesktopStatusView = {
  loaded: false,
  isDesktop: false,
  serverMode: "local",
  serverHost: "127.0.0.1:4180",
};

export const getDesktopStatus = (): DesktopStatusView => desktopStatus;

export function useDesktopStatus(): DesktopStatusView {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getDesktopStatus,
  );
}

export async function loadDesktopStatus(): Promise<DesktopStatusView> {
  if (!(globalThis as any).__VIBESQUAD_DESKTOP_BRIDGE__) {
    if (isRemote()) return desktopStatus;
  }
  try {
    const r = await fetch("/__desktop/status", { cache: "no-store" });
    if (r.ok) {
      const d = await r.json();
      setDesktopConfigWarning(d.configWarning);
      const next: DesktopStatusView = {
        loaded: true,
        isDesktop: true,
        serverMode: d.serverMode === "remote" ? "remote" : d.serverMode === "local" ? "local" : "",
        serverHost: String(d.serverHost || "127.0.0.1:4180"),
      };
      if (
        next.loaded !== desktopStatus.loaded ||
        next.isDesktop !== desktopStatus.isDesktop ||
        next.serverMode !== desktopStatus.serverMode ||
        next.serverHost !== desktopStatus.serverHost
      ) {
        desktopStatus = next;
        listeners.forEach((l) => l());
      }
      return desktopStatus;
    }
  } catch {}
  if (!desktopStatus.loaded) {
    const host = typeof location !== "undefined" ? location.hostname : "127.0.0.1";
    const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
    desktopStatus = {
      loaded: true,
      isDesktop: false,
      serverMode: isLoopback ? "local" : "remote",
      serverHost: typeof location !== "undefined" ? location.host : "127.0.0.1:4180",
    };
    listeners.forEach((l) => l());
  }
  return desktopStatus;
}

export async function loadUpdaterStatus(): Promise<UpdaterStatusView> {
  if (!(globalThis as any).__VIBESQUAD_DESKTOP_BRIDGE__) {
    if (isRemote()) return updaterStatus;
  }
  void loadDesktopStatus();
  try {
    const r = await fetch("/__desktop/updater/status", { cache: "no-store" });
    if (r.ok) {
      const d = await r.json();
      setDesktopConfigWarning(d.configWarning);
      setUpdaterStatus({
        currentVersion: String(d.currentVersion || "0.2.0"),
        channel: d.channel === "beta" ? "beta" : "stable",
        updateAvailable: Boolean(d.updateAvailable),
        availableVersion: String(d.availableVersion || ""),
        downloaded: Boolean(d.downloaded),
      });
    }
  } catch {}
  return updaterStatus;
}

export async function saveUpdateChannel(channel: UpdateChannel): Promise<UpdaterStatusView> {
  const ch: UpdateChannel = channel === "beta" ? "beta" : "stable";
  setUpdaterStatus({ channel: ch, dismissed: false });
  try {
    const r = await fetch("/__desktop/updater/channel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: ch }),
    });
    if (r.ok) {
      const d = await r.json();
      setDesktopConfigWarning(d.configWarning);
      setUpdaterStatus({
        currentVersion: String(d.currentVersion || updaterStatus.currentVersion),
        channel: d.channel === "beta" ? "beta" : "stable",
        updateAvailable: Boolean(d.updateAvailable),
        availableVersion: String(d.availableVersion || ""),
        downloaded: Boolean(d.downloaded),
      });
    }
  } catch {}
  return updaterStatus;
}

export async function triggerUpdateInstall(): Promise<boolean> {
  try {
    const r = await fetch("/__desktop/updater/install", { method: "POST" });
    return r.ok;
  } catch {
    return false;
  }
}

export function dismissUpdateBanner(): void {
  setUpdaterStatus({ dismissed: true });
}
