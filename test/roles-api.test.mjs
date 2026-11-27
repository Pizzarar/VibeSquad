// P5d: role + ladder editor endpoints (server/roles-api.mjs).
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertLegacyProfilesWritable,
  getRolesState,
  handleRolesApi,
  legacyProfilesConflict,
  saveLadder,
  saveRoles,
} from "../server/roles-api.mjs";
import { buildRolesFromProfiles, loadRoles } from "../server/profiles-v2.mjs";
import { loadProfiles, saveProfiles, seedDefaultPack } from "../server/profiles.mjs";
import { ROLE_TABLE, resolveRoute } from "../server/role-route.mjs";
import { liveRoles, roleMcpExtras, roleSpawnConfig, roleSpawnProfile } from "../server/spawn-route.mjs";
import { STAKES_VALUES, loadTierLadder } from "../server/stakes-ladder.mjs";

const FIXTURE = new URL("./fixtures/profiles-v1-2026-11-17.json", import.meta.url);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "roles-api-"));
  const profiles = join(dir, "profiles.json");
  copyFileSync(FIXTURE, profiles);
  return { dir, profiles, ladder: join(dir, "stakes-ladder.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("saveRoles migrates v1 -> v2 with a backup, replaces only the named role, keeps profiles", () => {
  const t = setup();
  try {
    const before = JSON.parse(readFileSync(t.profiles, "utf8")).profiles;
    const role = { ...loadRoles(t.profiles).roles.review, prompt: "Review only. No edits.", mcpExtras: ["Browser"] };
    role.modes = { ...role.modes, claude: { ...role.modes.claude, effort: "high" } };
    saveRoles({ review: role }, t.profiles);
    assert.ok(existsSync(`${t.profiles}.bak-p5`));
    const file = JSON.parse(readFileSync(t.profiles, "utf8"));
    assert.equal(file.schemaVersion, 2);
    assert.deepEqual(file.profiles, before);
    assert.equal(file.roles.review.prompt, "Review only. No edits.");
    assert.deepEqual(file.roles.review.mcpExtras, ["browser"]);
    assert.equal(file.roles.review.modes.claude.effort, "high");
    assert.ok(file.roles.lead, "other roles stay");
    const again = loadRoles(t.profiles);
    assert.equal(again.source, "v2");
    assert.equal(again.roles.review.prompt, "Review only. No edits.");
  } finally {
    t.done();
  }
});

test("saveRoles keeps a tier/provider change and rejects a role with no usable shape", () => {
  const t = setup();
  try {
    const role = { ...loadRoles(t.profiles).roles.implement, tier: "cheap", providers: ["opencode", "claude"] };
    saveRoles({ implement: role }, t.profiles);
    const got = loadRoles(t.profiles).roles.implement;
    assert.equal(got.tier, "cheap");
    assert.deepEqual(got.providers, ["opencode", "claude"]);
    assert.throws(() => saveRoles({ "my-new": { prompt: "x" } }, t.profiles), /needs a name/);
    saveRoles({ "My New": { name: "My New", tier: "mid", providers: ["claude"], prompt: "p", modes: { claude: { modeId: "auto" } } } }, t.profiles);
    assert.equal(loadRoles(t.profiles).roles["my-new"].name, "My New");
    assert.throws(() => saveRoles({}, t.profiles));
  } finally {
    t.done();
  }
});

test("saveLadder writes tier rungs, merges, a blank rung restores the default, fable refused", () => {
  const t = setup();
  try {
    let l = saveLadder({ claude: { mid: { model: "claude-sonnet-5-5", effort: "high" } } }, t.ladder);
    assert.equal(l.claude.mid.effort, "high");
    assert.equal(l.claude.top.model, "claude-opus-5-5");
    l = saveLadder({ opencode: { cheap: { model: "deepseek/deepseek-v4-flash" } } }, t.ladder);
    assert.equal(l.claude.mid.effort, "high", "earlier edit kept");
    assert.equal(l.opencode.cheap.model, "deepseek/deepseek-v4-flash");
    l = saveLadder({ claude: { mid: {} } }, t.ladder);
    assert.equal(l.claude.mid.effort, "medium", "default back");
    assert.throws(() => saveLadder({ claude: { top: { model: "claude-fable-5-2" } } }, t.ladder), /Fable/);
    assert.throws(() => saveLadder({ claude: { huge: { model: "x" } } }, t.ladder), /tier/);
  } finally {
    t.done();
  }
});

