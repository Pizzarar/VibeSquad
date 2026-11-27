// Storybook V12: Placeholder -> final progress rollup.
// Computed once per snapshot on the server (alongside audit.mjs / unlocks.mjs); client renders and applies live V6 mark deltas.
//
// Areas (5):
//   traders   — trader dialogue/quest lines + trader portraits
//   locations — map/location lines + location art
//   squad     — squad/party lines + squad portraits
//   items     — item lines + item icons
//   ui        — system/UI/other lines + UI/system art slots
//
// Per-entity rollups are keyed by:
//   location:<id>, trader:<id>, squad:<id>, enemy:<id>, item:<id>, party:<id>, system:<id>, narrator:<id>
import { rowKey } from "./marks.mjs";

export const PROGRESS_AREAS = Object.freeze([
  { id: "traders", label: "Traders" },
  { id: "locations", label: "Maps & locations" },
  { id: "squad", label: "Squad" },
  { id: "items", label: "Items" },
  { id: "ui", label: "UI & system" },
]);

export const TEXT_BUCKETS = Object.freeze(["ok", "draft", "rewrite", "todo"]);

const emptyText = () => ({ ok: 0, draft: 0, rewrite: 0, todo: 0, total: 0 });
const emptyArt = (tracked = false) => ({ tracked, final: 0, draft: 0, placeholder: 0, missing: 0, total: 0 });

/** Map a text_review.csv status (or V6 mark status) / entity production state into one of the 4 honest buckets. */
export function statusToBucket(status, production = null) {
  const s = typeof status === "string" ? status.trim().toUpperCase() : "";
  if (s === "OWNER-OK" || s === "OK" || s === "FINAL") return "ok";
  if (s === "NEEDS-REWRITE" || s === "REDO") return "rewrite";
  if (s === "DRAFT" || s === "VERIFY" || s === "AI-DRAFT") return "draft";
  if (s === "STORY-TODO" || s === "TODO" || s === "PLACEHOLDER" || s === "MISSING") return "todo";
  if (production === "final") return "ok";
  if (production === "needs-review") return "rewrite";
  if (production === "ai-draft") return "draft";
  return "todo";
}

/** Bucket a V6 owner mark shows in Review: OWNER-OK is OK, any other mark status is a Redo (needs rewrite). */
export function markToBucket(status) {
  return typeof status === "string" && status.trim().toUpperCase() === "OWNER-OK" ? "ok" : "rewrite";
}

/** Map a line entity to its primary V12 area id. Every line belongs to exactly one area. */
export function lineAreaId(e) {
  const d = e?.data ?? {};
  const sk = typeof d.speakerKind === "string" ? d.speakerKind.toLowerCase() : "";
  const sid = typeof d.speakerId === "string" ? d.speakerId.toLowerCase() : "";
  const file = String(d.file ?? e?.source?.path ?? "");
  const links = Array.isArray(e?.links) ? e.links : [];
  if (sk === "trader") return "traders";
  if (sk === "squad" || sk === "party") return "squad";
  if (links.some((l) => l.kind === "location") || /(^|[\\/])locations\.json$/i.test(file) || sid === "locations") return "locations";
  if (links.some((l) => l.kind === "item") || /(^|[\\/])items\.json$/i.test(file) || sid === "items") return "items";
  return "ui";
}

/** Owning item/location sheet of an items.json / locations.json row (no link; its data id is "<entityId>.<field>"). */
function dataFileOwner(e, itemIdByLower, locIdByLower) {
  const d = e?.data ?? {};
  const file = String(d.file ?? e?.source?.path ?? "");
  const id = typeof d.id === "string" ? d.id : "";
  const dot = id.indexOf(".");
  if (dot <= 0) return null;
  const pre = id.slice(0, dot).toLowerCase();
  if (/(^|[\\/])items\.json$/i.test(file) && itemIdByLower.has(pre)) return `item:${itemIdByLower.get(pre)}`;
  if (/(^|[\\/])locations\.json$/i.test(file) && locIdByLower.has(pre)) return `location:${locIdByLower.get(pre)}`;
  return null;
}

