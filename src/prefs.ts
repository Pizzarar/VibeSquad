import { useCallback, useSyncExternalStore } from "react";

// App-level preferences, per device. One typed registry (PREF_DEFS) drives the store, the Settings home,
// search, the command palette, reset and import/export. Stored as one JSON blob under vs.prefs.v1.
// Prefs that predate this module (vs.right-dock.*, vs.push.enabled) keep their old localStorage key as the
// source of truth: reads go to the old key and writes go to both, so callers that still use the old key
// don't break.

export const PREFS_KEY = "vs.prefs.v1";
export const PREFS_EXPORT_KIND = "vibesquad-prefs";

export type PrefSection = "app" | "chat" | "notifications" | "newAgent" | "layout";
export type Density = "comfortable" | "compact";
export type Accent = "cyan" | "magenta" | "violet" | "amber";
export type MonoFont = "jetbrains" | "cascadia" | "consolas" | "system";
export type SendKey = "enter" | "ctrl-enter";
export type TimestampFormat = "relative" | "absolute" | "both";

export type Prefs = {
  "app.density": Density;
  "app.accent": Accent;
  "app.confirmClose": boolean;
  "app.restoreLastView": boolean;
  "chat.fontSize": number;
  "chat.monoFont": MonoFont;
  "chat.maxWidth": number;
  "chat.sendKey": SendKey;
  "chat.timestampFormat": TimestampFormat;
  "chat.collapseToolCalls": boolean;
  "notify.sound": boolean;
  "notify.permission": boolean;
  "notify.needsYou": boolean;
  "notify.finished": boolean;
  "notify.errored": boolean;
  "notify.push": boolean;
  "newAgent.profile": string;
  "newAgent.folder": string;
  "layout.rightDockOpen": boolean;
  "layout.rightDockTab": string;
  "layout.rightDockWidth": number;
};
export type PrefKey = keyof Prefs;

type Opt = { value: string; label: string };
type Legacy = { key: string; read: (raw: string) => unknown; write: (v: any) => string };
export type PrefDef = {
  key: PrefKey;
  section: PrefSection;
  label: string;
  hint?: string;
  kind: "bool" | "enum" | "number" | "text";
  options?: Opt[];
  min?: number;
  max?: number;
  step?: number;
  /** Owned by another control (push subscription): shown, exported, but never reset or imported. */
  readonly?: boolean;
  /** Not a user-facing setting: no Settings row, no palette entry. */
  hidden?: boolean;
  legacy?: Legacy;
};

const bool01: Legacy["read"] = (raw) => (raw === "1" ? true : raw === "0" ? false : undefined);
const boolTF: Legacy["read"] = (raw) => (raw === "true" ? true : raw === "false" ? false : undefined);

export const PREF_DEFAULTS: Prefs = {
  "app.density": "comfortable",
  "app.accent": "cyan",
  "app.confirmClose": true,
  "app.restoreLastView": true,
  "chat.fontSize": 14,
  "chat.monoFont": "jetbrains",
  "chat.maxWidth": 0,
  "chat.sendKey": "enter",
  "chat.timestampFormat": "relative",
  "chat.collapseToolCalls": true,
  "notify.sound": false,
  "notify.permission": true,
  "notify.needsYou": true,
  "notify.finished": true, // the server already pushed "finished"; the toggle now gates push too, so on keeps that
  "notify.errored": true,
  "notify.push": false,
  "newAgent.profile": "",
  "newAgent.folder": "",
  "layout.rightDockOpen": false,
  "layout.rightDockTab": "Changes",
  "layout.rightDockWidth": 320,
};

