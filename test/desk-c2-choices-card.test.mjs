// @desk C2 (docs/PLAN_DESK_DD_CHOICES.md): unit and contract tests for option definitions,
// Show source disclosure, mixed-ask option+reply batching, F1 filter preservation, and CSS scope.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { transformSync } from "rolldown/utils";
import { buildAnswerPrompt, choiceLabel, deliveryLogSummary, resolveLeanAltIndex, validateAnswerBatch } from "../server/decisions.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "vs-desk-c2-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const reactUrl = import.meta.resolve("react");
const stub = (name, body) => writeFileSync(join(dir, name), `import React from ${JSON.stringify(reactUrl)};\n${body}\n`);

globalThis.window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 0, clearInterval() {} };

writeFileSync(
  join(dir, "react-hooks.mjs"),
  `export * from ${JSON.stringify(reactUrl)};
export const useRef = (init) => ({ current: init });
export const useMemo = (fn) => fn();
export const useSyncExternalStore = (_sub, get) => get();
export const useEffect = () => {};
export const useState = (init) => [typeof init === "function" ? init() : init, () => {}];`,
);

stub("demoFlag.mjs", "export const DEMO = false;");
stub("demo.mjs", "export const demoLog = () => [];");
stub("attentionItems.mjs", `export const formatAge = () => "1m";`);
writeFileSync(join(dir, "teams.mjs"), `export const isHubLane = () => false; export const isTeamAsleep = (t, cfg) => Boolean((cfg.folders || []).find((f) => f.name === t.folder)?.asleep); export const refreshTeams = async () => true;`);
writeFileSync(join(dir, "boringLocation.mjs"), transformSync("boringLocation.ts", readFileSync(join(ROOT, "src", "boringLocation.ts"), "utf8"), { lang: "ts" }).code.replace("./teams.ts", "./teams.mjs"));
stub("pins.mjs", `export const isHubPin = () => false; export const pinsForSquad = () => ({ pinned: [], done: [] }); export const isLive = () => false; export const liveBuddyId = () => null; export const quickBugsChipState = () => ({ pin: null, leadRunning: false, needsYou: 0 });`);
stub("skyZonesLogic.mjs", "export const skyZonesFor = (v) => v.zones;");
stub("ui.mjs", `export const cleanTitle = (t) => String(t ?? "").trim();`);
writeFileSync(join(dir, "boringFolders.mjs"), transformSync("boringFolders.ts", readFileSync(join(ROOT, "src", "boringFolders.ts"), "utf8"), { lang: "ts" }).code.replace("./teams.ts", "./teams.mjs"));
writeFileSync(join(dir, "decisionFilter.mjs"), transformSync("decisionFilter.ts", readFileSync(join(ROOT, "src", "decisionFilter.ts"), "utf8"), { lang: "ts" }).code.replace(/from "\.\/(\w+)"/g, (_m, n) => `from "./${n}.mjs"`));

const ddSrc = readFileSync(join(ROOT, "src", "BoringDecisionDesk.tsx"), "utf8");
const ddCode = transformSync("BoringDecisionDesk.tsx", ddSrc, { lang: "tsx", jsx: { runtime: "classic" } })
  .code.replace(/^/, `import React from ${JSON.stringify(reactUrl)};\n`)
  .replace(/from "react"/, `from "./react-hooks.mjs"`)
  .replace(/from "\.\/(\w+)"/g, (_m, n) => `from "./${n}.mjs"`);
writeFileSync(join(dir, "BoringDecisionDesk.mjs"), ddCode);

const {
  DECISION_LEANS_OPT_IN,
  hasDecisionOptions,
  hasSourceDisclosure,
  sourceExcerptText,
  formatSentChoiceSummary,
  applyChoiceToggle,
  applyReplyText,
  buildAnswerBatch,
  demoDecisionItems,
  resolveLeanAlt,
  leanStage,
  isUnresolvedBareLean,
  notChoiceLabel,
  decisionOptionCount,
} = await import(pathToFileURL(join(dir, "BoringDecisionDesk.mjs")).href);
const F = await import(pathToFileURL(join(dir, "decisionFilter.mjs")).href);

