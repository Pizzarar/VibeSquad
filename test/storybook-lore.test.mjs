import { test } from "node:test";
import assert from "node:assert/strict";
import { FILES, makeFakeRepo } from "./storybook-fake-repo.mjs";
import { makeReader } from "../server/storybook/git-read.mjs";
import { efiAdapter } from "../server/storybook/adapters/efi.mjs";
import { loadSnapshot } from "../server/storybook/adapter.mjs";
import { makeRegistry, validateFinding } from "../server/storybook/schema.mjs";
import { checks } from "../server/storybook/checks/lore.mjs";

/** Build a fake repo from FILES (+ mutate(files)), run the #12 check, return its findings. */
async function run(mutate) {
  const files = { ...FILES };
  mutate?.(files);
  const fake = makeFakeRepo(files);
  try {
    const snapshot = await loadSnapshot(efiAdapter, makeReader(fake.clone, fake.sha), { ref: "origin/main", generatedAt: "2026-01-01T00:00:00.000Z" });
    const registry = makeRegistry(snapshot.entities);
    const fs = await checks.find((c) => c.id === "#12").run({ snapshot, registry, adapter: efiAdapter, hooks: efiAdapter.hooks });
    for (const f of fs) assert.equal(validateFinding(f).ok, true, JSON.stringify(f));
    return fs;
  } finally { fake.cleanup(); }
}
const locs = (files, fn) => { const j = JSON.parse(files["data/locations.json"]); fn(j); files["data/locations.json"] = JSON.stringify(j, null, 2); };
const sev = (fs, s) => fs.filter((f) => f.severity === s);

test("module contract: one #12 check with id/title/run", () => {
  assert.deepEqual(checks.map((c) => c.id), ["#12"]);
  for (const c of checks) assert.ok(c.title && typeof c.run === "function");
});

test("base fixture: data and the map boss lore agree, so no contradiction", async () => {
  const fs = await run();
  assert.deepEqual(fs, []);
});

test("an enemy that is boss of two locations is a warn", async () => {
  const fs = await run((f) => locs(f, (l) => { l.find((x) => x.id === "sealed_vault").boss = { enemy_id: "boss_dockmaster" }; }));
  const w = sev(fs, "warn");
  assert.equal(w.length, 1, JSON.stringify(fs));
  assert.match(w[0].msg, /boss_dockmaster/);
  assert.match(w[0].msg, /boss location/);
  assert.match(w[0].msg, /harbor_district/);
  assert.match(w[0].msg, /sealed_vault/);
  assert.deepEqual(w[0].entityRef, { kind: "enemy", id: "boss_dockmaster" });
  assert.equal(w[0].check, "#12");
});

test("a map's PLAN_MAP_VIBES boss that disagrees with the data is info (lore-sourced)", async () => {
  const fs = await run((f) => {
    f["docs/PLAN_MAP_VIBES.md"] = f["docs/PLAN_MAP_VIBES.md"]
      .replace("### 6. Sealed Vault (`sealed_vault`)\n- **Setting:** the sealed records vault; steel shelving.",
        "### 6. Sealed Vault (`sealed_vault`)\n- **Setting:** the sealed records vault; steel shelving.\n- **Roster:** **Boss** `boss_dockmaster`: wrong boss, data says Harbor.");
  });
  const inf = sev(fs, "info");
  assert.equal(inf.length, 1, JSON.stringify(fs));
  assert.match(inf[0].msg, /boss_dockmaster/);
  assert.match(inf[0].msg, /sealed_vault/);
  assert.match(inf[0].msg, /harbor_district/);
  assert.equal(inf[0].check, "#12");
  assert.deepEqual(sev(fs, "warn"), []);
});

test("a boss backtick id that is not an enemy is skipped (no dangling-subject fact)", async () => {
  const fs = await run((f) => {
    f["docs/PLAN_MAP_VIBES.md"] = f["docs/PLAN_MAP_VIBES.md"]
      .replace("### 6. Sealed Vault (`sealed_vault`)\n- **Setting:** the sealed records vault; steel shelving.",
        "### 6. Sealed Vault (`sealed_vault`)\n- **Setting:** the sealed records vault; steel shelving.\n- **Roster:** **Boss** `ghost_enemy`: not in data.");
  });
  assert.deepEqual(fs, []);
});

test("a map_vibe describes a dangling location: fact skipped, no phantom contradiction", async () => {
  // The heading points at a location id that is not in the data; the boss line still names the real map's boss.
  // Canonicalising the describes target must skip the fact instead of comparing "harbor_ward" against "harbor_district".
  const fs = await run((f) => {
    f["docs/PLAN_MAP_VIBES.md"] = f["docs/PLAN_MAP_VIBES.md"].replace("(`harbor_district`)", "(`harbor_ward`)");
  });
  assert.deepEqual(fs, []);
});

// Minimal entity builder for the direct-registry tests (the check runs over a registry, not the fixture).
const ent = (id, kind, line, links = []) => ({ id, kind, display: id, aliases: [], links, source: { path: `data/${kind}.json`, line }, data: {} });

test("differing-source pick is insertion-order independent (sort by src path/line)", () => {
  const enemy = ent("boss_x", "enemy", 1);
  const locA = ent("loc_a", "location", 1);
  const locB = ent("loc_b", "location", 2);
  const a = ent("look:a", "lore", 10, [{ rel: "describes", kind: "enemy", id: "boss_x" }, { rel: "seen_at", kind: "location", id: "loc_a" }]);
  const b = ent("look:b", "lore", 20, [{ rel: "describes", kind: "enemy", id: "boss_x" }, { rel: "seen_at", kind: "location", id: "loc_b" }]);
  const c = ent("look:c", "lore", 30, [{ rel: "describes", kind: "enemy", id: "boss_x" }, { rel: "seen_at", kind: "location", id: "loc_b" }]);
  for (const e of [a, b, c]) e.data = { lore_kind: "enemy_look" };
  const runWith = (rows) => {
    const registry = makeRegistry([enemy, locA, locB, ...rows]);
    const fs = checks.find((x) => x.id === "#12").run({ registry });
    for (const f of fs) assert.equal(validateFinding(f).ok, true, JSON.stringify(f));
    assert.equal(fs.length, 1, JSON.stringify(fs));
    return fs[0];
  };
  const one = runWith([a, b, c]);
  const two = runWith([a, c, b]);
  assert.deepEqual(one, two);
  assert.deepEqual(one.source, { path: "data/lore.json", line: 20 });
});

test("message reports the real value count (three, not two)", () => {
  const enemy = ent("boss_x", "enemy", 1, [
    { rel: "boss_of", kind: "location", id: "loc_a" },
    { rel: "boss_of", kind: "location", id: "loc_b" },
    { rel: "boss_of", kind: "location", id: "loc_c" },
  ]);
  const registry = makeRegistry([enemy, ent("loc_a", "location", 1), ent("loc_b", "location", 2), ent("loc_c", "location", 3)]);
  const fs = checks.find((x) => x.id === "#12").run({ registry });
  assert.equal(fs.length, 1, JSON.stringify(fs));
  assert.match(fs[0].msg, /has 3 boss location values/);
  assert.deepEqual(fs[0].severity, "warn");
});

test("deterministic: two runs over the same mutated fixture agree", async () => {
  const mutate = (f) => locs(f, (l) => { l.find((x) => x.id === "sealed_vault").boss = { enemy_id: "boss_dockmaster" }; });
  assert.deepEqual(await run(mutate), await run(mutate));
});
