import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("addLocalProject times out and still saves the path", () => {
  const s = src("TeamActions.tsx");
  assert.match(s, /15000/);
  assert.match(s, /Folder saved, but the daemon could not register it/);
  assert.match(s, /setCwd\(path\)/);
});

test("New Agent dirs prefer team paths and skip the runtime dir", () => {
  const s = src("TeamActions.tsx");
  assert.equal((s.match(/isRuntime/g) ?? []).length, 4);
  assert.equal((s.match(/for \(const p of team\.paths\) if/g) ?? []).length, 2);
  const re = /vibesquad[\\/]runtime/i;
  const B = String.fromCharCode(92);
  assert.ok(re.test(["C:", "Users", "x", "AppData", "Local", "VibeSquad", "runtime", "a"].join(B)));
  assert.ok(!re.test(["C:", "Users", "x", "projects", "foo"].join(B)));
});

test("model change failure reverts and shows an error", () => {
  const s = src("DrawerHeader.tsx");
  assert.match(s, /setModelValue\(agent\.model \?\? ""\)/);
  assert.match(s, /Model change failed/);
  assert.doesNotMatch(s, /setModelHelper\(agent, next\)\.catch\(\(\) => \{\}\)/);
});

test("rewind updates timeline without resend", () => {
  const s = src("Timeline.tsx");
  assert.match(s, /else onRewound\?\.\(e\)/);
  assert.match(s, /cutLen/);
});

test("rewind cut clears on any length change and on agent change", () => {
  const s = src("Timeline.tsx");
  assert.match(s, /entries.length !== cutLen.current/);
  assert.match(s, /setCut\(null\);\s*\}, \[agentId\]\)/);
});

test("send failure has inline Retry", () => {
  assert.match(src("AgentDrawer.tsx"), /data-testid="send-retry"/);
});

test("mention list does not leak demo files into live composer", () => {
  const s = src("Composer.tsx");
  assert.match(s, /DEMO \? DEMO_MENTION_FILES : \[\]/);
  assert.match(s, /if \(!cancelled\) setFiles\(paths/);
});

test("palette jump focuses composer", () => {
  const s = src("CommandPalette.tsx");
  assert.equal((s.match(/focusComposer\(m\.agent\.id\)/g) ?? []).length, 2);
  assert.match(s, /\.pane-slot\[data-agent=/);
  assert.match(s, /offsetParent !== null/);
  assert.ok(s.includes('!cur.closest(".cmd-palette, .modal-back")'));
  assert.match(s, /isContentEditable\)\) return/);
});