/** Speaker key for a line entity (matches src/storybookLogic.ts lineSpeakerKey). */
function lineSpeakerKey(e) {
  const d = e?.data ?? {};
  if (typeof d.speakerKind === "string" && d.speakerKind && typeof d.speakerId === "string" && d.speakerId) {
    return `${d.speakerKind.toLowerCase()}:${d.speakerId.toLowerCase()}`;
  }
  const link = (e?.links ?? []).find((l) => l.rel === "spoken_by");
  if (link) return `${String(link.kind).toLowerCase()}:${String(link.id).toLowerCase()}`;
  const legacy = typeof d.speaker === "string" ? d.speaker.trim().toLowerCase() : "";
  return legacy ? `legacy:${legacy}` : "system:system";
}

/** Mark key for a csv-backed line entity (same identity as marks.mjs rowKey); null for non-csv lines. */
export function lineMarkKey(e) {
  const d = e?.data;
  if (!e || e.kind !== "line" || !d || d.origin !== "csv" || typeof d.file !== "string" || !d.file) return null;
  return rowKey({ file: d.file, data_path: d.data_path ?? "", where_seen: d.where_seen ?? "", current_text: d.current_text ?? "" });
}

/** Classify a single art_slot production state into final | draft | placeholder | missing. */
function artProdBucket(prod) {
  if (prod === "final") return "final";
  if (prod === "ai-draft" || prod === "needs-review") return "draft";
  if (prod === "placeholder") return "placeholder";
  return "missing";
}

/** Aggregate multiple art_slots for one entity into one entity-level art state. */
function entityArtBucket(slots) {
  if (!slots || slots.length === 0) return "missing";
  const states = slots.map((s) => artProdBucket(s.production));
  if (states.every((s) => s === "final")) return "final";
  if (states.some((s) => s === "final" || s === "draft")) return "draft";
  if (states.some((s) => s === "placeholder")) return "placeholder";
  return "missing";
}

/**
 * Normalize optional marks input into Map<rowKey, statusString>.
 * Accepts: null/undefined, Map<string, string|{status}>, Array<{key, status}>, or plain object { [key]: status|{status} }.
 */
function normalizeMarks(marks) {
  const out = new Map();
  if (!marks) return out;
  if (marks instanceof Map) {
    for (const [k, v] of marks) {
      const st = typeof v === "string" ? v : v?.status;
      if (k && typeof st === "string" && st) out.set(k, st);
    }
    return out;
  }
  if (Array.isArray(marks)) {
    for (const m of marks) {
      if (m && typeof m.key === "string" && m.key && typeof m.status === "string" && m.status) out.set(m.key, m.status);
    }
    return out;
  }
  if (typeof marks === "object") {
    for (const [k, v] of Object.entries(marks)) {
      const st = typeof v === "string" ? v : v?.status;
      if (k && typeof st === "string" && st) out.set(k, st);
    }
  }
  return out;
}

/**
 * Compute the V12 progress rollup for one snapshot.
 *
 * Returns:
 * {
 *   areas: [{ id, label, text: {ok,draft,rewrite,todo,total}, art: {tracked,final,draft,placeholder,missing,total} }],
 *   entities: { [entityKey]: { id, kind, label, text, art } },
 *   lineAreas: { [lineEntityId]: areaId },
 *   lineSheets: { [lineEntityId]: entityKey[] }   (the sheets that show the line; Review's entity filter reads this)
 *   markIndex: { [markKey]: { lines: [{ base, area, entities, n }] } },  (n = csv rows sharing that key)
 *   artTracked: boolean,
 * }
 */
