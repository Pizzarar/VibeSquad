// @desk C2 (docs/PLAN_DESK_DD_CHOICES.md): unit and contract tests for option definitions,
// Show source disclosure, mixed-ask option+reply batching, F1 filter preservation, and CSS scope.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { transformSync } from "rolldown/utils";
import { buildAnswerPrompt, validateAnswerBatch } from "../server/decisions.mjs";

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
  applyChoiceToggle,
  applyReplyText,
  buildAnswerBatch,
  demoDecisionItems,
} = await import(pathToFileURL(join(dir, "BoringDecisionDesk.mjs")).href);
const F = await import(pathToFileURL(join(dir, "decisionFilter.mjs")).href);

test("C2 helpers: hasDecisionOptions, hasSourceDisclosure, and plain-text sourceExcerptText", () => {
  assert.equal(hasDecisionOptions({ kind: "yesno", lean: "", alts: ["A: one", "B: two"] }), true);
  assert.equal(hasDecisionOptions({ kind: "answer", lean: "", alts: ["A: one", "B: two"] }), true, "answer cards with alts still render option buttons");
  assert.equal(hasDecisionOptions({ kind: "answer", lean: "", alts: [] }), false);
  assert.equal(hasDecisionOptions({ kind: "offscreen", lean: "", alts: ["A: one"] }), false);

  assert.equal(hasSourceDisclosure({ inferred: true, context: "" }), true, "every inferred card gets Show source");
  assert.equal(hasSourceDisclosure({ inferred: false, context: "A) foo\nB) bar" }), true, "any card with context gets Show source");
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
