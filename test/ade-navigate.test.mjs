import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ADE editor depth block 2 (Navigate): quick open, find in files, keybinding editor.

const mem = new Map();
Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => void mem.set(k, String(v)), removeItem: (k) => void mem.delete(k) },
  configurable: true,
  writable: true,
});

// S3: the middleware reads the local token from VIBESQUAD_HOME; keep it in a temp home.
const vsHome = mkdtempSync(join(tmpdir(), "vs-nav-home-"));
process.env.VIBESQUAD_HOME = vsHome;
test.after(() => rmSync(vsHome, { recursive: true, force: true }));

const K = await import("../src/keymap.ts");
const N = await import("../src/navigateLogic.ts");
const P = await import("../src/prefs.ts");
const S = await import("../server/file-search.mjs");
const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

// ---- keymap ---------------------------------------------------------------------------------

test("normalizeCombo: canonical order, aliases, folded shift, named keys, rejects junk", () => {
  assert.equal(K.normalizeCombo("ctrl+shift+f"), "Ctrl+Shift+F");
  assert.equal(K.normalizeCombo("Shift+Ctrl+F"), "Ctrl+Shift+F");
  assert.equal(K.normalizeCombo("Cmd+P"), "Ctrl+P");
  assert.equal(K.normalizeCombo("Meta+Alt+k"), "Ctrl+Alt+K");
  assert.equal(K.normalizeCombo("?"), "?");
  assert.equal(K.normalizeCombo("Shift+?"), "?", "shift is part of ?");
  assert.equal(K.normalizeCombo("Ctrl+."), "Ctrl+.");
  assert.equal(K.normalizeCombo("Ctrl++"), "Ctrl+Plus");
  assert.equal(K.normalizeCombo("esc"), "Escape");
  assert.equal(K.normalizeCombo("Ctrl+f5"), "Ctrl+F5");
  assert.equal(K.normalizeCombo("Hyper+K"), null);
  assert.equal(K.normalizeCombo("Ctrl+Banana"), null);
  assert.equal(K.normalizeCombo(""), null);
});

