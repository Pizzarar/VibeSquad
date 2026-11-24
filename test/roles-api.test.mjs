// P5d: role + ladder editor endpoints (server/roles-api.mjs).
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getRolesState, handleRolesApi, saveLadder, saveRoles } from "../server/roles-api.mjs";
import { loadRoles } from "../server/profiles-v2.mjs";

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
    assert.equal(Object.keys(s.roles).length, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
