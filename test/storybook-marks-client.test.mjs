// PLAN_STORYBOOK_V2 V6 client marks (src/storybookMarksLogic.ts, pure): mark labels, "OK (draft)", the End-session summary,
// and the CSS rule that hides a marked row's origin status tag.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const M = await import("../src/storybookMarksLogic.ts");

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

test("V7 friction 8: mark buttons disable while the session bar shows a session error", () => {
  assert.equal(M.hasSessionError(null, { autoCommitError: undefined }), false);
  assert.equal(M.hasSessionError({ msg: "review worktree folder already exists but is not on storybook/review-2026-11-27", session: true }, { autoCommitError: undefined }), true);
  assert.equal(M.hasSessionError(null, { autoCommitError: "review_pack --write failed" }), true);
  const tsx = fs.readFileSync(new URL("../src/StorybookMarks.tsx", import.meta.url), "utf8");
  assert.match(tsx, /const errBlocked = hasSessionError\(m\.error, m\.state\);/);
  assert.match(tsx, /data-mark-key="1"[^>]*disabled=\{disabled\}/);
  assert.match(tsx, /data-mark-key="2"[^>]*disabled=\{disabled\}/);
  assert.match(tsx, /data-mark-key="3"[^>]*disabled=\{disabled\}/);
});

test("V7 rn-e56176218a8a M1: a contract preview's third button is Note (a contract note), never an owner_rewrite", () => {
  assert.deepEqual(M.formMark("note", "Bring {qty}", "d_a"), { action: "redo", note: "Bring {qty}" });
  assert.deepEqual(M.formMark("edit", "Bring {qty}", "d_a"), { action: "redo", note: "Bring {qty}" }, "even a stray edit form on a contract saves a note");
  assert.deepEqual(M.formMark("edit", "New text."), { action: "edit", text: "New text." });
  assert.deepEqual(M.formMark("redo", "colder"), { action: "redo", note: "colder" });
  const tsx = fs.readFileSync(new URL("../src/StorybookMarks.tsx", import.meta.url), "utf8");
  assert.match(tsx, /hit\.contract\s*\? <button[^>]*data-mark-key="3"[^>]*onClick=\{\(\) => start\("note"\)\}>Note<\/button>/);
  assert.match(tsx, /k === "note" \? ""/, "Note starts empty, not pre-filled with the template");
  assert.match(tsx, /void send\(formMark\(open, draft, hit\.contract\)\)/);
});

