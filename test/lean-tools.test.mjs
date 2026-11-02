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
  assert.equal(out.extraArgs["disable-slash-commands"], null);
  assert.equal(out.extraArgs.other, "1");
  assert.deepEqual(leanProviderOptions(undefined), { disallowedTools: LEAN_DENY, extraArgs: LEAN_ARGS });
});

test("core tools and the paseo MCP are never denied", () => {
  for (const t of ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "Skill", "ToolSearch"]) assert.ok(!LEAN_DENY.includes(t), t);
  assert.ok(!LEAN_DENY.some((t) => t.startsWith("mcp__")));
});

test("before(agent.create) adds lean providerOptions to claude spawns only", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-lean-test-"));
  const prev = { h: process.env.VIBESQUAD_HOME, t: process.env.VIBESQUAD_TEAMS_FILE };
  mkdirSync(join(dir, "h"), { recursive: true });
  writeFileSync(join(dir, "h", "teams.json"), JSON.stringify({ teams: [] }), "utf8");
  process.env.VIBESQUAD_HOME = join(dir, "h");
  process.env.VIBESQUAD_TEAMS_FILE = join(dir, "h", "teams.json");
  const before = new Map();
  const server = { before: (n, f) => (before.set(n, f), () => {}), on: () => () => {} };
  const stop = createPlugin({ startWatcher: false })(server);
  const create = (config, env) => {
    const req = { config: { cwd: dir, ...config }, ...(env ? { env } : {}) };
    return before.get("agent.create")({ request: req }) ?? req;
  };
  try {
    const c = create({ provider: "claude", model: "claude-sonnet-5-5", title: "w" });
    assert.ok(c.config.providerOptions.disallowedTools.includes("Workflow"));
    assert.equal(c.config.providerOptions.extraArgs["disable-slash-commands"], null);
    assert.equal(create({ provider: "codex", title: "w" }).config.providerOptions, undefined);
    assert.equal(create({ provider: "claude", title: "w" }, { VS_LEAN: "off" }).config.providerOptions, undefined);
  } finally {
    stop?.();
    for (const [k, v] of [["VIBESQUAD_HOME", prev.h], ["VIBESQUAD_TEAMS_FILE", prev.t]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(dir, { recursive: true, force: true });
  }
});
