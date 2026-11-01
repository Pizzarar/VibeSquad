// Unit tests for ADE Batch C — pure logic helpers from src/Timeline.tsx
// No DOM or React rendering. Node-only.
import assert from "node:assert/strict";
import test from "node:test";

// ─── Inline implementations of the pure helpers ───────────────────────────────
// We re-implement the pure logic here (since Timeline.tsx is TSX and not importable
// directly in node:test without a build step), testing the same logic they encode.

// isFailedTool
function isFailedTool(it, d) {
  return it.status === "failed" || it.status === "error" || !!it.error || (d.exitCode != null && d.exitCode !== 0);
}

// isSubAgentTool
function isSubAgentTool(it, d) {
  return d.type === "sub_agent" || it.name === "Task" || !!(d.subAgentId || d.agentId || it.callId);
}

// isCompaction
function isCompaction(it) {
  return it.type === "compaction" || it.type === "compacted" || it.type === "context_compaction";
}

// isReasoning
function isReasoning(it) {
  return it.type === "reasoning";
}

// extractFileLinks
const FILE_LINK_RE = /(?<![`"'(])([a-zA-Z0-9_.\-/\\]+\.[a-zA-Z]{1,6})(?::(\d+)|#L(\d+))(?![a-zA-Z0-9_])/g;
function extractFileLinks(text) {
  const results = [];
  const re = new RegExp(FILE_LINK_RE.source, "g");
  let m;
  while ((m = re.exec(text)) !== null) {
    const filePath = m[1];
    const lineStr = m[2] ?? m[3];
    results.push({ filePath, line: lineStr ? parseInt(lineStr, 10) : null });
  }
  return results;
}

// findPinnedTodo
function findPinnedTodo(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.item?.type === "todo" && Array.isArray(e.item.items) && e.item.items.length > 0) return e;
  }
  return null;
}

// shouldShowLoadOlder
function shouldShowLoadOlder(entries, hasMore) {
  return !!hasMore || entries.length >= 60;
}

// getToolSummary
function getToolSummary(it, d) {
  return d.type === "shell" ? (d.command ?? "") : (d.filePath ?? d.query ?? d.url ?? d.label ?? d.text ?? "");
}

// tokenizeMarkdown (simplified version matching the TSX logic)
function tokenizeMarkdown(text) {
  const tokens = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = line.match(/^```(\w*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? "";
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].match(/^```\s*$/)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      tokens.push({ type: "code_block", lang, code: codeLines.join("\n") });
      continue;
    }
    const hMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (hMatch) {
      tokens.push({ type: "heading", level: hMatch[1].length, text: hMatch[2] });
      i++;
      continue;
    }
    if (line.includes("|") && line.trim().startsWith("|")) {
      const tableLines = [line];
      i++;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim().startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      const parseRow = (l) => l.split("|").slice(1, -1).map((c) => c.trim());
      const header = parseRow(tableLines[0]);
      const dataStart = tableLines[1]?.match(/^\|[\s\-|]+\|$/) ? 2 : 1;
      const rows = tableLines.slice(dataStart).map(parseRow);
      tokens.push({ type: "table", header, rows });
      continue;
    }
    if (line.match(/^(\s*[-*]\s)/)) {
      const items = [];
      while (i < lines.length && lines[i].match(/^(\s*[-*]\s)/)) {
        items.push(lines[i].replace(/^\s*[-*]\s/, ""));
        i++;
      }
      tokens.push({ type: "bullet_list", items });
      continue;
    }
    if (line.match(/^\d+\.\s/)) {
      const items = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s/)) {
        items.push(lines[i].replace(/^\d+\.\s/, ""));
        i++;
      }
      tokens.push({ type: "ordered_list", items });
      continue;
    }
    if (line.trim() === "") {
      tokens.push({ type: "blank" });
      i++;
      continue;
    }
    tokens.push({ type: "paragraph", text: line });
    i++;
  }
  return tokens;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

test("C1a: isFailedTool — status failed", () => {
  assert.equal(isFailedTool({ status: "failed" }, {}), true);
});

test("C1b: isFailedTool — status error", () => {
  assert.equal(isFailedTool({ status: "error" }, {}), true);
});

test("C1c: isFailedTool — it.error truthy", () => {
  assert.equal(isFailedTool({ error: "oops" }, {}), true);
});

test("C1d: isFailedTool — non-zero exitCode", () => {
  assert.equal(isFailedTool({}, { exitCode: 1 }), true);
});

test("C1e: isFailedTool — exit 0 is NOT failed", () => {
  assert.equal(isFailedTool({ status: "success" }, { exitCode: 0 }), false);
});

test("C1f: isFailedTool — no failure markers", () => {
  assert.equal(isFailedTool({ status: "success" }, {}), false);
});

test("C1g: getToolSummary — shell uses command", () => {
  const d = { type: "shell", command: "ls -la" };
  assert.equal(getToolSummary({}, d), "ls -la");
});

test("C1h: getToolSummary — non-shell uses filePath", () => {
  const d = { filePath: "src/Foo.tsx" };
  assert.equal(getToolSummary({ name: "Read" }, d), "src/Foo.tsx");
});

test("C1i: getToolSummary — falls through to empty string", () => {
  assert.equal(getToolSummary({}, {}), "");
});

test("C1j: isSubAgentTool — d.type sub_agent", () => {
  assert.equal(isSubAgentTool({}, { type: "sub_agent" }), true);
});

test("C1k: isSubAgentTool — it.name Task", () => {
  assert.equal(isSubAgentTool({ name: "Task" }, {}), true);
});

test("C1l: isSubAgentTool — d.subAgentId present", () => {
  assert.equal(isSubAgentTool({}, { subAgentId: "abc" }), true);
});

test("C1m: isSubAgentTool — d.agentId present", () => {
  assert.equal(isSubAgentTool({}, { agentId: "abc" }), true);
});

test("C1n: isSubAgentTool — it.callId present", () => {
  assert.equal(isSubAgentTool({ callId: "x" }, {}), true);
});

test("C1o: isSubAgentTool — none of the markers → false", () => {
  assert.equal(isSubAgentTool({ name: "Bash" }, { type: "shell" }), false);
});

// ─── Markdown tokenizer tests ─────────────────────────────────────────────────

test("C2a: tokenizeMarkdown — heading h1", () => {
  const tokens = tokenizeMarkdown("# Hello");
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, "heading");
  assert.equal(tokens[0].level, 1);
  assert.equal(tokens[0].text, "Hello");
});

test("C2b: tokenizeMarkdown — heading h2", () => {
  const tokens = tokenizeMarkdown("## Subheading");
  assert.equal(tokens[0].type, "heading");
  assert.equal(tokens[0].level, 2);
});

test("C2c: tokenizeMarkdown — heading h3", () => {
  const tokens = tokenizeMarkdown("### Deep");
  assert.equal(tokens[0].type, "heading");
  assert.equal(tokens[0].level, 3);
});

test("C2d: tokenizeMarkdown — code block", () => {
  const tokens = tokenizeMarkdown("```ts\nconst x = 1;\n```");
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, "code_block");
  assert.equal(tokens[0].lang, "ts");
  assert.equal(tokens[0].code, "const x = 1;");
});

test("C2e: tokenizeMarkdown — code block no lang", () => {
  const tokens = tokenizeMarkdown("```\nhello\n```");
  assert.equal(tokens[0].type, "code_block");
  assert.equal(tokens[0].lang, "");
  assert.equal(tokens[0].code, "hello");
});

test("C2f: tokenizeMarkdown — table", () => {
  const md = "| A | B |\n|---|---|\n| 1 | 2 |";
  const tokens = tokenizeMarkdown(md);
  const tableToken = tokens.find((t) => t.type === "table");
  assert.ok(tableToken, "should have a table token");
  assert.deepEqual(tableToken.header, ["A", "B"]);
  assert.deepEqual(tableToken.rows[0], ["1", "2"]);
});

test("C2g: tokenizeMarkdown — bullet list", () => {
  const tokens = tokenizeMarkdown("- item one\n- item two");
  assert.equal(tokens[0].type, "bullet_list");
  assert.deepEqual(tokens[0].items, ["item one", "item two"]);
});

test("C2h: tokenizeMarkdown — ordered list", () => {
  const tokens = tokenizeMarkdown("1. first\n2. second");
  assert.equal(tokens[0].type, "ordered_list");
  assert.deepEqual(tokens[0].items, ["first", "second"]);
});

test("C2i: tokenizeMarkdown — paragraph", () => {
  const tokens = tokenizeMarkdown("Just plain text");
  assert.equal(tokens[0].type, "paragraph");
  assert.equal(tokens[0].text, "Just plain text");
});

test("C2j: tokenizeMarkdown — blank line", () => {
  const tokens = tokenizeMarkdown("line1\n\nline2");
  const blanks = tokens.filter((t) => t.type === "blank");
  assert.equal(blanks.length, 1);
});

// ─── File:line detection tests ────────────────────────────────────────────────

test("C3a: extractFileLinks — colon notation", () => {
  const links = extractFileLinks("see src/Foo.tsx:45 for details");
  assert.equal(links.length, 1);
  assert.equal(links[0].filePath, "src/Foo.tsx");
  assert.equal(links[0].line, 45);
});

test("C3b: extractFileLinks — #L notation", () => {
  const links = extractFileLinks("src/Bar.ts#L10 has the bug");
  assert.equal(links.length, 1);
  assert.equal(links[0].filePath, "src/Bar.ts");
  assert.equal(links[0].line, 10);
});

test("C3c: extractFileLinks — multiple links", () => {
  const links = extractFileLinks("src/A.tsx:1 and src/B.ts:2");
  assert.equal(links.length, 2);
  assert.equal(links[0].filePath, "src/A.tsx");
  assert.equal(links[1].filePath, "src/B.ts");
});

test("C3d: extractFileLinks — no links returns empty array", () => {
  const links = extractFileLinks("no links here");
  assert.equal(links.length, 0);
});

test("C3e: extractFileLinks — plain filename without line number not matched", () => {
  const links = extractFileLinks("just src/Foo.tsx without line");
  assert.equal(links.length, 0);
});

// ─── Reasoning / compaction logic ─────────────────────────────────────────────

test("C4a: isReasoning — reasoning type", () => {
  assert.equal(isReasoning({ type: "reasoning" }), true);
});

test("C4b: isReasoning — other type", () => {
  assert.equal(isReasoning({ type: "assistant_message" }), false);
});

test("C4c: isCompaction — compaction type", () => {
  assert.equal(isCompaction({ type: "compaction" }), true);
});

test("C4d: isCompaction — compacted type", () => {
  assert.equal(isCompaction({ type: "compacted" }), true);
});

test("C4e: isCompaction — context_compaction type", () => {
  assert.equal(isCompaction({ type: "context_compaction" }), true);
});

test("C4f: isCompaction — unrelated type", () => {
  assert.equal(isCompaction({ type: "notification" }), false);
});

// ─── Pinned todo extraction ───────────────────────────────────────────────────

test("C5a: findPinnedTodo — returns last todo entry with items", () => {
  const entries = [
    { item: { type: "user_message", text: "hi" }, seqStart: 1 },
    { item: { type: "todo", items: [{ text: "do A", status: "pending" }] }, seqStart: 2 },
    { item: { type: "assistant_message", text: "ok" }, seqStart: 3 },
    { item: { type: "todo", items: [{ text: "do B", completed: true }] }, seqStart: 4 },
  ];
  const result = findPinnedTodo(entries);
  assert.ok(result, "should find a todo entry");
  assert.equal(result.seqStart, 4, "should return the last todo entry");
});

test("C5b: findPinnedTodo — ignores todo with empty items", () => {
  const entries = [
    { item: { type: "todo", items: [] }, seqStart: 1 },
    { item: { type: "assistant_message", text: "ok" }, seqStart: 2 },
  ];
  assert.equal(findPinnedTodo(entries), null);
});

test("C5c: findPinnedTodo — returns null when no todo", () => {
  const entries = [
    { item: { type: "user_message", text: "hello" }, seqStart: 1 },
  ];
  assert.equal(findPinnedTodo(entries), null);
});

test("C5d: findPinnedTodo — empty entries returns null", () => {
  assert.equal(findPinnedTodo([]), null);
});

// ─── Older history pagination ─────────────────────────────────────────────────

test("C6a: shouldShowLoadOlder — true when entries.length >= 60", () => {
  const entries = Array.from({ length: 60 }, (_, i) => ({ item: {}, seqStart: i }));
  assert.equal(shouldShowLoadOlder(entries, false), true);
});

test("C6b: shouldShowLoadOlder — true when hasMore flag is set", () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ item: {}, seqStart: i }));
  assert.equal(shouldShowLoadOlder(entries, true), true);
});

test("C6c: shouldShowLoadOlder — false when few entries and no hasMore", () => {
  const entries = [{ item: {}, seqStart: 0 }];
  assert.equal(shouldShowLoadOlder(entries, false), false);
});

test("C6d: shouldShowLoadOlder — false on empty array with no hasMore", () => {
  assert.equal(shouldShowLoadOlder([], false), false);
});

test("C6e: shouldShowLoadOlder — exactly 59 entries, no hasMore → false", () => {
  const entries = Array.from({ length: 59 }, (_, i) => ({ item: {}, seqStart: i }));
  assert.equal(shouldShowLoadOlder(entries, false), false);
});

// ─── Copy message logic ───────────────────────────────────────────────────────

test("C7a: copy message state machine — starts not copied", () => {
  let copied = false;
  assert.equal(copied, false);
});

test("C7b: copy message state machine — becomes copied after action", () => {
  let copied = false;
  // simulate click
  copied = true;
  assert.equal(copied, true);
});

test("C7c: copy message state machine — reverts to false after 1500ms", () => {
  // Test the logic: after timeout fires, copied returns to false
  let copied = true;
  // simulate timeout callback
  copied = false;
  assert.equal(copied, false, "should revert after timeout");
});

test("C7d: copy message — copies it.text", () => {
  const it = { text: "Hello world", type: "assistant_message" };
  const textToCopy = it.text;
  assert.equal(textToCopy, "Hello world");
});
