import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LEAN_ARGS, LEAN_DENY, leanApplies, leanProviderOptions } from "../server/lean-tools.mjs";
import { createPlugin } from "../plugin/index.server.ts";

test("leanApplies: claude only, VS_LEAN=off opts out, provider/model string handled", () => {
  assert.equal(leanApplies("claude", {}), true);
  assert.equal(leanApplies("claude/claude-opus-5-5", undefined), true);
  assert.equal(leanApplies("codex", {}), false);
  assert.equal(leanApplies("antigravity-cli", {}), false);
  assert.equal(leanApplies("", {}), false);
  assert.equal(leanApplies("claude", { VS_LEAN: "off" }), false);
});

test("leanProviderOptions: unions deny lists, caller extraArgs win, keeps other options", () => {
  const out = leanProviderOptions({ disallowedTools: ["Foo", "Workflow"], extraArgs: { "strict-mcp-config": "x", other: "1" }, allowedTools: ["Bar"] });
  assert.deepEqual(out.allowedTools, ["Bar"]);
  assert.ok(out.disallowedTools.includes("Foo"));
  assert.equal(out.disallowedTools.filter((t) => t === "Workflow").length, 1);
  for (const t of ["Workflow", "PowerShell", "Agent", "ScheduleWakeup", "ReportFindings"]) assert.ok(out.disallowedTools.includes(t), t);
  assert.equal(out.extraArgs["strict-mcp-config"], "x");
  assert.equal(out.extraArgs.other, "1");
  assert.equal(out.extraArgs["disable-slash-commands"], undefined);
  assert.deepEqual(leanProviderOptions(undefined), { disallowedTools: LEAN_DENY });
  assert.equal(leanProviderOptions(undefined).extraArgs, undefined);
  assert.ok(leanProviderOptions({}, "worker").disallowedTools.includes("AskUserQuestion"));
  assert.ok(leanProviderOptions({}, "lead").disallowedTools.includes("AskUserQuestion"));
  assert.ok(!leanProviderOptions({}, "brainstorm").disallowedTools.includes("AskUserQuestion"));
  assert.ok(leanProviderOptions({}, "brainstorm").disallowedTools.includes("Workflow"));
});

test("core tools and the paseo MCP are never denied", () => {
  for (const t of ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "Skill", "ToolSearch"]) assert.ok(!LEAN_DENY.includes(t), t);
  assert.ok(!LEAN_DENY.some((t) => t.startsWith("mcp__")));
});

test("before(agent.create) adds lean providerOptions to claude spawns only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-lean-test-"));
  const prev = { h: process.env.VIBESQUAD_HOME, t: process.env.VIBESQUAD_TEAMS_FILE };
  mkdirSync(join(dir, "h"), { recursive: true });
  writeFileSync(join(dir, "h", "teams.json"), JSON.stringify({ teams: [] }), "utf8");
  process.env.VIBESQUAD_HOME = join(dir, "h");
  process.env.VIBESQUAD_TEAMS_FILE = join(dir, "h", "teams.json");
  const before = new Map();
  const server = { before: (n, f) => (before.set(n, f), () => {}), on: () => () => {} };
  const stop = createPlugin({ startWatcher: false })(server);
  const create = async (config, env) => {
    const req = { config: { cwd: dir, ...config }, ...(env ? { env } : {}) };
    return (await before.get("agent.create")({ request: req })) ?? req;
  };
  try {
    const c = await create({ provider: "claude", model: "claude-sonnet-5-5", title: "w" });
    assert.ok(c.config.providerOptions.disallowedTools.includes("Workflow"));
    assert.equal(c.config.providerOptions.extraArgs, undefined);
    assert.ok(c.config.providerOptions.disallowedTools.includes("AskUserQuestion"));
    const b = await create({ provider: "claude", title: "BRAINSTORM · X" }, { VS_ROLE: "brainstorm" });
    assert.ok(!b.config.providerOptions.disallowedTools.includes("AskUserQuestion"));
    assert.equal((await create({ provider: "codex", title: "w" })).config.providerOptions, undefined);
    assert.equal((await create({ provider: "claude", title: "w" }, { VS_LEAN: "off" })).config.providerOptions, undefined);
  } finally {
    stop?.();
    for (const [k, v] of [["VIBESQUAD_HOME", prev.h], ["VIBESQUAD_TEAMS_FILE", prev.t]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(dir, { recursive: true, force: true });
  }
});

