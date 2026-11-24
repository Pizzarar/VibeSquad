import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeFakeRepo } from "./storybook-fake-repo.mjs";
import { makeReader } from "../server/storybook/git-read.mjs";
import { efiAdapter, NEVER_SAYS_OVERRIDES } from "../server/storybook/adapters/efi.mjs";
import { assertAdapter, loadSnapshot } from "../server/storybook/adapter.mjs";
import { makeRegistry, validateSnapshot, KINDS, validateEntity } from "../server/storybook/schema.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures/storybook/efi-mini.json");
const SAMPLE_FINDING = { check: "#2", severity: "error", entityRef: { kind: "quest_step", id: "popper_2" }, msg: "kill target scav does not spawn in harbor_district (sample finding, hand-made)", source: { path: "data/questlines.json", line: 12 } };

let fake, snap, reg;
before(async () => {
  fake = makeFakeRepo();
  snap = await loadSnapshot(efiAdapter, makeReader(fake.clone, fake.sha), { ref: "origin/main", generatedAt: "2026-01-01T00:00:00.000Z" });
  reg = makeRegistry(snap.entities);
});
after(() => fake.cleanup());

test("adapter satisfies the interface", () => {
  assertAdapter(efiAdapter);
  assert.equal(efiAdapter.id, "efi");
  assert.equal(efiAdapter.defaultRepoPath, null);
  assert.throws(() => assertAdapter({ id: "x", defaultRepoPath: 5 }), /defaultRepoPath/);
});

test("snapshot is valid and covers every v1 kind", () => {
  assert.deepEqual(validateSnapshot(snap).errors, []);
  for (const k of Object.keys(KINDS)) assert.ok(reg.byKind(k).length >= 1, `kind ${k} present`);
  for (const e of snap.entities) assert.equal(validateEntity(e).ok, true, `${e.kind}:${e.id}`);
  assert.deepEqual(snap.findings, []);
  assert.equal(snap.sha, fake.sha);
});

test("doc is both trader and squad; aliases id<->display", () => {
  assert.equal(reg.get("trader", "doc").display, "Doc");
  assert.equal(reg.get("squad", "doc").display, "Saint");
  assert.ok(reg.findByName("Saint").some((e) => e.kind === "squad"));
  assert.equal(reg.findByName("Heavy Trooper")[0].id, "exo_trooper");
  assert.equal(reg.findByName("barracks")[0].id, "bedroom");
  assert.equal(reg.findByName("Cot")[0].id, "bedroom");
  assert.ok(reg.findByName("Reyes").some((e) => e.kind === "squad"), "STORY-TODO prefix stripped from alias");
});

test("scavenging merged into skills; no dangling links in the mini tree (lore bands name deep_N floors the mini tree lacks)", () => {
  const s = reg.get("skill", "scavenging");
  assert.equal(s.source.path, "systems/ScavengingSystem.gd");
  assert.equal(s.source.line, 3);
  assert.ok(reg.has("skill", "combat"));
  const dangling = [];
  for (const e of reg.all()) for (const l of e.links) if (!reg.resolve(l) && e.kind !== "lore") dangling.push(`${e.kind}:${e.id} ${l.rel}->${l.kind}:${l.id}`);
  assert.deepEqual(dangling, []);
  // the contract's scavenging requirement resolves
  assert.ok(reg.get("contract", "d_popper_scrap_metal").links.some((l) => l.kind === "skill" && l.id === "scavenging"));
});

test("registries: enemy boss flag via locations[].boss, location pool, line numbers", () => {
  assert.equal(reg.get("enemy", "boss_dockmaster").data.boss, true);
  assert.equal(reg.get("enemy", "boss_dockmaster").data.boss_of, "harbor_district");
  assert.equal(reg.get("enemy", "scav").data.boss, false);
  const h = reg.get("location", "harbor_district");
  assert.equal(h.data.default_raid_seconds, 600);
  assert.deepEqual(h.data.enemy_pool[1], { id: "armored_scav", tier: 2, min_time_seconds: 600, max_time_seconds: 1800, weight: 1 });
  assert.ok(h.links.some((l) => l.rel === "spawns" && l.id === "armored_scav"));
  assert.ok(h.links.some((l) => l.rel === "boss" && l.id === "boss_dockmaster"));
  const fx = JSON.parse(fake.origin && fs.readFileSync(path.join(fake.origin, "data/locations.json"), "utf8"));
  assert.equal(fx.length, 2);
  const lineOf = (file, needle) => fs.readFileSync(path.join(fake.origin, file), "utf8").split("\n").findIndex((l) => l.includes(needle)) + 1;
  assert.equal(h.source.line, lineOf("data/locations.json", '"id": "harbor_district"'));
  assert.equal(reg.get("enemy", "armored_scav").source.line, lineOf("data/enemies.json", '"armored_scav":'));
  assert.equal(reg.get("recipe", "bandage").links.find((l) => l.rel === "workshop").id, "workshop");
});

