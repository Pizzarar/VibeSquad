// P5b (docs/PLAN_PROFILES_ROLE_ONLY.md, idea-77): profiles.json schema v2 (roles), the migration, and the legacy
// name -> role map. All file work happens in temp dirs; the fixture is a copy of ~/.vibesquad/profiles.json on
// 2026-11-17 (12 profiles, v1).
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_PACK_PROFILES,
  LEGACY_PROFILE_ALIASES,
  LEGACY_PROFILE_ROLES,
  legacyProfileRole,
  loadProfiles,
  saveProfiles,
} from "../server/profiles.mjs";
import {
  buildRolesFromProfiles,
  loadRoles,
  migrateProfilesData,
  migrateProfilesFile,
  normalizeRoles,
} from "../server/profiles-v2.mjs";
import { COUNTERPART_PROFILES, ROLE_FAILOVER_CHAINS, resolveProfileWithFailover } from "../server/provider-failover.mjs";
import { LEGACY_HOP_PROFILES, LEGACY_ROUTES, ROLE_TABLE, lookupRole, resolveRoute } from "../server/role-route.mjs";
import { DEFAULT_STAKES_LADDER, STAKES_VALUES, resolveStakesRoute } from "../server/stakes-ladder.mjs";
import { main as migrateCli, parseArgs } from "../scripts/migrate-profiles-v2.mjs";
import { migrateModelId } from "../server/model-ids.mjs";

const FIXTURE = new URL("./fixtures/profiles-v1-2026-11-17.json", import.meta.url);
const FIXTURE_BYTES = readFileSync(FIXTURE);
const FIXTURE_DATA = JSON.parse(FIXTURE_BYTES.toString("utf8"));
const USER_PROFILES = FIXTURE_DATA.profiles;
// The routing oracle reads the file as the server sees it after the N1 load-time migration (gemini-4-argon -> gemini-4-neon,
// server/profiles.mjs migrateRetiredProfileModels); the raw fixture stays the v2-migration input.
const LIVE_PROFILES = USER_PROFILES.map((p) => ({ ...p, model: migrateModelId(p.model) }));

const C = "claude";
const A = "antigravity-cli";
const O = "opencode";
const FAMS = [C, A, O];
const CAP_SETS = [[]];
for (const f of FAMS) for (const s of [...CAP_SETS]) CAP_SETS.push([...s, f]);
const pick = (r) => r && { provider: r.provider, model: r.model, effort: r.effort, modeId: r.modeId };

// The P5a golden table's roles for the 12 names in use (LEGACY_ROUTES at 2e3b9b99), plus the 9 old names P5b adds.
const P5A_ROLES = {
  "Lead - Claude": "lead",
  "Lead - Gemini": "lead",
  "Brainstorm - Claude": "brainstorm",
  "Brainstorm - Gemini": "brainstorm",
  "Implement - Sonnet": "implement",
  "Implement - Gemini (trial)": "implement",
  "Work Order - DSP": "work-order",
  "Review - Gemini": "review",
  "Review - Sonnet": "review",
  "Pre-check - Flash": "pre-check",
  "Art Director - Gemini": "art-director",
  "Art Painter - Opus": "art-painter",
};
const P5B_ROLES = {
  "Spec - Opus": "planner",
  "Planner - Sonnet": "planner",
  "Implement - Opus": "implement",
  "Senior Reasoning - DSP": "implement",
  "Mechanical - DSF": "work-order",
  "UX Reviewer - Opus": "review",
  "Check - Haiku": "pre-check",
  "Audit - DSF": "pre-check",
  "Scout - Flash": "pre-check",
};
const ALL_ROLES = { ...P5A_ROLES, ...P5B_ROLES };

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "vs-p5b-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixtureCopy(dir, name = "profiles.json") {
  const f = join(dir, name);
  copyFileSync(FIXTURE, f);
  return f;
}

const load = (f) => loadProfiles(f, { paseoProfiles: [], autoSeed: false });

/** Today's route for an old name: the failover walk over the real user file, then the old stakes ladder. */
function today(name, caps, stakes) {
  const fo = resolveProfileWithFailover(name, LIVE_PROFILES, [], { cappedProviders: caps, ignoreDiskCaps: true });
  const p = fo.profile;
  const sr = resolveStakesRoute(p.provider, p, stakes, false, { ladder: DEFAULT_STAKES_LADDER });
  return {
    provider: p.provider,
    model: (sr.apply && sr.model) || p.model,
    effort: (sr.apply && sr.effort) || p.thinkingOptionId,
    modeId: p.modeId,
  };
}

