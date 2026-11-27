import { test, after } from "node:test";
import assert from "node:assert/strict";
import { FILES, makeFakeRepo } from "./storybook-fake-repo.mjs";
import { makeReader } from "../server/storybook/git-read.mjs";
import { efiAdapter } from "../server/storybook/adapters/efi.mjs";
import { loadSnapshot } from "../server/storybook/adapter.mjs";
import { validateFinding } from "../server/storybook/schema.mjs";
import { CHECK_MODULES, runChecks } from "../server/storybook/checks/index.mjs";
import { CHARACTER_KINDS } from "../server/storybook/checks/structural.mjs";
import { KIND_TABLE } from "../server/registry/index.mjs";

const cleanups = [];
after(() => cleanups.forEach((c) => c()));

async function run(files, { reader = true } = {}) {
  const fake = makeFakeRepo(files);
  cleanups.push(fake.cleanup);
  const rd = makeReader(fake.clone, fake.sha);
  const snap = await loadSnapshot(efiAdapter, rd, { ref: "origin/main", generatedAt: "2026-01-01T00:00:00.000Z" });
  const findings = await runChecks(snap, efiAdapter, { reader: reader ? rd : null });
  // the shared fake repo's sublevel band lore points at deep_N floors it does not define: a true #1 hit, unrelated to these tests
  const keep = (f) => !(f.check === "#1" && f.entityRef?.id === "band:A");
  const kept = findings.filter(keep);
  return { findings: kept, by: (c) => kept.filter((f) => f.check === c) };
}
const edit = (file, fn) => { const j = JSON.parse(FILES[file]); fn(j); return { ...FILES, [file]: JSON.stringify(j, null, 2) }; };

test("registry: modules list, findings valid, deterministic order", async () => {
  assert.ok(CHECK_MODULES.length >= 1 && CHECK_MODULES.every((m) => Array.isArray(m.checks)));
  const a = await run(FILES);
  for (const f of a.findings) assert.equal(validateFinding(f).ok, true, JSON.stringify(f));
  for (const f of a.findings) assert.ok(f.source, `source on ${f.check} ${f.msg}`);
  const nums = a.findings.map((f) => Number(f.check.slice(1)));
  assert.deepEqual(nums, [...nums].sort((x, y) => x - y));
  const b = await run(FILES);
  assert.deepEqual(a.findings, b.findings);
});

test("a throwing check becomes one warn entry, others still run", async () => {
  const fake = makeFakeRepo(); cleanups.push(fake.cleanup);
  const snap = await loadSnapshot(efiAdapter, makeReader(fake.clone, fake.sha), { ref: "x" });
  const mods = [{ checks: [{ id: "#9", title: "boom", run() { throw new Error("kaboom"); } }, { id: "#3", title: "ok", run: () => [{ check: "#3", severity: "info", entityRef: null, msg: "fine", source: null }] }] }];
  const f = await runChecks(snap, efiAdapter, { modules: mods });
  assert.deepEqual(f.map((x) => [x.check, x.severity]), [["#3", "info"], ["#9", "warn"]]);
  assert.match(f[1].msg, /kaboom/);
});

test("baseline fake repo: #1 clean (scavenging resolves), #2 and #5 clean", async () => {
  const { by } = await run(FILES);
  assert.deepEqual(by("#1"), []);
  assert.deepEqual(by("#2"), []);
  assert.deepEqual(by("#5"), []);
});

test("#1 flags dangling ids as errors", async () => {
  const files = edit("data/questlines.json", (j) => { j.questlines.popper.steps[0].task.item_id = "no_such_item"; });
  const { by } = await run(files);
  const f = by("#1").find((x) => /no_such_item/.test(x.msg));
  assert.ok(f);
  assert.equal(f.severity, "error");
  assert.deepEqual(f.entityRef, { kind: "quest_step", id: "popper_1" });
  assert.equal(f.source.path, "data/questlines.json");
  assert.ok(f.source.line >= 1);
});

test("#1 flags a dangling skill, but not the merged scavenging skill", async () => {
  const files = edit("data/contracts.json", (j) => { j.templates[0].requires = { skill: "juggling", level: 1 }; });
  const { by } = await run(files);
  assert.equal(by("#1").length, 1);
  assert.match(by("#1")[0].msg, /juggling/);
});

