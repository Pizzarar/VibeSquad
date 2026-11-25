// Registry kind: Art slot (F4). One slot of art for an entity (a portrait or a sprite). Its production state is the
// art's own state: "final" (COMMISSIONED), "ai-draft" (PIPELINE), "placeholder", or "missing" (no art). Read-only: the
// Storybook adapter (adapters/efi.mjs) ingests it from data/art_manifest.json for coverage counting; no gallery UI.
export default { kind: "art_slot", label: "Art slot", order: 1060, reserved: false, lane: "storybook", required: [], slots: ["art"] };