test("fixture is today's real pack: v1, the 12 golden names", () => {
  assert.equal(FIXTURE_BYTES[0], 0x7b); // no BOM
  assert.deepEqual(Object.keys(FIXTURE_DATA), ["version", "profiles"]);
  assert.deepEqual(USER_PROFILES.map((p) => p.name).sort(), Object.keys(P5A_ROLES).sort());
});

test("migration of the real pack: v2 written by node (no BOM), backup = original bytes, profiles untouched", (t) => {
  const dir = tmp(t);
  const f = fixtureCopy(dir);
  const rolesBefore = loadRoles(f);
  assert.equal(rolesBefore.source, "v1");
  const res = migrateProfilesFile(f);
  assert.equal(res.ok, true, res.error);
  assert.deepEqual([res.changed, res.fromVersion, res.roleCount, res.unmapped], [true, 1, 9, []]);
  assert.equal(res.backupPath, `${f}.bak-p5`);
  assert.ok(readFileSync(res.backupPath).equals(FIXTURE_BYTES), "backup is the original bytes");
  const raw = readFileSync(f);
  assert.notEqual(raw[0], 0xef, "no BOM");
  const text = raw.toString("utf8");
  assert.ok(text.endsWith("}\n"));
  const data = JSON.parse(text);
  assert.deepEqual(Object.keys(data), ["version", "schemaVersion", "roles", "profiles"]);
  assert.deepEqual([data.version, data.schemaVersion], [1, 2]);
  assert.deepEqual(Object.keys(data.roles), Object.keys(ROLE_TABLE));
  assert.deepEqual(data.profiles, FIXTURE_DATA.profiles, "v1 profile list kept as-is");
  // round trip: the stored roles read back equal what a v1 read builds, and equal a fresh build
  const after = loadRoles(f);
  assert.equal(after.source, "v2");
  assert.deepEqual(after.roles, rolesBefore.roles);
  // The fixture's notes are older shipped defaults: the migration stores them as-is, a load upgrades them (R1 follow-up).
  const norm = normalizeRoles(data.roles);
  assert.deepEqual(norm, after.roles);
  assert.deepEqual(normalizeRoles(norm), norm, "normal + upgraded is a fixed point");
  assert.deepEqual(buildRolesFromProfiles(data.profiles).roles, data.roles);
});

test("migration is idempotent: second run (API and CLI) changes nothing, no second backup", (t) => {
  const dir = tmp(t);
  const f = fixtureCopy(dir);
  assert.equal(migrateProfilesFile(f).changed, true);
  const once = readFileSync(f);
  const second = migrateProfilesFile(f);
  assert.deepEqual([second.ok, second.changed, second.reason], [true, false, "already-v2"]);
  const lines = [];
  assert.equal(migrateCli(["--path", f], (l) => lines.push(l)), 0);
  assert.match(lines[0], /no change \(already-v2\)/);
  assert.ok(readFileSync(f).equals(once), "byte-identical after re-runs");
  assert.deepEqual(readdirSync(dir).sort(), ["profiles.json", "profiles.json.bak-p5"]);
  // the data-level migration is idempotent too
  const d = JSON.parse(once.toString("utf8"));
  const r = migrateProfilesData(d);
  assert.deepEqual([r.changed, r.data], [false, d]);
});

test("v1 still loads, and loads the same profiles before and after migration", (t) => {
  const dir = tmp(t);
  const v1 = fixtureCopy(dir, "v1.json");
  const v2 = fixtureCopy(dir, "v2.json");
  migrateProfilesFile(v2);
  const a = load(v1);
  const b = load(v2);
  assert.equal(a.profiles.length, 12);
  assert.deepEqual(b.profiles, a.profiles);
  assert.equal(a.schemaVersion, undefined);
  assert.equal(a.roles, undefined);
  assert.equal(b.schemaVersion, 2);
  assert.deepEqual(Object.keys(b.roles), Object.keys(ROLE_TABLE));
  // a bare-array v1 root (oldest shape) also migrates
  const arr = join(dir, "arr.json");
  writeFileSync(arr, JSON.stringify(USER_PROFILES), "utf8");
  const ra = migrateProfilesFile(arr);
  assert.deepEqual([ra.ok, ra.changed], [true, true]);
  const da = JSON.parse(readFileSync(arr, "utf8"));
  assert.deepEqual(Object.keys(da), ["version", "schemaVersion", "roles", "profiles"]);
  assert.deepEqual(da.profiles, USER_PROFILES);
});

