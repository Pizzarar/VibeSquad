import { test } from "node:test";
import assert from "node:assert/strict";
import { FILES, makeFakeRepo } from "./storybook-fake-repo.mjs";
import { makeReader } from "../server/storybook/git-read.mjs";
import { efiAdapter } from "../server/storybook/adapters/efi.mjs";
import { loadSnapshot } from "../server/storybook/adapter.mjs";
import { makeRegistry, validateFinding } from "../server/storybook/schema.mjs";
import { checks } from "../server/storybook/checks/text.mjs";

/** Build a fake repo from FILES (+ mutate(files)), run one check, return its findings. */
async function run(id, mutate) {
  const files = { ...FILES };
  mutate?.(files);
  const fake = makeFakeRepo(files);
  try {
    const snapshot = await loadSnapshot(efiAdapter, makeReader(fake.clone, fake.sha), { ref: "origin/main", generatedAt: "2026-01-01T00:00:00.000Z" });
    const registry = makeRegistry(snapshot.entities);
    const fs = await checks.find((c) => c.id === id).run({ snapshot, registry, adapter: efiAdapter, hooks: efiAdapter.hooks });
    for (const f of fs) assert.equal(validateFinding(f).ok, true, JSON.stringify(f));
    return id === "#9" ? fs.filter((f) => !String(f.entityRef?.id).startsWith("csv:data/questlines.json:12:")) : fs; // fixture csv row 12 has a "he'll" contraction: not under test here
  } finally { fake.cleanup(); }
}
const ql = (files, fn) => { const j = JSON.parse(files["data/questlines.json"]); fn(j.questlines); files["data/questlines.json"] = JSON.stringify(j, null, 2); };
const rel = (files, fn) => { const j = JSON.parse(files["data/trader_relations.json"]); fn(j.traders); files["data/trader_relations.json"] = JSON.stringify(j, null, 2); };
const sev = (fs, s) => fs.filter((f) => f.severity === s);

test("module contract: six checks with id/title/run", () => {
  assert.deepEqual(checks.map((c) => c.id), ["#3", "#4", "#6", "#9", "#10", "#11"]);
  for (const c of checks) assert.ok(c.title && typeof c.run === "function");
});

test("#3 base fixture: only the unscored-step info", async () => {
  const fs = await run("#3");
  assert.deepEqual(sev(fs, "warn"), []);
  assert.equal(fs.length, 1);
  assert.match(fs[0].msg, /popper_1 is not scored/);
});
test("#3 drift: qty, stale cite, stale quote, ghost row, chain count all warn", async () => {
  const fs = await run("#3", (f) => {
    f["docs/narrative/QUEST_AUDIT.md"] = f["docs/narrative/QUEST_AUDIT.md"]
      .replace("scav @harbor_district ×10", "scav @harbor_district ×99")
      .replace("**3 steps across 2 chains**", "**5 steps across 2 chains**")
      .replace("- **doc_1**", "- **ghost_9** — reach · room workshop lv1 · R1 1 pass · **9/12** · `:1`\n- **doc_1**")
      .replace(/(\*\*9\/12\*\* · `:)(\d+)(`\n\nPopper)/, "$1999$3")
      .replace('"Clear the harbor."', '"Bring thirty casings"');
  });
  const w = sev(fs, "warn").map((f) => f.msg).join("\n");
  assert.match(w, /qty 99 -> 10/);
  assert.match(w, /ghost_9 but no such quest step/);
  assert.match(w, /5 steps across 2 chains, data has 3 steps across 2 chains/);
  assert.match(w, /quotes "Bring thirty casings".*now at data\/questlines\.json:\d+/i);
  assert.match(w, /cites doc_1 at .*:999/);
});
test("#3 a quote that drops a modifier is not drift (significant-word containment)", async () => {
  const fs = await run("#3", (f) => { f["docs/narrative/QUEST_AUDIT.md"] += '\nDoc asks for "build the bench" (data/questlines.json:' + (f["data/questlines.json"].slice(0, f["data/questlines.json"].indexOf('"story": "Build a bench."')).split("\n").length) + ").\n"; });
  assert.deepEqual(sev(fs, "warn"), []);
});

