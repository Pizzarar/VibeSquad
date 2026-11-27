// Storybook item checks (PLAN_STORYBOOK_V2 V4): report-only, mapped onto the F2 audit signals.
//   #13 (integrity, error)  quest/contract item is obtainable (loot, trader stock, recipe, node/action/plant/camp)
//   #14 (integrity, info)   item is never referenced (no source and no use — orphan)
//   #15 (coverage, info)    item has no story (no description and no story mention)

const SOURCE_RELS = new Set([
  "drops", "sells", "produces",
  "first_clear_unique", "kill_valuable", "key_drop", "locked_room_loot", "container_loot", "long_haul_loot",
]);
const USE_RELS = new Set(["wants_item", "item", "ingredient", "upgrade_material"]);
const STORY_ORIGINS = new Set(["trader_relations", "encouragement", "raid_story", "long_haul", "squad"]);

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Build per-item source/use/required index from registry links + adapter node_sources/extra_uses. */
export function buildItemIndex(registry) {
  const byId = new Map();
  for (const it of registry.byKind("item")) {
    byId.set(it.id, {
      item: it,
      sources: [...(Array.isArray(it.data?.node_sources) ? it.data.node_sources : [])],
      uses: [...(Array.isArray(it.data?.extra_uses) ? it.data.extra_uses : [])],
      requiredBy: [],
    });
  }
  for (const e of registry.all()) {
    for (const l of e.links ?? []) {
      if (l.kind !== "item") continue;
      const entry = byId.get(l.id);
      if (!entry) continue;
      if (SOURCE_RELS.has(l.rel)) {
        entry.sources.push({ kind: e.kind, id: e.id, rel: l.rel, label: e.display });
      }
      if (USE_RELS.has(l.rel)) {
        entry.uses.push({ kind: e.kind, id: e.id, rel: l.rel, label: e.display });
        if ((e.kind === "quest_step" && l.rel === "wants_item") || (e.kind === "contract" && l.rel === "item")) {
          entry.requiredBy.push(e);
        }
      }
    }
  }
  return byId;
}

/** Collect narrative text corpus (quest stories/titles, in-game lore, story/flavor lines) + direct story item links. */
function buildStoryCorpus(registry) {
  const chunks = [];
  const linkedStoryItems = new Set();
  for (const q of registry.byKind("quest_step")) {
    const s = [q.data?.title, q.data?.story].filter(Boolean).join(" ");
    if (s) chunks.push(s);
    for (const l of q.links ?? []) if (l.kind === "item" && l.rel === "wants_item") linkedStoryItems.add(l.id);
  }
  for (const l of registry.byKind("lore")) {
    if (l.data?.lore_kind === "doc") continue;
    if (typeof l.data?.text === "string" && l.data.text) chunks.push(l.data.text);
  }
  for (const l of registry.byKind("line")) {
    if (l.data?.rowClass === "story" || STORY_ORIGINS.has(l.data?.origin)) {
      if (typeof l.data?.text === "string" && l.data.text) chunks.push(l.data.text);
      for (const lk of l.links ?? []) if (lk.kind === "item" && lk.rel === "wants_item") linkedStoryItems.add(lk.id);
    }
  }
  return { corpus: chunks.join("\n").toLowerCase(), linkedStoryItems };
}

function hasStoryMention(item, { corpus, linkedStoryItems }) {
  if (linkedStoryItems.has(item.id)) return true;
  if (!corpus) return false;
  const terms = [item.display, item.id.replace(/_/g, " ")].map((t) => String(t ?? "").trim().toLowerCase()).filter((t) => t.length >= 3);
  for (const term of new Set(terms)) {
    if (new RegExp(`\\b${escRe(term)}\\b`, "i").test(corpus)) return true;
  }
  return false;
}

export const checks = [
  {
    id: "#13",
    title: "quest/contract item obtainable",
    run({ registry }) {
      const idx = buildItemIndex(registry);
      const out = [];
      for (const { item, sources, requiredBy } of idx.values()) {
        if (!requiredBy.length || sources.length > 0) continue;
        const who = requiredBy.slice(0, 4).map((e) => `${e.kind}:${e.id}`).join(", ") + (requiredBy.length > 4 ? ` (+${requiredBy.length - 4} more)` : "");
        out.push({
          check: "#13",
          severity: "error",
          entityRef: { kind: "item", id: item.id },
          msg: `${item.display} (${item.id}) is required by ${who} but has no source (no loot, trader stock, recipe, or node)`,
          source: item.source ?? null,
        });
      }
      return out;
    },
  },
  {
    id: "#14",
    title: "item never referenced (orphan)",
    run({ registry }) {
      const idx = buildItemIndex(registry);
      const out = [];
      for (const { item, sources, uses } of idx.values()) {
        if (sources.length > 0 || uses.length > 0) continue;
        out.push({
          check: "#14",
          severity: "info",
          entityRef: { kind: "item", id: item.id },
          msg: `${item.display} (${item.id}) is never referenced (no source and no use)`,
          source: item.source ?? null,
        });
      }
      return out;
    },
  },
  {
    id: "#15",
    title: "item has no story",
    run({ registry }) {
      const story = buildStoryCorpus(registry);
      const out = [];
      for (const item of registry.byKind("item")) {
        const hasDesc = typeof item.data?.description === "string" && item.data.description.trim().length > 0;
        if (hasDesc || hasStoryMention(item, story)) continue;
        out.push({
          check: "#15",
          severity: "info",
          entityRef: { kind: "item", id: item.id },
          msg: `${item.display} (${item.id}) has no story (no description and no story mention)`,
          source: item.source ?? null,
        });
      }
      return out;
    },
  },
];
