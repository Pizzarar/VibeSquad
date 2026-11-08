// The hits Aub reported (docs/PLAN_OVERLAP_AUDIT_V1.md rounds 1-3). The guard must flag each one;
// `matchers` classify aggregated hits, `targets` are always screenshotted (so "not reproduced" has a picture).
const hay = (h) => `${h.selector} ${h.classes.join(" ")} ${h.text} ${h.other?.selector ?? ""} ${(h.other?.classes ?? []).join(" ")} ${h.other?.text ?? ""}`;
const has = (h, re) => re.test(hay(h));

export const KNOWN = [
  {
    id: "r1-summary-blank-btn", what: "R1: blank yellow button left of SUMMARY in the active card's token row (label invisible)",
    match: (h) => h.kind === "contrast" && has(h, /pin-rail-active|pin-rail-buddy|summary|handoff|ctx/i),
    targets: [{ surface: "focus-brainstorm", selector: '[data-testid="pin-rail-active-buddy"]' }],
  },
  {
    id: "r1-tok-label-over-bar", what: "R1: '115K / 150K TOK' label sits on top of its own bar",
    match: (h) => /\btok\b/i.test(h.text) || /\btok\b/i.test(h.other?.text ?? ""),
    targets: [{ surface: "focus-brainstorm", selector: '[data-testid="pin-rail-active-buddy"]' }],
  },
  {
    id: "r1-provider-badge-over-avatar", what: "R1: provider badge (red */cyan diamond) covers the avatar on Other-teams cards",
    match: (h) => has(h, /prov-badge/i) && has(h, /cast-sprite|avatar/i),
    targets: [{ surface: "focus-brainstorm", selector: '[data-testid="pin-rail-riffbot"]' }],
  },
  {
    id: "r2-chip-row-clipping", what: "R2: worker chip row above the composer clips titles mid-word / last chip runs off the edge",
    match: (h) => has(h, /drawer-subagent|subagents-bar/i) && ["edge-clip", "text-overflow", "text-outside-container", "overlap", "truncated"].includes(h.kind),
    targets: [{ surface: "focus-brainstorm", selector: '[data-testid="drawer-subagents-bar"]' }],
  },
  {
    id: "r3-settings-header", what: "R3: Settings header: SETTINGS label above/outside its bar, bar edge through text, right button half-clipped",
    match: (h) => h.surface === "settings" && has(h, /settings-(head|header|top|title|bar)|settings-pane|\bsettings\b/i) && ["decor-line", "text-outside-container", "edge-clip", "overlap", "text-overflow"].includes(h.kind),
    targets: [{ surface: "settings", selector: '[data-testid="settings-pane"]' }],
  },
  {
    id: "r3-exposed-banner-line", what: "R3: EXPOSED ON ... LAN banner has a horizontal line through the text",
    match: (h) => has(h, /exposed-network-banner/i) && h.kind === "decor-line",
    targets: [{ surface: "squads-home", selector: '[data-testid="exposed-network-banner"]' }],
  },
  {
    id: "r3-squads-rail-line", what: "R3: Squads rail button (PinRail.tsx:237) has a horizontal line across icon/label",
    match: (h) => has(h, /pin-focus-home|pin-focus-bar/i) && h.kind === "decor-line",
    targets: [{ surface: "focus-brainstorm", selector: '[data-testid="pin-focus-bar"]' }],
  },
  {
    id: "r3-squads-label-truncated", what: "R3: Squads label truncated to 'Squa...'",
    match: (h) => h.kind === "truncated" && (/^squa/i.test(h.text) || has(h, /pin-focus-home|breadcrumb-squads|pin-rail-squads/i)),
    targets: [{ surface: "focus-brainstorm", selector: '[data-testid="top-breadcrumb"]' }],
  },
  {
    id: "r3-medium-auto-chip-line", what: "R3: MEDIUM · AUTO chip has a line through/at its top and its bottom border runs into the bar",
    match: (h) => has(h, /drawer-(thinking|config|mode)|drawer-head-compact|medium/i) && ["decor-line", "overlap", "edge-clip"].includes(h.kind),
    targets: [{ surface: "focus-brainstorm", selector: '[data-testid="drawer-head-compact"]' }],
  },
];

export function matchKnown(hit) {
  return KNOWN.filter((k) => k.match(hit)).map((k) => k.id);
}
