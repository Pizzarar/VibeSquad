import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseFileToken, bareFileTargets, normalizeRepoPath, makePending, claimPending, PENDING_TTL_MS,
} from "../src/fileLinks.ts";

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const BS = String.fromCharCode(92);
const timeline = src("src/Timeline.tsx");
// Pull the real renderInline regex literals out of the source so they are tested as written.
const reOf = (key) => {
  const m = new RegExp(`\\{ re: (/.*/g), key: "${key}" \\}`).exec(timeline);
  assert.ok(m, `regex ${key} not found`);
  return new Function(`return ${m[1]}`)();
};
const BT = { backticked: true };

// ── accepted ─────────────────────────────────────────────────────────────────
test("backticked path is a file target", () => {
  assert.deepEqual(parseFileToken("docs/brainstorm/vibesquad.md", BT), { path: "docs/brainstorm/vibesquad.md", line: null, isDir: false });
});
test("bare path in prose is a file target", () => {
  assert.deepEqual(bareFileTargets("read docs/art/PIXELLAB_PROMPTS.md first."), [{ path: "docs/art/PIXELLAB_PROMPTS.md", line: null, isDir: false }]);
});
test("path:line, path#L12 and ranges carry the first line", () => {
  assert.equal(parseFileToken("src/Timeline.tsx:200").line, 200);
  assert.equal(parseFileToken("src/Timeline.tsx#L12").line, 12);
  assert.equal(parseFileToken("src/Timeline.tsx:200-213").line, 200);
  assert.equal(parseFileToken("src/Timeline.tsx:200-213").path, "src/Timeline.tsx");
  assert.equal(parseFileToken("src/Timeline.tsx#L12-L20").line, 12);
});
test("parenthesised (src/Timeline.tsx:200) keeps its line via the filelink regex", () => {
  const m = reOf("filelink").exec("see (src/Timeline.tsx:200) now");
  assert.equal(m[1], "src/Timeline.tsx");
  assert.equal(m[2], "200");
  assert.equal(parseFileToken(m[0]).line, 200);
});
test("range :200-213 is matched whole by the filelink regex", () => {
  const m = reOf("filelink").exec("at src/Timeline.tsx:200-213.");
  assert.equal(m[0], "src/Timeline.tsx:200-213");
});
test("backticked root file with a line links; bare root file does not", () => {
  assert.deepEqual(parseFileToken("README.md:10", BT), { path: "README.md", line: 10, isDir: false });
  assert.equal(parseFileToken("README.md:10"), null);
  assert.equal(parseFileToken("README.md"), null);
});
test("backticked folders with a real dir shape link", () => {
  assert.deepEqual(parseFileToken("scratch/", BT), { path: "scratch", line: null, isDir: true });
  assert.deepEqual(parseFileToken("scratch/pixellab/", BT), { path: "scratch/pixellab", line: null, isDir: true });
  assert.deepEqual(parseFileToken("docs/brainstorm/", BT), { path: "docs/brainstorm", line: null, isDir: true });
});
test("./ and backslash paths normalise", () => {
  assert.equal(parseFileToken("./src/App.tsx").path, "src/App.tsx");
  assert.equal(parseFileToken("src" + BS + "App.tsx").path, "src/App.tsx");
  assert.equal(parseFileToken("." + BS + "src" + BS + "App.tsx:7").line, 7);
  assert.equal(normalizeRepoPath("." + BS + "src" + BS + "x.ts"), "src/x.ts");
  assert.equal(bareFileTargets("open src/App.tsx.")[0].path, "src/App.tsx");
});

