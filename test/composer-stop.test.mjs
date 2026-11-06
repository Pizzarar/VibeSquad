import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Composer ■ Stop button: source assertions (Node-only, no DOM).
const src = readFileSync(new URL("../src/Composer.tsx", import.meta.url), "utf8");
const m = /\{agent\.status === "running" && \(\s*<button\s+className="btn ghost composer-stop-btn"[\s\S]*?<\/button>\s*\)\}/.exec(src);

test("composer-stop: rendered only while running", () => {
  assert.ok(m, "stop button block gated on agent.status === running");
  assert.equal((src.match(/composer-stop-btn"/g) ?? []).length, 2); // className + testid, one button
  assert.match(m[0], /data-testid="composer-stop-btn"/);
});

test("composer-stop: always enabled (no disabled prop)", () => {
  assert.doesNotMatch(m[0], /disabled/);
});

test("composer-stop: click calls stopAgent(agent.id) exactly once", () => {
  assert.match(src, /import \{[^}]*\bstopAgent\b[^}]*\} from "\.\/paseo"/);
  assert.equal((m[0].match(/stopAgent\(/g) ?? []).length, 1);
  assert.match(m[0], /onClick=\{\(\) => stopAgent\(agent\.id\)/);
  assert.match(m[0], /setNotice\(/); // errors surfaced
});