export const PREF_DEFS: PrefDef[] = [
  { key: "app.density", section: "app", label: "UI density", hint: "Compact tightens padding and gaps.", kind: "enum", options: [{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }] },
  {
    key: "app.accent",
    section: "app",
    label: "Accent color",
    hint: "Neon-noir variants. Cyan is the default look.",
    kind: "enum",
    options: [{ value: "cyan", label: "Neon cyan" }, { value: "magenta", label: "Hot magenta" }, { value: "violet", label: "Synth violet" }, { value: "amber", label: "Sunset amber" }],
  },
  { key: "app.confirmClose", section: "app", label: "Confirm before closing while agents run", hint: "Asks before the window closes or reloads while any agent is working.", kind: "bool" },
  { key: "app.restoreLastView", section: "app", label: "Reopen last view on launch", hint: "Restore the last squad, agent and panes when the app opens.", kind: "bool" },
  { key: "chat.fontSize", section: "chat", label: "Chat font size", hint: "Pixels, for the transcript and composer.", kind: "number", min: 11, max: 22, step: 1 },
  {
    key: "chat.monoFont",
    section: "chat",
    label: "Monospace font",
    kind: "enum",
    options: [{ value: "jetbrains", label: "JetBrains Mono" }, { value: "cascadia", label: "Cascadia Code" }, { value: "consolas", label: "Consolas" }, { value: "system", label: "System monospace" }],
  },
  { key: "chat.maxWidth", section: "chat", label: "Max prose width", hint: "Characters per line for agent replies. 0 = full width.", kind: "number", min: 0, max: 200, step: 10 },
  {
    key: "chat.sendKey",
    section: "chat",
    label: "Send key",
    hint: "With Ctrl+Enter, plain Enter adds a new line and Ctrl+Shift+Enter interrupts.",
    kind: "enum",
    options: [{ value: "enter", label: "Enter sends" }, { value: "ctrl-enter", label: "Ctrl+Enter sends" }],
  },
  {
    key: "chat.timestampFormat",
    section: "chat",
    label: "Timestamp format",
    kind: "enum",
    options: [{ value: "relative", label: "Relative (5m ago)" }, { value: "absolute", label: "Absolute (14:05)" }, { value: "both", label: "Both" }],
  },
  { key: "chat.collapseToolCalls", section: "chat", label: "Collapse successful tool calls", hint: "Failed tool calls always start expanded.", kind: "bool" },
  { key: "notify.sound", section: "notifications", label: "Alert sound", hint: "A short chime with each enabled alert below.", kind: "bool" },
  { key: "notify.permission", section: "notifications", label: "Alert on permission request", kind: "bool" },
  { key: "notify.needsYou", section: "notifications", label: "Alert on needs-you", kind: "bool" },
  { key: "notify.finished", section: "notifications", label: "Alert when an agent finishes", kind: "bool" },
  { key: "notify.errored", section: "notifications", label: "Alert when an agent errors", kind: "bool" },
  { key: "notify.push", section: "notifications", label: "Push notifications (lock screen / desktop)", kind: "bool", readonly: true, legacy: { key: "vs.push.enabled", read: bool01, write: (v) => (v ? "1" : "0") } },
  { key: "newAgent.profile", section: "newAgent", label: "Default profile", hint: "Preselected in New Agent. Empty = built-in default.", kind: "text" },
  { key: "newAgent.folder", section: "newAgent", label: "Default folder", hint: "Prefills the New Agent folder. Empty = the team's first folder.", kind: "text" },
  { key: "layout.rightDockOpen", section: "layout", label: "Right dock open", kind: "bool", hidden: true, legacy: { key: "vs.right-dock.open", read: boolTF, write: (v) => String(!!v) } },
  { key: "layout.rightDockTab", section: "layout", label: "Right dock tab", kind: "text", hidden: true, legacy: { key: "vs.right-dock.tab", read: (r) => r || undefined, write: String } },
  {
    key: "layout.rightDockWidth",
    section: "layout",
    label: "Right dock width",
    kind: "number",
    hidden: true,
    min: 0,
    max: 4000,
    legacy: { key: "vs.right-dock.width", read: (r) => (Number(r) > 0 ? Number(r) : undefined), write: String },
  },
];

export const PREF_SECTION_LABEL: Record<PrefSection, string> = {
  app: "App",
  chat: "Chat",
  notifications: "Notifications",
  newAgent: "New Agent defaults",
  layout: "Layout",
};

const DEF = new Map(PREF_DEFS.map((d) => [d.key, d]));
export const prefDef = (key: PrefKey): PrefDef => DEF.get(key)!;

/** The value if it fits the pref's type/options/range, else undefined. */
export function coercePref<K extends PrefKey>(key: K, value: unknown): Prefs[K] | undefined {
  const d = DEF.get(key);
  if (!d) return undefined;
  if (d.kind === "bool") return typeof value === "boolean" ? (value as Prefs[K]) : undefined;
  if (d.kind === "enum") return typeof value === "string" && d.options!.some((o) => o.value === value) ? (value as Prefs[K]) : undefined;
  if (d.kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    if ((d.min !== undefined && value < d.min) || (d.max !== undefined && value > d.max)) return undefined;
    return value as Prefs[K];
  }
  return typeof value === "string" && value.length <= 1000 ? (value as Prefs[K]) : undefined;
}

