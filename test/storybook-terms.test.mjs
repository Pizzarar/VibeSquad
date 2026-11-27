import { test } from "node:test";
import assert from "node:assert/strict";
import { efiAdapter } from "../server/storybook/adapters/efi.mjs";
import { makeReader } from "../server/storybook/git-read.mjs";
import { loadSnapshot } from "../server/storybook/adapter.mjs";
import { buildGlossary, GLOSSARY_PATH, parseGlossaryMarkdown } from "../server/storybook/glossary.mjs";
import { runChecks } from "../server/storybook/checks/index.mjs";
import { checks as termChecks } from "../server/storybook/checks/terms.mjs";
import { FILES, makeFakeRepo } from "./storybook-fake-repo.mjs";

async function runOn(mutator = null) {
  const files = { ...FILES };
  if (mutator) mutator(files);
  const fake = makeFakeRepo(files);
  try {
    const reader = makeReader(fake.clone, fake.sha);
    const snap = await loadSnapshot(efiAdapter, reader, { ref: "origin/main", generatedAt: "2026-01-01T00:00:00.000Z" });
    snap.glossary = await buildGlossary(snap.entities, reader);
    const findings = await runChecks(snap, efiAdapter, { reader });
    return { snap, findings, by: (id) => findings.filter((f) => f.check === id) };
  } finally {
    fake.cleanup();
  }
}

test("glossary: seeds from VOICE_BIBLE + player word when GLOSSARY.md is absent", async () => {
  const { snap } = await runOn();
  assert.equal(snap.glossary.source.seeded, true);
  assert.equal(snap.glossary.playerWord, "runner");
  assert.ok(snap.glossary.canonical.some((c) => c.term === "runner"));
  assert.ok(snap.glossary.canonical.some((c) => c.term === "Scav"));
  assert.ok(snap.glossary.banned.some((b) => b.term === "paranormal"));
  assert.ok(snap.glossary.banned.some((b) => b.term === "adventurer"));
  assert.equal(snap.glossary.nameStyleRules.length, 3);
});

test("glossary: parses docs/narrative/GLOSSARY.md when present", async () => {
  const md = [
    "# Glossary",
    "## Canonical terms",
    "- **Scav** — variants: scav, scavenger; Title Case faction name.",
    "- **runner** — variants: Runner; Default player word.",
    "## Banned terms",
    "- **wizard** — No fantasy terms.",
    "## Name-style rules",
    "- **cross-kind-id** — Keep ids unique across kinds.",
  ].join("\n");
  const parsed = parseGlossaryMarkdown(md, GLOSSARY_PATH);
  assert.equal(parsed.source.seeded, false);
  assert.equal(parsed.source.path, GLOSSARY_PATH);
  assert.equal(parsed.canonical.length, 2);
  assert.deepEqual(parsed.canonical[0].variants, ["scav", "scavenger"]);
  assert.equal(parsed.banned.length, 1);
  assert.equal(parsed.banned[0].term, "wizard");

  const { snap } = await runOn((f) => { f[GLOSSARY_PATH] = md; });
  assert.equal(snap.glossary.source.seeded, false);
  assert.equal(snap.glossary.banned.length, 1);
  assert.equal(snap.glossary.banned[0].term, "wizard");
});

test("#16 flags canonical term variants and banned terms; skips ALL-CAPS headers and allowlisted idioms", async () => {
  const { by } = await runOn((f) => {
    const csv = f["docs/review/text_review.csv"];
    f["docs/review/text_review.csv"] = csv
      + 'data/questlines.json,10,"[""q1""]",Popper,DRAFT,,"The scavs took my crate.",,""\n'
      + 'data/questlines.json,11,"[""q2""]",Popper,DRAFT,,"A wizard walked into the dock.",,""\n'
      + 'scenes/ui.gd,12,"[""u1""]",System,DRAFT,,"HIDEOUT",,""\n'
      + 'data/questlines.json,13,"[""q3""]",Popper,DRAFT,,"This place is a ghost town now.",,""\n';
  });
  const f16 = by("#16");
  assert.ok(f16.some((f) => f.severity === "info" && /term "Scav" written as "scavs"/.test(f.msg)), f16.map((x) => x.msg).join("\n"));
  assert.ok(f16.some((f) => f.severity === "warn" && /banned term "wizard"/.test(f.msg)), f16.map((x) => x.msg).join("\n"));
  assert.ok(!f16.some((f) => /"HIDEOUT"/.test(f.msg)), "ALL-CAPS UI header should be ignored");
  assert.ok(!f16.some((f) => /ghost town/.test(f.msg)), "allowlisted idiom should be ignored");
});