test("#2 flags a kill target that never spawns in the quest location, and one that spawns nowhere", async () => {
  const files = edit("data/questlines.json", (j) => {
    j.questlines.popper.steps[1].task.enemy_id = "exo_trooper"; // spawns only in sealed_vault, quest says harbor
    j.questlines.doc.steps.push({ id: "doc_2", title: "Hunt", story: "x", task: { type: "kill", enemy_id: "boss_dockmaster", qty: 1 }, rep: 0 });
    j.questlines.doc.steps.push({ id: "doc_3", title: "Hunt2", story: "x", task: { type: "kill", enemy_id: "scav", qty: 1 }, rep: 0 });
  });
  const en = JSON.parse(files["data/enemies.json"]); en.enemies.ghost = { name: "Ghost Unit", hp: 1, attack: 1, defense: 1, xp: 1, loot: {} };
  files["data/enemies.json"] = JSON.stringify(en);
  files["data/questlines.json"] = JSON.stringify({ meta: {}, questlines: { ...JSON.parse(files["data/questlines.json"]).questlines, ghosty: { steps: [{ id: "ghosty_1", title: "T", story: "S", task: { type: "kill", enemy_id: "ghost", qty: 1 }, rep: 0 }] } } });
  const { by } = await run(files);
  const ids = by("#2").map((f) => f.entityRef.id).sort();
  assert.deepEqual(ids, ["ghosty_1", "popper_2"]); // doc_2 (boss, no location) and doc_3 (scav, no location) are fine
  assert.ok(by("#2").every((f) => f.severity === "warn"));
});

test("#5 flags a spawn window that starts at/after the default raid length", async () => {
  const files = edit("data/questlines.json", (j) => { j.questlines.popper.steps[1].task.enemy_id = "armored_scav"; }); // harbor 600-1800 vs 600
  const { by } = await run(files);
  assert.equal(by("#5").length, 1);
  assert.equal(by("#5")[0].severity, "warn");
  assert.deepEqual(by("#5")[0].entityRef, { kind: "quest_step", id: "popper_2" });
  assert.deepEqual(by("#2"), []);
});

test("#5 no-location kill: info when only some locations are late, warn when all are", async () => {
  const loc = (j, id, pool) => j.push({ id, display_name: id, default_raid_seconds: 600, enemy_pool: pool });
  const files = edit("data/locations.json", (j) => {
    loc(j, "late_a", [{ id: "exo_trooper", tier: 2, min_time_seconds: 900, max_time_seconds: 1800, weight: 1 }]);
    j.find((l) => l.id === "sealed_vault").default_raid_seconds = 1200; // exo_trooper there starts at 0: early
  });
  const q = JSON.parse(files["data/questlines.json"]);
  q.questlines.popper.steps.push({ id: "popper_3", title: "T", story: "S", task: { type: "kill", enemy_id: "exo_trooper", qty: 3 }, rep: 0 });
  files["data/questlines.json"] = JSON.stringify(q);
  const some = (await run(files)).by("#5");
  assert.equal(some.length, 1);
  assert.equal(some[0].severity, "info");
  const f2 = edit("data/locations.json", (j) => { j.find((l) => l.id === "sealed_vault").enemy_pool[0].min_time_seconds = 1500; });
  const q2 = JSON.parse(f2["data/questlines.json"]);
  q2.questlines.popper.steps.push({ id: "popper_3", title: "T", story: "S", task: { type: "kill", enemy_id: "exo_trooper", qty: 3 }, rep: 0 });
  f2["data/questlines.json"] = JSON.stringify(q2);
  const all = (await run(f2)).by("#5");
  assert.equal(all.length, 1);
  assert.equal(all[0].severity, "warn");
});

test("#5 flags a reach level above the room cap; at the cap is fine", async () => {
  const mk = (level) => edit("data/questlines.json", (j) => { j.questlines.doc.steps[0].task = { type: "reach", room: "bedroom", level }; });
  assert.equal((await run(mk(99))).by("#5").length, 1);
  assert.equal((await run(mk(20))).by("#5").length, 0);
});

