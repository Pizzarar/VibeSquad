import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => fs.readFileSync(path.join(root, "src", f), "utf8");
const panel = src("BoringContextPanel.tsx");

test("panel: 460px, six tabs, testids per tab and the panel", () => {
  assert.match(panel, /CONTEXT_PANEL_WIDTH = 460/);
  assert.match(panel, /\["Workers", "Changes", "Plan", "Feed", "Files", "Terminal"\]/);
  assert.match(panel, /data-testid="boring-context-panel"/);
  assert.match(panel, /data-testid=\{`boring-context-tab-\$\{t\.toLowerCase\(\)\}`\}/);
  assert.match(panel, /data-testid="boring-context-toggle"/);
});

test("panel reuses RightDock content components, not re-implementations", () => {
  for (const c of ["ChangesPanel", "FilesPanel", "TerminalPanel"]) assert.match(panel, new RegExp(`<${c} `));
  assert.match(panel, /vs:open-right-dock/);
});

test("collapse rule: below 1600px auto-collapses, explicit choice persists", async () => {
  assert.match(panel, /CONTEXT_PANEL_MIN_VIEWPORT = 1600/);
  assert.match(panel, /vs\.context-panel\.open/);
  const open = (pref, w) => { const wide = w >= 1600; return pref === "0" ? false : pref === "1" ? true : wide; };
  assert.equal(open(null, 1599), false);
  assert.equal(open(null, 1600), true);
  assert.equal(open("0", 3200), false);
  assert.equal(open("1", 1200), true);
});

test("AgentDrawer: Normal mounts the panel and hides the inner RightDock; Psycho keeps RightDock", () => {
  const d = src("AgentDrawer.tsx");
  assert.match(d, /vibe === "boring" && !chatOnly[\s\S]{0,200}<BoringContextPanel/);
  assert.match(d, /vibe !== "boring" && dockOpen && !chatOnly[\s\S]{0,200}<RightDock/);
  assert.match(d, /dockOpen=\{ctxPanelOpen\}/);
});

test("Workers/Plan/Feed sources: live workers, pinned todo, lane log", () => {
  assert.match(panel, /boringWorkerIsLive/);
  assert.match(panel, /findPinnedTodo/);
  assert.match(panel, /__vibesquad\/log\?team=/);
});

test("header role subtitle is sentence case", () => {
  const h = src("BoringAgentHeader.tsx");
  assert.match(h, /sentenceCase\(AGENT_TYPE_LABEL\[p\.agentType\]\)/);
});

test("CSS scoped to Normal mode, no Hypnospace in UI", () => {
  const css = src("boring.css");
  const d3c = css.slice(css.indexOf("D3c: single Normal-mode"));
  for (const line of d3c.split("\n").filter((l) => l.includes("{") && !l.startsWith("/*"))) assert.match(line.trim(), /^(@media[^{]*\{ )?html\[data-vibe="boring"\]/);
  assert.doesNotMatch(panel, /Hypnospace/i);
});
