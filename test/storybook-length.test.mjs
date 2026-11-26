import { test } from "node:test";
import assert from "node:assert/strict";
import { entity, makeRegistry, validateFinding } from "../server/storybook/schema.mjs";
import { checks, parseBudget } from "../server/storybook/checks/length.mjs";
import { CHECK_MODULES } from "../server/storybook/checks/index.mjs";

const line = (id, text, data = {}) => entity({ id, kind: "line", display: text.slice(0, 20), source: { path: "x.gd", line: 1 }, data: { text, origin: "csv", ...data } });
const run = (ents, adapter = {}) => checks[0].run({ snapshot: { project: "efi" }, registry: makeRegistry(ents), adapter });

test("registered as #18 and findings validate", async () => {
  assert.ok(CHECK_MODULES.some((m) => m.checks.some((c) => c.id === "#18")));
  const fs = await run([line("a", "x".repeat(100), { group: "Screen: Raids", where_seen: "toast", length_budget: "none pinned (wraps)" })]);
  assert.equal(fs.length, 1);
  assert.equal(validateFinding(fs[0]).ok, true);
  assert.equal(fs[0].category, "too-long");
});
test("parseBudget: numbers only, prose is not a budget", () => {
  assert.deepEqual(parseBudget("1-3 sentences (tests pin)"), { unit: "sentences", max: 3 });
  assert.deepEqual(parseBudget("max 40 chars"), { unit: "chars", max: 40 });
  assert.equal(parseBudget("none pinned (labels wrap)"), null);
});
test("budget-pinned: sentence breach warns, within budget is quiet", async () => {
  const b = "1-2 sentences (squad.json balance_note spec)";
  const fs = await run([line("a", "One. Two. Three.", { length_budget: b }), line("b", "One. Two.", { length_budget: b })]);
  assert.equal(fs.length, 1);
  assert.equal(fs[0].severity, "warn");
  assert.equal(fs[0].entityRef.id, "a");
  assert.match(fs[0].msg, /pinned budget 2/);
});
test("default cap: toast over cap flags as info; under cap is quiet", async () => {
  const d = { where_seen: "toast on raid end", length_budget: "none pinned (wraps)" };
  const fs = await run([line("a", "y".repeat(91), d), line("b", "y".repeat(90), d)]);
  assert.equal(fs.length, 1);
  assert.equal(fs[0].severity, "info");
  assert.equal(fs[0].over.mode, "default");
});
test("unknown group: no cap, never flagged", async () => {
  assert.deepEqual(await run([line("a", "z".repeat(900), { group: "Screen: Misc", where_seen: "(not mapped: verify)" })]), []);
});
test("pinned budget beats default cap; native duplicate of a csv row is skipped; adapter override", async () => {
  const fs = await run([line("a", "q".repeat(200), { where_seen: "toast", length_budget: "100 chars" })]);
  assert.match(fs[0].msg, /pinned budget 100/);
  const dup = await run([line("a", "w".repeat(95), { where_seen: "toast" }), line("n", "w".repeat(95), { origin: "squad", field: "bio" })]);
  assert.equal(dup.length, 1);
  const ov = await run([line("a", "hi there", { where_seen: "button" })], { lengthCaps: [{ key: "button", label: "button", match: /button/, max: 3 }] });
  assert.equal(ov.length, 1);
});