test("saving a profile into a v2 file keeps schemaVersion + roles (no downgrade), then migrate = no change", (t) => {
  const dir = tmp(t);
  const f = fixtureCopy(dir);
  migrateProfilesFile(f);
  const before = JSON.parse(readFileSync(f, "utf8"));
  saveProfiles({ profile: { name: "Lead - Claude", notes: "edited" } }, f);
  const after = JSON.parse(readFileSync(f, "utf8"));
  assert.deepEqual(Object.keys(after), ["version", "schemaVersion", "roles", "profiles"]);
  assert.equal(after.schemaVersion, 2);
  assert.deepEqual(after.roles, before.roles);
  assert.equal(after.profiles.find((p) => p.name === "Lead - Claude").notes, "edited");
  assert.equal(migrateProfilesFile(f).changed, false);
  // providers block + roles both survive a save
  const withIcons = { ...after, providers: { claude: { color: "#112233" } } };
  writeFileSync(f, JSON.stringify(withIcons), "utf8");
  saveProfiles({ profile: { name: "Lead - Gemini", notes: "x" } }, f);
  const again = JSON.parse(readFileSync(f, "utf8"));
  assert.deepEqual(Object.keys(again), ["version", "schemaVersion", "providers", "roles", "profiles"]);
  assert.deepEqual(again.roles, before.roles);
});

test("BOM input: output is BOM-free, backup keeps the original BOM bytes", (t) => {
  const dir = tmp(t);
  const f = join(dir, "profiles.json");
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), FIXTURE_BYTES]);
  writeFileSync(f, bom);
  const r = migrateProfilesFile(f);
  assert.deepEqual([r.ok, r.changed, r.hadBom], [true, true, true]);
  assert.ok(readFileSync(`${f}.bak-p5`).equals(bom));
  assert.notEqual(readFileSync(f)[0], 0xef);
  assert.equal(migrateProfilesFile(f).changed, false);
});

test("migrated real-pack roles: sources, prompts, tools, and routing identical to the built-in role table", (t) => {
  const { roles, sources } = buildRolesFromProfiles(USER_PROFILES);
  const byName = Object.fromEntries(USER_PROFILES.map((p) => [p.name, p]));
  for (const [key, def] of Object.entries(ROLE_TABLE)) {
    const r = roles[key];
    assert.deepEqual([r.name, r.tier, r.providers], [def.name, def.tier, def.providers], key);
    for (const p of def.providers) {
      assert.equal(r.modes[p].modeId, def.modes[p].modeId, `${key}/${p} modeId`);
      assert.equal(r.modes[p].effort, def.modes[p].effort, `${key}/${p} effort`);
      assert.notEqual(sources[key][p], "table", `${key}/${p} copied from a profile`);
    }
  }
  // prompts come from the role's own profiles in the user file; a differing per-provider prompt is kept
  assert.equal(roles.lead.prompt, byName["Lead - Claude"].notes);
  assert.equal(roles.lead.modes[A].prompt, byName["Lead - Gemini"].notes);
  assert.deepEqual(roles.lead.modes[A].featureValues, { approvalPolicy: "skip", shareMcp: "on" });
  assert.equal(roles.lead.modes[O].prompt, undefined, "cross-role hop (Senior Reasoning) keeps the role prompt");
  assert.equal(roles.lead.modes[O].from, "Senior Reasoning - DSP");
  assert.equal(sources.lead[O], "pack");
  assert.equal(roles.implement.modes[A].from, "Implement - Gemini (trial)");
  assert.equal(roles.implement.modes[A].prompt, byName["Implement - Gemini (trial)"].notes);
  assert.equal(roles.review.prompt, byName["Review - Gemini"].notes);
  assert.equal(roles.review.modes[C].prompt, byName["Review - Sonnet"].notes);
  assert.equal(roles["work-order"].prompt, byName["Work Order - DSP"].notes);
  assert.equal(roles["work-order"].modes[C].prompt, undefined);
  // tools: the user file predates mcpExtras, so the shipped value of the source profile applies
  assert.deepEqual(roles.implement.mcpExtras, ["playwright"]);
  assert.equal(roles.lead.mcpExtras, undefined);
  assert.deepEqual(roles.implement.modes[A].mcpExtras, [], "trial profile ships without playwright");
  // routing: stored roles behave exactly like ROLE_TABLE for every role x stakes x caps, and legacy names are unchanged
  let n = 0;
  for (const name of [...Object.keys(ROLE_TABLE), ...Object.keys(ALL_ROLES)]) {
    for (const caps of CAP_SETS) {
      for (const stakes of [...STAKES_VALUES, undefined]) {
        const want = resolveRoute({ role: name, stakes, caps });
        const got = resolveRoute({ role: name, stakes, caps }, { roles });
        assert.deepEqual(got, want, `${name} caps=[${caps}] stakes=${stakes}`);
        n++;
      }
    }
  }
  assert.equal(n, (9 + 21) * 8 * (STAKES_VALUES.length + 1));
});

