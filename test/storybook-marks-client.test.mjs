// PLAN_STORYBOOK_V2 V6 client marks (src/storybookMarks.ts, pure): mark labels, "OK (draft)", the End-session summary,
// and the CSS rule that hides a marked row's origin status tag.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const M = await import("../src/storybookMarks.ts");

const line = (over = {}) => ({
  kind: "line", id: "l1", name: "x",
  data: { origin: "csv", file: "data/questlines.json", data_path: '["questlines", "popper", "steps", 1, "story"]', where_seen: "quests", line: "12", current_text: "Bring thirty casings.", status: "DRAFT", owner_rewrite: "Bring me thirty clean casings.", ...over },
});
const server = (e, over = {}) => ({ key: M.targetKey(M.lineTarget(e)), file: e.data.file, line: e.data.line, data_path: e.data.data_path, where_seen: e.data.where_seen, status: "OWNER-OK", note: "", contracts: {}, rewrite: "", text: e.data.current_text, hashOk: true, ...over });

test("u2: OK on a drafted rewrite reads 'OK (draft)', an owner's own rewrite reads 'Edited'", () => {
  const e = line();
  const st = (m) => M.markState(e, [e], M.marksByKey([m]), true);
  const draft = st(server(e, { rewrite: "Bring me thirty clean casings." }));
  assert.equal(draft.kind, "ok");
  assert.equal(draft.draft, true);
  assert.equal(M.markLabel(draft), "OK (draft)");
  const own = st(server(e, { rewrite: "Thirty casings. Now." }));
  assert.equal(own.kind, "edit");
  assert.equal(M.markLabel(own), "Edited");
  assert.equal(M.markLabel(st(server(e))), "OK");
  assert.equal(M.markLabel(st(server(e, { status: "NEEDS-REWRITE", note: "colder" }))), "Redo");
  // csv_safe'd rewrite still matches its draft
  const neg = line({ owner_rewrite: "'-5 HP" });
  assert.equal(M.markState(neg, [neg], M.marksByKey([server(neg, { rewrite: "-5 HP" })]), true).draft, true);
  // a row without a draft: any rewrite is the owner's
  const plain = line({ owner_rewrite: "" });
  assert.equal(M.markState(plain, [plain], M.marksByKey([server(plain, { rewrite: "New." })]), true).kind, "edit");
  // OK (draft) counts as reviewed, and OK all skips it
  assert.equal(M.progress([draft]).done, 1);
  assert.deepEqual(M.batchMarks([e], [e], M.marksByKey([server(e, { rewrite: "Bring me thirty clean casings." })]), true, "ok"), []);
});

test("M3/m2 client: End-session summary says what the owner must know", () => {
  assert.equal(M.commitSummary({ committed: null }), "Nothing to commit");
  assert.equal(M.commitSummary({ committed: "0123456789abcdef", subject: "storybook review 2026-11-27: 1 OK, 0 redo, 0 edit", write: "ok", lost: 0 }), "storybook review 2026-11-27: 1 OK, 0 redo, 0 edit (01234567)");
  const s = M.commitSummary({ committed: "0123456789abcdef", subject: "s", write: "missing", lost: 2 });
  assert.match(s, /2 mark\(s\) lost in review_pack --write/);
  assert.match(s, /review_pack --write not run/);
});

test("u1: a marked row hides its origin status tag (CSS), an unmarked one keeps it", () => {
  const css = fs.readFileSync(new URL("../src/storybook.css", import.meta.url), "utf8");
  assert.match(css, /\.sb-row:has\(\.sb-mark:not\(\[data-mark="none"\]\)\) \.sb-row-meta \.sb-status \{ display: none; \}/);
  const text = fs.readFileSync(new URL("../src/StorybookText.tsx", import.meta.url), "utf8");
  assert.match(text, /<span className="sb-row-meta">[\s\S]*?className=\{`sb-status /, "V8 moved the status tag into .sb-row-meta; the rule must follow it");
  const tsx = fs.readFileSync(new URL("../src/StorybookMarks.tsx", import.meta.url), "utf8");
  assert.match(tsx, /data-mark=\{st\.kind\}/, "the mark wrapper carries data-mark the rule keys on");
});

test("W4 friction 1: per-contract note keeps note on its preview, does not mark sibling previews, and My marks counts CSV rows once", () => {
  const tpl = {
    kind: "line", id: "tpl_kill", name: "tpl_kill",
    data: { origin: "csv", file: "scripts/systems/ContractSystem.gd", id: "contract_title", data_path: "", where_seen: "contracts", line: "42", current_text: "Eliminate %d-%d x %s for %s", status: "STORY-TODO", owner_rewrite: "" },
  };
  const c1 = { kind: "contract", id: "k_doc_pmc_squad", name: "k_doc_pmc_squad", data: { type: "kill" } };
  const c2 = { kind: "contract", id: "k_fence_armored_scav", name: "k_fence_armored_scav", data: { type: "kill" } };
  const lines = [tpl];
  const m = server(tpl, { status: "NEEDS-REWRITE", note: "", contracts: { k_doc_pmc_squad: "too many kills" } });
  const byKey = M.marksByKey([m]);

  // c1 keeps its own contract note visible
  const st1 = M.markState(c1, lines, byKey, true);
  assert.equal(st1.kind, "redo");
  assert.equal(st1.contractNote, "too many kills");

  // sibling c2 is NOT marked by c1's per-contract note
  const st2 = M.markState(c2, lines, byKey, true);
  assert.equal(st2.kind, "none");

  // My marks counts CSV rows once (template counts once; contract preview rows do not count)
  assert.equal(M.isMarkedCsvRow(tpl, lines, byKey, true), true);
  assert.equal(M.isMarkedCsvRow(c1, lines, byKey, true), false);
  assert.equal(M.isMarkedCsvRow(c2, lines, byKey, true), false);
  const rows = [tpl, c1, c2];
  assert.equal(rows.filter((e) => M.isMarkedCsvRow(e, lines, byKey, true)).length, 1);

  // Adding a second per-contract note on the same template still counts once
  const m2 = server(tpl, { status: "NEEDS-REWRITE", note: "", contracts: { k_doc_pmc_squad: "too many kills", k_fence_armored_scav: "too low payout" } });
  const byKey2 = M.marksByKey([m2]);
  assert.equal(M.markState(c2, lines, byKey2, true).contractNote, "too low payout");
  assert.equal(rows.filter((e) => M.isMarkedCsvRow(e, lines, byKey2, true)).length, 1);

  // V7 friction 6: a contract with a contractNote always renders as redo, never OK
  const mOkWithNote = server(tpl, { status: "OWNER-OK", note: "", contracts: { k_doc_pmc_squad: "too many kills" } });
  assert.equal(M.markState(c1, lines, M.marksByKey([mOkWithNote]), true).kind, "redo");
});

test("W4 friction 7 CSS: .sb-row-actions stays right-aligned on Edited/draft rows", () => {
  const css = fs.readFileSync(new URL("../src/storybook.css", import.meta.url), "utf8");
  assert.match(css, /\.sb-row-actions \{ margin-left: auto; \}/);
  assert.match(css, /\.sb-row-actions:has\(\.sb-mark-draft, \.sb-mark-form\) \{ flex: 1 1 100%; \}/);
  assert.match(css, /\.sb-row-actions:has\(\.sb-mark-draft, \.sb-mark-form\) \.sb-mark \{ width: 100%; \}/);
});
