// Leaf module (no app imports): paseo.ts re-exports this, but importers use it directly so a
// cycle back into paseo.ts can't observe DEMO before it's initialised (vite dev TDZ).
// ?demo swaps the daemon for a fixed cast so the art can be reviewed without live agents.
// typeof guard: node tests import this leaf without a browser `location`.
export const DEMO = typeof location !== "undefined" && new URLSearchParams(location.search).has("demo");