test("user edits flow into the role: a changed mode, custom profiles kept but unmapped, renamed alias profile found", () => {
  const list = USER_PROFILES.map((p) => ({ ...p }));
  list.find((p) => p.name === "Review - Gemini").modeId = "plan";
  list.find((p) => p.name === "Lead - Claude").name = "Lead - Opus"; // stored under its old alias
  list.push({ name: "My Custom", role: "worker", provider: "codex", model: "gpt-x", notes: "mine" });
  const res = migrateProfilesData({ version: 1, profiles: list, extraKey: { keep: true } });
  assert.equal(res.changed, true);
  assert.deepEqual(res.unmapped, ["My Custom"]);
  assert.equal(res.data.roles.review.modes[A].modeId, "plan");
  assert.equal(res.data.roles.lead.modes[C].from, "Lead - Claude");
  assert.equal(res.data.roles.lead.prompt, USER_PROFILES.find((p) => p.name === "Lead - Claude").notes);
  assert.equal(res.data.profiles, list, "same array, untouched");
  assert.deepEqual(res.data.extraKey, { keep: true });
  // a profile moved to another provider no longer feeds that provider's mode: table defaults apply
  const moved = USER_PROFILES.map((p) => (p.name === "Review - Sonnet" ? { ...p, provider: "opencode" } : p));
  const b = buildRolesFromProfiles(moved);
  assert.equal(b.sources.review[C], "table");
  assert.deepEqual(b.roles.review.modes[C], { modeId: "auto", effort: "medium" });
});

test("migration guards: newer schema refused, bad JSON untouched, missing file, dry run, backup collision", (t) => {
  const dir = tmp(t);
  const f = join(dir, "profiles.json");
  assert.deepEqual(migrateProfilesFile(f), { ok: true, changed: false, path: f, reason: "missing" });
  writeFileSync(f, JSON.stringify({ version: 1, schemaVersion: 3, profiles: [] }), "utf8");
  const newer = migrateProfilesFile(f);
  assert.deepEqual([newer.ok, newer.changed], [false, false]);
  assert.match(newer.error, /newer/);
  writeFileSync(f, "{nope", "utf8");
  const bad = migrateProfilesFile(f);
  assert.deepEqual([bad.ok, bad.changed], [false, false]);
  assert.equal(readFileSync(f, "utf8"), "{nope");
  assert.equal(existsSync(`${f}.bak-p5`), false);
  writeFileSync(f, JSON.stringify({ version: 1 }), "utf8");
  assert.match(migrateProfilesFile(f).error, /no profiles list/);
  // dry run: reports, writes nothing
  copyFileSync(FIXTURE, f);
  const dry = migrateProfilesFile(f, { dryRun: true });
  assert.deepEqual([dry.ok, dry.changed, dry.dryRun, dry.roleCount], [true, true, true, 9]);
  assert.ok(readFileSync(f).equals(FIXTURE_BYTES));
  assert.equal(existsSync(`${f}.bak-p5`), false);
  // an older, different .bak-p5 is never overwritten
  writeFileSync(`${f}.bak-p5`, "older backup", "utf8");
  const r = migrateProfilesFile(f);
  assert.equal(r.backupPath, `${f}.bak-p5.1`);
  assert.equal(readFileSync(`${f}.bak-p5`, "utf8"), "older backup");
  assert.ok(readFileSync(`${f}.bak-p5.1`).equals(FIXTURE_BYTES));
});

