import assert from "node:assert/strict";
import { test } from "node:test";
import { EDITABLE_CONFIG_FIELDS, LOCKED_CONFIG_SECTIONS, isEditableConfigPath, readConfigPath, validateFieldValue, buildConfigDiff, buildConfigPatch, formatDiffValue } from "../src/paseoOpsLogic.ts";

test("editable allowlist excludes security and connectivity paths", () => {
  const bad = /auth|password|relay|listen|host|port|cors|origin|plugin|env|args|command|mcp|token|secret/i;
  for (const f of EDITABLE_CONFIG_FIELDS) assert.ok(!bad.test(f.path), f.path);
  for (const p of ["relay.enabled", "mcp.injectIntoAgents", "cors.allowedOrigins", "hostnames", "pluginsEnabled", "plugins.x.source", "providers.claude.env"]) assert.equal(isEditableConfigPath(p), false, p);
  assert.ok(LOCKED_CONFIG_SECTIONS.length >= 9);
});

test("validateFieldValue per kind", () => {
  assert.deepEqual(validateFieldValue({ kind: "boolean", path: "a", label: "", help: "", fallback: false }, true), { ok: true, value: true });
  assert.equal(validateFieldValue({ kind: "boolean", path: "a", label: "", help: "", fallback: false }, "true").ok, false);
  const en = { kind: "enum", path: "a", label: "", help: "", options: ["x", "y"], fallback: "x" };
  assert.equal(validateFieldValue(en, "y").ok, true);
  assert.equal(validateFieldValue(en, "z").ok, false);
  const num = { kind: "number", path: "a", label: "", help: "", min: 1, max: 10, fallback: 1 };
  assert.deepEqual(validateFieldValue(num, "5"), { ok: true, value: 5 });
  for (const bad of ["", "1.5", "0", "11", "abc", null]) assert.equal(validateFieldValue(num, bad).ok, false, String(bad));
  const str = { kind: "string", path: "a", label: "", help: "", maxLength: 5, fallback: "" };
  assert.equal(validateFieldValue(str, "abc").ok, true);
  assert.equal(validateFieldValue(str, "abcdef").ok, false);
  assert.equal(validateFieldValue({ ...str, maxLength: 99 }, "sk-abcdefghijk").ok, false);
});

test("buildConfigDiff only lists real changes, uses fallback for missing keys", () => {
  const cfg = { autoArchiveAfterMerge: false, browserTools: { enabled: true } };
  const d = buildConfigDiff(cfg, { autoArchiveAfterMerge: true, "browserTools.enabled": true, idleRuntimeCleanup: false, "relay.enabled": true });
  assert.deepEqual(d.map((e) => [e.path, e.from, e.to]), [["autoArchiveAfterMerge", false, true]]);
  const d2 = buildConfigDiff(cfg, { idleRuntimeCleanup: true });
  assert.deepEqual(d2.map((e) => [e.path, e.from, e.to]), [["idleRuntimeCleanup", false, true]]);
});

test("buildConfigPatch nests dotted paths and drops non-editable ones", () => {
  const p = buildConfigPatch([
    { path: "browserTools.enabled", label: "", from: false, to: true },
    { path: "autoArchiveAfterMerge", label: "", from: false, to: true },
    { path: "relay.enabled", label: "", from: true, to: false },
  ]);
  assert.deepEqual(p, { browserTools: { enabled: true }, autoArchiveAfterMerge: true });
  assert.equal(readConfigPath({ a: { b: 3 } }, "a.b"), 3);
  assert.equal(readConfigPath({ a: 1 }, "a.b"), undefined);
  assert.equal(formatDiffValue(true), "on");
});