test("saveLadder keeps legacy per-stakes keys already in the file", () => {
  const t = setup();
  try {
    writeFileSync(t.ladder, JSON.stringify({ ladder: { claude: { mechanical: { model: "claude-haiku-5-5" } } } }));
    saveLadder({ claude: { top: { effort: "max" } } }, t.ladder);
    const raw = JSON.parse(readFileSync(t.ladder, "utf8"));
    assert.equal(raw.ladder.claude.mechanical.model, "claude-haiku-5-5");
    assert.equal(raw.ladder.claude.top.effort, "max");
  } finally {
    t.done();
  }
});

test("handleRolesApi GET/PUT round trip", async () => {
  const t = setup();
  try {
    const sent = [];
    const sendJson = (_r, status, data) => sent.push({ status, data });
    const res = {};
    await handleRolesApi({ method: "GET" }, res, { sendJson, readBody: async () => ({}), profilesPath: t.profiles, ladderPath: t.ladder });
    assert.equal(sent[0].status, 200);
    assert.equal(sent[0].data.source, "v1");
    assert.deepEqual(sent[0].data.tiers, ["top", "mid", "cheap"]);
    const roles = { lead: { ...sent[0].data.roles.lead, prompt: "Lead notes" } };
    await handleRolesApi({ method: "PUT" }, res, {
      sendJson,
      readBody: async () => ({ roles, ladder: { claude: { top: { effort: "max" } } } }),
      profilesPath: t.profiles,
      ladderPath: t.ladder,
    });
    assert.equal(sent[1].status, 200);
    assert.equal(sent[1].data.source, "v2");
    assert.equal(sent[1].data.roles.lead.prompt, "Lead notes");
    assert.equal(sent[1].data.ladder.claude.top.effort, "max");
    await handleRolesApi({ method: "PUT" }, res, { sendJson, readBody: async () => ({}), profilesPath: t.profiles, ladderPath: t.ladder });
    assert.equal(sent[2].status, 400);
  } finally {
    t.done();
  }
});

