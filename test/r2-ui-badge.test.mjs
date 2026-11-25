// R2 UI: New Agent badge shows where a spawn lands (landingPick) + GET /roles carries `capped`; drawer chip reads routeWhy.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getRolesState } from "../server/roles-api.mjs";
import { routeWhy } from "../server/spawn-reason.mjs";
import { SPAWN_REASONS } from "../server/spawn-reason.mjs";
import { SPAWN_REASON_GLOSS, allCappedNote, landingPick, spawnChipTitle, spawnReasonLabel } from "../src/roleSpawn.ts";

const ladder = {
  claude: { top: { model: "claude-opus-5-5" }, mid: { model: "claude-sonnet-5-5" }, cheap: { model: "claude-haiku-5-5" } },
  "antigravity-cli": { top: { model: "g-top" }, mid: { model: "g-mid" }, cheap: { model: "g-cheap" } },
};
const role = { name: "Implement", tier: "mid", providers: ["claude", "antigravity-cli"] };

test("landingPick: nothing capped lands on the first provider via ladder", () => {
  assert.deepEqual(landingPick(role, ladder, "normal", { capped: [] }), { provider: "claude", model: "claude-sonnet-5-5", via: "ladder", allCapped: false });
});
test("landingPick: capped first provider fails over to the next", () => {
  const l = landingPick(role, ladder, "normal", { capped: ["claude"] });
  assert.deepEqual(l, { provider: "antigravity-cli", model: "g-mid", via: "failover (Claude capped → Gemini)", allCapped: false });
});
test("landingPick: the hook only skips CAPPED providers, so `installed` is ignored (no not-installed failover)", () => {
  const l = landingPick(role, ladder, "tierA-security", { capped: [], installed: ["antigravity-cli"] });
  assert.deepEqual([l.provider, l.model, l.via], ["claude", "claude-opus-5-5", "ladder"]);
});
test("landingPick: an uncapped override wins", () => {
  const l = landingPick(role, ladder, "normal", { capped: [], override: { provider: "claude", model: "claude-opus-5-5" } });
  assert.deepEqual(l, { provider: "claude", model: "claude-opus-5-5", via: "override", allCapped: false });
  assert.equal(landingPick(role, ladder, "normal", { capped: [], override: { provider: "antigravity-cli" } }).via, "override (provider, ladder model)");
});
test("landingPick: a CAPPED override provider hops along the role's walk like roleSpawnProfile", () => {
  const l = landingPick(role, ladder, "normal", { capped: ["claude"], override: { provider: "claude", model: "claude-opus-5-5" } });
  assert.deepEqual([l.provider, l.model, l.via, l.allCapped], ["antigravity-cli", "g-mid", "failover (Claude capped → Gemini)", false]);
  // override = the role's second provider, capped: hops to the first uncapped one (Claude)
  const m = landingPick(role, ladder, "normal", { capped: ["antigravity-cli"], override: { provider: "antigravity-cli" } });
  assert.deepEqual([m.provider, m.via], ["claude", "failover (Gemini capped → Claude)"]);
});
test("landingPick: mechanical walks A2's cheap order (Gemini Flash first, Claude Haiku next) like the hook", () => {
  assert.deepEqual(landingPick(role, ladder, "mechanical", { capped: [] }), { provider: "antigravity-cli", model: "g-cheap", via: "ladder", allCapped: false });
  assert.deepEqual(landingPick(role, ladder, "mechanical", { capped: ["antigravity-cli"] }), { provider: "claude", model: "claude-haiku-5-5", via: "failover (Gemini capped → Claude)", allCapped: false });
  const all = landingPick(role, ladder, "mechanical", { capped: ["claude", "antigravity-cli"] });
  assert.deepEqual([all.provider, all.via, all.allCapped], ["antigravity-cli", "all capped (Gemini capped, Claude capped)", true]);
});
test("landingPick: all capped stays on the first provider (or the override's) and flags allCapped", () => {
  const l = landingPick(role, ladder, "normal", { capped: ["claude", "antigravity-cli"] });
  assert.equal(l.provider, "claude");
  assert.equal(l.allCapped, true);
  assert.match(l.via, /^all capped \(Claude capped, Gemini capped\)$/);
  const o = landingPick(role, ladder, "normal", { capped: ["claude", "antigravity-cli"], override: { provider: "antigravity-cli", model: "g-top" } });
  assert.deepEqual([o.provider, o.model, o.allCapped], ["antigravity-cli", "g-top", true]);
  assert.match(allCappedNote(l.provider), /^All providers capped: will start on Claude and wait or fail over\.$/);
});

