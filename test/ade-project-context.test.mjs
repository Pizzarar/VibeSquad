import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// ADE block 3: Project panel provider→file table, @folder insert, expand-on-send, listing timeout.
const C = await import("../src/projectContext.ts");
const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("provider→file table: one table, Claude reads CLAUDE.md, Gemini reads GEMINI.md and AGENTS.md", () => {
  const by = (p) => C.CONTEXT_FILES.find((f) => f.path === p);
  assert.deepEqual(
    C.CONTEXT_FILES.map((f) => f.path),
    ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".claude/CLAUDE.md"],
  );
  assert.ok(C.isLoadedBy(by("CLAUDE.md"), "claude"));
  assert.ok(C.isLoadedBy(by(".claude/CLAUDE.md"), "claude"));
  assert.ok(!C.isLoadedBy(by("AGENTS.md"), "claude"));
  assert.ok(C.isLoadedBy(by("GEMINI.md"), "antigravity-cli"));
  assert.ok(C.isLoadedBy(by("AGENTS.md"), "antigravity-cli"));
  assert.ok(C.isLoadedBy(by("AGENTS.md"), "gemini"));
  assert.ok(C.isLoadedBy(by("AGENTS.md"), "codex"));
  assert.ok(!C.isLoadedBy(by("CLAUDE.md"), "codex"));
});

test("providerFamily maps Paseo provider ids", () => {
  assert.equal(C.providerFamily("claude"), "claude");
  assert.equal(C.providerFamily("antigravity-cli"), "gemini");
  assert.equal(C.providerFamily("codex"), "codex");
  assert.equal(C.providerFamily(undefined), "other");
});

test("contextFilesFor adds the lane brainstorm doc, not auto-loaded; unsafe lane names are dropped", () => {
  const files = C.contextFilesFor("basic-ade-agentic-development-en");
  const bs = files.at(-1);
  assert.equal(bs.path, "docs/brainstorm/basic-ade-agentic-development-en.md");
  assert.deepEqual(bs.loadedBy, []);
  assert.equal(C.contextFilesFor("").length, 4);
  assert.equal(C.contextFilesFor("../etc").length, 4);
});

