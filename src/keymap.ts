// Keymap: default bindings for palette commands + user overrides (prefs "keys.bindings"), conflict
// detection and focus-scoped lookup. Pure; the dispatcher lives in CommandPalette.tsx.
//
// Combos are canonical strings: modifiers in the order Ctrl, Alt, Shift, then the key ("Ctrl+Shift+F",
// "Ctrl+.", "?"). Cmd on macOS counts as Ctrl. Shift is folded into printable non-letter keys ("?" not
// "Shift+/"), so a combo reads the way the key is labelled.
//
// Scopes: a command with `scope: "files-editor"` only fires while focus is inside an element with
// data-keyscope="files-editor", and wins over a global command on the same combo (block 4's inline edit
// on Ctrl+K vs the palette's Ctrl+K). Conflicts are only reported within one scope.

export type KeyScope = "global" | "files-editor";

export type KeyCommand = {
  /** Palette action id (CommandPalette run()) or a dispatcher-only id. */
  id: string;
  label: string;
  defaults: string[];
  scope?: KeyScope;
};

export const KEY_COMMANDS: KeyCommand[] = [
  { id: "palette", label: "Command palette", defaults: ["Ctrl+K", "Ctrl+Shift+P"] },
  { id: "quickOpen", label: "Quick open file", defaults: ["Ctrl+P"] },
  { id: "findInFiles", label: "Find in files", defaults: ["Ctrl+Shift+F"] },
  { id: "focus", label: "Toggle Focus mode", defaults: ["Ctrl+."] },
  { id: "needsYou", label: "Open the top NEEDS YOU agent", defaults: ["Ctrl+J"] },
  { id: "shortcuts", label: "Keyboard shortcuts (this sheet)", defaults: ["?"] },
  { id: "search", label: "Search all transcripts", defaults: [] },
  { id: "new", label: "New agent", defaults: [] },
  { id: "settings", label: "Settings", defaults: [] },
  { id: "workspaces", label: "Workspaces", defaults: [] },
  { id: "reopen", label: "Reopen closed tab", defaults: [] },
];

/** Shown in the cheat sheet, not rebindable. Also reserved: binding one of these is a conflict. */
export const FIXED_SHORTCUTS: [string, string][] = [
  ["Ctrl+1 … 9", "Switch tab in the active pane"],
  ["Shift+Tab", "Cycle permission mode (composer)"],
  ["Ctrl+R", "Reload the page"],
  ["Ctrl+= / Ctrl+- / Ctrl+0", "UI scale up / down / reset"],
  ["Esc", "Close dialogs and menus"],
];

const RESERVED: Record<string, string> = {
  "Shift+Tab": "permission mode",
  "Ctrl+R": "reload",
  "Ctrl+=": "UI scale",
  "Ctrl+-": "UI scale",
  "Ctrl+0": "UI scale",
  Escape: "close dialogs",
  "Ctrl+C": "copy",
  "Ctrl+V": "paste",
  "Ctrl+X": "cut",
  "Ctrl+A": "select all",
  "Ctrl+Z": "undo",
  "Ctrl+W": "the browser (close tab)",
  "Ctrl+T": "the browser (new tab)",
  "Ctrl+N": "the browser (new window)",
  "Ctrl+Shift+N": "the browser",
  "Ctrl+Shift+T": "the browser",
};
for (let i = 1; i <= 9; i++) RESERVED[`Ctrl+${i}`] = "switch tab";

const MOD_ALIASES: Record<string, "Ctrl" | "Alt" | "Shift"> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  cmd: "Ctrl",
  meta: "Ctrl",
  mod: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};
const NAMED: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  space: "Space",
  " ": "Space",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  plus: "Plus",
  "+": "Plus",
};
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS", "AltGraph", "CapsLock", "Fn"]);

function canonKey(raw: string): string | null {
  if (!raw) return null;
  const named = NAMED[raw.toLowerCase()];
  if (named) return named;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(raw)) return raw.toUpperCase();
  if ([...raw].length === 1) return raw.toUpperCase();
  return null;
}

function build(mods: Set<string>, key: string): string {
  // Shift is part of a printable non-letter character ("?" is Shift+/); keep it for letters and named keys.
  const shiftFolds = key.length === 1 && !/[A-Z0-9]/.test(key);
  const out: string[] = [];
  if (mods.has("Ctrl")) out.push("Ctrl");
  if (mods.has("Alt")) out.push("Alt");
  if (mods.has("Shift") && !shiftFolds) out.push("Shift");
  out.push(key);
  return out.join("+");
}

/** Canonical combo string, or null if it is not a valid single combo. */
export function normalizeCombo(s: string): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t || t.length > 40) return null;
  // "Ctrl++" ends in a literal plus.
  const parts = t.endsWith("++") ? [...t.slice(0, -2).split("+"), "+"] : t === "+" ? ["+"] : t.split("+");
  const keyRaw = parts.pop()!.trim();
  const mods = new Set<string>();
  for (const p of parts) {
    const m = MOD_ALIASES[p.trim().toLowerCase()];
    if (!m) return null;
    mods.add(m);
  }
  const key = canonKey(keyRaw);
  if (!key) return null;
  return build(mods, key);
}