test("CLI: --path required value, dry run and real run report, unknown args refused", (t) => {
  const dir = tmp(t);
  const f = fixtureCopy(dir);
  assert.throws(() => parseArgs(["--path"]), /needs a value/);
  assert.throws(() => parseArgs(["--path", "--dry-run"]), /needs a value/);
  assert.throws(() => parseArgs(["--path="]), /needs a value/);
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
  const out = [];
  assert.equal(migrateCli(["--bogus"], (l) => out.push(l)), 2);
  assert.equal(migrateCli(["--path", f, "--dry-run"], (l) => out.push(l)), 0);
  assert.match(out.at(-1), /would migrate .* v1 -> v2: 9 roles$/);
  assert.ok(readFileSync(f).equals(FIXTURE_BYTES));
  assert.equal(migrateCli([`--path=${f}`], (l) => out.push(l)), 0);
  assert.match(out.at(-1), /migrated .* v1 -> v2: 9 roles, backup .*profiles\.json\.bak-p5$/);
});

test("normalizeRoles: defaults fill gaps, provider aliases fold, bad fields fall back, user roles kept, stable", () => {
  const n = normalizeRoles({
    Review: { tier: "huge", providers: ["gemini", "anthropic", "gemini"], prompt: "r", modes: { gemini: { modeId: "plan" } } },
    "My Role": { name: "Mine", tier: "cheap", providers: ["codex"], modes: { codex: { modeId: "full-access" } } },
    junk: { name: "No tier" },
    lead: "not an object",
  });
  assert.deepEqual(Object.keys(n), [...Object.keys(ROLE_TABLE), "my-role"]);
  assert.equal(n.review.tier, "mid");
  assert.deepEqual(n.review.providers, [A, C]);
  assert.equal(n.review.prompt, "r");
  assert.deepEqual(n.review.modes[A], { modeId: "plan", effort: "medium" });
  assert.deepEqual(n.review.modes[C], { modeId: "auto", effort: "medium" });
  assert.deepEqual(n.lead.providers, ROLE_TABLE.lead.providers);
  assert.deepEqual(n["my-role"], { name: "Mine", tier: "cheap", providers: ["codex"], prompt: "", modes: { codex: { modeId: "full-access" } } });
  assert.deepEqual(normalizeRoles(n), n);
  // a role the stored block lacks still resolves (defaults), so legacy names keep working
  const r = resolveRoute({ role: "Lead - Claude" }, { roles: normalizeRoles({}) });
  assert.deepEqual([r.reason, r.role], ["legacy-name", "lead"]);
  assert.equal(loadRoles(join(tmpdir(), "vs-p5b-missing", "profiles.json")).source, "default");
});

test("legacy names: every old name and alias resolves to the P5a golden-table role, reason=legacy-name", () => {
  assert.deepEqual(LEGACY_PROFILE_ROLES, ALL_ROLES);
  assert.deepEqual(Object.keys(LEGACY_ROUTES).sort(), Object.keys(ALL_ROLES).sort());
  for (const [name, role] of Object.entries(ALL_ROLES)) {
    assert.equal(LEGACY_ROUTES[name].role, role, name);
    assert.deepEqual(legacyProfileRole(name), { name, alias: null, role }, name);
    assert.equal(lookupRole(name)?.key, role, name);
    const r = resolveRoute({ role: name });
    assert.deepEqual([r.reason, r.role, r.legacy, r.alias], ["legacy-name", role, name, null], name);
    assert.ok(LEGACY_HOP_PROFILES[name], `${name} hop pin`);
  }
  for (const [alias, target] of Object.entries(LEGACY_PROFILE_ALIASES)) {
    const role = ALL_ROLES[target];
    assert.ok(role, `${alias} -> ${target} has a role`);
    assert.deepEqual(legacyProfileRole(alias), { name: target, alias, role }, alias);
    const r = resolveRoute({ role: alias });
    assert.deepEqual([r.reason, r.role, r.legacy, r.alias], ["legacy-name", role, target, alias], alias);
  }
  // case-insensitive old names still hit; lowercase role words reach the new role, not an alias
  assert.equal(legacyProfileRole("review - gemini")?.name, "Review - Gemini");
  assert.equal(legacyProfileRole("lead"), null);
  assert.equal(lookupRole("lead")?.legacy, null);
  assert.equal(legacyProfileRole("Nope"), null);
  // coverage: the shipped pack, the failover tables (keys and hops), all have a role + route
  const names = new Set([
    ...DEFAULT_PACK_PROFILES.map((p) => p.name),
    ...Object.keys(ROLE_FAILOVER_CHAINS),
    ...Object.values(ROLE_FAILOVER_CHAINS).flat(),
    ...Object.keys(COUNTERPART_PROFILES),
    ...Object.values(COUNTERPART_PROFILES),
  ]);
  for (const n of names) assert.ok(LEGACY_PROFILE_ROLES[n] && LEGACY_ROUTES[n], n);
  for (const r of Object.values(LEGACY_PROFILE_ROLES)) assert.ok(ROLE_TABLE[r], r);
});