test("C2 helpers: hasDecisionOptions, hasSourceDisclosure, and plain-text sourceExcerptText", () => {
  assert.equal(hasDecisionOptions({ kind: "yesno", lean: "", alts: ["A: one", "B: two"] }), true);
  assert.equal(hasDecisionOptions({ kind: "answer", lean: "", alts: ["A: one", "B: two"] }), true, "answer cards with alts still render option buttons");
  assert.equal(hasDecisionOptions({ kind: "answer", lean: "", alts: [] }), false);
  assert.equal(hasDecisionOptions({ kind: "offscreen", lean: "", alts: ["A: one"] }), false);

  assert.equal(hasSourceDisclosure({ inferred: true, context: "" }), false, "inferred card with empty excerpt hides Show source (idea-1150)");
  assert.equal(hasSourceDisclosure({ inferred: true, ask: "Pick A or B?", context: "A) foo\nB) bar" }), true, "card with informative context gets Show source");
  assert.equal(hasSourceDisclosure({ inferred: false, ask: "Pick A or B?", context: "A) foo\nB) bar" }), true, "any card with informative context gets Show source");
  assert.equal(hasSourceDisclosure({ inferred: false, context: "   " }), false);
  assert.equal(hasSourceDisclosure({ inferred: false }), false);

  assert.equal(sourceExcerptText({ context: "line 1\nline 2", rawText: "raw" }), "line 1\nline 2");
  assert.equal(sourceExcerptText({ context: "", rawText: "raw fallback" }), "raw fallback");
  assert.equal(sourceExcerptText({}), "No source message excerpt available.");
});