export type KeyEventLike = { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };

/** Combo for a keydown, or null for a lone modifier / dead key. */
export function comboFromEvent(e: KeyEventLike): string | null {
  if (!e.key || MODIFIER_KEYS.has(e.key) || e.key === "Dead" || e.key === "Unidentified") return null;
  let raw = e.key;
  // Alt (Option on macOS) changes e.key to a symbol; use the physical key instead.
  if (e.altKey && e.code) {
    const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code);
    if (m) raw = m[1] ?? m[2];
  }
  const key = canonKey(raw);
  if (!key) return null;
  const mods = new Set<string>();
  if (e.ctrlKey || e.metaKey) mods.add("Ctrl");
  if (e.altKey) mods.add("Alt");
  if (e.shiftKey) mods.add("Shift");
  return build(mods, key);
}

/** A combo without Ctrl/Alt (e.g. "?") must not fire while the user is typing in a field. */
export const firesWhileTyping = (combo: string): boolean => /^(Ctrl|Alt)\+/.test(combo) || /(^|\+)F\d+$/.test(combo);

export type KeyOverrides = Record<string, string[]>;

/** Drops unknown commands and invalid combos; normalizes; an empty list means "unbound". */
export function sanitizeOverrides(obj: unknown, commands: KeyCommand[] = KEY_COMMANDS): KeyOverrides {
  const out: KeyOverrides = {};
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  const known = new Set(commands.map((c) => c.id));
  for (const [id, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!known.has(id) || !Array.isArray(v)) continue;
    const combos = [...new Set(v.map((x) => normalizeCombo(String(x))).filter((x): x is string => !!x))].slice(0, 4);
    out[id] = combos;
  }
  return out;
}

export function parseOverrides(raw: string, commands: KeyCommand[] = KEY_COMMANDS): KeyOverrides {
  if (!raw) return {};
  try {
    return sanitizeOverrides(JSON.parse(raw), commands);
  } catch {
    return {};
  }
}

/** "" when nothing is overridden, so the pref stays at its default. */
export const serializeOverrides = (o: KeyOverrides): string => (Object.keys(o).length ? JSON.stringify(o) : "");

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Returns new overrides with `id` bound to `combos`; drops the entry when it equals the defaults. */
export function setBinding(o: KeyOverrides, id: string, combos: string[], commands: KeyCommand[] = KEY_COMMANDS): KeyOverrides {
  const cmd = commands.find((c) => c.id === id);
  if (!cmd) return o;
  const list = [...new Set(combos.map(normalizeCombo).filter((x): x is string => !!x))].slice(0, 4);
  const defaults = cmd.defaults.map(normalizeCombo).filter((x): x is string => !!x);
  const next = { ...o };
  if (sameList(list, defaults)) delete next[id];
  else next[id] = list;
  return next;
}

export function resetBinding(o: KeyOverrides, id: string): KeyOverrides {
  const next = { ...o };
  delete next[id];
  return next;
}

export type Bindings = Map<string, string[]>;

export function effectiveBindings(o: KeyOverrides, commands: KeyCommand[] = KEY_COMMANDS): Bindings {
  const out: Bindings = new Map();
  for (const c of commands) {
    const list = o[c.id] ?? c.defaults;
    out.set(c.id, [...new Set(list.map(normalizeCombo).filter((x): x is string => !!x))]);
  }
  return out;
}

export type Conflict = { combo: string; with: string };

/** Per command: combos that are also bound to another command in the same scope, or reserved. */
export function findConflicts(b: Bindings, commands: KeyCommand[] = KEY_COMMANDS): Map<string, Conflict[]> {
  const out = new Map<string, Conflict[]>();
  const add = (id: string, c: Conflict) => out.set(id, [...(out.get(id) ?? []), c]);
  const owners = new Map<string, string[]>(); // scope|combo -> command ids
  for (const c of commands) {
    for (const combo of b.get(c.id) ?? []) {
      const k = `${c.scope ?? "global"}|${combo}`;
      owners.set(k, [...(owners.get(k) ?? []), c.id]);
      if (RESERVED[combo]) add(c.id, { combo, with: `reserved for ${RESERVED[combo]}` });
    }
  }
  const label = (id: string) => commands.find((c) => c.id === id)?.label ?? id;
  for (const [k, ids] of owners) {
    if (ids.length < 2) continue;
    const combo = k.slice(k.indexOf("|") + 1);
    for (const id of ids) for (const other of ids) if (other !== id) add(id, { combo, with: label(other) });
  }
  return out;
}

/** Command for a combo given the active scopes (innermost first; "global" is always implied last). */
export function resolveCommand(combo: string, b: Bindings, scopes: KeyScope[] = [], commands: KeyCommand[] = KEY_COMMANDS): string | null {
  const order = [...scopes.filter((s) => s !== "global"), "global"];
  for (const scope of order) {
    const hit = commands.find((c) => (c.scope ?? "global") === scope && (b.get(c.id) ?? []).includes(combo));
    if (hit) return hit.id;
  }
  return null;
}

/** "Ctrl+K / Ctrl+Shift+P", or "" when unbound. */
export const bindingLabel = (b: Bindings, id: string): string => (b.get(id) ?? []).join(" / ");