// ── rejected ─────────────────────────────────────────────────────────────────
test("bare folders never link", () => {
  assert.equal(parseFileToken("scratch/"), null);
  assert.deepEqual(bareFileTargets("see scratch/pixellab/ now"), []);
});
test("date-like and prose folders are rejected even when backticked", () => {
  assert.equal(parseFileToken("2026/11/", BT), null);
  assert.equal(parseFileToken("1/2/", BT), null);
  assert.equal(parseFileToken("and/or/", BT), null);
  assert.equal(parseFileToken("and/or", BT), null);
});
test("traversal is rejected", () => {
  assert.equal(parseFileToken("../../secret.md", BT), null);
  assert.equal(parseFileToken("src/../../secret.md", BT), null);
  assert.equal(parseFileToken("../x/", BT), null);
  assert.equal(normalizeRepoPath("a/../b"), null);
  assert.deepEqual(bareFileTargets("read ../../etc/passwd.txt"), []);
});
test("absolute, drive-letter and home paths are rejected", () => {
  assert.equal(parseFileToken("/etc/passwd.txt:1", BT), null);
  assert.equal(parseFileToken(BS + "etc" + BS + "x.txt", BT), null);
  assert.equal(parseFileToken("C:" + BS + "Users" + BS + "x.md", BT), null);
  assert.equal(parseFileToken("C:/Users/x.md", BT), null);
  assert.equal(parseFileToken("~/notes.md", BT), null);
  assert.deepEqual(bareFileTargets("open /etc/passwd.txt and ~/a/b.md"), []);
  assert.equal(parseFileToken(reOf("filelink").exec("/etc/passwd.txt:1")[0]), null); // regex may match; the gate rejects
});
test("URLs never link, including :line and #L12 forms", () => {
  assert.equal(parseFileToken("https://example.com/a/b.md", BT), null);
  assert.deepEqual(bareFileTargets("go to https://example.com/a/b.md or http://x.dev/docs/"), []);
  assert.equal(reOf("filelink").exec("https://x.com/a/b.md:80"), null);
  assert.equal(reOf("filelink2").exec("https://github.com/a/b/blob/main/x.ts#L12"), null);
  assert.deepEqual(bareFileTargets("https://github.com/a/b/blob/main/x.ts#L12"), []);
  assert.equal(parseFileToken("https://x.com/a/b.md:80", BT), null);
});
test("@scope/pkg and plain slashed words are not links", () => {
  assert.equal(parseFileToken("@types/node", BT), null);
  assert.deepEqual(bareFileTargets("install @types/node and @scope/pkg.js"), []);
  assert.deepEqual(bareFileTargets("either and/or 1.5/2.5 on 11/01/2026"), []);
});

// ── wiring ───────────────────────────────────────────────────────────────────
test("every chat path goes through parseFileToken; no raw openRightDockTab path", () => {
  const calls = timeline.match(/openRightDockTab\("Files"/g) ?? [];
  assert.equal(calls.length, 1, "only openFileTarget may open Files");
  assert.match(timeline, /parseFileToken\(m\[7\], \{ backticked: true \}\)/);
  assert.match(timeline, /parseFileToken\(raw\)/);
  assert.match(timeline, /key: "barepath"/);
  assert.doesNotMatch(timeline, /clipboard\.writeText\(fp\)/);
});
test("FilesPanel: .md rendered/Source, not-found, folder reveal, confinement, normalized highlight", () => {
  const f = src("src/FilesPanel.tsx");
  assert.match(f, /isMd && !sourceView/);
  assert.match(f, /data-testid="files-source-btn"/);
  assert.match(f, /File not found: \{openFile\}/);
  assert.match(f, /revealFolder/);
  assert.match(f, /normalizeRepoPath\(targetFile\)/);
  assert.match(f, /normalizeRepoPath\(path\) === null/);
  assert.match(f, /setSourceView\(line !== undefined\)/);
  assert.match(f, /targetNonce\]/);
  assert.match(f, /agentId=\{agent\.id\} doc \/>/);
});
test("doc-mode markdown only for the Files dock", () => {
  assert.match(timeline, /tokenizeMarkdown\(text: string, doc = false\)/);
  assert.ok(timeline.includes("if (doc && /") && timeline.includes('type: "blockquote"'));
});

// ── pendingOpen ──────────────────────────────────────────────────────────────
test("pendingOpen keeps only Files targets with a file or folder", () => {
  assert.equal(makePending("Changes", undefined, 1), null);
  assert.equal(makePending("Files", undefined, 1), null);
  assert.equal(makePending("Files", { line: 3 }, 1), null);
  assert.equal(makePending("Terminal", { filePath: "a/b.md" }, 1), null);
  assert.deepEqual(makePending("Files", { filePath: "a/b.md", line: 3 }, 7, 1000), { tab: "Files", filePath: "a/b.md", line: 3, nonce: 7, at: 1000 });
});
test("pendingOpen expires after ~2s", () => {
  const p = makePending("Files", { filePath: "scratch" }, 1, 10_000);
  assert.equal(claimPending(p, 10_000 + PENDING_TTL_MS - 1)?.filePath, "scratch");
  assert.equal(claimPending(p, 10_000 + PENDING_TTL_MS + 1), null);
  assert.equal(claimPending(null), null);
  assert.ok(PENDING_TTL_MS >= 1500 && PENDING_TTL_MS <= 3000);
});
test("RightDock: nonce per request, pending claimed once, keyed per agent", () => {
  const r = src("src/RightDock.tsx");
  assert.match(r, /const nonce = \+\+openNonce/);
  assert.match(r, /claimPending\(pendingOpen\)/);
  assert.match(r, /pendingOpen = null;\s+if \(p\)/);
  assert.match(src("src/AgentDrawer.tsx"), /<RightDock key=\{agent\.id\}/);
});

