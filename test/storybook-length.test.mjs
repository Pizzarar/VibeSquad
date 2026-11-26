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
  const ov = await run([line("a", "hi there", { where_seen: "button" })], { lengthCaps: [{ key: "button", label: "button", match: /button/, max: 3, fallback: 1 }] });
  assert.equal(ov.length, 1);
});

test("owner_rewrite checked even when current_text is empty", async () => {
  const fs = await run([line("a", "", { owner_rewrite: "r".repeat(100), data_path: '["x", "toast"]' })]);
  assert.equal(fs.length, 1);
  assert.match(fs[0].msg, /owner_rewrite/);
});
test("multiline / whitespace-varying csv text still dedupes the native duplicate", async () => {
  const d = { data_path: '["a","toast"]' };
  const fs = await run([line("c", "w".repeat(50) + "\n\n  " + "w".repeat(50), d), line("n", "w".repeat(50) + " " + "w".repeat(50), { origin: "squad", field: "toast" })]);
  assert.equal(fs.length, 1);
  assert.equal(fs[0].entityRef.id, "c");
});
test("group match: field key / group column first, JSON-array and dotted data_path both work", async () => {
  const long = "s".repeat(200);
  assert.equal((await run([line("a", long, { data_path: '["questlines","x","steps",0,"title"]' })])).length, 1);          // title cap 48
  assert.equal((await run([line("a", long, { data_path: "questlines.popper.steps[0].title" })])).length, 1);
  assert.equal((await run([line("a", long, { data_path: "questlines.popper.steps[0].story" })])).length, 0);             // story 300
  assert.equal((await run([line("a", long, { data_path: '["a","description"]' })])).length, 1);                           // 160
});
test("regex false positives: free-text prose cannot cap long copy", async () => {
  const long = "p".repeat(100);
  assert.equal((await run([line("a", long, { where_seen: "tooltip below Deploy button", data_path: '["x","description"]' })])).length, 0);
  assert.equal((await run([line("a", long, { where_seen: "dialogue label", data_path: '["x","story"]' })])).length, 0);
  assert.equal((await run([line("a", long, { where_seen: "toaster oven", file: "scenes/title_screen.gd" })])).length, 0);
  assert.equal((await run([line("a", long, { where_seen: "descending list" })])).length, 0);
  assert.equal((await run([line("a", long, { where_seen: "kit_model verdicts() (toast)" })])).length, 1);   // genuine fallback still caps
});
test("sentence counter ignores decimals and ellipses", async () => {
  const fs = await run([line("a", "Costs 1.5 coins... wait. Done.", { length_budget: "1-2 sentences" })]);
  assert.equal(fs.length, 0);
});

test("Data: group / data/<name>.json stem scopes the field (trader_relations rows keep their story cap)", async () => {
  const dp = '["traders","popper","lines","wary"]';
  const row = { group: "Data: trader_relations", file: "data/trader_relations.json", data_path: dp, where_seen: "(not mapped: verify)" };
  assert.equal((await run([line("a", "t".repeat(301), row)])).length, 1);
  assert.equal((await run([line("a", "t".repeat(300), row)])).length, 0);
  assert.equal((await run([line("a", "t".repeat(301), { ...row, group: "" })])).length, 1);           // file stem alone
});
test("Screen: group and scenes/ path never pick a cap", async () => {
  const row = { group: "Screen: title", file: "scenes/title/title_screen.gd", where_seen: "(not mapped: verify)" };
  assert.equal((await run([line("a", "u".repeat(200), row)])).length, 0);
});
test("where_seen leading '<screen> page >' breadcrumb is stripped before the fallback", async () => {
  const long = "v".repeat(100);
  assert.equal((await run([line("a", long, { where_seen: "title page > armory_view > (file scope)" })])).length, 0);
  assert.equal((await run([line("a", long, { where_seen: "title page > Questline panel (step title)" })])).length, 1); // genuine title still caps
});
test("bare code identifiers in where_seen (title_screen) do not match", async () => {
  assert.equal((await run([line("a", "x".repeat(100), { where_seen: "title page > title_screen > (file scope)" })])).length, 0);
});
