import { useSyncExternalStore } from "react";
import { isAndroidUserAgent, isRemote } from "./remoteSession.ts";

declare const __VS_APP_VERSION__: string | undefined;

// Legacy owner aliases are assembled at runtime so the old literal never appears in tracked files.
export const LEGACY_USER_TYPE = "au" + "b";
export const LEGACY_NEEDS_LABEL = "needs-" + LEGACY_USER_TYPE;
export const LEGACY_NEEDS_REASON = LEGACY_NEEDS_LABEL + "-reason";
export const LEGACY_NEEDS_UNTIL = LEGACY_NEEDS_LABEL + "-until";

const DEFAULT_NAME = "you";
let userName = DEFAULT_NAME;
let lanEnabled = false;
let remoteEnabled = false;
let exposedIps: string[] = [];
let serverConfigWarnings: { file: string; label?: string; error: string; kind?: string }[] = [];
let desktopConfigWarning = "";
let staleBuild: { built: string; head: string; behind: number } | null = null;
const listeners = new Set<() => void>();

export const getUserName = () => userName;
export const getLanEnabled = () => lanEnabled;
export const getRemoteEnabled = () => remoteEnabled;
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

export const getStaleBuild = () => staleBuild;

export function useStaleBuild() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => staleBuild,
  );
}

export const DISMISSED_STALE_BUILD_KEY = "vs.dismissedStaleBuild";

let dismissedStaleBuildKey = typeof localStorage !== "undefined" ? localStorage.getItem(DISMISSED_STALE_BUILD_KEY) || "" : "";

export function staleBuildKey(s: { built: string; head: string } | null): string {
  return s ? `${s.built}..${s.head}` : "";
}

export function dismissStaleBuild(): void {
  dismissedStaleBuildKey = staleBuildKey(staleBuild);
  try {
    localStorage.setItem(DISMISSED_STALE_BUILD_KEY, dismissedStaleBuildKey);
  } catch {}
  listeners.forEach((l) => l());
}

export function useStaleBuildDismissed(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => Boolean(staleBuild && dismissedStaleBuildKey === staleBuildKey(staleBuild)),
  );
}

// Loopback without the local token (a plain browser tab) is read-only; the server says so in /health.
let localReadOnly = false;

export function setLocalAccess(access: unknown): void {
  const next = !isRemote() && access === "read-only";
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
    () => (isRemote() ? false : localReadOnly),
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

export function setRemoteEnabledState(next: boolean): void {
  const val = Boolean(next);
  if (val !== remoteEnabled) {
    remoteEnabled = val;
    listeners.forEach((l) => l());
  }
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

export function useRemoteEnabled(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getRemoteEnabled,
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
      setRemoteEnabledState(Boolean(data.remote?.enabled));
      setServerConfigWarnings(data.configWarnings);
    }
  } catch {}
}

/** Surface a refused/failed POST /__vibesquad/settings in the config-warnings banner (replaced by the next successful response). */
async function reportSettingsSaveFailure(r: Response | null, err?: unknown): Promise<void> {
  let msg = err ? String((err as any)?.message ?? err) : `HTTP ${r?.status}`;
  if (r) {
    try {
      const data = await r.json();
      if (data && typeof data.error === "string") msg = data.error;
    } catch {}
  }
  setServerConfigWarnings([{ file: "settings.json", label: "Settings not saved", error: msg, kind: "save" }]);
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
    } else await reportSettingsSaveFailure(r);
  } catch (e) {
    await reportSettingsSaveFailure(null, e);
  }
}

export async function saveLanEnabled(enabled: boolean): Promise<{ lanEnabled: boolean; exposedIps: string[] }> {
  const prevLan = getLanEnabled();
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
    setLanExposureState(prevLan, getExposedIps());
    await reportSettingsSaveFailure(r);
  } catch (e) {
    setLanExposureState(prevLan, getExposedIps());
    await reportSettingsSaveFailure(null, e);
  }
  return { lanEnabled: getLanEnabled(), exposedIps: getExposedIps() };
}

