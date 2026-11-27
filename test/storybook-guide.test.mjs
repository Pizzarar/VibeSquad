import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import * as G from "../src/storybookGuideLogic.ts";

const viewSrc = readFileSync(new URL("../src/StorybookView.tsx", import.meta.url), "utf8");
const textSrc = readFileSync(new URL("../src/StorybookText.tsx", import.meta.url), "utf8");
const homeSrc = readFileSync(new URL("../src/StorybookHome.tsx", import.meta.url), "utf8");
const marksSrc = readFileSync(new URL("../src/StorybookMarks.tsx", import.meta.url), "utf8");

function makeStorage() {
  const m = new Map();
  return {
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    raw: m,
  };
}

describe("storybookGuide data and navigation targets", () => {
  test("has 6-8 steps with unique ids, plain titles, one-sentence bodies, and Show me CTAs", () => {
    assert.ok(G.GUIDE_STEPS.length >= 6 && G.GUIDE_STEPS.length <= 8, `expected 6-8 steps, got ${G.GUIDE_STEPS.length}`);
    const ids = new Set();
    for (const s of G.GUIDE_STEPS) {
      assert.ok(s.id && !ids.has(s.id), `duplicate or empty id: ${s.id}`);
      ids.add(s.id);
      assert.ok(s.title.trim().length > 0, `empty title on ${s.id}`);
      assert.ok(s.body.trim().length > 10, `too-short body on ${s.id}`);
      assert.equal(s.cta, "Show me", `cta on ${s.id}`);
      // One sentence per step (single terminal period).
      const sentences = s.body.trim().split(/[.!?]+(?:\s+|$)/).filter(Boolean);
      assert.equal(sentences.length, 1, `expected one sentence for ${s.id}, got: ${s.body}`);
    }
  });

  test("covers all 8 walkthrough topics", () => {
    const ids = G.GUIDE_STEPS.map((s) => s.id);
    for (const req of ["home", "arcs", "mark", "session", "contracts", "find", "coherence", "changes"]) {
      assert.ok(ids.includes(req), `missing step ${req}`);
    }
  });

  test("every Show me target references a real built tab, preset, scope, questMode, and scrollTestId", () => {
    // Extract built tabs from StorybookView.tsx TABS array.
    const builtTabs = new Set([...viewSrc.matchAll(/\{\s*id:\s*"([a-z]+)"[^}]*built:\s*true\s*\}/g)].map((m) => m[1]));
    assert.ok(builtTabs.size >= 8, `expected >=8 built tabs in StorybookView.tsx, found ${builtTabs.size}`);

    // Extract QuestMode values from StorybookView.tsx.
    const questModes = new Set([...viewSrc.matchAll(/\["(arcs|order|web)",\s*"[^"]+"\]/g)].map((m) => m[1]));
    assert.deepEqual([...questModes].sort(), ["arcs", "order", "web"]);

    // Extract TextPreset only union values from StorybookText.tsx.
    const presetLine = textSrc.match(/only\?:\s*([^;]+);/)?.[1] ?? "";
    const validPresets = new Set([...presetLine.matchAll(/"([a-z]+)"/g)].map((m) => m[1]));
    assert.ok(validPresets.has("contracts") && validPresets.has("changed") && validPresets.has("unreviewed"));

    // Known testids across Home / Marks / Text / View.
    const allSrc = viewSrc + "\n" + textSrc + "\n" + homeSrc + "\n" + marksSrc;

    for (const s of G.GUIDE_STEPS) {
      assert.ok(builtTabs.has(s.target.tab), `step ${s.id} targets unknown tab: ${s.target.tab}`);
      if (s.target.presetOnly) {
        assert.equal(s.target.tab, "review", `step ${s.id} sets presetOnly on non-review tab ${s.target.tab}`);
        assert.ok(validPresets.has(s.target.presetOnly), `step ${s.id} targets unknown presetOnly: ${s.target.presetOnly}`);
      }
      if (s.target.questMode) {
        assert.equal(s.target.tab, "quests", `step ${s.id} sets questMode on non-quests tab ${s.target.tab}`);
        assert.ok(questModes.has(s.target.questMode), `step ${s.id} targets unknown questMode: ${s.target.questMode}`);
      }
      if (s.target.findingScope) {
        assert.equal(s.target.tab, "problems", `step ${s.id} sets findingScope on non-problems tab ${s.target.tab}`);
        assert.ok(G.GUIDE_SCOPES.includes(s.target.findingScope), `step ${s.id} unknown scope ${s.target.findingScope}`);
      }
      if (s.target.scrollTestId) {
        assert.ok(allSrc.includes(`data-testid="${s.target.scrollTestId}"`), `step ${s.id} scrollTestId "${s.target.scrollTestId}" not found in source`);
      }
      if (s.target.fallbackScrollTestId) {
        assert.ok(allSrc.includes(`data-testid="${s.target.fallbackScrollTestId}"`), `step ${s.id} fallbackScrollTestId "${s.target.fallbackScrollTestId}" not found in source`);
      }
    }
    // V7 friction 3: step 4 (session) targets End session button (falling back to session bar) and highlights it.
    const sessionStep = G.GUIDE_STEPS.find((s) => s.id === "session");
    assert.equal(sessionStep.target.scrollTestId, "sb-end-session");
    assert.equal(sessionStep.target.fallbackScrollTestId, "sb-marksbar");
    assert.equal(sessionStep.target.highlight, true);
    assert.match(viewSrc, /el\.classList\.add\("sb-flash"\)/);
  });

  test("first-visit auto-open and per-project dismissal in localStorage", () => {
    const store = makeStorage();
    assert.equal(G.shouldAutoOpenGuide("efi", store), true);
    assert.equal(G.shouldAutoOpenGuide("other-proj", store), true);
    assert.equal(G.isGuideDismissed("efi", store), false);

    G.setGuideDismissed("efi", store);
    assert.equal(G.isGuideDismissed("efi", store), true);
    assert.equal(G.shouldAutoOpenGuide("efi", store), false);
    // Independent per project
    assert.equal(G.isGuideDismissed("other-proj", store), false);
    assert.equal(G.shouldAutoOpenGuide("other-proj", store), true);
  });

  test("storage errors never throw", () => {
    const broken = {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("quota"); },
    };
    assert.equal(G.isGuideDismissed("efi", broken), false);
    assert.doesNotThrow(() => G.setGuideDismissed("efi", broken));
    assert.equal(G.shouldAutoOpenGuide("", broken), false);
  });
});