test("getRolesState on a missing file falls back to ROLE_TABLE defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "roles-api-"));
  try {
    const s = getRolesState({ profilesPath: join(dir, "nope.json"), ladderPath: join(dir, "nol.json") });
    assert.equal(s.source, "default");
    assert.equal(Object.keys(s.roles).length, 10);
    assert.equal(s.roles["ux-review"]?.name, "UX Review", "R1 fu: UX Review is listed (not hidden)");
    assert.deepEqual(s.hiddenRoles, ["work-order"], "R1: work-order routes but is left out of role listings");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- P5d fix round 2 ----

const sink = () => {
  const sent = [];
  return { sent, sendJson: (_r, status, data) => sent.push({ status, data }) };
};
const put = async (t, body, extra = {}) => {
  const { sent, sendJson } = sink();
  await handleRolesApi({ method: "PUT" }, {}, { sendJson, readBody: async () => body, profilesPath: t.profiles, ladderPath: t.ladder, ...extra });
  return sent[0];
};

test("saveRoles migration is idempotent: one backup, profiles list byte-stable, second save changes only the role", () => {
  const t = setup();
  try {
    const role = loadRoles(t.profiles).roles.review;
    saveRoles({ review: { ...role, prompt: "one" } }, t.profiles);
    const first = JSON.parse(readFileSync(t.profiles, "utf8"));
    saveRoles({ review: { ...role, prompt: "two" } }, t.profiles);
    saveRoles({ review: { ...role, prompt: "two" } }, t.profiles);
    const second = JSON.parse(readFileSync(t.profiles, "utf8"));
    const backups = readdirSync(t.dir).filter((f) => f.includes(".bak-p5"));
    assert.deepEqual(backups, ["profiles.json.bak-p5"], "the migration backed up once");
    assert.deepEqual(second.profiles, first.profiles);
    assert.equal(second.roles.review.prompt, "two");
    assert.deepEqual({ ...second.roles, review: null }, { ...first.roles, review: null }, "other roles untouched");
  } finally {
    t.done();
  }
});

test("invalid role input is a 400 and never falls back silently (tier, providers, unknown provider, effort, prototype keys)", async () => {
  const t = setup();
  try {
    const base = loadRoles(t.profiles).roles.implement;
    const cases = [
      [{ implement: { ...base, tier: "huge" } }, /unknown tier "huge"/],
      [{ implement: { ...base, providers: [] } }, /at least one provider/],
      [{ implement: { ...base, providers: ["claude", "openai"] } }, /unknown provider "openai"/],
      [{ implement: { ...base, modes: { ...base.modes, bogus: { modeId: "auto" } } } }, /unknown provider "bogus"/],
      [{ implement: { ...base, modes: { ...base.modes, claude: { modeId: "auto", effort: "turbo" } } } }, /unknown effort "turbo"/],
      [{ implement: { ...base, name: "  " } }, /needs a name/],
      [{ constructor: { ...base } }, /not allowed/],
      [{ "new-role": { name: "New", tier: "mid", providers: ["claude"] }, "bad role!": { ...base } }, /not allowed/],
    ];
    const before = readFileSync(t.profiles, "utf8");
    for (const [roles, re] of cases) {
      const r = await put(t, { roles: JSON.parse(JSON.stringify(roles)) });
      assert.equal(r.status, 400, `${JSON.stringify(roles).slice(0, 80)}: ${JSON.stringify(r.data)}`);
      assert.match(r.data.error, re);
    }
    const proto = await put(t, { roles: JSON.parse(`{"__proto__": ${JSON.stringify(base)}}`) });
    assert.equal(proto.status, 400, JSON.stringify(proto.data));
    assert.match(proto.data.error, /not allowed/);
    assert.equal(readFileSync(t.profiles, "utf8"), before, "a refused save writes nothing (not even the migration)");
    // A built-in role patch that omits tier/providers keeps the stored ones.
    const ok = await put(t, { roles: { implement: { name: "Implement", prompt: "p" } } });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.roles.implement.tier, base.tier);
    assert.deepEqual(ok.data.roles.implement.providers, base.providers);
  } finally {
    t.done();
  }
});

test("effort: omitted takes the shipped value, cleared (blank/null) stays cleared across reloads and resolves to none", () => {
  const t = setup();
  try {
    const role = loadRoles(t.profiles).roles["work-order"];
    const ocEffort = ROLE_TABLE["work-order"].modes.opencode.effort;
    assert.ok(ocEffort, "fixture: work-order has a shipped opencode effort");
    saveRoles({ "work-order": { ...role, modes: { ...role.modes, opencode: { modeId: "build" } } } }, t.profiles);
    assert.equal(loadRoles(t.profiles).roles["work-order"].modes.opencode.effort, ocEffort, "omitted = shipped effort");
    saveRoles({ "work-order": { ...role, modes: { ...role.modes, opencode: { modeId: "build", effort: "" } } } }, t.profiles);
    const cleared = loadRoles(t.profiles).roles["work-order"];
    assert.equal(cleared.modes.opencode.effort, null, "cleared survives the reload");
    const route = resolveRoute({ role: "work-order", ladder: { opencode: { mid: { model: "deepseek/deepseek-v4-pro" } } } }, { roles: cleared ? loadRoles(t.profiles).roles : undefined });
    assert.equal(route.provider, "opencode");
    assert.equal(route.effort, undefined, "no rung effort + cleared role effort = provider default");
  } finally {
    t.done();
  }
});

test("saveLadder: unknown provider/effort are 400s; {} deletes the override key; a corrupt file is refused and kept", async () => {
  const t = setup();
  try {
    for (const [ladder, re] of [
      [{ openai: { top: { model: "gpt" } } }, /Unknown provider "openai"/],
      [{ claude: { top: { effort: "turbo" } } }, /unknown effort "turbo"/],
      [{ claude: { top: "x" } }, /must be an object/],
      [{ claude: { top: { model: "claude-fable-5-2" } } }, /Fable/],
    ]) {
      const r = await put(t, { ladder });
      assert.equal(r.status, 400, JSON.stringify(r.data));
      assert.match(r.data.error, re);
    }
    assert.equal(existsSync(t.ladder), false, "nothing written");
    saveLadder({ claude: { top: { model: "claude-opus-5-5", effort: "max" } } }, t.ladder);
    saveLadder({ claude: { top: {} } }, t.ladder);
    assert.deepEqual(JSON.parse(readFileSync(t.ladder, "utf8")), { ladder: {} }, "reset removes the key, no explicit default strings");
    writeFileSync(t.ladder, "{ not json");
    const r = await put(t, { ladder: { claude: { mid: { effort: "high" } } } });
    assert.equal(r.status, 500, JSON.stringify(r.data));
    assert.match(r.data.error, /not valid JSON/);
    assert.equal(readFileSync(t.ladder, "utf8"), "{ not json", "corrupt file kept");
    writeFileSync(t.ladder, "[1,2]");
    assert.throws(() => saveLadder({ claude: { mid: { effort: "high" } } }, t.ladder), /not a JSON object/);
    assert.equal(readFileSync(t.ladder, "utf8"), "[1,2]");
  } finally {
    t.done();
  }
});

test("a corrupt profiles.json is refused (500 with a fix-it message) and left as it was; other faults go to serverError", async () => {
  const t = setup();
  try {
    writeFileSync(t.profiles, "{ broken");
    const r = await put(t, { roles: { lead: { prompt: "x" } } });
    assert.equal(r.status, 500, JSON.stringify(r.data));
    assert.match(r.data.error, /not valid JSON|invalid JSON/);
    assert.equal(readFileSync(t.profiles, "utf8"), "{ broken");
    const seen = [];
    const fsErr = Object.assign(new Error("EACCES: permission denied, open '/secret/path'"), { code: "EACCES", syscall: "open" });
    const { sent, sendJson } = sink();
    await handleRolesApi({ method: "PUT" }, {}, {
      sendJson,
      readBody: async () => { throw fsErr; },
      serverError: (_res, e) => seen.push(e),
    });
    assert.deepEqual(seen, [fsErr], "fs faults go to the caller's sendServerFsError path");
    assert.equal(sent.length, 0);
  } finally {
    t.done();
  }
});

test("C2: after migration a legacy write that changes a role is a 409; custom profiles and model-only edits pass; v1 unaffected", () => {
  const t = setup();
  try {
    const guard = { beforeWrite: assertLegacyProfilesWritable };
    // v1: anything goes (today's behaviour).
    assert.deepEqual(legacyProfilesConflict([], t.profiles), []);
    saveProfiles({ profile: { name: "Review - Gemini", notes: "v1 edit" } }, t.profiles, guard);
    saveRoles({ lead: loadRoles(t.profiles).roles.lead }, t.profiles);
    const migrated = readFileSync(t.profiles, "utf8");
    let err;
    try {
      saveProfiles({ profile: { name: "Review - Gemini", notes: "after migration" } }, t.profiles, guard);
    } catch (e) {
      err = e;
    }
    assert.equal(err?.status, 409, String(err));
    assert.match(err.message, /Review.*Edit Roles and Tier Ladder/);
    assert.equal(readFileSync(t.profiles, "utf8"), migrated, "refused write left the file alone");
    assert.throws(() => saveProfiles({ profile: { name: "Lead - Claude", modeId: "plan" } }, t.profiles, guard), /read-only/);
    assert.throws(() => seedDefaultPack(t.profiles, guard), (e) => e.status === 409);
    // A custom profile and a model-only change of an old name do not touch any role.
    saveProfiles({ profile: { name: "My Custom", provider: "claude", model: "claude-sonnet-5-5", notes: "x" } }, t.profiles, guard);
    const list = loadProfiles(t.profiles, { autoSeed: false }).profiles;
    const lc = list.find((p) => p.name === "Lead - Claude");
    saveProfiles({ profile: { ...lc, model: "claude-sonnet-5-5" } }, t.profiles, guard);
    const file = JSON.parse(readFileSync(t.profiles, "utf8"));
    assert.equal(file.schemaVersion, 2);
    assert.ok(file.roles.lead, "roles block kept");
    assert.ok(file.profiles.some((p) => p.name === "My Custom"));
  } finally {
    t.done();
  }
});

test("C1: a saved role and ladder change the live spawn config; a v1 home routes exactly as P5c built it", () => {
  const t = setup();
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = t.dir; // roleSpawnConfig reads the ladder from $VIBESQUAD_HOME/stakes-ladder.json
  try {
    const list = loadProfiles(t.profiles, { autoSeed: false }).profiles;
    // v1: stored roles absent -> identical to building from the list (P5c), for every role x stakes value.
    assert.deepEqual(liveRoles(list, t.profiles), buildRolesFromProfiles(list).roles);
    for (const key of Object.keys(ROLE_TABLE)) {
      for (const stakes of [...STAKES_VALUES, undefined]) {
        const got = roleSpawnConfig(key, { profiles: list, profilesPath: t.profiles, stakes });
        const want = roleSpawnProfile(key, { stakes, caps: [], roles: buildRolesFromProfiles(list).roles });
        assert.deepEqual(got.profile, want.profile, `${key} ${stakes}`);
        assert.deepEqual(got.route, want.route, `${key} ${stakes}`);
      }
    }
    const before = roleSpawnConfig("implement", { profiles: list, profilesPath: t.profiles });
    assert.equal(before.spawnCfg.provider, "antigravity-cli");
    assert.equal(before.route.provider, "agy-claude");
    // Save: implement prefers opencode in plan mode with its own prompt + tools; opencode mid rung -> flash model.
    const role = loadRoles(t.profiles).roles.implement;
    saveRoles(
      {
        implement: {
          ...role,
          prompt: "Saved implement prompt",
          mcpExtras: ["browser"],
          providers: ["opencode", "claude"],
          modes: { ...role.modes, opencode: { modeId: "plan", effort: "low" } },
        },
      },
      t.profiles,
    );
    saveLadder({ opencode: { mid: { model: "deepseek/deepseek-v4-flash" } } }, join(t.dir, "stakes-ladder.json"));
    const after = roleSpawnConfig("implement", { profiles: list, profilesPath: t.profiles });
    assert.deepEqual(
      [after.spawnCfg.provider, after.spawnCfg.model, after.spawnCfg.modeId, after.spawnCfg.thinkingOptionId, after.spawnCfg.notes],
      ["opencode", "deepseek/deepseek-v4-flash", "plan", "low", "Saved implement prompt"],
    );
    assert.deepEqual(roleMcpExtras("implement", list, "opencode", t.profiles), ["browser"]);
    // The same through resolveRoute with the stored roles + effective ladder.
    const r = resolveRoute({ role: "implement", ladder: loadTierLadder(join(t.dir, "stakes-ladder.json")) }, { roles: loadRoles(t.profiles).roles });
    assert.deepEqual([r.provider, r.model, r.modeId, r.effort], ["opencode", "deepseek/deepseek-v4-flash", "plan", "low"]);
    // Capped opencode walks to the next stored provider (agy-claude before direct claude under R10).
    const capped = roleSpawnConfig("implement", { profiles: list, profilesPath: t.profiles, usageList: [{ id: "opencode", status: "exhausted", usedPct: 100 }] });
    assert.equal(capped.spawnCfg.provider, "antigravity-cli");
    assert.equal(capped.route.provider, "agy-claude");
    const cappedBoth = roleSpawnConfig("implement", {
      profiles: list,
      profilesPath: t.profiles,
      usageList: [{ id: "opencode", status: "exhausted", usedPct: 100 }, { id: "agy-claude", status: "exhausted", usedPct: 100 }],
    });
    assert.equal(cappedBoth.spawnCfg.provider, "claude");
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    t.done();
  }
});

// ---- P5d fix round 3 ----

test("r3: a partial role PUT merges over the stored role (prompt, tools, modes kept); [] and \"\" clear them", () => {
  const t = setup();
  try {
    const role = loadRoles(t.profiles).roles.review;
    saveRoles({ review: { ...role, prompt: "MY CUSTOM PROMPT", providers: ["claude"], mcpExtras: ["playwright"] } }, t.profiles);
    saveRoles({ review: { tier: "top" } }, t.profiles);
    const kept = loadRoles(t.profiles).roles.review;
    assert.equal(kept.tier, "top");
    assert.equal(kept.prompt, "MY CUSTOM PROMPT");
    assert.deepEqual(kept.providers, ["claude"]);
    assert.deepEqual(kept.mcpExtras, ["playwright"]);
    saveRoles({ review: { mcpExtras: [], prompt: "" } }, t.profiles);
    const cleared = loadRoles(t.profiles).roles.review;
    assert.equal(cleared.prompt, "");
    assert.equal(cleared.mcpExtras, undefined);
    assert.equal(cleared.tier, "top");
  } finally {
    t.done();
  }
});

test("r3: a { roles, ladder } PUT with a bad ladder is a 400 and writes neither file", async () => {
  const t = setup();
  try {
    const before = readFileSync(t.profiles, "utf8");
    const role = loadRoles(t.profiles).roles.review;
    const out = await put(t, { roles: { review: { ...role, prompt: "changed" } }, ladder: { claude: { top: { effort: "warp" } } } });
    assert.equal(out.status, 400);
    assert.equal(readFileSync(t.profiles, "utf8"), before, "profiles.json untouched");
    assert.ok(!existsSync(`${t.profiles}.bak-p5`), "no migration ran");
    assert.ok(!existsSync(t.ladder), "ladder untouched");
  } finally {
    t.done();
  }
});