test("the 9 names P5b adds route exactly as today (real user file) for every caps x stakes", () => {
  let n = 0;
  for (const name of Object.keys(P5B_ROLES)) {
    for (const v of LEGACY_ROUTES[name].via) {
      const p = DEFAULT_PACK_PROFILES.find((x) => x.name === v) ?? LIVE_PROFILES.find((x) => x.name === v);
      assert.deepEqual(LEGACY_HOP_PROFILES[v], { provider: p.provider, model: p.model, effort: p.thinkingOptionId, modeId: p.modeId }, v);
    }
    for (const caps of CAP_SETS) {
      for (const s of [...STAKES_VALUES, undefined, "bogus"]) {
        const r = resolveRoute({ role: name, stakes: s, caps });
        assert.deepEqual(pick(r), today(name, caps, s), `${name} caps=[${caps}] stakes=${s}`);
        n++;
      }
    }
  }
  assert.equal(n, 9 * 8 * 6);
});

test("P5c L4: a schemaVersion 2 body without a roles object (or an empty one) is rebuilt, not returned as-is", (t) => {
  const list = JSON.parse(readFileSync(FIXTURE, "utf8")).profiles;
  for (const roles of [undefined, null, [], "x", {}]) {
    const res = migrateProfilesData({ version: 1, schemaVersion: 2, ...(roles === undefined ? {} : { roles }), profiles: list });
    assert.deepEqual([res.ok, res.changed, res.fromVersion], [true, true, 2], `roles=${JSON.stringify(roles)}`);
    assert.equal(Object.keys(res.data.roles).length, 9);
  }
  const good = migrateProfilesData(migrateProfilesData({ profiles: list }).data);
  assert.deepEqual([good.ok, good.changed], [true, false], "a real v2 body stays idempotent");
  const dir = tmp(t);
  const f = join(dir, "profiles.json");
  writeFileSync(f, JSON.stringify({ version: 1, schemaVersion: 2, profiles: list }), "utf8");
  const r = migrateProfilesFile(f);
  assert.deepEqual([r.ok, r.changed, r.roleCount], [true, true, 9]);
  assert.equal(migrateProfilesFile(f).reason, "already-v2");
});

test("P5c L1: the migrate CLI prints FAIL <reason> backup=<path>, never a raw stack", (t) => {
  const dir = tmp(t);
  const f = fixtureCopy(dir);
  const out = [];
  writeFileSync(f, "{nope", "utf8");
  assert.equal(migrateCli(["--path", f], (l) => out.push(l)), 1);
  assert.match(out.at(-1), /^migrate-profiles-v2: FAIL invalid JSON: .* path=.*profiles\.json backup=none$/);
  // A throw inside the migration (here: the backup slot is a directory) is caught and reported the same way.
  copyFileSync(FIXTURE, f);
  mkdirSync(`${f}.bak-p5`);
  assert.equal(migrateCli(["--path", f], (l) => out.push(l)), 1);
  assert.match(out.at(-1), /^migrate-profiles-v2: FAIL .* path=.*profiles\.json backup=none$/);
  assert.doesNotMatch(out.at(-1), /\n\s+at /);
  assert.ok(readFileSync(f).equals(FIXTURE_BYTES), "the file is untouched");
});

