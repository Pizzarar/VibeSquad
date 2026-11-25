// R2 UI: New Agent badge shows where a spawn lands (landingPick) + GET /roles carries `capped`; drawer chip reads routeWhy.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getRolesState } from "../server/roles-api.mjs";
import { routeWhy } from "../server/spawn-reason.mjs";
import { landingPick } from "../src/roleSpawn.ts";

const ladder = {
  claude: { top: { model: "claude-opus-5-5" }, mid: { model: "claude-sonnet-5-5" }, cheap: { model: "claude-haiku-5-5" } },
  "antigravity-cli": { top: { model: "g-top" }, mid: { model: "g-mid" }, cheap: { model: "g-cheap" } },
};
const role = { name: "Implement", tier: "mid", providers: ["claude", "antigravity-cli"] };
const ALL = ["claude", "antigravity-cli", "opencode"];

test("landingPick: nothing capped lands on the first provider via ladder", () => {
  assert.deepEqual(landingPick(role, ladder, "normal", { capped: [], installed: ALL }), { provider: "claude", model: "claude-sonnet-5-5", via: "ladder" });
});
test("landingPick: capped first provider fails over to the next", () => {
  const l = landingPick(role, ladder, "normal", { capped: ["claude"], installed: ALL });
  assert.deepEqual(l, { provider: "antigravity-cli", model: "g-mid", via: "failover (Claude capped → Gemini)" });
});
test("landingPick: first provider not installed fails over", () => {
  const l = landingPick(role, ladder, "tierA-security", { capped: [], installed: ["antigravity-cli"] });
  assert.equal(l.provider, "antigravity-cli");
  assert.equal(l.model, "g-top");
  assert.equal(l.via, "failover (Claude not installed → Gemini)");
});
test("landingPick: override wins over caps", () => {
  const l = landingPick(role, ladder, "normal", { capped: ["claude"], installed: ALL, override: { provider: "claude", model: "claude-opus-5-5" } });
  assert.deepEqual(l, { provider: "claude", model: "claude-opus-5-5", via: "override" });
  assert.equal(landingPick(role, ladder, "normal", { capped: [], override: { provider: "antigravity-cli" } }).via, "override (provider rung)");
});
test("landingPick: mechanical walks A2's cheap order (Gemini Flash first, Claude Haiku next) like the hook", () => {
  assert.deepEqual(landingPick(role, ladder, "mechanical", { capped: [], installed: ALL }), { provider: "antigravity-cli", model: "g-cheap", via: "ladder" });
  assert.deepEqual(landingPick(role, ladder, "mechanical", { capped: ["antigravity-cli"], installed: ALL }), { provider: "claude", model: "claude-haiku-5-5", via: "failover (Gemini capped → Claude)" });
  const all = landingPick(role, ladder, "mechanical", { capped: ["claude", "antigravity-cli"], installed: ALL });
  assert.deepEqual([all.provider, all.via], ["antigravity-cli", "all capped (Gemini capped, Claude capped)"]);
});
test("landingPick: all capped stays on the first provider and says so", () => {
  const l = landingPick(role, ladder, "normal", { capped: ["claude", "antigravity-cli"], installed: ALL });
  assert.equal(l.provider, "claude");
  assert.match(l.via, /^all capped \(Claude capped, Gemini capped\)$/);
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