// ── local-disk md links (file:// / drive paths) ──────────────────────────────
import { isLocalHref, localLinkTarget } from "../src/fileLinks.ts";
const CWD = "C:/Users/dev/projects/Repo";
const SANCT = "C:/Users/dev/AppData/Local/Repo/worktrees/Repo/art-a/scratch/shots/a.png";
test("isLocalHref: file:// and drive paths are local, http(s) is not", () => {
  assert.ok(isLocalHref("file:///C:/a/b.png"));
  assert.ok(isLocalHref("C:/a/b.png"));
  assert.ok(isLocalHref("C:" + BS + "a" + BS + "b.png"));
  assert.ok(!isLocalHref("https://example.com/a.png"));
  assert.ok(!isLocalHref("http://localhost:5173/x"));
});
test("localLinkTarget (a): inside the agent cwd becomes repo-relative", () => {
  assert.deepEqual(localLinkTarget(`file:///${CWD}/docs/x.md`, CWD), { path: "docs/x.md", line: null, isDir: false });
  assert.equal(localLinkTarget(`file:///${CWD.toLowerCase()}/docs/x.md`, CWD + "/").path, "docs/x.md");
});
test("localLinkTarget (b): sanctuary worktree path keeps worktrees/<repo>/<unit>/…", () => {
  assert.equal(localLinkTarget(`file:///${SANCT}`, CWD).path, "worktrees/Repo/art-a/scratch/shots/a.png");
  assert.equal(localLinkTarget(SANCT).path, "worktrees/Repo/art-a/scratch/shots/a.png");
});
test("localLinkTarget decodes %20 and normalises backslashes", () => {
  assert.equal(localLinkTarget("file:///C:/Users/me/AppData/Local/Repo/worktrees/R/u/a%20b.png").path, "worktrees/R/u/a b.png");
  const win = ["C:", "Users", "me", "AppData", "Local", "Repo", "worktrees", "R", "u", "s.png"].join(BS);
  assert.equal(localLinkTarget(win).path, "worktrees/R/u/s.png");
});
test("localLinkTarget (c): outside the workspace yields a name for the toast", () => {
  assert.deepEqual(localLinkTarget("file:///C:/Users/me/Desktop/my%20shot.png", CWD), { path: null, name: "my shot.png" });
});
test("Timeline routes local md links to a tl-file-link button, http stays an anchor", () => {
  const i = timeline.indexOf("isLocalHref(m[10])");
  assert.ok(i > 0);
  const branch = timeline.slice(i, timeline.indexOf("<a key", i));
  assert.match(branch, /data-testid="tl-file-link"/);
  assert.match(timeline.slice(i), /<a key=\{keyIdx\+\+\} href=\{m\[10\]\} target="_blank"/);
});

test("localLinkTarget rejects UNC / remote hosts in every form", () => {
  const W = "worktrees/R/u/x.png";
  for (const h of [`file://evil-host/${W}`, `file:////host/share/${W}`, `file:///${BS}${BS}host${BS}share${BS}${W}`,
    `//host/${W}`, `${BS}${BS}host${BS}share${BS}${W}`, `file://host/C:/${W}`]) {
    assert.ok(isLocalHref(h), h);
    const t = localLinkTarget(h, CWD);
    assert.equal(t.path, null, h);
    assert.equal(t.name, "x.png", h);
  }
  assert.equal(localLinkTarget("file://localhost/C:/Users/me/AppData/Local/Repo/worktrees/R/u/a.png").path, "worktrees/R/u/a.png");
});
test("localLinkTarget rejects . and .. segments (cwd and worktrees forms, encoded too)", () => {
  assert.equal(localLinkTarget(`file:///${CWD}/../../worktrees/Repo/art-a/x.png`, CWD).path, null);
  assert.equal(localLinkTarget(`file:///${CWD}/docs/../src/x.ts`, CWD).path, null);
  assert.equal(localLinkTarget(`file:///${CWD}/docs/%2e%2e/x.ts`, CWD).path, null);
  assert.equal(localLinkTarget(`${CWD}/./docs/x.ts`, CWD).path, null);
});
test("localLinkTarget keeps the leading slash of POSIX file:/// paths", () => {
  assert.equal(localLinkTarget("file:///Users/me/repo/docs/x.md", "/Users/me/repo").path, "docs/x.md");
  assert.equal(localLinkTarget("file:///home/me/.local/share/Repo/worktrees/R/u/s.png").path, "worktrees/R/u/s.png");
});
test("localLinkTarget: %23/%3F survive in filenames, bad escapes and real ?# are handled", () => {
  assert.equal(localLinkTarget(`file:///${CWD}/docs/a%23b%3Fc.md`, CWD).path, "docs/a#b?c.md");
  assert.equal(localLinkTarget(`file:///${CWD}/docs/x.md#L3`, CWD).path, "docs/x.md");
  assert.equal(localLinkTarget(`file:///${CWD}/docs/%E0%A4%A.md`, CWD).path, null);
});
