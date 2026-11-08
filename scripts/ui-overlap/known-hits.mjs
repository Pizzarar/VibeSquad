// The hits Aub reported (docs/PLAN_OVERLAP_AUDIT_V1.md rounds 1-3). The guard must flag each one;
// `matchers` classify aggregated hits, `targets` are always screenshotted (so "not reproduced" has a picture).
const hay = (h) => `${h.selector} ${h.classes.join(" ")} ${h.text} ${h.other?.selector ?? ""} ${(h.other?.classes ?? []).join(" ")} ${h.other?.text ?? ""}`;
const has = (h, re) => re.test(hay(h));

const CTX_BAR = /brainstorm-ctx-bar|pin-rail-active-ctx/i;
const GEOM = ["decor-line", "decor-suspect", "overlap", "edge-clip", "text-outside-container", "text-overflow", "truncated", "contrast"];

export const KNOWN = [
  {
    id: "r1-summary-blank-btn", what: "R1: blank yellow button left of SUMMARY in the active card's token row (label invisible, contrast hit on a ctx-bar button)",
    // Exact: a contrast hit on a button inside the token (ctx) bar row or labelled Handoff/Summary/Inbox.
    match: (h) => h.kind === "contrast" && h.tag === "button" && (has(h, CTX_BAR) || /^(handoff|summary|inbox)$/i.test(h.text.replace(/^\W+/, ""))),
    targets: [{ surface: "focus-brainstorm-hot", selector: '[data-testid="brainstorm-ctx-bar"]' }, { surface: "focus-brainstorm", selector: '[data-testid="brainstorm-ctx-bar"]' }],
  },
  {
    id: "r1-tok-label-over-bar", what: "R1: '115K / 150K TOK' label sits on top of its own bar",
    match: (h) => /\btok\b/i.test(h.text) && has(h, CTX_BAR) && ["decor-line", "decor-suspect", "overlap", "text-outside-container", "contrast"].includes(h.kind),
    targets: [{ surface: "focus-brainstorm-hot", selector: '[data-testid="brainstorm-ctx-bar"]' }],
  },
  {
    id: "r1-provider-badge-over-avatar", what: "R1: provider badge (red */cyan diamond) covers the avatar sprite",
    match: (h) => has(h, /prov-badge/i) && has(h, /cast-sprite|avatar/i),
    targets: [{ surface: "focus-brainstorm", selector: '[data-testid="pin-rail-riffbot"]' }],
  },
  {
    id: "r2-chip-row-clipping", what: "R2: worker chip row above the composer clips titles mid-word / last chip runs off the edge",
    match: (h) => has(h, /drawer-subagent|subagents-bar|subagent-chip/i) && ["edge-clip", "text-overflow", "text-outside-container", "overlap", "truncated", "decor-line"].includes(h.kind),
    targets: [{ surface: "composer", selector: '[data-testid="drawer-subagents-bar"]' }],
  },
  {
    id: "r3-settings-header", what: "R3: Settings header: SETTINGS label above/outside its bar, bar edge through text, right button half-clipped",
    match: (h) => h.surface === "settings" && has(h, /modal-head/i) && GEOM.includes(h.kind),
    targets: [{ surface: "settings", selector: ".modal-head" }],
  },
  {
    id: "r3-exposed-banner-line", what: "R3: EXPOSED ON ... LAN banner has a horizontal line through the text",
    match: (h) => has(h, /exposed-network-banner/i) && ["decor-line", "decor-suspect"].includes(h.kind),
    targets: [{ surface: "squads-home", selector: '[data-testid="exposed-network-banner"]' }],
  },
  {
    id: "r3-squads-rail-line", what: "R3: Squads rail button (PinRail.tsx:237) has a horizontal line across icon/label",
    match: (h) => has(h, /pin-focus-home/i) && ["decor-line", "decor-suspect"].includes(h.kind),
    targets: [{ surface: "focus-brainstorm", selector: '[data-testid="pin-focus-bar"]' }],
  },
  {
    id: "r3-squads-label-truncated", what: "R3: Squads label truncated to 'Squa...'",
    match: (h) => h.kind === "truncated" && (/^squa/i.test(h.text) || has(h, /pin-focus-home|breadcrumb-squads|pin-rail-squads/i) || /squa/i.test(h.text)),
    targets: [{ surface: "focus-brainstorm", selector: '[data-testid="top-breadcrumb"]' }],
  },
  {
    id: "r3-medium-auto-chip-line", what: "R3: MEDIUM · AUTO chip (drawer-config-menu-btn, 'medium · <mode>') has a line through/at its top and its bottom border runs into the bar; must be found by the composer surface",
    match: (h) => h.surface === "composer" && has(h, /drawer-config-menu-btn|drawer-config-summary/i) && GEOM.includes(h.kind),
    targets: [{ surface: "composer", selector: '[data-testid="drawer-config-menu-btn"]' }],
  },
];

export function matchKnown(hit) {
  return KNOWN.filter((k) => k.match(hit)).map((k) => k.id);
}