// ---- store ----------------------------------------------------------------------------------------

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

let saved: Partial<Prefs> | null = null;
let version = 0;
const listeners = new Set<() => void>();

/** Reads vs.prefs.v1; on first run copies the legacy keys in so exports include them. */
function load(): Partial<Prefs> {
  if (saved) return saved;
  const s = storage();
  let raw: string | null = null;
  try {
    raw = s?.getItem(PREFS_KEY) ?? null;
  } catch {
    /* unavailable */
  }
  saved = raw ? sanitize(safeParse(raw)) : migrateLegacy(s);
  if (!raw) persist();
  return saved;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sanitize(obj: unknown): Partial<Prefs> {
  const out: Partial<Prefs> = {};
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const ok = coercePref(k as PrefKey, v);
    if (ok !== undefined) (out as any)[k] = ok;
  }
  return out;
}

export function migrateLegacy(s: Storage | null = storage()): Partial<Prefs> {
  const out: Partial<Prefs> = {};
  for (const d of PREF_DEFS) {
    if (!d.legacy) continue;
    let raw: string | null = null;
    try {
      raw = s?.getItem(d.legacy.key) ?? null;
    } catch {
      /* unavailable */
    }
    if (raw === null) continue;
    const v = coercePref(d.key, d.legacy.read(raw));
    if (v !== undefined) (out as any)[d.key] = v;
  }
  return out;
}

function persist() {
  try {
    storage()?.setItem(PREFS_KEY, JSON.stringify(saved ?? {}));
  } catch {
    /* full or unavailable: memory copy still works */
  }
}

function notify() {
  version++;
  listeners.forEach((l) => l());
}

export function getPref<K extends PrefKey>(key: K): Prefs[K] {
  const cur = load();
  const d = DEF.get(key);
  if (d?.legacy) {
    // The old key stays the source of truth while callers still write it directly.
    let raw: string | null = null;
    try {
      raw = storage()?.getItem(d.legacy.key) ?? null;
    } catch {
      /* unavailable */
    }
    const v = raw === null ? undefined : coercePref(key, d.legacy.read(raw));
    if (v !== undefined) return v;
  }
  const v = cur[key];
  return v === undefined ? PREF_DEFAULTS[key] : (v as Prefs[K]);
}

export function getPrefs(): Prefs {
  const out = { ...PREF_DEFAULTS };
  for (const k of Object.keys(PREF_DEFAULTS) as PrefKey[]) (out as any)[k] = getPref(k);
  return out;
}

export function setPref<K extends PrefKey>(key: K, value: Prefs[K]): boolean {
  const v = coercePref(key, value);
  if (v === undefined) return false;
  const cur = load();
  if (v === PREF_DEFAULTS[key]) delete cur[key];
  else (cur as any)[key] = v;
  persist();
  const d = DEF.get(key)!;
  if (d.legacy) {
    try {
      storage()?.setItem(d.legacy.key, d.legacy.write(v));
    } catch {
      /* unavailable */
    }
  }
  notify();
  return true;
}

export function resetPref(key: PrefKey): void {
  setPref(key, PREF_DEFAULTS[key]);
}

/** Resets every writable pref in the section. Read-only ones (push) are owned elsewhere. */
export function resetSection(section: PrefSection): PrefKey[] {
  const keys = PREF_DEFS.filter((d) => d.section === section && !d.readonly).map((d) => d.key);
  for (const k of keys) resetPref(k);
  return keys;
}

export function isDefault(key: PrefKey): boolean {
  return getPref(key) === PREF_DEFAULTS[key];
}

