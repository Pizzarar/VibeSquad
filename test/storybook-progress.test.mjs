import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildProgress, lineAreaId, lineMarkKey, PROGRESS_AREAS, statusToBucket } from "../server/storybook/progress.mjs";
import { markState } from "../src/storybookMarks.ts";
import { applyLiveMarks, formatArtSummary, formatProgressSummary } from "../src/storybookProgress.ts";

function makeLine({ id, file = "data/quests.json", data_path = `["${id}"]`, status = "STORY-TODO", origin = "csv", speakerKind = "trader", speakerId = "popper", links = [], production = "placeholder" }) {
  return {
    id,
    kind: "line",
    display: id,
    aliases: [],
    source: { path: file, line: 1 },
    links,
    production,
    data: {
      origin,
      file,
      data_path,
      where_seen: "",
      current_text: `Text for ${id}`,
      text: `Text for ${id}`,
      status,
      speakerKind,
      speakerId,
    },
  };
}

function makeEntity(kind, id, display = id, extra = {}) {
  return {
    id,
    kind,
    display,
    aliases: [],
    source: { path: `data/${kind}s.json`, line: 1 },
    links: [],
    production: null,
    data: {},
    ...extra,
  };
}

function makeArt(id, production, { links = [], artKind = "other" } = {}) {
  return {
    id,
    kind: "art_slot",
    display: id,
    aliases: [],
    source: { path: "art/manifest.json", line: 1 },
    links,
    production,
    data: { artKind, slot: "portrait", status: production.toUpperCase() },
  };
}

