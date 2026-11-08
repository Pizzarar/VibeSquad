import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { sandboxPosture, missingLine, MAX_VALUE } from "../src/paseoSandboxLogic.ts";

const by = (p, k) => p.rows.find((r) => r.key === k);
const modes = [{ id: "auto", label: "Auto", description: "edits freely" }];

test("claude shape: mode only, everything else in one muted line", () => {
  const p = sandboxPosture({
    runtimeInfo: { provider: "claude", extra: { runtimeModel: "opus" } },
    features: [{ type: "toggle", id: "fast_mode", label: "Fast", value: false }],
    currentModeId: "auto",
    availableModes: modes,
  });
  assert.deepEqual(p.rows.map((r) => r.key), ["mode"]);
  assert.equal(by(p, "mode").value, "Auto - edits freely");
  assert.equal(missingLine(p), "Not reported by claude: sandbox, approval policy, network access, network allowlist, writable roots");
});

test("antigravity shape: sandbox, approvalPolicy and shareMcp are rows", () => {
  const p = sandboxPosture({
    runtimeInfo: { provider: "antigravity-cli" },
    features: [
      { type: "select", id: "sandbox", label: "Sandbox", value: "off", options: [{ id: "off", label: "Off" }] },
      { type: "select", id: "approvalPolicy", label: "Approval", value: "skip", options: [] },
      { type: "toggle", id: "shareMcp", label: "Share Paseo tools with Antigravity", value: true },
    ],
    currentModeId: "accept-edits",
  });
  assert.deepEqual(p.rows.map((r) => [r.key, r.value, r.source]), [
    ["mode", "accept-edits", "mode"],
    ["sandbox", "Off", "feature"],
    ["approval", "skip", "feature"],
    ["shareMcp", "on", "feature"],
  ]);
  assert.ok(!missingLine(p).includes("sandbox"));
});

test("runtimeInfo.extra keys count; objects ignored; empty agent lists all missing", () => {
  const p = sandboxPosture({ runtimeInfo: { extra: { networkAccess: true, nested: { x: 1 }, writable_roots: ["/a", "/b"] } } });
  assert.equal(by(p, "network").source, "runtimeInfo");
  assert.equal(by(p, "roots").value, "/a, /b");
  const e = sandboxPosture({});
  assert.equal(e.rows.length, 0);
  assert.match(missingLine(e), /^Not reported by provider: permission mode/);
});

test("long strings and arrays are capped, full value kept", () => {
  const long = "x".repeat(500);
  const p = sandboxPosture({ features: [{ type: "select", id: "sandbox", label: "S", value: long, options: [] }] });
  assert.equal(by(p, "sandbox").value.length, MAX_VALUE);
  assert.equal(by(p, "sandbox").full, long);
  const q = sandboxPosture({ runtimeInfo: { extra: { writableRoots: Array.from({ length: 20 }, (_, i) => `/r${i}`) } } });
  assert.match(by(q, "roots").value, /\(\+12 more\)$/);
});

test("SandboxView Esc marks the event handled so outer Esc handlers skip it", () => {
  const src = readFileSync(new URL("../src/SandboxView.tsx", import.meta.url), "utf8");
  const m = src.match(/const onKey = \(e: KeyboardEvent\) => \{([\s\S]*?)\n    \};/);
  assert.ok(m, "onKey handler found");
  assert.match(m[1], /"Escape"/);
  assert.ok(m[1].indexOf("e.preventDefault()") < m[1].indexOf("setOpen(false)"));
});