test("AGENTS.md template is tiny and titled", () => {
  assert.match(C.AGENTS_TEMPLATE, /^# AGENTS\.md/);
  assert.ok(C.AGENTS_TEMPLATE.length < 400);
});

test("folder token insert: folders get a trailing slash and a folder glyph; files don't", () => {
  assert.equal(C.mentionInsertText({ path: "docs", kind: "directory" }), "@docs/ ");
  assert.equal(C.mentionInsertText({ path: "docs/", kind: "directory" }), "@docs/ ");
  assert.equal(C.mentionInsertText({ path: "src/App.tsx", kind: "file" }), "@src/App.tsx ");
  assert.equal(C.mentionLabel({ path: "docs", kind: "directory" }), "📁 @docs/");
  assert.equal(C.mentionLabel({ path: "README.md", kind: "file" }), "@README.md");
});

test("@ menu lists folders before files", () => {
  const out = C.filterMentionEntries(
    [
      { path: "docs/NAMING.md", kind: "file" },
      { path: "docs", kind: "directory" },
      { path: "src/App.tsx", kind: "file" },
    ],
    "docs",
  );
  assert.deepEqual(out.map((e) => e.path), ["docs", "docs/NAMING.md"]);
});

test("slow-suggestions fallback lists the query's parent folder and filters it locally", () => {
  assert.equal(C.parentDirOf("doc"), "");
  assert.equal(C.parentDirOf("docs/ar"), "docs");
  assert.equal(C.parentDirOf("docs/"), "docs");
  const root = [
    { path: ".git", kind: "directory" },
    { path: "README.md", kind: "file" },
    { path: "mydocs.txt", kind: "file" },
    { path: "docs", kind: "directory" },
  ];
  assert.deepEqual(C.filterListing(root, "doc").map((e) => e.path), ["docs", "mydocs.txt"]);
  assert.deepEqual(C.filterListing(root, "").map((e) => e.path), ["docs", "README.md", "mydocs.txt"]);
  const docs = [
    { path: "docs/art", kind: "directory" },
    { path: "docs/ADE_JOB_WALK.md", kind: "file" },
  ];
  assert.deepEqual(C.filterListing(docs, "docs/ar").map((e) => e.path), ["docs/art"]);
});

test("@url: inserted as-is, recognised for the link chip", () => {
  assert.ok(C.isUrlMention("https://example.com/a"));
  assert.ok(!C.isUrlMention("docs/"));
  assert.deepEqual(C.urlMentions("see @https://x.dev/a and @docs/"), ["https://x.dev/a"]);
  assert.deepEqual(C.folderMentions("see @https://x.dev/a/ now"), []);
});

test("folderMentions finds @dir/ tokens only, skipping absolute and .. paths", () => {
  assert.deepEqual(C.folderMentions("@docs/ list the files"), ["docs"]);
  assert.deepEqual(C.folderMentions("look at @src/ and @docs/ and @src/"), ["src", "docs"]);
  assert.deepEqual(C.folderMentions("@src/App.tsx is a file"), []);
  assert.deepEqual(C.folderMentions("@../secret/ @/etc/ @C:/x/"), []);
  assert.deepEqual(C.folderMentions("mail me@host/ x"), []);
});

test("expand-on-send rule: Claude resolves @dir/ natively, Gemini/others get a Folder line", async () => {
  assert.equal(C.shouldExpandFolders("claude"), false);
  assert.equal(C.shouldExpandFolders("antigravity-cli"), true);
  assert.equal(C.shouldExpandFolders("codex"), true);
  const list = async (d) => [
    { path: `${d}/a.md`, kind: "file" },
    { path: `${d}/b.md`, kind: "file" },
    { path: `${d}/art`, kind: "directory" },
  ];
  const text = "@docs/ list the files in that folder";
  assert.equal(await C.expandFolderMentions(text, "claude", list), text);
  const out = await C.expandFolderMentions(text, "antigravity-cli", list);
  assert.equal(out, `${text}\n\nFolder: docs/ (2 files, 1 folder): a.md, b.md, art/`);
  assert.equal(await C.expandFolderMentions("no folders here", "antigravity-cli", list), "no folders here");
});

test("folderLine caps long listings", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ path: `d/f${i}`, kind: "file" }));
  const line = C.folderLine("d", many);
  assert.match(line, /^Folder: d\/ \(50 files\): f0, f1/);
  assert.match(line, /\+10 more$/);
});

test("listing timeout fallback: a hung listing resolves to 'couldn't list' instead of hanging", async () => {
  const hang = () => new Promise(() => {});
  const t0 = Date.now();
  const out = await C.expandFolderMentions("@docs/ hi", "antigravity-cli", hang, 30);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(out, "@docs/ hi\n\nFolder: docs/ (couldn't list)");
  const failed = await C.expandFolderMentions("@docs/ hi", "antigravity-cli", async () => { throw new Error("boom"); }, 30);
  assert.match(failed, /couldn't list/);
  const r = await C.withTimeout(hang(), 20, "fallback");
  assert.deepEqual(r, { value: "fallback", timedOut: true });
  const ok = await C.withTimeout(Promise.resolve(1), 1000, 0);
  assert.deepEqual(ok, { value: 1, timedOut: false });
});

test("wiring: Project tab in RightDock, Composer time-boxes the @ listing, AgentDrawer expands on send", () => {
  const dock = src("RightDock.tsx");
  assert.match(dock, /"Changes", "Files", "Terminal", "Scripts", "Project"/);
  assert.match(dock, /<ProjectPanel agent=\{agent\} \/>/);
  const comp = src("Composer.tsx");
  assert.match(comp, /withTimeout\(/);
  assert.match(comp, /includeDirectories: true/);
  assert.match(comp, /composer-mention-failed/);
  assert.match(src("AgentDrawer.tsx"), /expandFolderMentions\(composed, agent\.provider/);
  const panel = src("ProjectPanel.tsx");
  assert.match(panel, /openRightDockTab\("Files", \{ filePath: f\.path \}\)/);
  assert.match(panel, /Create AGENTS\.md/);
  assert.match(panel, /project-panel-empty/);
});
