// Per-project "fits on screen" caps for check #18 (V11). Used only where a row has no pinned length_budget.
// Per-project config lives here (the adapter module is owned by another lane); an adapter may also expose `lengthCaps`
// to override. Each group = {key, label, match: RegExp, max: characters, fallback?: number}. First match wins in pass 1.
// `match` is tested on a token string (non-alphanumerics collapsed to spaces, lowercased). Pass 1 (primary): the data_path
// field key + origin/field + a `Data:` group / data/<name>.json stem (a `Screen:` group names a screen, so it is ignored). Pass 2 (fallback, only when pass 1 matched
// nothing): free-text where_seen only, tried in `fallback` order (lower first; groups without it are skipped). Description and
// story come first so prose like "tooltip below Deploy button" cannot cap long copy at a button cap.
// A row matching no group has no cap (unknown group: never flagged).
export const DEFAULT_LENGTH_GROUPS = Object.freeze([
  { key: "toast", label: "toast", match: /\btoasts?\b/, max: 90, fallback: 3 },                       // one line over the game view, auto-dismisses
  { key: "button", label: "button", match: /\b(?:buttons?|btns?)\b/, max: 28, fallback: 4 },           // buttons do not wrap
  { key: "bio", label: "bio", match: /\b(?:bio|balance note)\b/, max: 280 },                          // squad bio: 1-2 sentences
  { key: "card-title", label: "card title", match: /\btitles?\b|\bitem name\b/, max: 48, fallback: 5 }, // card / row / room titles clip at ~48
  { key: "label", label: "label", match: /\blabels?\b/, max: 60, fallback: 6 },                        // short UI labels
  { key: "description", label: "description", match: /\bdesc(?:ription)?s?\b/, max: 160, fallback: 1 }, // item / recipe description, ~3 lines
  { key: "story", label: "story / dialogue", match: /\bstory\b|\bencouragement\b|\btrader relations\b|\blong haul\b|\braid story\b|\bsquad\b/, max: 300, fallback: 2 }, // dialogue panel, ~1-3 sentences
]);

/** project key -> caps (replaces the defaults for that project). Unlisted projects use DEFAULT_LENGTH_GROUPS. */
export const PROJECT_LENGTH_GROUPS = Object.freeze({});

export function lengthGroupsFor(project, adapter) {
  return adapter?.lengthCaps ?? PROJECT_LENGTH_GROUPS[project] ?? DEFAULT_LENGTH_GROUPS;
}
