// Per-project "fits on screen" caps for check #18 (V11). Used only where a row has no pinned length_budget.
// Per-project config lives here (the adapter module is owned by another lane); an adapter may also expose `lengthCaps`
// to override. Each group = {key, label, match: RegExp tested (case-insensitive) against the row's group + where_seen +
// file + data_path + origin/field haystack, max: characters}. First match wins, so order specific -> general.
// A row matching no group has no cap (unknown group: never flagged).
export const DEFAULT_LENGTH_GROUPS = Object.freeze([
  { key: "toast", label: "toast", match: /toast/, max: 90 },                                  // one line over the game view, auto-dismisses
  { key: "button", label: "button", match: /\bbutton|\bbtn\b/, max: 28 },                     // buttons do not wrap
  { key: "bio", label: "bio", match: /\bbio\b|balance_note/, max: 280 },                      // squad bio: 1-2 sentences
  { key: "card-title", label: "card title", match: /\btitle\b|item name/, max: 48 }, // card / row / room titles clip at ~48
  { key: "label", label: "label", match: /\blabels?\b/, max: 60 },                            // short UI labels
  { key: "description", label: "description", match: /\bdesc/, max: 160 },                    // item / recipe description, ~3 lines
  { key: "story", label: "story / dialogue", match: /\bstory\b|encouragement|trader_relations|long_haul|raid_story|\bsquad\b/, max: 300 }, // dialogue panel, ~1-3 sentences
]);

/** project key -> caps (replaces the defaults for that project). Unlisted projects use DEFAULT_LENGTH_GROUPS. */
export const PROJECT_LENGTH_GROUPS = Object.freeze({});

export function lengthGroupsFor(project, adapter) {
  return adapter?.lengthCaps ?? PROJECT_LENGTH_GROUPS[project] ?? DEFAULT_LENGTH_GROUPS;
}