test("#7 flags display clashes (Wrench / Foreman); cross-kind id `doc` moved to #17", async () => {
  const { by, findings } = await run(FILES);
  assert.equal(by("#7").filter((f) => /id "doc"/.test(f.msg)).length, 0); // cross-kind id collisions moved to #17 in V10
  assert.equal(by("#7").filter((f) => /id "(?!doc)/.test(f.msg)).length, 0); // item/recipe `bandage` is by design
  assert.ok(findings.length > 0);
  const items = JSON.parse(FILES["data/items.json"]); items.items.push({ id: "tool_wrench", name: "Wrench", category: "tool", tier: 1, weight: 1, base_value: 1 });
  const sq = JSON.parse(FILES["data/squad.json"]); sq.members.push({ id: "wrench", callsign: "Wrench", name: "Ray", bio: "b", trait_text: "t", key: "k", size: 0.1, unlock: "", flaw: null, synergy: null });
  const en = JSON.parse(FILES["data/enemies.json"]); en.enemies.line_foreman = { name: "Line Foreman", hp: 1, attack: 1, defense: 1, xp: 1, loot: {} }; en.enemies.the_foreman = { name: "The Foreman", hp: 1, attack: 1, defense: 1, xp: 1, loot: {} };
  const r = await run({ ...FILES, "data/items.json": JSON.stringify(items), "data/squad.json": JSON.stringify(sq), "data/enemies.json": JSON.stringify(en) });
  const names = r.by("#7").filter((f) => f.severity === "info").map((f) => f.msg);
  assert.ok(names.some((m) => /wrench/.test(m) && /item tool_wrench/.test(m) && /squad wrench/.test(m)), names.join("\n"));
  assert.ok(names.some((m) => /foreman/.test(m) && /line_foreman/.test(m) && /the_foreman/.test(m)));
});

test("#8 counts STORY-TODO strings (quest steps + squad lines) and .gd comments through the reader", async () => {
  const gd = "extends Node\nfunc a():\n\tlabel.text = \"Pick\"  # STORY-TODO: CONSEQ-UI\n\tvar s = \"STORY-TODO: not a comment\"\n# STORY-TODO: top\nfunc b(): pass # fine\n";
  const { by } = await run({ ...FILES, "scenes/x/ui.gd": gd, "tools/ignored.gd": "# STORY-TODO: out of scope dir\n" });
  const strings = by("#8").filter((f) => f.entityRef);
  const comments = by("#8").filter((f) => !f.entityRef);
  assert.equal(strings.length, 4); // popper_1 title+story, squad doc name+bio
  assert.deepEqual(comments.map((f) => [f.source.path, f.source.line]), [["scenes/x/ui.gd", 3], ["scenes/x/ui.gd", 5]]);
  assert.ok(by("#8").every((f) => f.severity === "info" && f.source));
});

test("#8 negative: no STORY-TODO anywhere -> 0; without a reader the .gd part is skipped", async () => {
  const q = edit("data/questlines.json", (j) => { for (const s of j.questlines.popper.steps) { s.title = s.title.replace("STORY-TODO: ", ""); s.story = s.story.replace("STORY-TODO: ", ""); } });
  const sq = edit("data/squad.json", (j) => { for (const m of j.members) { m.name = m.name.replace("STORY-TODO: ", ""); m.bio = m.bio.replace("STORY-TODO: ", ""); } });
  const files = { ...FILES, "data/questlines.json": q["data/questlines.json"], "data/squad.json": sq["data/squad.json"], "scenes/x/ui.gd": "# STORY-TODO: hidden\n" };
  assert.equal((await run(files)).by("#8").length, 1);
  assert.equal((await run(files, { reader: false })).by("#8").length, 0);
});

test("SB2-FIX M1: a check returning a non-array becomes a warn, others still run", async () => {
  const fake = makeFakeRepo(); cleanups.push(fake.cleanup);
  const snap = await loadSnapshot(efiAdapter, makeReader(fake.clone, fake.sha), { ref: "x" });
  const mods = [{ checks: [{ id: "#9", title: "obj", run: () => ({ check: "#9" }) }, { id: "#3", title: "ok", run: () => [{ check: "#3", severity: "info", entityRef: null, msg: "fine", source: null }] }] }];
  const f = await runChecks(snap, efiAdapter, { modules: mods });
  assert.deepEqual(f.map((x) => [x.check, x.severity]), [["#3", "info"], ["#9", "warn"]]);
});

test("SB2-FIX L2: single-word collision keys on the token (punctuated names)", async () => {
  const en = JSON.parse(FILES["data/enemies.json"]);
  en.enemies.tank_diver = { name: "(Tank)", hp: 1, attack: 1, defense: 1, xp: 1, loot: {} };
  en.enemies.big_tank = { name: "Big Tank", hp: 1, attack: 1, defense: 1, xp: 1, loot: {} };
  const r = await run({ ...FILES, "data/enemies.json": JSON.stringify(en) });
  assert.ok(r.by("#7").some((f) => /word "tank"/.test(f.msg) && /tank_diver/.test(f.msg) && /big_tank/.test(f.msg)), r.by("#7").map((f) => f.msg).join("\n"));
});

test("#7 SB6b: word-subset is quiet for same-kind item chains (Coffee / Coffee Beans)", async () => {
  const items = JSON.parse(FILES["data/items.json"]);
  items.items.push({ id: "coffee", name: "Coffee", category: "material", tier: 1, weight: 1, base_value: 1 });
  items.items.push({ id: "coffee_beans", name: "Coffee Beans", category: "material", tier: 1, weight: 1, base_value: 1 });
  const r = await run({ ...FILES, "data/items.json": JSON.stringify(items) });
  assert.equal(r.by("#7").filter((f) => /word "coffee"/.test(f.msg)).length, 0, r.by("#7").map((f) => f.msg).join("\n"));
});

test("#7 SB6b: word-subset is quiet for an item vs a room starter name (Barrel / Barrel Fire)", async () => {
  const items = JSON.parse(FILES["data/items.json"]);
  items.items.push({ id: "barrel", name: "Barrel", category: "material", tier: 1, weight: 1, base_value: 1 });
  const rooms = JSON.parse(FILES["data/rooms.json"]);
  rooms.rooms.workshop.starter_display_name = "Barrel Fire";
  const r = await run({ ...FILES, "data/items.json": JSON.stringify(items), "data/rooms.json": JSON.stringify(rooms) });
  assert.equal(r.by("#7").filter((f) => /word "barrel"/.test(f.msg)).length, 0, r.by("#7").map((f) => f.msg).join("\n"));
});

test("#7 SB6b: character vs item word overlap is quiet, character vs character still fires", async () => {
  const items = JSON.parse(FILES["data/items.json"]);
  items.items.push({ id: "tank_plate", name: "Tank Plate", category: "material", tier: 1, weight: 1, base_value: 1 });
  const sq = JSON.parse(FILES["data/squad.json"]);
  sq.members.push({ id: "tank", callsign: "Tank", name: "Bo", bio: "b", trait_text: "t", key: "k", size: 0.1, unlock: "", flaw: null, synergy: null });
  const base = { ...FILES, "data/items.json": JSON.stringify(items), "data/squad.json": JSON.stringify(sq) };
  const quiet = await run(base);
  assert.equal(quiet.by("#7").filter((f) => /word "tank"/.test(f.msg)).length, 0, quiet.by("#7").map((f) => f.msg).join("\n"));
  const en = JSON.parse(FILES["data/enemies.json"]);
  en.enemies.big_tank = { name: "Big Tank", hp: 1, attack: 1, defense: 1, xp: 1, loot: {} };
  const hit = await run({ ...FILES, "data/squad.json": JSON.stringify(sq), "data/enemies.json": JSON.stringify(en) });
  assert.ok(hit.by("#7").some((f) => /word "tank"/.test(f.msg) && /squad tank/.test(f.msg) && /enemy big_tank/.test(f.msg)), hit.by("#7").map((f) => f.msg).join("\n"));
});

test("#7 SB6b-minors: a non-character entity sharing the word does not silence a character-vs-character clash", async () => {
  const items = JSON.parse(FILES["data/items.json"]);
  items.items.push({ id: "tank_plate", name: "Tank Plate", category: "material", tier: 1, weight: 1, base_value: 1 });
  const sq = JSON.parse(FILES["data/squad.json"]);
  sq.members.push({ id: "tank", callsign: "Tank", name: "Bo", bio: "b", trait_text: "t", key: "k", size: 0.1, unlock: "", flaw: null, synergy: null });
  const en = JSON.parse(FILES["data/enemies.json"]);
  en.enemies.big_tank = { name: "Big Tank", hp: 1, attack: 1, defense: 1, xp: 1, loot: {} };
  const r = await run({ ...FILES, "data/items.json": JSON.stringify(items), "data/squad.json": JSON.stringify(sq), "data/enemies.json": JSON.stringify(en) });
  const hit = r.by("#7").filter((f) => /word "tank"/.test(f.msg));
  assert.equal(hit.length, 1, r.by("#7").map((f) => f.msg).join("\n"));
  assert.ok(/squad tank/.test(hit[0].msg) && /enemy big_tank/.test(hit[0].msg) && !/item tank_plate/.test(hit[0].msg), hit[0].msg);
});

test("#7 SB6b-minors: CHARACTER_KINDS derives from the registry character flag", () => {
  assert.deepEqual([...CHARACTER_KINDS].sort(), ["enemy", "squad", "trader"]);
  assert.deepEqual([...CHARACTER_KINDS].sort(), KIND_TABLE.defs.filter((d) => d.character === true).map((d) => d.kind).sort());
  assert.ok(KIND_TABLE.defs.filter((d) => !CHARACTER_KINDS.includes(d.kind)).every((d) => d.character === false));
});

test("SB2-FIX L3: STORY-TODO without a space still trims the marker", async () => {
  const q = edit("data/questlines.json", (j) => { j.questlines.popper.steps[0].title = "STORY-TODO:fix intro"; });
  const r = await run({ ...FILES, ...q });
  assert.ok(r.by("#8").some((f) => f.msg.includes('"fix intro"')), r.by("#8").map((f) => f.msg).join("\n"));
});
