// U1: light/dark theme choice. Pure helpers (no DOM), so the pick logic is unit-tested.
// The pref "app.theme" (System / Dark / Light) lives in prefs.ts; prefs.applyPrefsToDom sets data-theme on <html>.
export type ThemePref = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

export const THEME_PREFS: readonly ThemePref[] = ["system", "dark", "light"];

/** Anything unknown (old/corrupt storage) falls back to following the system. */
export function parseThemePref(raw: unknown): ThemePref {
  return raw === "dark" || raw === "light" || raw === "system" ? raw : "system";
}

/** The theme to paint: an explicit pick wins, otherwise prefers-color-scheme. */
export function resolveTheme(pref: ThemePref, systemPrefersDark: boolean): ResolvedTheme {
  return pref === "system" ? (systemPrefersDark ? "dark" : "light") : pref;
}

/** Same pick from the raw vs.prefs.v1 JSON blob; used by the pre-paint script in index.html (kept in sync by a test). */
export function themeFromPrefsBlob(blob: string | null, systemPrefersDark: boolean): ResolvedTheme {
  let pref: ThemePref = "system";
  try {
    pref = parseThemePref(blob ? (JSON.parse(blob) as Record<string, unknown>)["app.theme"] : undefined);
  } catch {
    /* corrupt blob: follow the system */
  }
  return resolveTheme(pref, systemPrefersDark);
}

/** Layout vibe: "fun" is the Hypnospace default, "boring" is the corporate ADE skin (src/boring.css). */
export type VibePref = "fun" | "boring";

export const VIBE_PREFS: readonly VibePref[] = ["fun", "boring"];

/** Anything but an explicit "boring" is the fun default. */
export function parseVibePref(raw: unknown): VibePref {
  return raw === "boring" ? "boring" : "fun";
}

/** Same pick from the raw vs.prefs.v1 JSON blob; mirrored by the pre-paint script in index.html. */
export function vibeFromPrefsBlob(blob: string | null): VibePref {
  try {
    return parseVibePref(blob ? (JSON.parse(blob) as Record<string, unknown>)["app.vibe"] : undefined);
  } catch {
    return "fun";
  }
}
