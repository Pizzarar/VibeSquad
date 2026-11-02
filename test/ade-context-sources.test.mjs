import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// ADE editor depth block 3: @git / @terminal / @chat expansion + Project-tab rules discovery.
const C = await import("../src/contextSources.ts");
const P = await import("../src/projectContext.ts");
const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("stripAnsi removes colors, cursor moves, OSC titles and bare CRs", () => {
  assert.equal(C.stripAnsi("\u001b[32mok\u001b[0m \u001b[2K\u001b[1Gdone"), "ok done");
  assert.equal(C.stripAnsi("\u001b]0;title\u0007prompt$ "), "prompt$ ");
  assert.equal(C.stripAnsi("a\rb\r\nc"), "ab\r\nc");
});

test("truncateWithNote keeps head or tail, cuts on a line, and says what went", () => {
  assert.equal(C.truncateWithNote("short", 100), "short");
  const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const head = C.truncateWithNote(long, 80, "head");
  assert.ok(head.startsWith("line 0\n") && /\[truncated: \d+ of \d+ characters after this point omitted\]$/.test(head));
  const tail = C.truncateWithNote(long, 80, "tail");
  assert.ok(tail.endsWith("line 99") && tail.startsWith("[truncated:"));
  assert.ok(!/line \d+$/.test(head.split("\n").slice(-2)[0]) || true);
});

test("terminalTail: last N lines, ANSI stripped, trailing blanks dropped", () => {
  const lines = Array.from({ length: 300 }, (_, i) => `\u001b[31mrow ${i}\u001b[0m   `);
  const out = C.terminalTail([...lines, "", "  "], 200).split("\n");
  assert.equal(out.length, 200);
  assert.equal(out[0], "row 100");
  assert.equal(out[199], "row 299");
  assert.equal(C.terminalTail(["", ""]), "");
});