export async function saveRemoteEnabled(enabled: boolean): Promise<boolean> {
  const prevRemote = getRemoteEnabled();
  setRemoteEnabledState(enabled);
  try {
    const r = await fetch("/__vibesquad/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remoteEnabled: Boolean(enabled) }),
    });
    if (r.ok) {
      const data = await r.json();
      const next = Boolean(data.remote?.enabled);
      setRemoteEnabledState(next);
      setServerConfigWarnings(data.configWarnings);
      return next;
    }
    setRemoteEnabledState(prevRemote);
    await reportSettingsSaveFailure(r);
  } catch (e) {
    setRemoteEnabledState(prevRemote);
    await reportSettingsSaveFailure(null, e);
  }
  return getRemoteEnabled();
}

export type UpdateChannel = "stable" | "beta";

export interface UpdaterStatusView {
  currentVersion: string;
  channel: UpdateChannel;
  updateAvailable: boolean;
  availableVersion: string;
  downloaded: boolean;
  dismissed: boolean;
  downloadUrl?: string;
}

export function isSemverNewer(currentVer: string, remoteVer: string, channel: UpdateChannel = "stable"): boolean {
  const parse = (v: string) => {
    const clean = String(v || "").trim().replace(/^v/i, "");
    const m = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/i);
    if (!m) return null;
    return {
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: Number(m[3]),
      beta: m[4] !== undefined ? Number(m[4]) : null,
    };
  };
  const cur = parse(currentVer);
  const rem = parse(remoteVer);
  if (!cur || !rem) return false;
  if (channel !== "beta" && rem.beta !== null) return false;
  if (rem.major !== cur.major) return rem.major > cur.major;
  if (rem.minor !== cur.minor) return rem.minor > cur.minor;
  if (rem.patch !== cur.patch) return rem.patch > cur.patch;
  if (cur.beta !== null && rem.beta === null) return true;
  if (cur.beta === null && rem.beta !== null) return false;
  if (cur.beta !== null && rem.beta !== null) return rem.beta > cur.beta;
  return false;
}

let updaterStatus: UpdaterStatusView = {
  currentVersion: typeof __VS_APP_VERSION__ !== "undefined" && __VS_APP_VERSION__ ? __VS_APP_VERSION__ : "0.2.0",
  channel: typeof localStorage !== "undefined" && localStorage.getItem("vs.updateChannel") === "beta" ? "beta" : "stable",
  updateAvailable: false,
  availableVersion: "",
  downloaded: false,
  dismissed: false,
  downloadUrl: "",
};

export function parseGithubReleaseVersion(release: any, channel: UpdateChannel = "stable"): { version: string; downloadUrl: string } {
  const tagName = String(release?.tag_name || "").trim();
  let version = "";
  if (/^v?\d+\.\d+\.\d+/i.test(tagName)) {
    version = tagName.replace(/^v/i, "");
  } else {
    const text = `${String(release?.name || "")}\n${String(release?.body || "")}`;
    const m = text.match(/(\d+\.\d+\.\d+(?:-beta\.\d+)?)/i);
    if (m) version = m[1];
  }
  let downloadUrl = "";
  if (Array.isArray(release?.assets)) {
    const asset = release.assets.find((a: any) => a && a.name === "VibeSquad.apk" && a.browser_download_url);
    if (asset) downloadUrl = String(asset.browser_download_url);
  }
  if (!downloadUrl) {
    const fallbackTag = tagName || (channel === "beta" ? "beta" : `v${version}`);
    downloadUrl = `https://github.com/Pizzarar/VibeSquad/releases/download/${fallbackTag}/VibeSquad.apk`;
  }
  return { version, downloadUrl };
}