test("narrative units: quest steps with task links, relations, squad text, long_haul, raid_story", () => {
  const k = reg.get("quest_step", "popper_2");
  assert.equal(k.data.trader, "popper");
  assert.deepEqual(k.links.filter((l) => l.rel !== "trader").map((l) => `${l.rel}:${l.kind}:${l.id}`).sort(), ["at_location:location:harbor_district", "targets_enemy:enemy:scav"]);
  assert.equal(k.production, null);
  assert.equal(reg.get("quest_step", "popper_1").production, "placeholder");
  assert.equal(reg.get("quest_step", "popper_1").display, "Spent Brass");
  assert.ok(reg.get("quest_step", "doc_1").links.some((l) => l.rel === "needs_room" && l.id === "workshop"));
  assert.equal(reg.get("line", "rel:popper:word").data.speaker, "popper");
  assert.ok(reg.get("line", "enc:popper:0").links.some((l) => l.rel === "requires_skill" && l.id === "scavenging"));
  assert.ok(reg.has("line", "squad:doc:bio") && reg.has("line", "squad:doc:flaw") && reg.has("line", "squad:doc:synergy"));
  assert.equal(reg.get("line", "long_haul:harbor_district").data.origin, "long_haul");
  const rs = reg.byKind("line").filter((l) => l.data.origin === "raid_story");
  assert.equal(rs.length, 4, "pool.append is not a template");
  assert.deepEqual(rs.map((r) => r.data.speaker), ["squad", "actor", "narrator", "narrator"]);
  assert.equal(reg.get("trader", "popper").links.filter((l) => l.rel === "rival")[0].id, "doc");
});

test("text_review.csv imported as is, quoted newline kept, status -> production, speaker linked", () => {
  const rows = reg.byKind("line").filter((l) => l.data.origin === "csv");
  assert.equal(rows.length, 3);
  const q = rows.find((r) => r.data.group === "Trader questlines");
  assert.equal(q.data.current_text, 'Bring thirty casings,\nand "he\'ll" know you.');
  for (const col of ["group", "file", "line", "data_path", "current_text", "status", "speaker", "owner_rewrite", "owner_note", "reviewed_hash"]) assert.ok(col in q.data, col);
  assert.equal(q.data.owner_rewrite, "Bring me thirty clean casings.");
  assert.equal(q.data.owner_note, "keep it short");
  assert.equal(q.production, "ai-draft");
  assert.deepEqual(q.source, { path: "data/questlines.json", line: 12 });
  assert.ok(q.links.some((l) => l.rel === "spoken_by" && l.kind === "trader" && l.id === "popper"));
  const ok = rows.find((r) => r.data.status === "OWNER-OK");
  assert.equal(ok.production, "final");
  assert.equal(ok.data.reviewed_hash, "abc123");
  assert.ok(ok.links.some((l) => l.kind === "squad" && l.id === "doc"), "Saint -> squad doc, not trader doc");
  assert.equal(rows.find((r) => r.data.status === "STORY-TODO").production, "placeholder");
});

test("voice cards: pronoun, player word, global bans, neverSays extraction + overrides, rivals", () => {
  const cards = reg.byKind("voice_card").map((c) => c.id).sort();
  assert.deepEqual(cards, ["doc", "popper", "squad-saint", "system"]);
  const p = reg.get("voice_card", "popper");
  assert.equal(p.data.pronoun, "he");
  assert.equal(p.data.playerWord, "runner");
  assert.deepEqual(p.data.callsPlayer, ["kid", "you"]);
  assert.ok(p.data.globalBans.includes("adventurer") && p.data.globalBans.includes("paranormal"));
  assert.deepEqual(p.data.neverSaysExtracted, ["good enough"]);
  assert.ok(p.data.neverSays.includes("good enough") && p.data.neverSays.includes("ballistics"));
  assert.deepEqual(p.data.rivals, ["doc"]);
  assert.ok(p.links.some((l) => l.rel === "speaker" && l.kind === "trader" && l.id === "popper"));
  assert.ok(p.data.samples[0].startsWith("Thirty casings"));
  const s = reg.get("voice_card", "squad-saint");
  assert.equal(s.data.pronoun, null);
  assert.equal(s.data.pronounRaw, "not set in data");
  assert.ok(s.links.some((l) => l.kind === "squad" && l.id === "doc"), "heading id `doc` -> squad doc");
  const sys = reg.get("voice_card", "system");
  assert.ok(sys.data.neverSays.includes("please"));
  assert.ok(!sys.data.neverSays.includes("you"), "quoted word in an 'anything but' exception clause is not a ban");
  assert.deepEqual(sys.data.neverSaysExtracted, ["please"]);
  assert.ok(sys.data.neverSays.some((t) => t.startsWith("re:")), "contractions regex from the override map");
  assert.ok(NEVER_SAYS_OVERRIDES.system.length >= 3);
});