test("every SPAWN_REASONS member has a plain-words gloss, and `rung` reads as ladder (never rung in the UI)", () => {
  for (const r of SPAWN_REASONS) assert.ok(SPAWN_REASON_GLOSS[r], `no gloss for ${r}`);
  assert.equal(spawnReasonLabel("rung"), "ladder");
  for (const r of SPAWN_REASONS) assert.doesNotMatch(`${spawnReasonLabel(r)} ${SPAWN_REASON_GLOSS[r]}`, /\brung\b/i);
});
test("spawnChipTitle is plain words: no route text, no key=value, no self-contradiction", () => {
  const t = spawnChipTitle({ role: "Implement", model: "claude-opus-5-5", reason: "failover", provider: "Gemini" });
  assert.doesNotMatch(t, /why=|reason=|route:|tier=/);
  assert.match(t, /Failover/);
  assert.doesNotMatch(t, /Ladder/);
  assert.match(spawnChipTitle({ model: "m", reason: "arm", staged: true }), /staged switch/);
  assert.doesNotMatch(spawnChipTitle({ model: "m", reason: "arm", staged: true }), /Arm/);
});
test("getRolesState carries capped families from the disk caps file; unreadable = []", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-r2ui-"));
  const prev = process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH;
  try {
    const capsPath = join(dir, "capped.json");
    process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH = capsPath;
    const opts = { profilesPath: join(dir, "nope.json"), ladderPath: join(dir, "nol.json") };
    assert.deepEqual(getRolesState(opts).capped, []);
    writeFileSync(capsPath, JSON.stringify({ claude: { reason: "capped" } }));
    assert.deepEqual(getRolesState(opts).capped, ["claude"]);
    mkdirSync(join(dir, "d"));
    process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH = join(dir, "d"); // a directory: unreadable
    assert.deepEqual(getRolesState(opts).capped, []);
  } finally {
    if (prev === undefined) delete process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH;
    else process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("routeWhy reads the why= token the drawer chip shows", () => {
  assert.equal(routeWhy("route:implement mid why=failover"), "failover");
  assert.equal(routeWhy("route:implement"), "");
});

import { drawerSpawnWhy } from "../src/roleSpawn.ts";
test("drawerSpawnWhy: reason from route, hidden while staged, override after a live switch", () => {
  const l = { "vs.route": "route:implement why=arm", "vs.model": "m1" };
  assert.equal(drawerSpawnWhy(l, "m1", false), "arm");
  assert.equal(drawerSpawnWhy(l, "m1", true), "");
  assert.equal(drawerSpawnWhy(l, "m2", false), "override");
  assert.equal(drawerSpawnWhy({}, "m2", false), "");
});

test("seam: landingPick lands on the same provider (and model) as the hook's roleSpawnProfile, capped overrides included", async () => {
  const { roleSpawnProfile } = await import("../server/spawn-route.mjs");
  const { ROLE_TABLE } = await import("../server/role-route.mjs");
  const { DEFAULT_TIER_LADDER } = await import("../server/stakes-ladder.mjs");
  const fams = ["claude", "antigravity-cli", "opencode"];
  const capSets = [[], ["claude"], ["antigravity-cli"], ["claude", "antigravity-cli"], fams];
  let n = 0;
  for (const [key, def] of Object.entries(ROLE_TABLE)) {
    const roleRow = { name: def.name ?? key, tier: def.tier, providers: [...(def.providers ?? [])] };
    for (const stakes of ["normal", "tierA-invariant", "mechanical"]) {
      for (const capped of capSets) {
        for (const override of [null, ...roleRow.providers.map((provider) => ({ provider }))]) {
          const srv = roleSpawnProfile(roleRow.name, { stakes, caps: capped, ladder: DEFAULT_TIER_LADDER, ...(override ? { override } : {}) });
          if (!srv) continue;
          const ui = landingPick(roleRow, DEFAULT_TIER_LADDER, stakes, { capped, override });
          const at = `${roleRow.name} ${stakes} caps=[${capped}] ov=${override?.provider ?? "-"}`;
          assert.equal(ui.provider, srv.route.provider, `${at}: provider`);
          assert.equal(ui.model, String(srv.profile.model ?? ""), `${at}: model`);
          n++;
        }
      }
    }
  }
  assert.ok(n > 50, `compared ${n} cases`);
});

test("drawer chip: why=all-capped shows all-capped; an old why=rung shows ladder (with its gloss)", () => {
  const all = drawerSpawnWhy({ "vs.model": "claude-sonnet-5-5", "vs.route": "stakes=normal reason=all-capped tier=mid role=implement why=all-capped" }, "claude-sonnet-5-5", false);
  assert.equal(all, "all-capped");
  assert.equal(spawnReasonLabel(all), "all-capped");
  assert.match(spawnChipTitle({ model: "m", reason: all }), /All capped/);
  const old = drawerSpawnWhy({ "vs.route": "reason=default tier=mid role=review why=rung" }, "m", false);
  assert.equal(old, "ladder");
  assert.match(spawnChipTitle({ model: "m", reason: "rung" }), /Ladder: picked/);
});
