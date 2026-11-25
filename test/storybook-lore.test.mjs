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

test("deterministic: two runs over the same mutated fixture agree", async () => {
  const mutate = (f) => locs(f, (l) => { l.find((x) => x.id === "sealed_vault").boss = { enemy_id: "boss_dockmaster" }; });
  assert.deepEqual(await run(mutate), await run(mutate));
});