test("lore: map vibes, sublevel band, enemy look lines linked; missing enemy warns, not dangles", () => {
  const m = reg.get("lore", "map:harbor_district");
  assert.match(m.data.fields.setting, /container port/);
  assert.ok(m.links.some((l) => l.rel === "describes" && l.kind === "location" && l.id === "harbor_district"));
  assert.ok(m.links.some((l) => l.rel === "mentions" && l.id === "boss_dockmaster"));
  assert.ok(reg.has("lore", "map:sealed_vault"));
  const band = reg.get("lore", "band:A");
  assert.deepEqual(band.links.filter((l) => l.rel === "describes").map((l) => l.id), ["deep_1", "deep_2", "deep_3"]);
  const look = reg.get("lore", "look:plant_heavy");
  assert.match(look.data.text, /padded suit/);
  assert.ok(look.links.some((l) => l.rel === "describes" && l.id === "plant_heavy") === false, "plant_heavy is not in the mini enemies");
  assert.ok(snap.warnings.some((w) => /plant_heavy/.test(w) && /no such enemy/.test(w)));
  assert.ok(look.links.some((l) => l.rel === "parent" && l.id === "exo_trooper"));
});

test("hooks: spawnWindow + killTargetLocations from data", () => {
  const { spawnWindow, killTargetLocations } = efiAdapter.hooks;
  assert.deepEqual(spawnWindow(reg, "harbor_district", "armored_scav"), { min: 600, max: 1800, tier: 2, weight: 1, defaultRaidSeconds: 600, boss: false });
  assert.equal(spawnWindow(reg, "harbor_district", "exo_trooper"), null);
  assert.equal(spawnWindow(reg, "nowhere", "scav"), null);
  assert.deepEqual(spawnWindow(reg, "harbor_district", "boss_dockmaster"), { min: 600, max: null, tier: null, weight: null, defaultRaidSeconds: 600, boss: true });
  assert.deepEqual(killTargetLocations(reg, "scav"), ["harbor_district"]);
  assert.deepEqual(killTargetLocations(reg, "boss_dockmaster"), ["harbor_district"]);
  assert.deepEqual(killTargetLocations(reg, "exo_trooper"), ["sealed_vault"]);
  assert.deepEqual(killTargetLocations(reg, "nope"), []);
});

test("CSV without a current_text column warns instead of throwing", async () => {
  const reader = { sha: "abcdef12", exists: async () => false, listTree: async () => [], readFile: async (p) => (p === "docs/review/text_review.csv" ? "group,file,line\nG,a.gd,3\n" : null) };
  const r = await efiAdapter.load(reader, reader.sha);
  assert.ok(r.warnings.some((w) => /no current_text column/.test(w)));
  const row = r.entities.find((e) => e.data.origin === "csv");
  assert.equal(row.data.text, "");
});

test("missing files become warnings, not throws", async () => {
  const reader = { sha: "abcdef12", readFile: async () => null, exists: async () => false, listTree: async () => [] };
  const r = await efiAdapter.load(reader, reader.sha);
  assert.equal(r.entities.length, 0);
  assert.ok(r.warnings.length >= 10);
});

test("fixture efi-mini.json: matches the adapter output (+1 hand-made finding), valid, covers all v1 kinds", () => {
  const generated = { ...snap, findings: [SAMPLE_FINDING] };
  if (process.env.UPDATE_FIXTURE === "1") {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify(generated, null, 2) + "\n");
  }
  const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(validateSnapshot(fx).errors, []);
  assert.equal(fx.findings.length, 1);
  const kinds = new Set(fx.entities.map((e) => e.kind));
  for (const k of Object.keys(KINDS)) assert.ok(kinds.has(k), `fixture has ${k}`);
  assert.deepEqual({ ...fx, sha: "x" }, { ...generated, sha: "x" }, "regenerate with UPDATE_FIXTURE=1 node --test test/storybook-efi-adapter.test.mjs");
});