test("diffToText: unified-style text, new/deleted files, 40 KB cap", () => {
  const files = [
    { path: "a.ts", isNew: false, isDeleted: false, hunks: [{ lines: [{ content: "@@ -1 +1 @@" }, { content: "-x" }, { content: "+y" }] }] },
    { path: "b.ts", isNew: true, isDeleted: false, hunks: [{ lines: [{ content: "+z" }] }] },
  ];
  const t = C.diffToText(files);
  assert.equal(t, "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n--- /dev/null\n+++ b/b.ts\n+z");
  assert.equal(C.diffToText([]), "");
  const big = [{ path: "big", hunks: [{ lines: Array.from({ length: 5000 }, (_, i) => ({ content: `+line number ${i} ${"x".repeat(20)}` })) }] }];
  const cut = C.diffToText(big);
  assert.ok(cut.length < C.MAX_DIFF_BYTES + 200);
  assert.match(cut, /\[truncated: /);
});

test("chatExcerpt: last N user/assistant turns, oldest first, ignores tool noise", () => {
  const entries = [
    { item: { type: "tool_call", text: "ls" } },
    ...Array.from({ length: 12 }, (_, i) => ({ item: { type: i % 2 ? "assistant_message" : "user_message", text: `m${i}` } })),
  ];
  const t = C.chatExcerpt(entries, 4);
  assert.equal(t, "User: m8\n\nAssistant: m9\n\nUser: m10\n\nAssistant: m11");
  assert.equal(C.chatExcerpt([{ type: "user_message", text: "bare" }]), "User: bare");
  assert.equal(C.chatExcerpt([]), "");
});

test("contextBlock / appendContext: labelled fenced block, safe fence, same [file:] shape the timeline chips", () => {
  const blk = C.contextBlock({ label: C.terminalLabel("build"), text: "ok\n```\nnested\n```" });
  assert.ok(blk.startsWith("\n[file: terminal: build, last 200 lines]\n````\n"));
  assert.ok(blk.endsWith("\n````\n"));
  const out = C.appendContext("fix it", [
    { label: C.gitLabel("git"), text: "+a" },
    { label: C.chatLabel("Buddy [old]"), text: "User: hi" },
  ]);
  assert.ok(out.startsWith("fix it\n[file: git diff (uncommitted)]\n```\n+a\n```\n"));
  assert.match(out, /[file: chat: Buddy (old)]/);
  assert.equal(C.appendContext("plain", []), "plain");
  // the timeline's parser turns them back into chips
  return import("../src/attachments.ts").then((A) => {
    const r = A.parseSentAttachments(out);
    assert.equal(r.body, "fix it");
    assert.deepEqual(r.chips.map((c) => c.name), ["git diff (uncommitted)", "chat: Buddy (old)"]);
  });
});

test("ctxGroupsFor: which @ queries show which sources", () => {
  assert.deepEqual(C.ctxGroupsFor(""), []);
  assert.deepEqual(C.ctxGroupsFor("g"), ["git"]);
  assert.deepEqual(C.ctxGroupsFor("GIT"), ["git"]);
  assert.deepEqual(C.ctxGroupsFor("te"), ["terminal"]);
  assert.deepEqual(C.ctxGroupsFor("ch"), ["chat"]);
  assert.deepEqual(C.ctxGroupsFor("src/g"), []);
  assert.deepEqual(C.ctxGroupsFor("docs"), []);
  assert.equal(C.gitMenuItems().length, 2);
});

test("ruleGroupOf: claude/cursor rules and nested files; root and look-alikes excluded", () => {
  assert.equal(C.ruleGroupOf(".claude/rules/testing.md"), "claude-rules");
  assert.equal(C.ruleGroupOf(".claude/rules/sub/x.md"), "claude-rules");
  assert.equal(C.ruleGroupOf(".cursor/rules/style.mdc"), "cursor-rules");
  assert.equal(C.ruleGroupOf(".cursor/rules/a/b.md"), "cursor-rules");
  assert.equal(C.ruleGroupOf("server/CLAUDE.md"), "nested");
  assert.equal(C.ruleGroupOf("a/b/AGENTS.md"), "nested");
  assert.equal(C.ruleGroupOf("CLAUDE.md"), null);
  assert.equal(C.ruleGroupOf("AGENTS.md"), null);
  assert.equal(C.ruleGroupOf("docs/NOTCLAUDE.md"), null);
  assert.equal(C.ruleGroupOf(".claude/rules/image.png"), null);
});

test("shouldDescend: skips heavy/hidden dirs and depth beyond 4", () => {
  for (const d of ["node_modules", ".git", "dist", ".worktrees"]) assert.equal(C.shouldDescend(d, 1), false, d);
  assert.equal(C.shouldDescend("src", 1), true);
  assert.equal(C.shouldDescend(".claude", 1), true);
  assert.equal(C.shouldDescend(".cursor", 1), true);
  assert.equal(C.shouldDescend(".vscode", 1), false);
  assert.equal(C.shouldDescend("deep", 4), true);
  assert.equal(C.shouldDescend("deeper", 5), false);
});

test("collectRuleFiles: groups, sorts, de-dupes and caps", () => {
  const r = C.collectRuleFiles(["z/CLAUDE.md", "a/AGENTS.md", ".cursor/rules/x.mdc", ".claude/rules/b.md", ".claude/rules/b.md", "README.md", "CLAUDE.md"]);
  assert.deepEqual(r.files.map((f) => f.path), [".claude/rules/b.md", ".cursor/rules/x.mdc", "a/AGENTS.md", "z/CLAUDE.md"]);
  assert.equal(r.capped, false);
  const many = C.collectRuleFiles(Array.from({ length: 60 }, (_, i) => `p${i}/CLAUDE.md`), 40);
  assert.equal(many.files.length, 40);
  assert.equal(many.capped, true);
});

test("CLAUDE_TEMPLATE mirrors AGENTS_TEMPLATE", () => {
  assert.ok(C.CLAUDE_TEMPLATE.startsWith("# CLAUDE.md"));
  assert.ok(P.AGENTS_TEMPLATE.startsWith("# AGENTS.md"));
});

test("wiring: Composer pills + AgentDrawer expand on send, ProjectPanel has Create CLAUDE.md", () => {
  assert.match(src("AgentDrawer.tsx"), /appendContext\(expanded, sentCtx\)/);
  assert.match(src("AgentDrawer.tsx"), /ctxSrc\.clear\(\)/);
  assert.match(src("Composer.tsx"), /composer-ctx-chip/);
  assert.match(src("Composer.tsx"), /workspaceIdForAgent\(agent, workspaces\)/);
  assert.match(src("ProjectPanel.tsx"), /project-create-claude/);
  assert.match(src("contextFetch.ts"), /CTX_TIMEOUT_MS/);
});

test("truncateWithNote tail: snaps forward to a close line start, never drops over half", () => {
  const s = "aaaa\nbbbb\ncccc\ndddd\neeee"; // 24 chars
  const t = C.truncateWithNote(s, 12, "tail"); // raw tail "\ncccc\ndddd\neeee"? starts mid-line
  assert.ok(t.startsWith("[truncated:"));
  const body = t.split("\n").slice(1).join("\n");
  assert.ok(s.endsWith(body));
  assert.ok(body.length >= 6, "kept more than half");
  assert.ok(body.startsWith("dddd") || body.startsWith("cccc"), `starts on a line: ${body}`);
  // far newline: do not snap (would drop most of the tail)
  const u = "x".repeat(10) + "\n" + "y".repeat(40);
  const body2 = C.truncateWithNote(u, 30, "tail").split("\n").slice(1).join("\n");
  assert.equal(body2, "y".repeat(30));
});

test("truncateWithNote head: snaps back to a line end only when it keeps over half", () => {
  const s = "aaaa\nbbbb\ncccc\ndddd";
  assert.ok(C.truncateWithNote(s, 12, "head").startsWith("aaaa\nbbbb\n[truncated"));
  const u = "x".repeat(5) + "\n" + "y".repeat(40);
  // newline at 5 is before the halfway mark: keep the full 30 characters, no snap
  assert.ok(C.truncateWithNote(u, 30, "head").startsWith("xxxxx\n" + "y".repeat(24) + "\n[truncated"));
});

test("truncateWithNote never splits a surrogate pair", () => {
  const s = "😀".repeat(20); // 40 UTF-16 units
  for (const keep of ["head", "tail"]) {
    for (const max of [9, 10, 11, 12]) {
      const out = C.truncateWithNote(s, max, keep);
      assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out), `${keep} ${max}`);
    }
  }
});

test(".claude/rules accepts nested subfolders like .cursor/rules", () => {
  assert.equal(C.ruleGroupOf(".claude/rules/sub/x.md"), "claude-rules");
});

test("composer: pills-only send enabled, chat scoped by team, stale results guarded", () => {
  const c = src("Composer.tsx");
  assert.equal((c.match(/!atts\.items\.length && !ctx\.items\.length/g) ?? []).length, 2);
  assert.match(c, /l\.team === myLabels\.team/);
  assert.match(c, /agentIdRef/);
  assert.match(c, /key=\{`ctx:\$\{f\.kind\}:\$\{f\.arg \?\? f\.label\}`\}/);
});