test("V7 rn-e56176218a8a M2: a per-mark refusal (stale row, mark failed) never locks marking; only session errors do", () => {
  // transient: per-mark results and 4xx request refusals stay clickable
  assert.equal(M.hasSessionError({ msg: "1 of 1 not saved: stale: the row's text changed since you saw it (Refresh to see the current text)", session: false }, {}), false);
  assert.equal(M.hasSessionError({ msg: "mark failed (400)", session: M.isSessionStatus(400) }, {}), false);
  assert.equal(M.hasSessionError({ msg: "payload too large", session: M.isSessionStatus(413) }, {}), false);
  // session: the worktree/branch 409, git 5xx
  assert.equal(M.isSessionStatus(409), true);
  assert.equal(M.isSessionStatus(500), true);
  assert.equal(M.hasSessionError({ msg: "review worktree folder already exists", session: M.isSessionStatus(409) }, {}), true);
  const tsx = fs.readFileSync(new URL("../src/StorybookMarks.tsx", import.meta.url), "utf8");
  // the per-mark failure line is recorded as transient (no session flag); the whole-request one goes through isSessionStatus
  assert.match(tsx, /if \(bad\.length\) setError\(`[^`]*`\);/);
  assert.match(tsx, /setError\(b\?\.error \?\? `mark failed \(\$\{r\.status\}\)`, isSessionStatus\(r\.status\)\)/);
  // mark() clears the error before each request, and the bar offers dismiss (transient) / Retry (session)
  assert.match(tsx, /setBusy\(true\); setError\(null\);\s*try \{\s*const r = await fetch\(url, \{ method: "POST"/);
  assert.match(tsx, /data-testid="sb-marks-error-dismiss"[^>]*onClick=\{m\.dismissError\}/);
});

test("V7 rn-e56176218a8a m3 client: the template row shows how many contract notes are still open", () => {
  const tpl = {
    kind: "line", id: "tpl_kill", name: "tpl_kill",
    data: { origin: "csv", file: "scripts/systems/ContractSystem.gd", id: "contract_title", data_path: "", where_seen: "contracts", line: "42", current_text: "Eliminate %d-%d x %s for %s", status: "STORY-TODO", owner_rewrite: "" },
  };
  const c1 = { kind: "contract", id: "k_a", name: "k_a", data: { type: "kill" } };
  const m = server(tpl, { status: "NEEDS-REWRITE", rewrite: "Kill %d-%d %s for %s", contracts: { k_a: "too many", k_b: "low pay" } });
  const st = M.markState(tpl, [tpl], M.marksByKey([m]), true);
  assert.equal(st.kind, "redo");
  assert.equal(st.openContracts, 2);
  assert.equal(st.rewrite, "Kill %d-%d %s for %s", "the stored rewrite still shows");
  assert.match(M.openContractsHint(st), /^2 contract notes still open/);
  assert.equal(M.openContractsHint(M.markState(c1, [tpl], M.marksByKey([m]), true)), "", "a contract preview shows its own note, not the count");
  assert.equal(M.openContractsHint(M.markState(tpl, [tpl], M.marksByKey([server(tpl)]), true)), "");
  const tsx = fs.readFileSync(new URL("../src/StorybookMarks.tsx", import.meta.url), "utf8");
  assert.match(tsx, /data-testid="sb-open-contracts">\{openContractsHint\(st\)\}/);
});

test("idea-1169: OK on a sibling contract preview shows muted feedback without counting as OK", () => {
  const tpl = {
    kind: "line", id: "tpl_kill", name: "tpl_kill",
    data: { origin: "csv", file: "scripts/systems/ContractSystem.gd", id: "contract_title", data_path: "", where_seen: "contracts", line: "42", current_text: "Eliminate %d-%d x %s for %s", status: "STORY-TODO", owner_rewrite: "" },
  };
  const c1 = { kind: "contract", id: "k_a", name: "k_a", data: { type: "kill" } };
  const c2 = { kind: "contract", id: "k_b", name: "k_b", data: { type: "kill" } };
  const c3 = { kind: "contract", id: "k_c", name: "k_c", data: { type: "kill" } };
  const lines = [tpl];
  const m1 = server(tpl, { status: "NEEDS-REWRITE", note: "", contracts: { k_a: "too many" } });
  const byKey1 = M.marksByKey([m1]);

  // Before clicking OK on c2, it stays unmarked without siblingOk hint
  const before = M.markState(c2, lines, byKey1, true, new Set());
  assert.equal(before.kind, "none");
  assert.equal(before.siblingOk, undefined);
  assert.equal(M.siblingOkHint(before), "");

  // Clicking OK on c2 records it in siblingOks (only when result.ok is true)
  const failed = M.nextSiblingOks(new Set(), [{ target: M.lineTarget(tpl), action: "ok", contract: "k_b" }], [{ ok: false }]);
  assert.equal(failed.has("k_b"), false);
  const oks = M.nextSiblingOks(new Set(), [{ target: M.lineTarget(tpl), action: "ok", contract: "k_b" }], [{ ok: true }]);
  assert.equal(oks.has("k_b"), true);

  // c2 shows muted feedback while kind stays "none" (not counted in progress or My marks)
  const st1 = M.markState(c2, lines, byKey1, true, oks);
  assert.equal(st1.kind, "none");
  assert.equal(st1.siblingOk, true);
  assert.equal(st1.openContracts, 1);
  assert.equal(M.siblingOkHint(st1), "OK: template still has 1 open note");
  assert.equal(M.openContractsHint(st1), "");
  assert.equal(M.markLabel(st1), "");
  assert.equal(M.progress([st1]).done, 0);
  assert.equal(M.isMarkedCsvRow(c2, lines, byKey1, true), false);

  // Plural when 2 other contracts have open notes
  const m2 = server(tpl, { status: "NEEDS-REWRITE", note: "", contracts: { k_a: "too many", k_c: "low pay" } });
  const st2 = M.markState(c2, lines, M.marksByKey([m2]), true, oks);
  assert.equal(M.siblingOkHint(st2), "OK: template still has 2 open notes");
  // c3 has its own note so it renders redo, never siblingOk
  assert.equal(M.markState(c3, lines, M.marksByKey([m2]), true, oks).kind, "redo");

  // Once the other contract notes clear and the template flips to OWNER-OK, c2 becomes normal OK
  const mOk = server(tpl, { status: "OWNER-OK", note: "", contracts: {} });
  const stOk = M.markState(c2, lines, M.marksByKey([mOk]), true, oks);
  assert.equal(stOk.kind, "ok");
  assert.equal(stOk.siblingOk, undefined);
  assert.equal(M.siblingOkHint(stOk), "");

  // A subsequent redo on c2 clears it from siblingOks
  const afterRedo = M.nextSiblingOks(oks, [{ target: M.lineTarget(tpl), action: "redo", note: "fix", contract: "k_b" }], [{ ok: true }]);
  assert.equal(afterRedo.has("k_b"), false);

  const tsx = fs.readFileSync(new URL("../src/StorybookMarks.tsx", import.meta.url), "utf8");
  assert.match(tsx, /data-testid="sb-sibling-ok"[\s\S]*?\{siblingOkHint\(st\)\}/);
  const css = fs.readFileSync(new URL("../src/storybook.css", import.meta.url), "utf8");
  assert.match(css, /\.sb-root \.sb-mark-sibling-ok\b/);
});

test("idea-1170: sb-autocommit-error offers Retry to re-read the session and unlock when server clears autoCommitError", () => {
  assert.equal(M.hasSessionError(null, { autoCommitError: "review_pack --write failed" }), true);
  assert.equal(M.hasSessionError(null, { autoCommitError: undefined }), false);
  assert.equal(M.hasSessionError(null, {}), false);
  const tsx = fs.readFileSync(new URL("../src/StorybookMarks.tsx", import.meta.url), "utf8");
  assert.match(tsx, /data-testid="sb-autocommit-error"[\s\S]*?data-testid="sb-autocommit-retry"[\s\S]*?onClick=\{\(\) => void m\.retrySession\(\)\}>Retry<\/button>/);
  assert.match(tsx, /const retrySession = useCallback\(async \(\) => \{[\s\S]*?await reload\(url\);/);
});

test("V7 minor 5: first mark of a session shows 'Starting session…' on MarksBar and keeps clicked button busy", () => {
  const tsx = fs.readFileSync(new URL("../src/StorybookMarks.tsx", import.meta.url), "utf8");
  assert.match(tsx, /const \[starting, setStarting\] = useState\(false\);/);
  assert.match(tsx, /if \(!existsRef\.current\) setStarting\(true\);/);
  assert.match(tsx, /data-testid="sb-marksbar-starting"[^>]*aria-busy="true"/);
  assert.match(tsx, /Starting session…/);
  assert.match(tsx, /const \[busyAction, setBusyAction\] = useState<[^>]+>\(null\);/);
  assert.match(tsx, /aria-busy=\{busyAction === "ok" \|\| undefined\}/);
  assert.match(tsx, /busyAction === "ok" \? "OK…" : "OK"/);
  const css = fs.readFileSync(new URL("../src/storybook.css", import.meta.url), "utf8");
  assert.match(css, /\.sb-root \.sb-mbtn\.sb-mbtn-busy\b/);
  assert.match(css, /\.sb-root \.sb-marksbar-starting\b/);
});