test("R1 planner role: Planner - Sonnet / Spec - Opus map to it; a v2 file migrated before it fills it from its own profiles", (t) => {
  assert.equal(legacyProfileRole("Planner - Sonnet").role, "planner");
  assert.equal(legacyProfileRole("Spec - Opus").role, "planner");
  const pack = DEFAULT_PACK_PROFILES.find((p) => p.name === "Planner - Sonnet");
  const built = buildRolesFromProfiles([]).roles.planner;
  assert.deepEqual([built.name, built.tier, built.providers], ["Planner", "mid", ROLE_TABLE.planner.providers]);
  assert.equal(built.prompt, pack.notes);
  assert.equal(built.modes.claude.from, "Planner - Sonnet");
  // A v2 body written before planner existed: loadRoles builds planner from the file's own (edited) profile.
  const list = JSON.parse(readFileSync(FIXTURE, "utf8")).profiles;
  const v2 = migrateProfilesData({ profiles: [...list, { ...pack, notes: "my planner notes" }] }).data;
  delete v2.roles.planner;
  const dir = tmp(t);
  const f = join(dir, "profiles.json");
  writeFileSync(f, JSON.stringify(v2), "utf8");
  const loaded = loadRoles(f);
  assert.equal(loaded.source, "v2");
  assert.equal(loaded.roles.planner.prompt, "my planner notes");
  assert.equal(v2.roles.lead.prompt, list.find((p) => p.name === "Lead - Claude").notes, "migration copies the stored note");
  assert.equal(loaded.roles.lead.prompt, DEFAULT_PACK_PROFILES.find((p) => p.name === "Lead - Claude").notes, "an unedited old default loads as the current one");
  // without the profiles list a missing role falls back to the table defaults (empty prompt), as before
  assert.equal(normalizeRoles({}).planner.prompt, "");
});

// R1 follow-up (unit-per-r1-v2-prompt-upgrade): v2 role prompts are migration copies of the shipped notes. One that is
// still exactly an older shipped default is upgraded to the current default at load; an edited one is never touched.
const packNote = (name) => DEFAULT_PACK_PROFILES.find((p) => p.name === name).notes;
const fixtureNote = (name) => USER_PROFILES.find((p) => p.name === name).notes;
function migratedFixture(t, edit) {
  const f = fixtureCopy(tmp(t));
  assert.equal(migrateProfilesFile(f).ok, true);
  if (edit) {
    const data = JSON.parse(readFileSync(f, "utf8"));
    edit(data);
    writeFileSync(f, JSON.stringify(data, null, 2) + "\n", "utf8");
  }
  return f;
}

test("v2 prompt upgrade: an unedited old shipped default (role and per-provider prompt) loads as the current default", (t) => {
  for (const n of ["Lead - Claude", "Lead - Gemini", "Review - Gemini", "Review - Sonnet"]) {
    assert.notEqual(fixtureNote(n), packNote(n), `${n}: fixture holds an older default`);
  }
  const f = migratedFixture(t);
  const stored = JSON.parse(readFileSync(f, "utf8")).roles;
  assert.equal(stored.lead.prompt, fixtureNote("Lead - Claude"), "the migration stored the old text");
  const bytes = readFileSync(f);
  const { roles, source } = loadRoles(f);
  assert.equal(source, "v2");
  assert.equal(roles.lead.prompt, packNote("Lead - Claude"));
  assert.equal(roles.lead.modes[A].prompt, packNote("Lead - Gemini"));
  assert.equal(roles.review.prompt, packNote("Review - Gemini"));
  assert.equal(roles.review.modes[C].prompt, packNote("Review - Sonnet"));
  assert.equal(roles["work-order"].prompt, packNote("Work Order - DSP"));
  // only prompts change; everything else is the stored role
  for (const [key, r] of Object.entries(roles)) {
    const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === "prompt" ? undefined : v)));
    assert.deepEqual(strip(r), strip(normalizeRoles({ [key]: stored[key] })[key]), key);
  }
  assert.ok(readFileSync(f).equals(bytes), "load-time upgrade: the file is not written");
  // a v1 file read through loadRoles gets the same upgrade
  const v1 = loadRoles(fixtureCopy(tmp(t)));
  assert.equal(v1.source, "v1");
  assert.deepEqual(v1.roles, roles);
});

test("v2 prompt upgrade: edited prompts are kept byte-for-byte, cross-role and user-added roles are never upgraded", (t) => {
  const edited = "My lead prompt.\r\n\r\nKeep this exactly.  ";
  const nearly = `${fixtureNote("Review - Sonnet")} Also check the tests.`;
  const f = migratedFixture(t, (data) => {
    data.roles.lead.prompt = edited;
    data.roles.review.modes.claude.prompt = nearly;
    data.roles.brainstorm.prompt = "";
    // implement's Gemini mode has no same-role shipped profile: even an old default there is kept
    data.roles.implement.modes["antigravity-cli"].prompt = fixtureNote("Lead - Gemini");
    data.roles["my-role"] = { name: "Mine", tier: "mid", providers: ["claude"], prompt: fixtureNote("Lead - Claude"), modes: {} };
  });
  const { roles } = loadRoles(f);
  assert.equal(roles.lead.prompt, edited);
  assert.equal(roles.lead.modes[A].prompt, packNote("Lead - Gemini"), "an unedited mode prompt next to an edited role prompt is still upgraded");
  assert.equal(roles.review.modes[C].prompt, nearly);
  assert.equal(roles.review.prompt, packNote("Review - Gemini"));
  assert.equal(roles.brainstorm.prompt, "", "a cleared prompt stays cleared");
  assert.equal(roles.implement.modes[A].prompt, fixtureNote("Lead - Gemini"));
  assert.equal(roles["my-role"].prompt, fixtureNote("Lead - Claude"));
});