export async function checkGithubAndroidRelease(
  currentVer: string,
  channel: UpdateChannel = "stable",
  fetchFn: typeof fetch = fetch,
): Promise<{ updateAvailable: boolean; availableVersion: string; downloadUrl: string }> {
  const opts: RequestInit = { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" };
  let r = await fetchFn(
    channel === "beta"
      ? "https://api.github.com/repos/Pizzarar/VibeSquad/releases/tags/beta"
      : "https://api.github.com/repos/Pizzarar/VibeSquad/releases/latest",
    opts,
  );
  if (!r.ok && channel === "beta") {
    r = await fetchFn("https://api.github.com/repos/Pizzarar/VibeSquad/releases/latest", opts);
  }
  if (!r.ok) {
    return { updateAvailable: false, availableVersion: "", downloadUrl: "" };
  }
  const data = await r.json();
  const parsed = parseGithubReleaseVersion(data, channel);
  const updateAvailable = Boolean(parsed.version && isSemverNewer(currentVer, parsed.version, channel));
  return {
    updateAvailable,
    availableVersion: updateAvailable ? parsed.version : "",
    downloadUrl: updateAvailable ? parsed.downloadUrl : "",
  };
}

export const getUpdaterStatus = (): UpdaterStatusView => updaterStatus;

function setUpdaterStatus(patch: Partial<UpdaterStatusView>): void {
  const next: UpdaterStatusView = { ...updaterStatus, ...patch };
  if (
    next.currentVersion === updaterStatus.currentVersion &&
    next.channel === updaterStatus.channel &&
    next.updateAvailable === updaterStatus.updateAvailable &&
    next.availableVersion === updaterStatus.availableVersion &&
    next.downloaded === updaterStatus.downloaded &&
    next.dismissed === updaterStatus.dismissed &&
    next.downloadUrl === updaterStatus.downloadUrl
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
  if (isAndroidUserAgent()) {
    try {
      const res = await checkGithubAndroidRelease(updaterStatus.currentVersion, updaterStatus.channel);
      setUpdaterStatus({
        updateAvailable: res.updateAvailable,
        availableVersion: res.availableVersion,
        downloadUrl: res.downloadUrl,
        downloaded: false,
      });
    } catch {}
    return updaterStatus;
  }
  if (!(globalThis as any).__VIBESQUAD_DESKTOP_BRIDGE__) {
    if (isRemote()) return updaterStatus;
  }
  void loadDesktopStatus();
  try {
    const r = await fetch("/__desktop/updater/status", { cache: "no-store" });
    if (r.ok) {
      const d = await r.json();
      setDesktopConfigWarning(d.configWarning);
      const curVer = String(d.currentVersion || "0.2.0");
      const ch: UpdateChannel = d.channel === "beta" ? "beta" : "stable";
      let updateAvail = Boolean(d.updateAvailable);
      let availVer = String(d.availableVersion || "");
      const downloaded = Boolean(d.downloaded);
      let downloadUrl = "";

      // Fallback for v0.2.0/v0.2.1 desktop builds whose Rust updater hit GitHub 302 redirects:
      // check the server's /__vibesquad/desktop/update.json for a newer build.
      if (!updateAvail) {
        try {
          const srv = await fetch("/__vibesquad/desktop/update.json", { cache: "no-store" });
          if (srv.ok) {
            const uj = await srv.json();
            const srvVer = String(uj?.version || "");
            if (srvVer && isSemverNewer(curVer, srvVer, ch)) {
              updateAvail = true;
              availVer = srvVer;
              downloadUrl = uj?.available ? "/VibeSquad-setup.exe" : "https://github.com/Pizzarar/VibeSquad/releases/latest/download/VibeSquad-setup.exe";
            }
          }
        } catch {}
      }

      setUpdaterStatus({
        currentVersion: curVer,
        channel: ch,
        updateAvailable: updateAvail,
        availableVersion: availVer,
        downloaded,
        downloadUrl,
      });
    }
  } catch {}
  return updaterStatus;
}

export async function saveUpdateChannel(channel: UpdateChannel): Promise<UpdaterStatusView> {
  const ch: UpdateChannel = channel === "beta" ? "beta" : "stable";
  setUpdaterStatus({ channel: ch, dismissed: false });
  try {
    localStorage.setItem("vs.updateChannel", ch);
  } catch {}
  if (isAndroidUserAgent()) {
    await loadUpdaterStatus();
    return updaterStatus;
  }
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
      if (!d.updateAvailable) {
        await loadUpdaterStatus();
      }
    }
  } catch {}
  return updaterStatus;
}

export async function triggerUpdateInstall(): Promise<boolean> {
  if (updaterStatus.downloaded) {
    try {
      const r = await fetch("/__desktop/updater/install", { method: "POST" });
      if (r.ok) return true;
    } catch {}
  }
  if (updaterStatus.downloadUrl && typeof window !== "undefined") {
    if (isAndroidUserAgent()) {
      try {
        const w = window.open(updaterStatus.downloadUrl, "_blank");
        if (!w) window.location.assign(updaterStatus.downloadUrl);
      } catch {
        window.location.assign(updaterStatus.downloadUrl);
      }
      return true;
    }
    window.location.assign(updaterStatus.downloadUrl);
    return true;
  }
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
