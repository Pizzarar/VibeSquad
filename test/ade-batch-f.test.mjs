import assert from "node:assert/strict";
import test from "node:test";

// F: Pure logic tests for Composer upgrades (slash, @-mention, any-file attach, prompt history).
// Helpers are mirrored from src/Composer.tsx; Node-only, no DOM.

const FALLBACK_COMMANDS = ["/btw", "/compact", "/clear", "/help", "/model", "/mode", "/rewind"];
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function slashToken(text, caret) {
  const m = /(^|\s)\/(\w*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}
function filterSlash(cmds, query) {
  const q = query.toLowerCase();
  return cmds.filter((c) => c.replace(/^\//, "").toLowerCase().startsWith(q)).slice(0, 8);
}
function mentionToken(text, caret) {
  const m = /(^|\s)@([^\s]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}
function replaceToken(text, start, caret, replacement) {
  return { text: text.slice(0, start) + replacement + text.slice(caret), caret: start + replacement.length };
}
function relativizePath(p, cwd) {
  const norm = p.split("\\").join("/");
  const base = cwd.split("\\").join("/").replace(/\/$/, "");
  return base && norm.startsWith(base + "/") ? norm.slice(base.length + 1) : norm;
}
function filterMentionFiles(files, query) {
  const q = query.toLowerCase();
  return files.filter((f) => f.toLowerCase().includes(q)).slice(0, 8);
}
function partitionFiles(files) {
  const images = [];
  const text = [];
  const tooLarge = [];
  for (const f of files) {
    if (f.type.startsWith("image/")) images.push(f);
    else if (f.size > MAX_FILE_BYTES) tooLarge.push(f);
    else text.push(f);
  }
  return { images, text, tooLarge };
}
function fenceFile(name, content) {
  const fence = content.includes("```") ? "~~~~" : "```";
  return `\n[file: ${name}]\n${fence}\n${content}\n${fence}\n`;
}
function historyStep(len, idx, dir) {
  return dir === "up" ? Math.min(idx + 1, len - 1) : Math.max(idx - 1, -1);
}
function searchHistory(history, query) {
  const q = query.toLowerCase();
  return history.filter((h) => h.toLowerCase().includes(q)).slice(0, 8);
}
function pushHistory(history, prompt, max = 50) {
  const t = prompt.trim();
  if (!t) return history;
  return [t, ...history.filter((h) => h !== t)].slice(0, max);
}

test("F1: slash token at start and after whitespace", () => {
  assert.deepEqual(slashToken("/co", 3), { start: 0, query: "co" });
  assert.deepEqual(slashToken("hello /mo", 9), { start: 6, query: "mo" });
  assert.deepEqual(slashToken("/", 1), { start: 0, query: "" });
});

test("F2: slash token ignores paths and mid-word slashes", () => {
  assert.equal(slashToken("src/app", 7), null);
  assert.equal(slashToken("/clear now", 10), null);
  assert.equal(slashToken("plain", 5), null);
});

test("F3: slash filtering by prefix, fallback list", () => {
  assert.deepEqual(filterSlash(FALLBACK_COMMANDS, "mo"), ["/model", "/mode"]);
  assert.equal(filterSlash(FALLBACK_COMMANDS, "").length, 7);
  assert.deepEqual(filterSlash(FALLBACK_COMMANDS, "zzz"), []);
});

test("F4: slash selection inserts command with trailing space", () => {
  const tok = slashToken("do /co", 6);
  const r = replaceToken("do /co", tok.start, 6, "/compact ");
  assert.equal(r.text, "do /compact ");
  assert.equal(r.caret, 12);
});

test("F5: mention token extraction", () => {
  assert.deepEqual(mentionToken("look at @src/Co", 15), { start: 8, query: "src/Co" });
  assert.deepEqual(mentionToken("@", 1), { start: 0, query: "" });
  assert.equal(mentionToken("user@host", 9), null);
  assert.equal(mentionToken("@a done", 7), null);
});

test("F6: mention replacement keeps trailing text", () => {
  const text = "see @pack and more";
  const tok = mentionToken(text, 9);
  const r = replaceToken(text, tok.start, 9, "@package.json ");
  assert.equal(r.text, "see @package.json  and more");
});

test("F7: mention file filtering and path relativizing", () => {
  const files = ["src/App.tsx", "src/Composer.tsx", "package.json", "README.md"];
  assert.deepEqual(filterMentionFiles(files, "comp"), ["src/Composer.tsx"]);
  assert.equal(filterMentionFiles(files, "").length, 4);
  assert.equal(relativizePath("C:\\proj\\src\\a.ts", "C:\\proj"), "src/a.ts");
  assert.equal(relativizePath("/w/proj/b.ts", "/w/proj/"), "b.ts");
  assert.equal(relativizePath("other/c.ts", "/w/proj"), "other/c.ts");
});

test("F8: non-image files are accepted, images split out", () => {
  const { images, text, tooLarge } = partitionFiles([
    { name: "a.png", type: "image/png", size: 10 },
    { name: "notes.md", type: "text/markdown", size: 10 },
    { name: "run.log", type: "", size: 500 },
  ]);
  assert.equal(images.length, 1);
  assert.deepEqual(text.map((f) => f.name), ["notes.md", "run.log"]);
  assert.equal(tooLarge.length, 0);
});

test("F9: files over 2MB are reported, not silently dropped", () => {
  const { text, tooLarge } = partitionFiles([{ name: "big.log", type: "text/plain", size: MAX_FILE_BYTES + 1 }]);
  assert.equal(text.length, 0);
  assert.deepEqual(tooLarge.map((f) => f.name), ["big.log"]);
});

test("F10: fenced content uses safe fence and is removable from draft", () => {
  const block = fenceFile("a.ts", "const x = 1;");
  assert.ok(block.includes("[file: a.ts]"));
  assert.ok(block.includes("```\nconst x = 1;\n```"));
  assert.ok(fenceFile("a.md", "has ``` inside").includes("~~~~"));
  const draft = "hi" + block;
  assert.equal(draft.replace(block, ""), "hi");
});

test("F11: history cycling up/down returns to original draft", () => {
  const h = ["c", "b", "a"];
  let i = -1;
  i = historyStep(h.length, i, "up");
  assert.equal(h[i], "c");
  i = historyStep(h.length, i, "up");
  i = historyStep(h.length, i, "up");
  i = historyStep(h.length, i, "up");
  assert.equal(h[i], "a", "clamped at oldest");
  i = historyStep(h.length, i, "down");
  assert.equal(h[i], "b");
  i = historyStep(h.length, 0, "down");
  assert.equal(i, -1, "back to draft");
  assert.equal(historyStep(h.length, -1, "down"), -1);
});

test("F12: history search filters case-insensitively", () => {
  const h = ["Run the tests", "fix lint", "run build"];
  assert.deepEqual(searchHistory(h, "RUN"), ["Run the tests", "run build"]);
  assert.equal(searchHistory(h, "").length, 3);
  assert.deepEqual(searchHistory(h, "zzz"), []);
});

test("F13: pushHistory dedupes, trims, caps, ignores blanks", () => {
  let h = pushHistory([], "  one ");
  h = pushHistory(h, "two");
  h = pushHistory(h, "one");
  assert.deepEqual(h, ["one", "two"]);
  assert.deepEqual(pushHistory(h, "   "), h);
  let big = [];
  for (let n = 0; n < 60; n++) big = pushHistory(big, `p${n}`);
  assert.equal(big.length, 50);
  assert.equal(big[0], "p59");
});