test("v2 prompt upgrade is idempotent: a second load and a re-normalize change nothing; a role save persists it", async (t) => {
  const f = migratedFixture(t);
  const first = loadRoles(f).roles;
  assert.deepEqual(loadRoles(f).roles, first);
  assert.deepEqual(normalizeRoles(first, { profiles: USER_PROFILES }), first);
  // saving any role writes the whole normalized block, so the upgraded text lands on disk once
  const { saveRoles } = await import("../server/roles-api.mjs");
  saveRoles({ "art-painter": { tier: "top" } }, f);
  const disk = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(disk.roles.lead.prompt, packNote("Lead - Claude"));
  assert.equal(disk.roles.review.modes.claude.prompt, packNote("Review - Sonnet"));
  assert.deepEqual(disk.profiles, FIXTURE_DATA.profiles, "v1 profiles untouched");
  const bytes = readFileSync(f);
  assert.deepEqual(loadRoles(f).roles, normalizeRoles(disk.roles, { profiles: disk.profiles }));
  assert.ok(readFileSync(f).equals(bytes));
});

test("v2 prompt upgrade: a v1 file still migrates as before (stored text = the v1 notes, upgrade is load-time only)", (t) => {
  const f = fixtureCopy(tmp(t));
  const res = migrateProfilesFile(f);
  assert.deepEqual([res.ok, res.changed, res.fromVersion], [true, true, 1]);
  const data = JSON.parse(readFileSync(f, "utf8"));
  assert.deepEqual(data.roles, buildRolesFromProfiles(FIXTURE_DATA.profiles).roles);
  assert.deepEqual(data.profiles, FIXTURE_DATA.profiles);
});

test("v2 prompt upgrade: a role missing from a migrated file is filled from the current default", (t) => {
  // the R1 planner path: the role is built from the file's own (old default) profile, then upgraded like a stored one
  const f = migratedFixture(t, (data) => {
    delete data.roles.review;
  });
  const { roles } = loadRoles(f);
  assert.equal(roles.review.prompt, packNote("Review - Gemini"));
  assert.equal(roles.review.modes[C].prompt, packNote("Review - Sonnet"));
});

test("v2 prompt upgrade: text equal to another role's or provider's CURRENT default is a deliberate copy and kept", (t) => {
  const shipped = buildRolesFromProfiles([]).roles;
  // reviewer repro 1: Lead's prompt pasted into Planner
  const a = normalizeRoles({ ...shipped, planner: { ...shipped.planner, prompt: shipped.lead.prompt } });
  assert.equal(a.planner.prompt, shipped.lead.prompt);
  // reviewer repro 2: one prompt for both providers (Gemini mode set to the role prompt)
  const lead = { ...shipped.lead, modes: { ...shipped.lead.modes, [A]: { ...shipped.lead.modes[A], prompt: shipped.lead.prompt } } };
  const b = normalizeRoles({ ...shipped, lead });
  assert.equal(b.lead.modes[A].prompt, shipped.lead.prompt);
  // another shipped note outside the role table (Scout) is current too
  assert.equal(normalizeRoles({ ...shipped, review: { ...shipped.review, prompt: packNote("Scout - Flash") } }).review.prompt, packNote("Scout - Flash"));
  // the same files through loadRoles (the Settings PUT reply and spawns read this)
  const f = migratedFixture(t, (data) => {
    data.roles.planner.prompt = packNote("Lead - Claude");
    data.roles.lead.modes[A].prompt = packNote("Lead - Claude");
  });
  const { roles } = loadRoles(f);
  assert.equal(roles.planner.prompt, packNote("Lead - Claude"));
  assert.equal(roles.lead.modes[A].prompt, packNote("Lead - Claude"));
  // its own old default still upgrades (fixture: lead prompt and review's Claude prompt are retired text)
  assert.equal(roles.lead.prompt, packNote("Lead - Claude"));
  assert.equal(roles.review.modes[C].prompt, packNote("Review - Sonnet"));
});