test("#4 base fixture: only inference tallies (info)", async () => {
  const fs = await run("#4");
  assert.deepEqual(fs.filter((f) => f.severity !== "info"), []);
});
test("#4 card neverSays + player word 'runner' flag; global bans do not; no-callsPlayer card allows runner", async () => {
  const fs = await run("#4", (f) => ql(f, (q) => {
    q.popper.steps[1].story = "Good enough, runner.";   // never-says + player word (popper calls the player kid/you)
    q.doc.steps[0].story = "Runner, the sterile kit is ready. A ghost walked by."; // sterile = doc ban; runner ok (no list); ghost is #10's
  }));
  const w = sev(fs, "warn").map((f) => f.msg);
  assert.ok(w.some((m) => /Popper.*never-says "good enough"/.test(m)), w.join("\n"));
  assert.ok(w.some((m) => /Popper.*player word "runner"/.test(m)));
  assert.ok(w.some((m) => /Doc.*never-says "sterile"/.test(m)));
  assert.ok(!w.some((m) => /Doc.*player word/.test(m)));
  assert.ok(!w.some((m) => /never-says "ghost"|tone/i.test(m)));
});

test("#6 identical long_haul texts warn; the base fixture has none", async () => {
  assert.deepEqual(sev(await run("#6"), "warn").filter((f) => /long_haul/.test(f.msg)), []);
  const fs = await run("#6", (f) => {
    const l = JSON.parse(f["data/locations.json"]);
    l.push({ id: "railway_yard", display_name: "Railway Yard", threat_tier: "low", default_raid_seconds: 600, long_haul: { at_s: 1800, text: "A supply drop came down nearby. The squad reached it.", rows: [] }, enemy_pool: [] });
    f["data/locations.json"] = JSON.stringify(l, null, 2);
  });
  assert.ok(sev(fs, "warn").some((x) => /identical text x2.*long_haul:harbor_district.*long_haul:railway_yard/.test(x.msg)));
});

test("#9 rival pronouns in speech never flag; own-gender slip and wrong rival gender do", async () => {
  // popper (he) and doc (she) are rivals; popper talking about doc as "her" is correct, "him" is not
  const ok = await run("#9", (f) => rel(f, (t) => { t.popper.lines.wary = 'Popper says "Doc? I would not trust her."'; }));
  assert.deepEqual(ok, []);
  const bad = await run("#9", (f) => rel(f, (t) => {
    t.popper.lines.wary = 'Popper says "Tell him I said so."';  // him = the rival Doc (she)
    t.popper.lines.word = "Popper counts the coin, then she leaves.";  // she = Popper (he)
  }));
  const m = bad.map((x) => x.msg).join("\n");
  assert.equal(bad.length, 2, m);
  assert.match(m, /"him".*Doc/);
  assert.match(m, /"she".*Popper/);
});
test("#9 unset squad pronouns are skipped", async () => {
  const fs = await run("#9", (f) => {
    const j = JSON.parse(f["data/squad.json"]); j.members[0].bio = "Saint packs her trauma kit and his own pride."; f["data/squad.json"] = JSON.stringify(j, null, 2);
  });
  assert.deepEqual(fs, []);
});

test("#10 base clean; 'spirits' in a recipe is allowlisted but a ghost in prose warns", async () => {
  assert.deepEqual(await run("#10"), []);
  const fs = await run("#10", (f) => {
    const r = JSON.parse(f["data/recipes.json"]); r.recipes.fuel_from_alcohol = { ingredients: { cloth: 1 }, result_id: "bandage", result_qty: 1, description: "Distill spirits into fuel.", skill_req: "medicine", level_req: 1, required_workshop: "workshop" }; f["data/recipes.json"] = JSON.stringify(r, null, 2);
  });
  assert.deepEqual(fs, [], "spirits in a fuel recipe is allowed");
  const bad = await run("#10", (f) => rel(f, (t) => { t.doc.lines.wary = "A ghost drifts past, lol."; }));
  const m = bad.map((x) => x.msg).join("\n");
  assert.match(m, /paranormal.*ghost/i);
  assert.match(m, /meme slang.*lol/i);
  assert.ok(bad.every((x) => x.severity === "warn"));
});

test("#11 base coherent; incoherent title is info (never warn); item category counts as a title match", async () => {
  const base = await run("#11");
  assert.deepEqual(base.map((f) => f.entityRef.id), ["popper_1", "popper_2"]); // "Spent Brass", "Dock Runs": lexical-only, info
  assert.ok(base.every((f) => f.severity === "info"));
  const bad = (await run("#11", (f) => ql(f, (q) => { q.popper.steps[1].title = "Brass Knuckles"; q.popper.steps[1].story = "Move along."; }))).filter((f) => f.entityRef.id === "popper_2");
  assert.equal(bad.length, 1);
  assert.equal(bad[0].severity, "info");
  assert.match(bad[0].msg, /popper_2.*Brass Knuckles/);
  const cat = (await run("#11", (f) => ql(f, (q) => { q.popper.steps[0].title = "Material Matters"; q.popper.steps[0].story = "Move along."; }))).filter((f) => f.entityRef.id === "popper_1");
  assert.deepEqual(cat, []);
});