export function buildProgress(snapshot, { marks = null } = {}) {
  const entities = Array.isArray(snapshot?.entities) ? snapshot.entities : [];
  const markMap = normalizeMarks(marks);
  const artSlots = entities.filter((e) => e.kind === "art_slot");
  const artTracked = artSlots.length > 0;

  // 1. Initialize area accumulators
  const areaById = new Map();
  for (const a of PROGRESS_AREAS) {
    areaById.set(a.id, { id: a.id, label: a.label, text: emptyText(), art: emptyArt(artTracked) });
  }

  // 2. Initialize per-entity accumulators for all sheet-bearing entities
  const entityRollups = new Map();
  const ensureEntity = (key, kind, label) => {
    let rec = entityRollups.get(key);
    if (!rec) {
      rec = { id: key, kind, label, text: emptyText(), art: emptyArt(false) };
      entityRollups.set(key, rec);
    }
    return rec;
  };

  const traders = [];
  const locations = [];
  const squad = [];
  const items = [];
  const enemies = [];
  const locIds = new Set();
  const itemIds = new Set();
  const itemIdByLower = new Map();
  const locIdByLower = new Map();

  for (const e of entities) {
    if (e.kind === "trader") {
      traders.push(e);
      ensureEntity(`trader:${e.id.toLowerCase()}`, "trader", e.display);
    } else if (e.kind === "location") {
      locations.push(e);
      locIds.add(e.id.toLowerCase());
      locIdByLower.set(e.id.toLowerCase(), e.id);
      ensureEntity(`location:${e.id}`, "location", e.display);
    } else if (e.kind === "squad") {
      squad.push(e);
      ensureEntity(`squad:${e.id.toLowerCase()}`, "squad", e.display);
    } else if (e.kind === "item") {
      items.push(e);
      itemIds.add(e.id.toLowerCase());
      itemIdByLower.set(e.id.toLowerCase(), e.id);
      ensureEntity(`item:${e.id}`, "item", e.display);
    } else if (e.kind === "enemy") {
      enemies.push(e);
      ensureEntity(`enemy:${e.id.toLowerCase()}`, "enemy", e.display);
    }
  }

  // 3. Index art_slots -> entity keys + track which art_slots are claimed by non-UI entities
  const slotsByEntity = new Map(); // entityKey -> art_slot[]
  const addSlot = (ek, slot) => {
    const arr = slotsByEntity.get(ek);
    if (arr) arr.push(slot);
    else slotsByEntity.set(ek, [slot]);
  };
  const claimedArtIds = new Set();

  if (artTracked) {
    for (const a of artSlots) {
      let claimed = false;
      for (const l of a.links ?? []) {
        if (l.project !== undefined) continue;
        if (l.kind === "trader" || l.kind === "squad" || l.kind === "enemy") {
          addSlot(`${l.kind}:${String(l.id).toLowerCase()}`, a);
          claimed = true;
        } else if (l.kind === "location" || l.kind === "item") {
          addSlot(`${l.kind}:${l.id}`, a);
          claimed = true;
        }
      }
      if (!claimed) {
        const ak = String(a.data?.artKind ?? "");
        const aid = String(a.id ?? "");
        if ((ak === "location_art" || aid.startsWith("location.")) && aid.startsWith("location.")) {
          const lid = aid.slice("location.".length);
          if (locIds.has(lid.toLowerCase())) {
            const loc = locations.find((x) => x.id.toLowerCase() === lid.toLowerCase());
            if (loc) { addSlot(`location:${loc.id}`, a); claimed = true; }
          }
        } else if ((ak === "item_icon" || aid.startsWith("item.")) && aid.startsWith("item.")) {
          const iid = aid.slice("item.".length);
          if (itemIds.has(iid.toLowerCase())) {
            const it = items.find((x) => x.id.toLowerCase() === iid.toLowerCase());
            if (it) { addSlot(`item:${it.id}`, a); claimed = true; }
          }
        } else if (ak === "raid_anchors" || ak === "raid_cover" || ak === "raid_still" || ak === "raid_prop_sprite") {
          // Location/raid-level auxiliary art slots: keep out of UI art count so UI art stays honest
          claimed = true;
        }
      }
      if (claimed) claimedArtIds.add(a.id);
    }

    // Populate art rollups on entity sheets and entity-backed areas
    const fillEntityAreaArt = (areaId, ents, keyOf) => {
      const areaArt = areaById.get(areaId).art;
      for (const e of ents) {
        const ek = keyOf(e);
        const slots = slotsByEntity.get(ek) ?? [];
        const rec = entityRollups.get(ek);
        // Entity sheet art: if it has multiple slots (e.g. enemy portrait + sprites), count each slot; if 0 slots, 1 missing slot.
        if (rec) {
          rec.art = emptyArt(true);
          if (slots.length === 0) {
            rec.art.missing = 1;
            rec.art.total = 1;
          } else {
            for (const s of slots) {
              const b = artProdBucket(s.production);
              rec.art[b]++;
              rec.art.total++;
            }
          }
        }
        // Area art: one unit per entity in the area (e.g. "art 3/7" for 7 traders)
        if (areaArt) {
          const eb = entityArtBucket(slots);
          areaArt[eb]++;
          areaArt.total++;
        }
      }
    };

    fillEntityAreaArt("traders", traders, (e) => `trader:${e.id.toLowerCase()}`);
    fillEntityAreaArt("locations", locations, (e) => `location:${e.id}`);
    fillEntityAreaArt("squad", squad, (e) => `squad:${e.id.toLowerCase()}`);
    fillEntityAreaArt("items", items, (e) => `item:${e.id}`);
    // Enemies get per-entity art rollups (not a separate top-level Home area)
    for (const e of enemies) {
      const ek = `enemy:${e.id.toLowerCase()}`;
      const slots = slotsByEntity.get(ek) ?? [];
      const rec = entityRollups.get(ek);
      if (rec) {
        rec.art = emptyArt(true);
        if (slots.length === 0) {
          rec.art.missing = 1;
          rec.art.total = 1;
        } else {
          for (const s of slots) {
            const b = artProdBucket(s.production);
            rec.art[b]++;
            rec.art.total++;
          }
        }
      }
    }

    // UI & system art: all unclaimed art_slots (ui_kit, nav_icon, font, room_icon, etc.)
    const uiArt = areaById.get("ui").art;
    for (const a of artSlots) {
      if (claimedArtIds.has(a.id)) continue;
      const b = artProdBucket(a.production);
      uiArt[b]++;
      uiArt.total++;
    }
  }

  // 4. Roll up all text lines into their area AND every matching entity sheet
  const lineAreas = {};
  const markIndex = {};
  const lineSheets = {};

  for (const e of entities) {
    if (e.kind !== "line") continue;
    const areaId = lineAreaId(e);
    lineAreas[e.id] = areaId;

    const mk = lineMarkKey(e);
    const baseBucket = statusToBucket(e.data?.status, e.production);
    const effectiveBucket = mk && markMap.has(mk) ? markToBucket(markMap.get(mk)) : baseBucket;

    const areaText = areaById.get(areaId).text;
    areaText[effectiveBucket]++;
    areaText.total++;

    // ONE attribution rule: the sheets that show this line = its speaker sheet + every linked location/item/enemy +
    // the owning item/location of a data-file row (items.json / locations.json rows carry no link, only an id prefix).
    // Review's entity filter reads this same list (lineSheets), so a sheet bar always equals its Review list.
    const sheetKeys = new Set();
    const sk = lineSpeakerKey(e);
    if (sk) {
      sheetKeys.add(sk);
      if (!entityRollups.has(sk)) {
        const i = sk.indexOf(":");
        ensureEntity(sk, sk.slice(0, i), sk.slice(i + 1));
      }
    }
    for (const l of e.links ?? []) {
      if (l.kind === "location") sheetKeys.add(`location:${l.id}`);
      else if (l.kind === "item") sheetKeys.add(`item:${l.id}`);
      else if (l.kind === "enemy") sheetKeys.add(`enemy:${String(l.id).toLowerCase()}`);
    }
    const owner = dataFileOwner(e, itemIdByLower, locIdByLower);
    if (owner) sheetKeys.add(owner);

    const validSheets = [];
    for (const ek of sheetKeys) {
      const rec = entityRollups.get(ek);
      if (!rec) continue;
      rec.text[effectiveBucket]++;
      rec.text.total++;
      validSheets.push(ek);
    }
    lineSheets[e.id] = validSheets;

    if (mk) {
      // Several csv rows can share one mark key (duplicate text); Review flips all of them, so keep every line's
      // (base, area, sheets) grouped with a count and let the client move exactly that many.
      const group = (markIndex[mk] ??= { lines: [] });
      const sig = `${baseBucket}|${areaId}|${validSheets.join(",")}`;
      const hit = group.lines.find((g) => g.sig === sig);
      if (hit) hit.n++;
      else group.lines.push({ sig, base: baseBucket, area: areaId, entities: validSheets, n: 1 });
    }
  }

  const areas = PROGRESS_AREAS.map((a) => areaById.get(a.id));
  const entitiesOut = Object.fromEntries(entityRollups);

  for (const g of Object.values(markIndex)) for (const l of g.lines) delete l.sig;
  return { areas, entities: entitiesOut, lineAreas, lineSheets, markIndex, artTracked };
}