test("#17 folds in cross-kind id collision (squad:doc / trader:doc), id↔display drift, and naming-style outliers", async () => {
  const { by } = await runOn((f) => {
    const en = JSON.parse(f["data/enemies.json"]);
    en.enemies.exo_trooper = { name: "Heavy Trooper", hp: 10, attack: 2, defense: 1, xp: 5, loot: {} };
    en.enemies.bad_enemy = { name: "bad_enemy", hp: 10, attack: 2, defense: 1, xp: 5, loot: {} };
    f["data/enemies.json"] = JSON.stringify(en, null, 2);
    const items = JSON.parse(f["data/items.json"]);
    items.items.push(
      { id: "health_potion", name: "Herbal Salve", category: "medical", tier: 1, weight: 1, base_value: 5 },
      { id: "ammo_556", name: "5.56 Rounds", category: "ammo", tier: 1, weight: 1, base_value: 5 },
      { id: "mag_762r", name: "7.62x54R Box (100)", category: "ammo", tier: 1, weight: 1, base_value: 5 },
    );
    f["data/items.json"] = JSON.stringify(items, null, 2);
  });
  const f17 = by("#17");
  const msgs = f17.map((f) => f.msg);
  // Doc/Saint cross-kind id collision is now in #17 (and NOT in #7)
  assert.ok(f17.some((f) => f.severity === "warn" && /cross-kind id "doc"/.test(f.msg)), msgs.join("\n"));
  assert.equal(by("#7").filter((f) => /id "doc"/.test(f.msg)).length, 0, "cross-kind id should no longer be in #7");
  // Id<->display drift
  assert.ok(msgs.some((m) => /enemy id "exo_trooper" displays as "Heavy Trooper"/.test(m)), msgs.join("\n"));
  assert.ok(msgs.some((m) => /item id "health_potion" displays as "Herbal Salve"/.test(m)), msgs.join("\n"));
  // Tuned caliber/mag items stay quiet
  assert.ok(!msgs.some((m) => /ammo_556/.test(m)), msgs.join("\n"));
  assert.ok(!msgs.some((m) => /mag_762r/.test(m)), msgs.join("\n"));
  // Naming-style outlier (raw underscore)
  assert.ok(f17.some((f) => f.severity === "warn" && /contains raw underscore/.test(f.msg) && /bad_enemy/.test(f.msg)), msgs.join("\n"));
});

test("#19 flags location vibe/lore naming enemies or bosses not in the location roster", async () => {
  const { by } = await runOn((f) => {
    const en = JSON.parse(f["data/enemies.json"]);
    en.enemies.exo_trooper = { name: "Heavy Trooper", hp: 10, attack: 2, defense: 1, xp: 5, loot: {} };
    en.enemies.archive_trooper = { name: "Archive Trooper", hp: 10, attack: 2, defense: 1, xp: 5, loot: {} };
    f["data/enemies.json"] = JSON.stringify(en, null, 2);

    const locs = JSON.parse(f["data/locations.json"]);
    const sv = locs.find((l) => l.id === "sealed_vault");
    sv.enemy_pool = [{ id: "archive_trooper", min_time_seconds: 0, max_time_seconds: 600 }];
    sv.boss = null;
    f["data/locations.json"] = JSON.stringify(locs, null, 2);

    f["docs/PLAN_MAP_VIBES.md"] = f["docs/PLAN_MAP_VIBES.md"].replace(
      "- **Setting:** the sealed records vault; steel shelving.",
      "- **Setting:** the sealed records vault; steel shelving.\n- **Roster:** shares `exo_trooper` with the Bunker.",
    );
  });
  const f19 = by("#19");
  assert.equal(f19.length, 1, f19.map((x) => x.msg).join("\n"));
  assert.deepEqual(f19[0].entityRef, { kind: "location", id: "sealed_vault" });
  assert.equal(f19[0].severity, "warn");
  assert.match(f19[0].msg, /Sealed Vault.*`exo_trooper`.*archive_trooper/);
});

test("terms module exports #16, #17, #19", () => {
  assert.deepEqual(termChecks.map((c) => c.id), ["#16", "#17", "#19"]);
});