test("C2 mixed asks: picking an option plus typing a reply preserves both and builds ONE prompt through buildAnswerPrompt", () => {
  const item = {
    id: "ny-00000000000000000013",
    squad: "vibesquad",
    lane: "desk",
    askerId: "rn-ov",
    ask: "Partial-fill entry handling: A, B, or C? Also add a veto window on the check-5 same-ticker block?",
    decides: "Spec change for partial fills + veto window",
    lean: "",
    alts: [
      "A: fill-or-kill at entry — cancel the order unless it fills completely",
      "B: keep the partial fill and resize the stop to the filled size",
      "C: top up the remainder at the next bar's open",
    ],
    kind: "yesno",
    inferred: true,
    rawText: "Partial-fill entry handling: A, B, or C? Also add a veto window?",
    ts: Date.parse("2026-11-26T22:00:00Z"),
  };

  // Pick B, then type veto reply
  let staged = applyChoiceToggle({}, item.id, { choice: "alt:1" });
  staged = applyReplyText(staged, item.id, "Yes, add a 30s veto window");
  assert.deepEqual(staged[item.id], { choice: "alt:1", text: "Yes, add a 30s veto window" });

  // Switch from B to C keeps reply text intact
  staged = applyChoiceToggle(staged, item.id, { choice: "alt:2" });
  assert.deepEqual(staged[item.id], { choice: "alt:2", text: "Yes, add a 30s veto window" });

  // Switch back to B and build batch payload
  staged = applyChoiceToggle(staged, item.id, { choice: "alt:1" });
  const batch = buildAnswerBatch([item], staged);
  assert.deepEqual(batch, [{ id: item.id, choice: "alt:1", text: "Yes, add a 30s veto window" }]);

  // Server validateAnswerBatch + buildAnswerPrompt produce ONE prompt with BOTH lines
  const [validated] = validateAnswerBatch({ answers: batch });
  const prompt = buildAnswerPrompt(item, validated, { ownerName: "Owner" });
  assert.match(prompt, /Owner's answer: Go with option 2: "B: keep the partial fill and resize the stop to the filled size"\./);
  assert.match(prompt, /--- BEGIN owner reply \(Owner\) ---\nYes, add a 30s veto window\n--- END owner reply ---/);

  // Unselecting B keeps the typed reply as a reply choice
  const onlyReply = applyChoiceToggle(staged, item.id, { choice: "alt:1" });
  assert.deepEqual(onlyReply[item.id], { choice: "reply", text: "Yes, add a 30s veto window" });

  // Selecting B again merges the existing reply text
  const reMerged = applyChoiceToggle(onlyReply, item.id, { choice: "alt:1" });
  assert.deepEqual(reMerged[item.id], { choice: "alt:1", text: "Yes, add a 30s veto window" });

  // Clearing reply text while B is selected keeps B selected without text
  const clearedReply = applyReplyText(reMerged, item.id, "");
  assert.deepEqual(clearedReply[item.id], { choice: "alt:1" });
  assert.deepEqual(buildAnswerBatch([item], clearedReply), [{ id: item.id, choice: "alt:1" }]);
});

test("C2 demo items: includes the two screenshot-style items with definitions and context excerpts", () => {
  const items = demoDecisionItems(Date.parse("2026-11-26T22:00:00Z"));
  const pf = items.find((i) => /Partial-fill entry handling: A, B, or C\?/i.test(i.ask));
  const sv = items.find((i) => /U11 survivorship: \(a\).*or \(b\)/i.test(i.ask));
  assert.ok(pf, "demo includes Partial-fill entry handling item");
  assert.equal(pf.inferred, true);
  assert.equal(pf.alts?.length, 3);
  assert.ok(pf.alts.every((a) => a.length <= 240 && !a.includes("\n")));
  assert.ok(typeof pf.context === "string" && pf.context.includes("\n") && pf.context.length <= 1500);

  assert.ok(sv, "demo includes U11 survivorship item");
  assert.equal(sv.inferred, true);
  assert.equal(sv.alts?.length, 2);
  assert.ok(sv.alts.every((a) => a.length <= 240 && !a.includes("\n")));
  assert.ok(typeof sv.context === "string" && sv.context.includes("\n") && sv.context.length <= 1500);
});

test("C2 + F1: staged mixed-ask answers survive filter toggles and count as hidden when filtered out", () => {
  const items = [
    { id: "ny-00000000000000000013", squad: "vibesquad", squadName: "VibeSquad", kind: "yesno" },
    { id: "ny-00000000000000000014", squad: "studio-tools", squadName: "Studio Tools", kind: "yesno" },
  ];
  let staged = applyChoiceToggle({}, "ny-00000000000000000013", { choice: "alt:1" });
  staged = applyReplyText(staged, "ny-00000000000000000013", "add 30s veto");

  // Hide vibesquad -> 1 hidden staged answer
  const visHidden = new Set(["studio-tools"]);
  assert.equal(F.countHiddenStaged(items, visHidden, staged), 1);

  // Unhide vibesquad -> 0 hidden, mixed-ask staged answer intact
  const visAll = new Set(["vibesquad", "studio-tools"]);
  assert.equal(F.countHiddenStaged(items, visAll, staged), 0);
  assert.deepEqual(buildAnswerBatch(items, staged), [
    { id: "ny-00000000000000000013", choice: "alt:1", text: "add 30s veto" },
  ]);
});

test("C2 contracts: plain-text rendering only, aria-expanded disclosure, leans opt-in unchanged, CSS scoped with no @media/@container", () => {
  assert.equal(DECISION_LEANS_OPT_IN, true, "DECISION_LEANS_OPT_IN unchanged");
  assert.doesNotMatch(ddSrc, /dangerouslySetInnerHTML/, "excerpt must never render as HTML");
  assert.match(ddSrc, /aria-expanded=\{isSourceOpen\}/, "Show source disclosure is keyboard accessible with aria-expanded");
  assert.match(ddSrc, /Show source ▾/, "Show source button label present");

  const css = readFileSync(join(ROOT, "src", "boring.css"), "utf8");
  const c2Start = css.indexOf("/* @desk C2 (PLAN_DESK_DD_CHOICES)");
  const f1Start = css.indexOf("/* @desk F1 (PLAN_DESK_DD_FILTER)");
  assert.ok(c2Start > 0 && f1Start > c2Start, "C2 CSS block sits before F1 block");
  const c2Css = css.slice(c2Start, f1Start);
  assert.doesNotMatch(c2Css, /@(media|container)\b/, "no @media or @container in C2 CSS");
  for (const line of c2Css.split("\n").filter((l) => /\{/.test(l))) {
    assert.match(line, /^html\[data-vibe="boring"\] \.boring-decision-/, `scoped to .boring-decision-*: ${line}`);
  }
  assert.match(c2Css, /\.boring-decision-choice\s*\{[^}]*white-space:\s*normal;/, "option buttons wrap instead of truncating");
  assert.match(c2Css, /\.boring-decision-source-body\s*\{[^}]*white-space:\s*pre-wrap;[^}]*overflow-y:\s*auto;/s, "source excerpt is pre-wrap and scrollable");
});

// ---- C2b (PLAN_DESK_DD_C2B B1) ----
const c2bItem = (over = {}) => ({
  id: "ny-00000000000000000090", source: "log", squad: "vibesquad", squadName: "VibeSquad", lane: "desk", askerId: "a-1",
  ask: "Pick one", lean: "B", alts: ["A: first thing", "B: second thing", "C: third thing"], kind: "yesno", ts: Date.UTC(2026, 10, 26), ...over,
});

test("C2b idea-1149: a bare-letter lean resolves to its lettered option and sends one consistent answer", () => {
  for (const lean of ["B", "b", "(b)", "Option B", "B."]) assert.equal(resolveLeanAlt(c2bItem({ lean })), 1, lean);
  assert.equal(resolveLeanAlt(c2bItem({ lean: "Z" })), -1, "no such option");
  assert.equal(resolveLeanAlt(c2bItem({ lean: "Ship it" })), -1, "not a bare letter");
  const item = c2bItem();
  // A staged lean goes out as the option it names, never as a second answer meaning the same thing.
  assert.deepEqual(buildAnswerBatch([item], { [item.id]: { choice: "lean" } }), [{ id: item.id, choice: "alt:1" }]);
  assert.deepEqual(buildAnswerBatch([item], { [item.id]: { choice: "alt:1" } }), [{ id: item.id, choice: "alt:1" }]);
  // A real-text lean stays a lean.
  const real = c2bItem({ lean: "Ship it" });
  assert.deepEqual(buildAnswerBatch([real], { [real.id]: { choice: "lean" } }), [{ id: real.id, choice: "lean" }]);
  // The server resolves the same way: the prompt names the definition.
  const p = buildAnswerPrompt(item, { id: item.id, choice: "lean" }, { ownerName: "Owner" });
  assert.match(p, /Owner's answer: Go with your lean, option 2: "B: second thing"\./);
  assert.match(choiceLabel(item, { choice: "lean" }), /^lean, option 2 "B: second thing"$/);
  // Unresolved bare letter: the letter is kept as the lean.
  assert.match(buildAnswerPrompt(c2bItem({ lean: "Z" }), { id: "x", choice: "lean" }, { ownerName: "Owner" }), /Go with your lean: "Z"\./);
});

test("C2b idea-1151: None of these on 2+ options, with matching prompt wording; Not that stays for one lean", () => {
  assert.equal(notChoiceLabel(c2bItem()), "None of these");
  assert.equal(decisionOptionCount(c2bItem()), 3);
  assert.equal(notChoiceLabel(c2bItem({ lean: "", alts: ["A: x", "B: y"] })), "None of these");
  assert.equal(notChoiceLabel(c2bItem({ lean: "Ship it", alts: ["Hold"] })), "None of these", "lean + 1 alt = 2 options");
  assert.equal(notChoiceLabel(c2bItem({ lean: "Ship it", alts: [] })), "Not that");
  const many = buildAnswerPrompt(c2bItem(), { id: "x", choice: "not" }, { ownerName: "Owner" });
  assert.match(many, /None of these: do NOT go with any of the options/);
  assert.doesNotMatch(many, /do not go ahead/);
  const one = c2bItem({ lean: "Ship it", alts: [] });
  assert.match(buildAnswerPrompt(one, { id: "x", choice: "not" }, { ownerName: "Owner" }), /Not that: do NOT go with your lean "Ship it"\./);
  assert.match(buildAnswerPrompt(c2bItem({ lean: "", alts: [] }), { id: "x", choice: "not" }, { ownerName: "Owner" }), /Not that: no, do not go ahead\./);
  assert.equal(choiceLabel(c2bItem(), { choice: "not" }), "none of these");
  assert.equal(choiceLabel(one, { choice: "not" }), "not that");
});

test("C2b idea-1152: the delivery summary keeps the typed reply note when an option is picked", () => {
  const item = c2bItem();
  assert.equal(choiceLabel(item, { choice: "alt", altIndex: 2, text: "but add a veto" }), 'option 3 "C: third thing" + reply "but add a veto"');
  assert.match(choiceLabel(item, { choice: "lean", text: "yes" }), /^lean, option 2 .* \+ reply "yes"$/);
  assert.equal(choiceLabel(item, { choice: "reply", text: "hi" }), 'reply "hi"');
  assert.equal(choiceLabel(item, { choice: "alt", altIndex: 0 }), 'option 1 "A: first thing"');
});

test("C2b fix G1: staging a lean that resolves picks the lettered option (one consistent selection)", () => {
  assert.deepEqual(leanStage(c2bItem()), { choice: "alt:1" });
  assert.deepEqual(leanStage(c2bItem({ lean: "Ship it" })), { choice: "lean" });
  // a stale {lean} on a resolved card still sends the option, and one toggle unstages it
  const item = c2bItem();
  assert.deepEqual(applyChoiceToggle({ [item.id]: { choice: "lean" } }, item.id, { choice: "lean" }), {});
});

test("C2b fix G2: a letter needs an explicit label marker; unlettered alts never match (client and server agree)", () => {
  const neg = c2bItem({ lean: "A", alts: ["A quick fix", "Keep current"] });
  assert.equal(resolveLeanAlt(neg), -1);
  assert.equal(resolveLeanAltIndex(neg), -1);
  for (const alt of ["Option B", "Option B: x", "(b) x", "B. x", "b: x", "B) x", "B - x", "B – x", "B — x", "B"]) {
    const it = c2bItem({ lean: "b", alts: ["Z other", alt] });
    assert.equal(resolveLeanAlt(it), 1, alt);
    assert.equal(resolveLeanAltIndex(it), 1, alt);
  }
  assert.equal(resolveLeanAlt(c2bItem({ lean: "B", alts: ["Bold move", "A: x"] })), -1);
});

test("C2b fix G3: the bare-letter hint points to Show source only when there is a source to show", () => {
  const withCtx = c2bItem({ lean: "Z", context: "the source" });
  const noCtx = c2bItem({ lean: "Z" });
  assert.equal(isUnresolvedBareLean(withCtx), true);
  assert.equal(hasSourceDisclosure(withCtx), true);
  assert.equal(hasSourceDisclosure(noCtx), false);
  assert.match(ddSrc, /hasSourceDisclosure\(item\) \? "\(letter only; see Show source\)" : "\(letter only; option not defined\)"/);
});

test("C2b fix: choiceLabel marks a truncated quote with an ellipsis", () => {
  const long = "x".repeat(100);
  const out = choiceLabel(c2bItem(), { choice: "reply", text: long });
  assert.match(out, /^reply "x{59}…"$/);
  assert.equal(choiceLabel(c2bItem(), { choice: "reply", text: "short" }), 'reply "short"');
});

// ---- L2 (PLAN_DESK_DD_LOWS: idea-1150, idea-1154) ----

test("L2 idea-1150: Show source hides when excerpt is empty or redundant with ask (case + whitespace normalized)", () => {
  assert.equal(hasSourceDisclosure({ inferred: true, ask: "Ship v2 now?", context: "", rawText: "" }), false);
  assert.equal(hasSourceDisclosure({ inferred: true, ask: "Ship v2 now?", context: "   \n\t  " }), false);
  assert.equal(hasSourceDisclosure({ inferred: true, ask: "Ship v2 now?", context: "  SHIP   V2\nNOW?  " }), false, "equal after whitespace/case norm");
  assert.equal(hasSourceDisclosure({ inferred: true, ask: "Ship v2 now? Also update docs.", context: "ship v2   now?" }), false, "contained in ask after norm");
  assert.equal(hasSourceDisclosure({ inferred: true, ask: "Ship v2 now?", rawText: "  ship  v2  now? " }), false, "rawText fallback equal to ask");
  assert.equal(hasSourceDisclosure({ inferred: true, ask: "Ship v2 now?", rawText: "Ship v2 now? Details: A) canary, B) full rollout" }), true, "rawText adds info");
  assert.equal(hasSourceDisclosure({ inferred: false, ask: "Ship v2 now?", context: "Context with extra details" }), true, "context adds info");

  // C2b bare-letter hint uses the same hasSourceDisclosure predicate
  const redundantBare = c2bItem({ lean: "Z", ask: "Pick one", context: "  PICK   ONE " });
  assert.equal(isUnresolvedBareLean(redundantBare), true);
  assert.equal(hasSourceDisclosure(redundantBare), false, "redundant context hides Show source and switches bare-letter hint");
});

test("L2 idea-1154: client formatSentChoiceSummary matches server choiceLabel and banner disclosure is keyboard-accessible", () => {
  const item = c2bItem();
  const oneLean = c2bItem({ lean: "Ship it", alts: [] });
  const cases = [
    { it: item, srv: { choice: "alt", altIndex: 1, text: "add a 30s veto" }, cli: { choice: "alt:1", text: "add a 30s veto" } },
    { it: item, srv: { choice: "alt", altIndex: 0 }, cli: { choice: "alt:0" } },
    { it: item, srv: { choice: "lean" }, cli: { choice: "lean" } },
    { it: item, srv: { choice: "lean", text: "go ahead" }, cli: { choice: "lean", text: "go ahead" } },
    { it: oneLean, srv: { choice: "lean" }, cli: { choice: "lean" } },
    { it: item, srv: { choice: "not" }, cli: { choice: "not" } },
    { it: oneLean, srv: { choice: "not" }, cli: { choice: "not" } },
    { it: item, srv: { choice: "reply", text: "x".repeat(90) }, cli: { choice: "reply", text: "x".repeat(90) } },
    { it: item, srv: { choice: "dismiss" }, cli: { choice: "dismiss" } },
  ];
  for (const c of cases) {
    assert.equal(formatSentChoiceSummary(c.it, c.cli), choiceLabel(c.it, c.srv), `match for ${c.cli.choice}`);
  }
  assert.match(ddSrc, /data-testid="boring-decision-banner-toggle"/);
  assert.match(ddSrc, /aria-expanded=\{bannerOpen\}/);
  assert.match(ddSrc, /aria-controls="boring-decision-banner-details"/);
  assert.match(ddSrc, /data-testid="boring-decision-banner-details"/);
});

test("L2 idea-1154: deliveryLogSummary preserves the end of the question by shrinking quoted option/reply first", () => {
  const ask = "Partial-fill entry handling: A, B, or C? Also add a veto window on the check-5 same-ticker block?";
  const item = c2bItem({
    ask,
    askerId: "a-vs-ov",
    alts: [
      "A: fill-or-kill at entry — cancel the order unless it fills completely right away",
      "B: keep the partial fill and resize the stop to the filled size immediately",
    ],
  });
  const ans = { choice: "alt", altIndex: 1, text: "Yes, add a 30s veto window on the check-5 same-ticker block too please" };
  const summary = deliveryLogSummary(item, ans, { deliveredTo: "a-vs-ov", via: "asker" });
  assert.ok(summary.length <= 240, `summary <= 240 chars (got ${summary.length}): ${summary}`);
  assert.ok(summary.endsWith(`re ${JSON.stringify(ask)}`), `full question preserved at end: ${summary}`);
  assert.match(summary, /…"/, "shrunk quoted part carries ellipsis");

  // Long option + short reply: shrinks the long option first, keeps short reply intact
  const shortReplyAns = { choice: "alt", altIndex: 1, text: "add veto" };
  const s2 = deliveryLogSummary(item, shortReplyAns, { deliveredTo: "a-vs-lead-fallback", via: "lead" });
  assert.ok(s2.length <= 240, `s2 <= 240 chars (got ${s2.length}): ${s2}`);
  assert.ok(s2.endsWith(`re ${JSON.stringify(ask)}`), `full question preserved: ${s2}`);
  assert.match(s2, /\+ reply "add veto"/, "short reply stays un-truncated when option absorbs shrink");

  // Extreme target + ask still stays <= 240 and ends with closing quote
  const hugeAsk = "Should we migrate the entire distributed storage engine? ".repeat(4).trim();
  const s3 = deliveryLogSummary(c2bItem({ ask: hugeAsk, askerId: "very-long-asker-id-1234567890" }), ans, {
    deliveredTo: "very-long-target-agent-id-1234567890",
    via: "buddy",
  });
  assert.ok(s3.length <= 240, `s3 <= 240 chars (got ${s3.length})`);
  assert.ok(s3.endsWith('…"'), `graceful ellipsis ending when ask must shrink: ${s3}`);
});