function roleHarness(profiles) {
  const dir = mkdtempSync(join(tmpdir(), "vs-role-test-"));
  const prev = { h: process.env.VIBESQUAD_HOME, t: process.env.VIBESQUAD_TEAMS_FILE, p: process.env.VIBESQUAD_PROFILES_PATH };
  mkdirSync(join(dir, "h"), { recursive: true });
  writeFileSync(join(dir, "h", "teams.json"), JSON.stringify({ teams: [] }), "utf8");
  writeFileSync(join(dir, "h", "profiles.json"), JSON.stringify({ profiles }), "utf8");
  process.env.VIBESQUAD_HOME = join(dir, "h");
  process.env.VIBESQUAD_TEAMS_FILE = join(dir, "h", "teams.json");
  process.env.VIBESQUAD_PROFILES_PATH = join(dir, "h", "profiles.json");
  const before = new Map();
  const stop = createPlugin({ startWatcher: false })({ before: (n, f) => (before.set(n, f), () => {}), on: () => () => {} });
  const create = async (config, env) => {
    const req = { config: { cwd: dir, provider: "claude", ...config }, ...(env ? { env } : {}) };
    return (await before.get("agent.create")({ request: req })) ?? req;
  };
  const done = () => {
    stop?.();
    for (const [k, v] of [["VIBESQUAD_HOME", prev.h], ["VIBESQUAD_TEAMS_FILE", prev.t], ["VIBESQUAD_PROFILES_PATH", prev.p]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(dir, { recursive: true, force: true });
  };
  return { create, done };
}
const asks = (out) => out.config.providerOptions.disallowedTools.includes("AskUserQuestion");
const sys = (out) => String(out.config.systemPrompt ?? "");

test("role-less stored profile: role derived from its name (VS_PROFILE only)", async () => {
  const h = roleHarness([{ name: "Brainstorm - Claude", provider: "claude", model: "claude-opus-5-5" }, { name: "Lead - Claude", provider: "claude" }]);
  try {
    const b = await h.create({ title: "x" }, { VS_PROFILE: "Brainstorm - Claude" });
    assert.equal(asks(b), false);
    assert.match(sys(b), /Role: brainstorm/);
    assert.match(sys(await h.create({ title: "x" }, { VS_PROFILE: "Lead - Claude" })), /Role: lead/);
  } finally {
    h.done();
  }
});

test("explicit VS_ROLE beats the title convention", async () => {
  const h = roleHarness([]);
  try {
    assert.match(sys(await h.create({ title: "BRAINSTORM · X" }, { VS_ROLE: "worker" })), /Role: worker/);
  } finally {
    h.done();
  }
});

test("MCP create_agent: title convention ★ → lead (Role: lead, Lead rules layer, VS_ROLE env)", async () => {
  const h = roleHarness([]);
  try {
    const out = await h.create({ title: "★ Bug8 · daemon spawn hang P0", provider: "antigravity-cli" }, {});
    assert.match(sys(out), /Role: lead/);
    assert.match(sys(out), /Dispatch workers/); // Lead rules layer
    assert.equal(out.env.VS_ROLE, "lead");
  } finally {
    h.done();
  }
});

test("MCP create_agent: title convention <Code> Buddy → brainstorm (Role: brainstorm, VS_ROLE env)", async () => {
  const h = roleHarness([]);
  try {
    const out = await h.create({ title: "VS Buddy", provider: "claude" }, {});
    assert.match(sys(out), /Role: brainstorm/);
    assert.equal(out.env.VS_ROLE, "brainstorm");
  } finally {
    h.done();
  }
});

test("spawnEnvFor carries role and profile into env for label-only spawn paths", async () => {
  const { spawnEnvFor } = await import("../src/spawn-env.ts");
  assert.deepEqual(spawnEnvFor({ role: "brainstorm", lane: "x", profile: "Brainstorm - Claude" }), { VS_ROLE: "brainstorm", VS_PROFILE: "Brainstorm - Claude" });
  assert.deepEqual(spawnEnvFor({ role: "lead" }), { VS_ROLE: "lead" });
  assert.equal(spawnEnvFor({ role: "former-lead" }), undefined);
  assert.equal(spawnEnvFor({}), undefined);
});