export function subscribePrefs(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

if (typeof window !== "undefined") {
  // Another window changed prefs (or a legacy key a pref mirrors).
  window.addEventListener("storage", (e) => {
    if (e.key === PREFS_KEY) saved = null;
    if (e.key === PREFS_KEY || PREF_DEFS.some((d) => d.legacy?.key === e.key)) notify();
  });
}

export function usePref<K extends PrefKey>(key: K): [Prefs[K], (v: Prefs[K]) => void] {
  const value = useSyncExternalStore(subscribePrefs, () => getPref(key));
  const set = useCallback((v: Prefs[K]) => void setPref(key, v), [key]);
  return [value, set];
}

/** Re-renders on any pref change; returns a counter (useful to recompute derived lists). */
export function usePrefsVersion(): number {
  return useSyncExternalStore(subscribePrefs, () => version);
}

/** For tests: drop the in-memory copy so the next read reloads from storage. */
export function _resetPrefsCache(): void {
  saved = null;
  notify();
}

// ---- getters other blocks read ------------------------------------------------------------------

export const getRestoreLastView = (): boolean => getPref("app.restoreLastView");
export const getTimestampFormat = (): TimestampFormat => getPref("chat.timestampFormat");

// ---- export / import ----------------------------------------------------------------------------

export function exportPrefs(): string {
  return JSON.stringify({ kind: PREFS_EXPORT_KIND, version: 1, prefs: getPrefs() }, null, 2);
}

export type ImportResult = { ok: true; applied: PrefKey[]; skipped: string[] } | { ok: false; error: string };

/** Validates a file from exportPrefs; nothing is applied unless the shape is right. Unknown/invalid keys are skipped. */
export function parsePrefsImport(text: string): ImportResult {
  const j = safeParse(text) as any;
  if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false, error: "Not a JSON object" };
  if (j.kind !== PREFS_EXPORT_KIND) return { ok: false, error: "Not a VibeSquad prefs file" };
  if (j.version !== 1) return { ok: false, error: `Unsupported version ${String(j.version)}` };
  if (!j.prefs || typeof j.prefs !== "object" || Array.isArray(j.prefs)) return { ok: false, error: "Missing prefs" };
  const applied: PrefKey[] = [];
  const skipped: string[] = [];
  for (const [k, v] of Object.entries(j.prefs)) {
    const d = DEF.get(k as PrefKey);
    if (!d || d.readonly || coercePref(d.key, v) === undefined) skipped.push(k);
    else applied.push(d.key);
  }
  return { ok: true, applied, skipped };
}

export function importPrefs(text: string): ImportResult {
  const r = parsePrefsImport(text);
  if (!r.ok) return r;
  const prefs = (JSON.parse(text) as any).prefs;
  for (const k of r.applied) setPref(k, prefs[k]);
  return r;
}

// ---- search + palette ---------------------------------------------------------------------------

export const visiblePrefDefs = (): PrefDef[] => PREF_DEFS.filter((d) => !d.hidden);

/** Settings that live in rehoused components (Team, Paseo, Profiles, About): searchable by label, open their section. */
export type HomeSection = "app" | "chat" | "notifications" | "newAgent" | "team" | "paseo" | "profiles" | "about";
export const EXTRA_SETTINGS: { id: string; section: HomeSection; label: string }[] = [
  { id: "ui-scale", section: "app", label: "UI scale (4K)" },
  { id: "user-name", section: "team", label: "Your name" },
  { id: "lan", section: "team", label: "Allow other devices (LAN / Meshnet)" },
  { id: "teams", section: "team", label: "Teams and lanes" },
  { id: "path-matchers", section: "team", label: "Path matchers" },
  { id: "token-thresholds", section: "team", label: "Token thresholds" },
  { id: "paseo-daemon", section: "paseo", label: "Paseo daemon" },
  { id: "paseo-providers", section: "paseo", label: "Paseo providers" },
  { id: "profiles", section: "profiles", label: "Agent profiles" },
  { id: "profile-import", section: "profiles", label: "Import profiles" },
  { id: "update-channel", section: "about", label: "Update channel" },
  { id: "check-updates", section: "about", label: "Check for updates" },
  { id: "diagnostics", section: "about", label: "Diagnostics & logs" },
  { id: "licenses", section: "about", label: "Licenses" },
];

export type SettingHit = { id: string; section: HomeSection; label: string; pref?: PrefKey };

export function allSettings(): SettingHit[] {
  return [
    ...visiblePrefDefs().map((d) => ({ id: d.key, section: d.section as HomeSection, label: d.label, pref: d.key })),
    ...EXTRA_SETTINGS,
  ];
}