test("comboFromEvent matches normalizeCombo and ignores lone modifiers", () => {
  const ev = (key, mods = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(K.comboFromEvent(ev("p", { ctrlKey: true })), "Ctrl+P");
  assert.equal(K.comboFromEvent(ev("F", { ctrlKey: true, shiftKey: true })), "Ctrl+Shift+F");
  assert.equal(K.comboFromEvent(ev("k", { metaKey: true })), "Ctrl+K", "Cmd = Ctrl");
  assert.equal(K.comboFromEvent(ev("?", { shiftKey: true })), "?");
  assert.equal(K.comboFromEvent(ev("Control", { ctrlKey: true })), null);
  assert.equal(K.comboFromEvent(ev("Shift", { shiftKey: true })), null);
  assert.equal(K.comboFromEvent(ev("å", { altKey: true, code: "KeyA" })), "Alt+A", "Option symbols use the physical key");
  assert.ok(K.firesWhileTyping("Ctrl+P"));
  assert.ok(K.firesWhileTyping("F2"));
  assert.ok(!K.firesWhileTyping("?"), "plain ? must not fire in a text field");
});

test("defaults: palette keeps Ctrl+K / Ctrl+Shift+P, new Ctrl+P / Ctrl+Shift+F, no default conflicts", () => {
  const b = K.effectiveBindings({});
  assert.deepEqual(b.get("palette"), ["Ctrl+K", "Ctrl+Shift+P"]);
  assert.deepEqual(b.get("quickOpen"), ["Ctrl+P"]);
  assert.deepEqual(b.get("findInFiles"), ["Ctrl+Shift+F"]);
  assert.deepEqual(b.get("focus"), ["Ctrl+."]);
  assert.deepEqual(b.get("needsYou"), ["Ctrl+J"]);
  assert.deepEqual(b.get("shortcuts"), ["?"]);
  assert.equal(K.findConflicts(b).size, 0);
  for (const c of K.KEY_COMMANDS) for (const d of c.defaults) assert.equal(K.normalizeCombo(d), d, `${c.id} default ${d} is canonical`);
  assert.equal(new Set(K.KEY_COMMANDS.map((c) => c.id)).size, K.KEY_COMMANDS.length);
});

test("overrides: set / reset / sanitize / serialize round trip", () => {
  let o = K.setBinding({}, "quickOpen", ["ctrl+o"]);
  assert.deepEqual(o, { quickOpen: ["Ctrl+O"] });
  assert.deepEqual(K.effectiveBindings(o).get("quickOpen"), ["Ctrl+O"]);
  o = K.setBinding(o, "quickOpen", ["Ctrl+P"]);
  assert.deepEqual(o, {}, "back to the default drops the override");
  o = K.setBinding({}, "focus", []);
  assert.deepEqual(o, { focus: [] }, "empty list = unbound");
  assert.deepEqual(K.effectiveBindings(o).get("focus"), []);
  assert.deepEqual(K.resetBinding(o, "focus"), {});
  assert.deepEqual(K.setBinding({}, "nope", ["Ctrl+O"]), {}, "unknown command ignored");
  assert.deepEqual(K.sanitizeOverrides({ quickOpen: ["Ctrl+O", "junk+x", "ctrl+o"], bogus: ["Ctrl+B"], focus: "Ctrl+." }), { quickOpen: ["Ctrl+O"] });
  assert.deepEqual(K.parseOverrides("not json"), {});
  assert.deepEqual(K.sanitizeOverrides({ quickOpen: ["junk+x", "Hyper+P"] }), {}, "all-invalid entry is dropped, not an unbind");
  assert.deepEqual(K.effectiveBindings(K.sanitizeOverrides({ quickOpen: ["junk+x"] })).get("quickOpen"), ["Ctrl+P"]);
  assert.deepEqual(K.sanitizeOverrides({ focus: [] }), { focus: [] }, "explicit [] still unbinds");
  assert.deepEqual(K.sanitizeOverrides({ palette: ["ctrl+k", "Ctrl+Shift+P"], quickOpen: ["Ctrl+P"] }), {}, "entries equal to the defaults are stripped");
  assert.equal(K.serializeOverrides({}), "");
  assert.deepEqual(K.parseOverrides(K.serializeOverrides({ quickOpen: ["Ctrl+O"] })), { quickOpen: ["Ctrl+O"] });
});

test("conflicts: same combo twice in one scope, reserved keys; different scopes don't clash", () => {
  const b = K.effectiveBindings({ quickOpen: ["Ctrl+K"], focus: ["Ctrl+1"] });
  const c = K.findConflicts(b);
  assert.deepEqual(c.get("quickOpen"), [{ combo: "Ctrl+K", with: "Command palette" }]);
  assert.deepEqual(c.get("palette"), [{ combo: "Ctrl+K", with: "Quick open file" }]);
  assert.match(c.get("focus")[0].with, /reserved for switch tab/);
  const r = K.findConflicts(K.effectiveBindings({ search: ["Ctrl+F"], reopen: ["Ctrl+Shift+T"] }));
  assert.match(r.get("search")[0].with, /transcript search/);
  assert.match(r.get("reopen")[0].with, /reopen closed tab/);
  const cmds = [...K.KEY_COMMANDS, { id: "inlineEdit", label: "Inline edit", defaults: ["Ctrl+K"], scope: "files-editor" }];
  assert.equal(K.findConflicts(K.effectiveBindings({}, cmds), cmds).size, 0, "a focus-scoped Ctrl+K is not a conflict");
});

test("resolveCommand: focus scope wins over global; global still works elsewhere", () => {
  const cmds = [...K.KEY_COMMANDS, { id: "inlineEdit", label: "Inline edit", defaults: ["Ctrl+K"], scope: "files-editor" }];
  const b = K.effectiveBindings({}, cmds);
  assert.equal(K.resolveCommand("Ctrl+K", b, [], cmds), "palette");
  assert.equal(K.resolveCommand("Ctrl+K", b, ["files-editor"], cmds), "inlineEdit");
  assert.equal(K.resolveCommand("Ctrl+Shift+P", b, ["files-editor"], cmds), "palette", "falls through to global");
  assert.equal(K.resolveCommand("Ctrl+Q", b, [], cmds), null);
  const rebound = K.effectiveBindings({ quickOpen: ["Ctrl+O"] });
  assert.equal(K.resolveCommand("Ctrl+O", rebound), "quickOpen", "new key works");
  assert.equal(K.resolveCommand("Ctrl+P", rebound), null, "old key no longer does");
});

test("prefs: keys.bindings stores overrides, validates JSON, resets, exports", () => {
  mem.clear();
  P._resetPrefsCache();
  assert.deepEqual(P.getKeyOverrides(), {});
  assert.equal(P.setKeyOverrides({ quickOpen: ["Ctrl+O"] }), true);
  assert.deepEqual(JSON.parse(mem.get(P.PREFS_KEY))["keys.bindings"], JSON.stringify({ quickOpen: ["Ctrl+O"] }));
  P._resetPrefsCache();
  assert.deepEqual(P.getKeyOverrides(), { quickOpen: ["Ctrl+O"] }, "survives reload");
  assert.equal(P.setPref("keys.bindings", "[1,2]"), false, "arrays rejected");
  assert.equal(P.setPref("keys.bindings", "{oops"), false, "bad JSON rejected");
  assert.ok(JSON.parse(P.exportPrefs()).prefs["keys.bindings"].includes("Ctrl+O"));
  P.resetSection("keys");
  assert.deepEqual(P.getKeyOverrides(), {});
  assert.equal(P.prefDef("keys.bindings").hidden, true, "own UI, no generic row");
  assert.ok(P.EXTRA_SETTINGS.some((s) => s.id === "keybindings" && s.section === "keys"));
});

test("wiring: palette dispatches through the keymap; cheat sheet shows effective bindings; App drops its Ctrl+./Ctrl+J", () => {
  const cp = src("src/CommandPalette.tsx");
  assert.match(cp, /resolveCommand\(combo, bindingsRef\.current/);
  assert.match(cp, /firesWhileTyping\(combo\)/);
  assert.match(cp, /closest\?\.\("\[data-keyscope\]"\)/);
  assert.match(cp, /shortcutRows\(bindings\)/);
  assert.doesNotMatch(cp, /const SHORTCUTS/);
  assert.match(cp, /<QuickOpen agent=\{navAgent\}/);
  assert.match(cp, /<FindInFiles agent=\{navAgent\}/);
  const app = src("src/App.tsx");
  assert.doesNotMatch(app, /if \(e\.key === "\."\) toggleFocus\(\)/);
  assert.match(app, /needsYou: openTopNeedsYou/);
  const home = src("src/SettingsHome.tsx");
  assert.match(home, /label: "Keybindings"/);
  assert.match(home, /<KeybindingsEditor \/>/);
  assert.match(src("src/KeybindingsEditor.tsx"), /addEventListener\("keydown", onKey, true\)/, "recorder captures before the dispatcher");
  for (const f of ["src/QuickOpen.tsx", "src/FindInFiles.tsx"]) assert.match(src(f), /setSel\(\(s\) => Math\.max\(0, Math\.min\(/, `${f}: ArrowDown on an empty list stays at 0`);
  assert.match(src("src/QuickOpen.tsx"), /openRightDockTab\("Files", \{ filePath: path, line \}\)/);
});

// ---- quick open / grouping ------------------------------------------------------------------

test("fuzzyScore / rankFiles: subsequence, basename and segment starts win, short paths break ties", () => {
  assert.equal(N.fuzzyScore("src/App.tsx", "xyz"), null);
  assert.ok(N.fuzzyScore("src/FilesPanel.tsx", "fpanel"));
  const files = ["src/FilesPanel.tsx", "docs/PLAN_FILES.md", "src/fileLinks.ts", "test/files-panel.test.mjs", "src/deep/nested/FilesPanelOld.tsx"];
  assert.equal(N.rankFiles(files, "FilesPanel")[0].path, "src/FilesPanel.tsx");
  assert.equal(N.rankFiles(files, "files panel")[0].path, "src/FilesPanel.tsx", "spaces ignored");
  assert.equal(N.rankFiles(files, "filelinks")[0].path, "src/fileLinks.ts");
  assert.equal(N.rankFiles(files, "fp")[0].path, "src/FilesPanel.tsx");
  assert.deepEqual(N.rankFiles(["a/b/c.ts", "z.ts", "a/y.ts"], "").map((h) => h.path), ["z.ts", "a/y.ts", "a/b/c.ts"]);
  assert.equal(N.rankFiles(files, "", 2).length, 2);
  const h = N.fuzzyScore("src/App.tsx", "app");
  assert.deepEqual(h.positions, [4, 5, 6]);
  assert.deepEqual(N.positionRanges(h.positions), [[4, 7]]);
});

test("groupMatches / matchRanges / splitMarked", () => {
  const m = [
    { path: "a.ts", line: 1, col: 1, text: "foo" },
    { path: "b.ts", line: 3, col: 1, text: "foo" },
    { path: "a.ts", line: 9, col: 1, text: "foo" },
  ];
  const g = N.groupMatches(m);
  assert.deepEqual(g.map((x) => [x.path, x.matches.map((y) => y.line)]), [["a.ts", [1, 9]], ["b.ts", [3]]]);
  assert.deepEqual(N.matchRanges("Foo foo", "foo"), [[0, 3], [4, 7]]);
  assert.deepEqual(N.matchRanges("Foo foo", "foo", { caseSensitive: true }), [[4, 7]]);
  assert.deepEqual(N.matchRanges("a1 b22", "\\d+", { regex: true }), [[1, 2], [4, 6]]);
  assert.deepEqual(N.matchRanges("x", "(", { regex: true }), [], "bad regex is harmless");
  assert.deepEqual(N.splitMarked("hello world", [[6, 11]]), [{ text: "hello ", mark: false }, { text: "world", mark: true }]);
});

// ---- server: args, parsing, confinement, a real search ------------------------------------

test("search args are arrays: git grep and rg, literal by default, -e guards a leading dash", () => {
  assert.deepEqual(S.gitGrepArgs({ q: "-rf", regex: false, caseSensitive: false }), ["-c", "core.quotepath=off", "grep", "-n", "-I", "--column", "-z", "--no-color", "--untracked", "-i", "-F", "-e", "-rf", "--"]);
  const re = S.gitGrepArgs({ q: "a.*b", regex: true, caseSensitive: true }, { noIndex: true });
  assert.ok(re.includes("--no-index") && re.includes("--exclude-standard") && re.includes("-E") && !re.includes("-i") && !re.includes("--untracked"));
  const rg = S.rgArgs({ q: "x", regex: false, caseSensitive: false });
  assert.ok(rg.includes("--json") && rg.includes("--fixed-strings") && rg.includes("--ignore-case"));
  assert.deepEqual(rg.slice(-4), ["-e", "x", "--", "."]);
  assert.equal(S.searchOptions(new URLSearchParams("q=")), null);
  assert.equal(S.searchOptions(new URLSearchParams(`q=${"x".repeat(501)}`)), null);
  assert.deepEqual(S.searchOptions(new URLSearchParams("q=foo&regex=1&case=true")), { q: "foo", regex: true, caseSensitive: true });
});

test("output parsing: git grep -z --column, rg --json, line clipping", () => {
  assert.deepEqual(S.parseGitGrepLine("src/a b.ts\u000012\u00005\u0000  const x = 1;"), { path: "src/a b.ts", line: 12, col: 5, text: "  const x = 1;" });
  assert.deepEqual(S.parseGitGrepLine("win\\path.ts\u00001\u00001\u0000x\r"), { path: "win/path.ts", line: 1, col: 1, text: "x" });
  assert.equal(S.parseGitGrepLine("garbage"), null);
  assert.equal(S.parseGitGrepLine("f\u0000zero\u00001\u0000x"), null);
  const long = S.parseGitGrepLine(`f\u00001\u00001\u0000${"y".repeat(500)}`);
  assert.equal(long.text.length, S.SEARCH_MAX_LINE + 1);
  const rg = JSON.stringify({ type: "match", data: { path: { text: "./src/x.ts" }, lines: { text: "hello world\n" }, line_number: 7, submatches: [{ start: 6, end: 11 }] } });
  assert.deepEqual(S.parseRgLine(rg), { path: "src/x.ts", line: 7, col: 7, text: "hello world" });
  assert.equal(S.parseRgLine(JSON.stringify({ type: "begin", data: {} })), null);
  assert.equal(S.parseRgLine("{"), null);
  assert.deepEqual(S.parseLsFiles("a.ts\u0000b/c.ts\u0000a.ts\u0000"), { files: ["a.ts", "b/c.ts"], truncated: false });
  assert.deepEqual(S.parseLsFiles("a\u0000b\u0000c\u0000", 2), { files: ["a", "b"], truncated: true });
});

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "vs-nav-")));
const repo = join(tmp, "repo");
const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
mkdirSync(join(repo, "src"), { recursive: true });
writeFileSync(join(repo, "src", "one.ts"), "const needle = 1;\nconst other = 2;\nNEEDLE again\n");
writeFileSync(join(repo, "two.md"), "no match here\n-dash needle\n");
writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
writeFileSync(join(repo, "ignored.txt"), "needle hidden\n");
git("init", "-q");
git("add", "src/one.ts", ".gitignore"); // two.md stays untracked: --untracked must still find it
test.after(() => rmSync(tmp, { recursive: true, force: true }));

test("confineCwd: absolute existing dir under an allowed root only", () => {
  assert.deepEqual(S.confineCwd(repo, [tmp]), { cwd: repo });
  assert.deepEqual(S.confineCwd(join(repo, "src"), [repo]), { cwd: join(repo, "src") });
  assert.match(S.confineCwd("src", [repo]).error, /absolute/);
  assert.match(S.confineCwd(`${repo}/../repo`, [repo]).error, /\.\./);
  assert.match(S.confineCwd(join(repo, "two.md"), [repo]).error, /not a directory/);
  assert.match(S.confineCwd(join(tmp, "missing"), [tmp]).error, /not a directory/);
  const out = S.confineCwd(tmpdir(), [repo]);
  assert.equal(out.status, 403);
  assert.equal(S.confineCwd("", [repo]).error, "cwd is required");
  assert.match(S.confineCwd("\\\\host\\share\\x", [repo]).error, /UNC/);
  assert.match(S.confineCwd("//host/share", [repo]).error, /UNC/);
});

test("runSearch (git grep): tracked + untracked, honours .gitignore, case, regex, cap", async () => {
  const r = await S.runSearch(repo, { q: "needle", regex: false, caseSensitive: false }, { rg: null });
  assert.equal(r.engine, "git");
  assert.deepEqual(r.matches.map((m) => `${m.path}:${m.line}`).sort(), ["src/one.ts:1", "src/one.ts:3", "two.md:2"]);
  assert.equal(r.matches.find((m) => m.path === "two.md").col, 7);
  const cs = await S.runSearch(repo, { q: "NEEDLE", regex: false, caseSensitive: true }, { rg: null });
  assert.deepEqual(cs.matches.map((m) => m.line), [3]);
  const dash = await S.runSearch(repo, { q: "-dash", regex: false, caseSensitive: false }, { rg: null });
  assert.deepEqual(dash.matches.map((m) => m.path), ["two.md"], "leading dash is a pattern, not a flag");
  const re = await S.runSearch(repo, { q: "const (needle|other)", regex: true, caseSensitive: true }, { rg: null });
  assert.equal(re.matches.length, 2);
  const capped = await S.runSearch(repo, { q: "e", regex: false, caseSensitive: false }, { rg: null, max: 2 });
  assert.equal(capped.matches.length, 2);
  assert.equal(capped.truncated, true);
  const none = await S.runSearch(repo, { q: "zzzz", regex: false, caseSensitive: false }, { rg: null });
  assert.deepEqual([none.matches, none.error], [[], undefined], "exit 1 = no matches, not an error");
  const bad = await S.runSearch(repo, { q: "(", regex: true, caseSensitive: false }, { rg: null });
  assert.ok(bad.error, "a bad regex reports an error");
  const ac = new AbortController();
  ac.abort();
  const aborted = await S.runSearch(repo, { q: "needle", regex: false, caseSensitive: false }, { rg: null, signal: ac.signal });
  assert.deepEqual(aborted.matches, [], "already aborted: nothing is spawned");
});

test("listFiles: git ls-files (tracked + untracked, not ignored) and the walk fallback", () => {
  const r = S.listFiles(repo, { refresh: true });
  assert.equal(r.source, "git");
  assert.deepEqual([...r.files].sort(), [".gitignore", "src/one.ts", "two.md"]);
  const plain = join(tmp, "plain");
  mkdirSync(join(plain, "node_modules", "x"), { recursive: true });
  mkdirSync(join(plain, "lib"), { recursive: true });
  writeFileSync(join(plain, "lib", "a.js"), "");
  writeFileSync(join(plain, "node_modules", "x", "b.js"), "");
  assert.deepEqual(S.walkFiles(plain).files, ["lib/a.js"]);
});

test("handlers: 403 outside roots, 400 without q, JSON results", async () => {
  const call = (handler, url, roots) =>
    new Promise((done) => {
      const res = { on() {}, writableFinished: false };
      handler({ method: "GET", url }, res, roots, (_r, code, body) => done({ code, body }));
    });
  const q = (o) => new URLSearchParams(o).toString();
  assert.equal((await call(S.handleSearch, `/__vibesquad/search?${q({ cwd: repo, q: "needle" })}`, [join(tmp, "elsewhere")])).code, 403);
  assert.equal((await call(S.handleSearch, `/__vibesquad/search?${q({ cwd: repo })}`, [tmp])).code, 400);
  const ok = await call(S.handleSearch, `/__vibesquad/search?${q({ cwd: repo, q: "needle" })}`, [tmp]);
  assert.equal(ok.code, 200);
  assert.ok(ok.body.ok && ok.body.matches.length >= 3);
  let fresh = 0;
  const getter = (f) => (f ? (fresh++, [tmp]) : [join(tmp, "stale")]);
  assert.equal((await call(S.handleSearch, `/__vibesquad/search?${q({ cwd: repo, q: "needle" })}`, getter)).code, 200, "a cached miss rescans once");
  assert.equal(fresh, 1);
  const files = await call(S.handleFileList, `/__vibesquad/files?${q({ cwd: repo })}`, [tmp]);
  assert.equal(files.code, 200);
  assert.ok(files.body.files.includes("src/one.ts"));
  assert.match(src("server/vibesquad-api.mjs"), /case "\/__vibesquad\/search":\s*return handleSearch\(req, res, navRoots\(rootDir, opts\), sendJson\)/);
  assert.doesNotMatch(src("server/file-search.mjs"), /shell:\s*true/);
});

test("S3: /__vibesquad/files and /search are gated reads: loopback without the owner token gets 403 readOnly, owner passes", async () => {
  const api = await import("../server/vibesquad-api.mjs");
  const { ownerHeaders } = await import("./helpers/local-owner.mjs");
  for (const p of S.ADE_GATED_READ_PATHS) assert.equal(api.isGatedRead(p, p), true, p);
  const rootDir = join(import.meta.dirname, "..");
  const srv = createServer(api.createVibesquadMiddleware(rootDir));
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const port = srv.address().port;
  const get = (path, headers = {}) =>
    new Promise((ok, fail) => {
      const r = request({ host: "127.0.0.1", port, path, headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => ok({ status: res.statusCode, json: JSON.parse(body || "{}") }));
      });
      r.on("error", fail);
      r.end();
    });
  try {
    const cwd = encodeURIComponent(rootDir);
    for (const path of [`/__vibesquad/files?cwd=${cwd}`, `/__vibesquad/search?cwd=${cwd}&q=ADE_GATED_READ_PATHS`]) {
      const anon = await get(path);
      assert.equal(anon.status, 403, path);
      assert.equal(anon.json.readOnly, true, path);
      assert.equal(anon.json.files ?? anon.json.matches, undefined, "nothing leaks");
      const owner = await get(path, ownerHeaders());
      assert.equal(owner.status, 200, `${path}: ${JSON.stringify(owner.json).slice(0, 200)}`);
      assert.equal(owner.json.ok, true);
    }
    const owned = await get(`/__vibesquad/search?cwd=${cwd}&q=ADE_GATED_READ_PATHS`, ownerHeaders());
    assert.ok(owned.json.matches.some((m) => m.path === "server/file-search.mjs"));
  } finally {
    await new Promise((ok) => srv.close(ok));
  }
});
