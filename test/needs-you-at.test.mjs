// setNeedsYou stamps `needs-you-at` (ISO) and clearNeedsYou blanks it, so queue age isn't stale on re-flag.
// src/paseo.ts pulls in the daemon client, so evaluate just the two functions against stubs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/paseo.ts", import.meta.url), "utf8");
const grab = (name) => {
  const start = src.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} present`);
  const end = src.indexOf("\n}\n", start) + 2;
  return src
    .slice(start, end)
    .replace("export function", "function")
    .replace(/\(agent: PaseoAgent, reason: string\): Promise<void>/, "(agent, reason)")
    .replace(/\(agent: PaseoAgent, opts\?: \{ optimistic\?: boolean \}\): Promise<void>/, "(agent, opts)");
};

function harness() {
  const calls = [];
  const factory = new Function(
    "updateAgent", "latestLabels", "hasLegacy", "LEGACY_NEEDS_LABEL", "LEGACY_NEEDS_REASON", "LEGACY_NEEDS_UNTIL",
    `${grab("setNeedsYou")}\n${grab("clearNeedsYou")}\nreturn { setNeedsYou, clearNeedsYou };`,
  );
  const fns = factory(
    async (id, patch) => calls.push({ id, labels: patch.labels }),
    (a) => a.labels ?? {},
    () => false,
    "legacy-needs", "legacy-reason", "legacy-until",
  );
  return { calls, ...fns };
}

test("set stamps needs-you-at ≈ now as ISO; clear blanks it; re-flag is newer", async () => {
  const h = harness();
  const agent = { id: "a1", labels: {} };
  const before = Date.now();
  await h.setNeedsYou(agent, "why");
  const first = h.calls[0].labels["needs-you-at"];
  assert.equal(new Date(first).toISOString(), first);
  assert.ok(Math.abs(Date.parse(first) - before) < 5000);

  await h.clearNeedsYou({ id: "a1", labels: h.calls[0].labels }, { optimistic: true });
  assert.equal(h.calls[1].labels["needs-you-at"], "");
  assert.equal(h.calls[1].labels["needs-you"], "cleared");

  await new Promise((r) => setTimeout(r, 15));
  await h.setNeedsYou({ id: "a1", labels: h.calls[1].labels }, "again");
  assert.ok(Date.parse(h.calls[2].labels["needs-you-at"]) > Date.parse(first));
});