export function searchSettings(q: string): SettingHit[] {
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return allSettings().filter((s) => {
    const hay = `${s.label} ${PREF_SECTION_LABEL[s.section as PrefSection] ?? s.section}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** One palette entry per setting: "Settings: <name>". The id after "setting:" is the SettingHit id. */
export function settingsPaletteItems(): { id: string; label: string }[] {
  return allSettings().map((s) => ({ id: `setting:${s.id}`, label: `Settings: ${s.label}` }));
}

type FlashEl = {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  click(): void;
  scrollIntoView?: (opts?: { block?: "center" }) => void;
};

/** Settings-home jump: find the setting's element under root, open it if it is a tab, scroll to it and flash it.
 *  The flash is a data attribute, not a className, so React re-renders of rehoused components don't clear it. */
export function flashSettingTarget(root: { querySelector(sel: string): unknown }, id: string, ms = 1600): boolean {
  const el = root.querySelector(`[data-setting-id="${id}"]`) as FlashEl | null; // ids are fixed [a-z.-] slugs
  if (!el) return false;
  if (el.getAttribute("role") === "tab" && el.getAttribute("aria-selected") !== "true") el.click();
  el.scrollIntoView?.({ block: "center" });
  el.setAttribute("data-flash", "");
  setTimeout(() => el.removeAttribute("data-flash"), ms);
  return true;
}

// ---- small pure helpers the UI uses ---------------------------------------------------------------

export const MONO_STACK: Record<MonoFont, string> = {
  jetbrains: '"JetBrains Mono", Consolas, monospace',
  cascadia: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
  consolas: "Consolas, monospace",
  system: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

/** What a key press in the composer does under the send-key pref. Menus/history are handled before this. */
export function composerKeyAction(
  e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean },
  sendKey: SendKey,
  touch = false,
): "send" | "interrupt" | "newline" | null {
  if (e.key !== "Enter") return null;
  const mod = e.ctrlKey || e.metaKey;
  if (sendKey === "ctrl-enter") {
    if (mod && e.shiftKey) return "interrupt";
    return mod ? "send" : "newline";
  }
  if (mod) return "interrupt";
  if (e.shiftKey || e.altKey || touch) return "newline";
  return "send";
}

export const BUILTIN_NEW_AGENT_PROFILE = "Implement - Sonnet";

/** The profile New Agent preselects: Settings › New Agent defaults › Default profile if it resolves, else the built-in one. */
export function defaultNewAgentProfile(pref: string, resolve: (name: string) => string | undefined): string {
  return (pref && resolve(pref)) || BUILTIN_NEW_AGENT_PROFILE;
}

/** Profiles arrived after New Agent opened: the profile to switch to, or null to leave the picker alone
 *  (the user already picked one, or the default already shows). */
export function reapplyDefaultProfile(current: string, pref: string, resolve: (name: string) => string | undefined, userPicked: boolean): string | null {
  if (userPicked) return null;
  const next = defaultNewAgentProfile(pref, resolve);
  return next !== current ? next : null;
}

/** The per-event toggles as the server stores them (~/.vibesquad/settings.json pushEvents). */
export function pushEventsFromPrefs(p: Pick<Prefs, "notify.permission" | "notify.needsYou" | "notify.finished" | "notify.errored">) {
  return { permission: p["notify.permission"], needsYou: p["notify.needsYou"], finished: p["notify.finished"], errored: p["notify.errored"] };
}

/** Alert tone → the pref that gates it. */
export function alertEnabled(tone: "permission" | "error" | "needs-you" | "finished", prefs: Pick<Prefs, "notify.permission" | "notify.needsYou" | "notify.finished" | "notify.errored">): boolean {
  if (tone === "permission") return prefs["notify.permission"];
  if (tone === "needs-you") return prefs["notify.needsYou"];
  if (tone === "finished") return prefs["notify.finished"];
  return prefs["notify.errored"];
}

/** Whether a tool row starts expanded. */
export const toolStartsExpanded = (failed: boolean, collapse: boolean): boolean => failed || !collapse;

export function formatTimestamp(iso: string | null | undefined, fmt: TimestampFormat, now = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  const rel = s < 45 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
  const d = new Date(t);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const abs = sameDay ? hm : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
  return fmt === "relative" ? rel : fmt === "absolute" ? abs : `${abs} · ${rel}`;
}

/** Applies the App/Chat look prefs to <html> (data attributes + CSS vars). */
export function applyPrefsToDom(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.density = getPref("app.density");
  root.dataset.accent = getPref("app.accent");
  root.style.setProperty("--chat-font-size", `${getPref("chat.fontSize")}px`);
  root.style.setProperty("--mono", MONO_STACK[getPref("chat.monoFont")]);
  const w = getPref("chat.maxWidth");
  root.style.setProperty("--chat-max-width", w > 0 ? `${w}ch` : "none");
}

if (typeof document !== "undefined") {
  applyPrefsToDom();
  subscribePrefs(applyPrefsToDom);
}