describe("V12 progress rollup (server/storybook/progress.mjs)", () => {
  it("maps statuses and production states to the 4 honest buckets", () => {
    assert.equal(statusToBucket("OWNER-OK"), "ok");
    assert.equal(statusToBucket("DRAFT"), "draft");
    assert.equal(statusToBucket("VERIFY"), "draft");
    assert.equal(statusToBucket("NEEDS-REWRITE"), "rewrite");
    assert.equal(statusToBucket("STORY-TODO"), "todo");
    assert.equal(statusToBucket("", "final"), "ok");
    assert.equal(statusToBucket(null, "ai-draft"), "draft");
    assert.equal(statusToBucket(null, "needs-review"), "rewrite");
    assert.equal(statusToBucket(null, "placeholder"), "todo");
  });

  it("rolls up text statuses and F4 art production per area and per entity", () => {
    const snap = {
      entities: [
        makeEntity("trader", "popper", "Popper"),
        makeEntity("trader", "doc", "Doc"),
        makeEntity("location", "customs_depot", "Customs Depot"),
        makeEntity("squad", "saint", "Saint"),
        makeEntity("item", "brass_casing", "Brass Casing"),
        makeEntity("enemy", "scav", "Scav"),
        // Trader lines: 1 OK, 1 draft, 1 rewrite, 1 todo
        makeLine({ id: "l1", status: "OWNER-OK", speakerKind: "trader", speakerId: "popper" }),
        makeLine({ id: "l2", status: "DRAFT", speakerKind: "trader", speakerId: "popper" }),
        makeLine({ id: "l3", status: "NEEDS-REWRITE", speakerKind: "trader", speakerId: "doc" }),
        makeLine({ id: "l4", status: "STORY-TODO", speakerKind: "trader", speakerId: "doc" }),
        // Location line
        makeLine({ id: "l5", file: "data/locations.json", status: "DRAFT", speakerKind: "system", speakerId: "locations", links: [{ rel: "said_at", kind: "location", id: "customs_depot" }] }),
        // Squad line
        makeLine({ id: "l6", file: "data/squad.json", status: "OWNER-OK", speakerKind: "squad", speakerId: "saint" }),
        // Item line
        makeLine({ id: "l7", file: "data/items.json", status: "STORY-TODO", speakerKind: "system", speakerId: "items", links: [{ rel: "mentions", kind: "item", id: "brass_casing" }] }),
        // UI line
        makeLine({ id: "l8", file: "scripts/ui.gd", data_path: "", status: "STORY-TODO", speakerKind: "system", speakerId: "shell" }),
        // Art slots
        makeArt("trader.popper", "final", { artKind: "trader_portrait", links: [{ rel: "portrait", kind: "trader", id: "popper" }] }),
        makeArt("trader.doc", "ai-draft", { artKind: "trader_portrait", links: [{ rel: "portrait", kind: "trader", id: "doc" }] }),
        makeArt("location.customs_depot", "placeholder", { artKind: "location_art" }),
        makeArt("squad.saint", "missing", { artKind: "squad_portrait", links: [{ rel: "portrait", kind: "squad", id: "saint" }] }),
        makeArt("item.brass_casing", "final", { artKind: "item_icon" }),
        makeArt("ui.panel", "ai-draft", { artKind: "ui_kit" }),
      ],
    };

    const p = buildProgress(snap);
    assert.equal(p.artTracked, true);
    assert.equal(p.areas.length, PROGRESS_AREAS.length);

    const byId = Object.fromEntries(p.areas.map((a) => [a.id, a]));
    assert.deepEqual(byId.traders.text, { ok: 1, draft: 1, rewrite: 1, todo: 1, total: 4 });
    assert.deepEqual(byId.traders.art, { tracked: true, final: 1, draft: 1, placeholder: 0, missing: 0, total: 2 });

    assert.deepEqual(byId.locations.text, { ok: 0, draft: 1, rewrite: 0, todo: 0, total: 1 });
    assert.deepEqual(byId.locations.art, { tracked: true, final: 0, draft: 0, placeholder: 1, missing: 0, total: 1 });

    assert.deepEqual(byId.squad.text, { ok: 1, draft: 0, rewrite: 0, todo: 0, total: 1 });
    assert.deepEqual(byId.squad.art, { tracked: true, final: 0, draft: 0, placeholder: 0, missing: 1, total: 1 });

    assert.deepEqual(byId.items.text, { ok: 0, draft: 0, rewrite: 0, todo: 1, total: 1 });
    assert.deepEqual(byId.items.art, { tracked: true, final: 1, draft: 0, placeholder: 0, missing: 0, total: 1 });

    assert.deepEqual(byId.ui.text, { ok: 0, draft: 0, rewrite: 0, todo: 1, total: 1 });
    assert.deepEqual(byId.ui.art, { tracked: true, final: 0, draft: 1, placeholder: 0, missing: 0, total: 1 });

    // Per-entity rollups
    assert.deepEqual(p.entities["trader:popper"].text, { ok: 1, draft: 1, rewrite: 0, todo: 0, total: 2 });
    assert.deepEqual(p.entities["trader:popper"].art, { tracked: true, final: 1, draft: 0, placeholder: 0, missing: 0, total: 1 });
    assert.deepEqual(p.entities["location:customs_depot"].text, { ok: 0, draft: 1, rewrite: 0, todo: 0, total: 1 });
    assert.deepEqual(p.entities["enemy:scav"].text, { ok: 0, draft: 0, rewrite: 0, todo: 0, total: 0 });
    assert.deepEqual(p.entities["enemy:scav"].art, { tracked: true, final: 0, draft: 0, placeholder: 0, missing: 1, total: 1 });
  });

  it("handles areas with 0 lines and snapshots with no art_slots", () => {
    const snap = {
      entities: [
        makeEntity("trader", "popper", "Popper"),
        makeEntity("location", "empty_map", "Empty Map"),
        makeLine({ id: "l1", status: "DRAFT", speakerKind: "trader", speakerId: "popper" }),
      ],
    };
    const p = buildProgress(snap);
    assert.equal(p.artTracked, false);
    const byId = Object.fromEntries(p.areas.map((a) => [a.id, a]));
    assert.deepEqual(byId.locations.text, { ok: 0, draft: 0, rewrite: 0, todo: 0, total: 0 });
    assert.deepEqual(byId.squad.text, { ok: 0, draft: 0, rewrite: 0, todo: 0, total: 0 });
    assert.deepEqual(byId.items.text, { ok: 0, draft: 0, rewrite: 0, todo: 0, total: 0 });
    assert.deepEqual(byId.ui.text, { ok: 0, draft: 0, rewrite: 0, todo: 0, total: 0 });
    assert.equal(byId.traders.art.tracked, false);
    assert.equal(byId.traders.art.total, 0);
    assert.equal(formatArtSummary(byId.traders.art), "");
    assert.equal(formatProgressSummary(byId.locations), "Maps & locations: 0 lines");
  });

  it("marks missing art when art is tracked but an entity has no art_slot", () => {
    const snap = {
      entities: [
        makeEntity("trader", "popper", "Popper"),
        makeEntity("trader", "fence", "Fence"),
        makeArt("trader.popper", "final", { artKind: "trader_portrait", links: [{ rel: "portrait", kind: "trader", id: "popper" }] }),
      ],
    };
    const p = buildProgress(snap);
    const traders = p.areas.find((a) => a.id === "traders");
    assert.deepEqual(traders.art, { tracked: true, final: 1, draft: 0, placeholder: 0, missing: 1, total: 2 });
    assert.deepEqual(p.entities["trader:fence"].art, { tracked: true, final: 0, draft: 0, placeholder: 0, missing: 1, total: 1 });
    assert.equal(formatArtSummary(traders.art), "art 1/2 (1 missing)");
  });

  it("overrides sheet status with V6 marks (server-side buildProgress and client applyLiveMarks)", () => {
    const l1 = makeLine({ id: "l1", status: "STORY-TODO", speakerKind: "trader", speakerId: "popper", links: [{ rel: "said_at", kind: "location", id: "depot" }] });
    const l2 = makeLine({ id: "l2", status: "DRAFT", speakerKind: "trader", speakerId: "popper" });
    const snap = {
      entities: [
        makeEntity("trader", "popper", "Popper"),
        makeEntity("location", "depot", "Depot"),
        l1,
        l2,
      ],
    };
    const k1 = lineMarkKey(l1);
    const k2 = lineMarkKey(l2);
    assert.ok(k1 && k2);

    // Server-side override
    const withServerMarks = buildProgress(snap, {
      marks: [
        { key: k1, status: "OWNER-OK" },
        { key: k2, status: "NEEDS-REWRITE" },
      ],
    });
    const tradersServer = withServerMarks.areas.find((a) => a.id === "traders");
    assert.deepEqual(tradersServer.text, { ok: 1, draft: 0, rewrite: 1, todo: 0, total: 2 });
    assert.deepEqual(withServerMarks.entities["trader:popper"].text, { ok: 1, draft: 0, rewrite: 1, todo: 0, total: 2 });
    assert.deepEqual(withServerMarks.entities["location:depot"].text, { ok: 1, draft: 0, rewrite: 0, todo: 0, total: 1 });

    // Client-side live mark delta over base snapshot progress must match server-side override identically
    const base = buildProgress(snap);
    assert.deepEqual(base.areas.find((a) => a.id === "traders").text, { ok: 0, draft: 1, rewrite: 0, todo: 1, total: 2 });

    const live = applyLiveMarks(base, [
      { key: k1, file: "data/quests.json", line: "1", data_path: '["l1"]', where_seen: "", status: "OWNER-OK", note: "", contracts: {}, rewrite: "", text: "", hashOk: true },
      { key: k2, file: "data/quests.json", line: "1", data_path: '["l2"]', where_seen: "", status: "NEEDS-REWRITE", note: "fix", contracts: {}, rewrite: "", text: "", hashOk: true },
    ]);
    assert.deepEqual(live.areas.find((a) => a.id === "traders").text, tradersServer.text);
    assert.deepEqual(live.entities["trader:popper"].text, withServerMarks.entities["trader:popper"].text);
    assert.deepEqual(live.entities["location:depot"].text, withServerMarks.entities["location:depot"].text);

    // Clearing marks reverts to base without mutating base
    const reverted = applyLiveMarks(base, []);
    assert.equal(reverted, base);
    assert.deepEqual(base.areas.find((a) => a.id === "traders").text, { ok: 0, draft: 1, rewrite: 0, todo: 1, total: 2 });
  });

  it("classifies every line into one of the 5 areas", () => {
    assert.equal(lineAreaId(makeLine({ id: "a", speakerKind: "trader", speakerId: "doc" })), "traders");
    assert.equal(lineAreaId(makeLine({ id: "b", speakerKind: "squad", speakerId: "saint" })), "squad");
    assert.equal(lineAreaId(makeLine({ id: "c", speakerKind: "party", speakerId: "squad" })), "squad");
    assert.equal(lineAreaId(makeLine({ id: "d", speakerKind: "system", speakerId: "raids", links: [{ rel: "said_at", kind: "location", id: "depot" }] })), "locations");
    assert.equal(lineAreaId(makeLine({ id: "e", speakerKind: "system", speakerId: "items", file: "data/items.json" })), "items");
    assert.equal(lineAreaId(makeLine({ id: "f", speakerKind: "system", speakerId: "shell", file: "scripts/ui.gd" })), "ui");
  });

  it("invariant: every bar segment (area + sheet) equals the Review filter's row count, before and after a mark on a duplicated key", () => {
    const L = (id, o = {}) => makeLine({ id, ...o });
    const dup = '["dup"]';
    const lines = [
      L("t1", { status: "DRAFT", production: "ai-draft" }),
      L("t2", { status: "STORY-TODO" }),
      // two csv rows sharing one mark key (same file + data_path), different base statuses, one trader
      L("d1", { data_path: dup, status: "DRAFT" }),
      L("d2", { data_path: dup, status: "STORY-TODO" }),
      L("d3", { data_path: dup, status: "OWNER-OK" }),
      // items.json rows carry no link: owned by their id prefix
      L("i1", { file: "data/items.json", data_path: '["items",0,"name"]', speakerKind: "system", speakerId: "items", status: "STORY-TODO" }),
      L("i2", { file: "data/items.json", data_path: '["items",0,"desc"]', speakerKind: "system", speakerId: "items", status: "DRAFT" }),
      // a squad line that mentions the item and the location (counts on those sheets, not in their areas)
      L("s1", { speakerKind: "squad", speakerId: "saint", status: "DRAFT", links: [{ rel: "mentions", kind: "item", id: "brass" }, { rel: "said_at", kind: "location", id: "depot" }] }),
      L("l1", { file: "data/locations.json", data_path: '["locations",0,"name"]', speakerKind: "system", speakerId: "locations", status: "STORY-TODO" }),
      L("u1", { file: "scripts/ui.gd", data_path: "", speakerKind: "system", speakerId: "shell", status: "DRAFT" }),
    ];
    lines[5].data.id = "brass.name";
    lines[6].data.id = "brass.desc";
    lines[8].data.id = "depot.name";
    const snap = { entities: [makeEntity("trader", "popper"), makeEntity("squad", "saint"), makeEntity("item", "brass"), makeEntity("location", "depot"), ...lines] };
    const base = buildProgress(snap);
    const dupKey = lineMarkKey(lines[2]);
    assert.equal(base.markIndex[dupKey].lines.reduce((n, g) => n + g.n, 0), 3);

    const reviewBucket = (e, marks) => {
      const m = marks.find((x) => x.key === lineMarkKey(e));
      const st = markState(e, lines, new Map(marks.map((x) => [x.key, x])), true);
      if (m) return st.kind === "ok" || st.kind === "edit" ? "ok" : "rewrite";
      return statusToBucket(e.data.status, e.production);
    };
    const check = (prog, marks) => {
      const T = ["ok", "draft", "rewrite", "todo"];
      for (const a of PROGRESS_AREAS) {
        const rows = lines.filter((e) => prog.lineAreas[e.id] === a.id);
        const area = prog.areas.find((x) => x.id === a.id);
        assert.equal(area.text.total, rows.length, `${a.id} total`);
        for (const b of T) assert.equal(area.text[b], rows.filter((e) => reviewBucket(e, marks) === b).length, `${a.id} ${b}`);
      }
      for (const [ek, ent] of Object.entries(prog.entities)) {
        const rows = lines.filter((e) => base.lineSheets[e.id].includes(ek));
        assert.equal(ent.text.total, rows.length, `${ek} total`);
        for (const b of T) assert.equal(ent.text[b], rows.filter((e) => reviewBucket(e, marks) === b).length, `${ek} ${b}`);
      }
    };
    check(base, []);
    // item/location data rows land on their own sheets (same rule as the area), plus the squad mention
    assert.equal(base.entities["item:brass"].text.total, 3);
    assert.equal(base.entities["location:depot"].text.total, 2);
    assert.equal(base.areas.find((a) => a.id === "items").text.total, 2);

    const marks = [{ key: dupKey, file: "data/quests.json", line: "1", data_path: dup, where_seen: "", status: "OWNER-OK", note: "", contracts: {}, rewrite: "", text: "", hashOk: true }];
    const live = applyLiveMarks(base, marks);
    check(live, marks);
    assert.equal(live.areas.find((a) => a.id === "traders").text.ok, 3, "all three duplicate rows flip");
    // a Redo on the same key moves them all to rewrite; server-side marks agree with the live overlay
    const redo = [{ ...marks[0], status: "NEEDS-REWRITE" }];
    check(applyLiveMarks(base, redo), redo);
    assert.deepEqual(buildProgress(snap, { marks: redo }).areas, applyLiveMarks(base, redo).areas);
    assert.deepEqual(buildProgress(snap, { marks: redo }).entities, applyLiveMarks(base, redo).entities);
  });
});
