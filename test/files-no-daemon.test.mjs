import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsList, fsRead, resolveInCwd, resolveBareName, handleFsRead, handleFsList, handleFsResolve } from "../server/file-search.mjs";
import { lookupBareName, isBareNameCandidate, _resetBareNames } from "../src/fileLinks.ts";
import { vsReadFile, vsListDirectory, VsFilesError } from "../src/vsFiles.ts";

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 1, 2]);

const root = realpathSync(mkdtempSync(join(tmpdir(), "vs-fs-")));
const outside = realpathSync(mkdtempSync(join(tmpdir(), "vs-out-")));
mkdirSync(join(root, "docs/art"), { recursive: true });
mkdirSync(join(root, ".git"));
writeFileSync(join(root, "docs/art/pingrid-menu-500.png"), PNG);
writeFileSync(join(root, "README.md"), "hi");
writeFileSync(join(root, ".git/config"), "secret");
writeFileSync(join(outside, "secret.txt"), "nope");
let linked = true;
try { symlinkSync(outside, join(root, "escape"), "junction"); } catch { linked = false; }

test("list works with no daemon: dirs first, .git hidden", () => {
  const r = fsList(root, "");
  assert.deepEqual(r.entries.map((e) => e.name).filter((n) => n !== "escape"), ["docs", "README.md"]);
  assert.ok(!r.entries.some((e) => e.name === ".git"));
  assert.equal(fsList(root, "docs/art").entries[0].path, "docs/art/pingrid-menu-500.png");
});

test("read returns exact binary bytes + image mime", () => {
  const r = fsRead(root, "docs/art/pingrid-menu-500.png");
  assert.deepEqual([...r.bytes], [...PNG]);
  assert.equal(r.mime, "image/png");
  assert.equal(fsRead(root, "README.md").bytes.toString(), "hi");
});

test("path confinement: absolute, traversal, drive, ~, .git, symlink escape", () => {
  for (const bad of ["/etc/passwd", "../x", "docs/../../x", "C:\Windows\win.ini", "~/x", "\\host\share\a"]) {
    const r = fsRead(root, bad);
    assert.ok(r.error, bad);
    assert.ok([400, 403, 404].includes(r.status), bad);
  }
  assert.equal(fsRead(root, ".git/config").status, 404);
  assert.equal(resolveInCwd(root, "nope.txt").status, 404);
  if (linked) assert.equal(fsRead(root, "escape/secret.txt").status, 403);
});

test("size cap returns 413", () => {
  assert.equal(fsRead(root, "docs/art/pingrid-menu-500.png", 3).status, 413);
});

test("bare-name resolution is unique-or-nothing", () => {
  const files = ["docs/art/a.png", "src/a.png", "docs/b.png", "README.md"];
  assert.equal(resolveBareName(files, "b.png").path, "docs/b.png");
  assert.equal(resolveBareName(files, "a.png").path, null);
  assert.equal(resolveBareName(files, "a.png").count, 2);
  assert.equal(resolveBareName(files, "zzz.png").path, null);
  assert.equal(resolveBareName(files, "docs/b.png").path, null);
  assert.ok(isBareNameCandidate("pingrid-menu-500.png"));
  assert.ok(!isBareNameCandidate("e.g"));
  assert.ok(!isBareNameCandidate("docs/x.png"));
});

const mkRes = () => {
  const r = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
  return r;
};
const sendJson = (res, code, data) => { res.statusCode = code; res.body = JSON.stringify(data); };

test("HTTP handlers serve confined reads and resolve a bare name end to end", async () => {
  const url = (p, q) => ({ method: "GET", url: `${p}?${new URLSearchParams(q)}` });
  let res = mkRes();
  handleFsRead(url("/x", { cwd: root, path: "docs/art/pingrid-menu-500.png" }), res, [root], sendJson);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/png");
  assert.deepEqual([...res.body], [...PNG]);
  res = mkRes();
  handleFsRead(url("/x", { cwd: root, path: "../etc" }), res, [root], sendJson);
  assert.equal(res.statusCode, 400);
  res = mkRes();
  handleFsRead(url("/x", { cwd: outside, path: "secret.txt" }), res, [root], sendJson);
  assert.equal(res.statusCode, 403);
  res = mkRes();
  handleFsList(url("/x", { cwd: root, path: "" }), res, [root], sendJson);
  assert.equal(JSON.parse(res.body).ok, true);
  res = mkRes();
  await handleFsResolve(url("/x", { agentId: "a1", name: "README.md" }), res, () => root, sendJson);
  assert.equal(JSON.parse(res.body).path, "README.md");
});

test("client: backend unreachable → 'Can't read files', not 'File not found'", async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
    await assert.rejects(vsReadFile("/r", "a.png"), (e) => e instanceof VsFilesError && !e.notFound && /^Can't read files: fetch failed/.test(e.message));
    await assert.rejects(vsListDirectory("/r", ""), (e) => /^Can't read files:/.test(e.message));
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404 });
    await assert.rejects(vsReadFile("/r", "a.png"), (e) => e.notFound === true);
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: "cwd is not a known agent or team path" }), { status: 403 });
    await assert.rejects(vsReadFile("/r", "a.png"), (e) => !e.notFound && /Can't read files: cwd is not a known/.test(e.message));
    globalThis.fetch = async () => new Response(PNG, { status: 200, headers: { "content-type": "image/png", "x-vs-size": "8" } });
    const ok = await vsReadFile("/r", "a.png");
    assert.equal(ok.mime, "image/png");
    assert.deepEqual([...ok.bytes], [...PNG]);
  } finally { globalThis.fetch = real; }
});

test("client: bare name links only when the server returns exactly one path", async () => {
  _resetBareNames();
  const fake = (path) => async () => ({ json: async () => ({ ok: true, path }) });
  assert.equal(lookupBareName("ag", "pingrid-menu-500.png", fake("docs/art/pingrid-menu-500.png")), undefined);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(lookupBareName("ag", "pingrid-menu-500.png"), "docs/art/pingrid-menu-500.png");
  lookupBareName("ag", "dup.png", fake(null));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(lookupBareName("ag", "dup.png"), null);
  assert.equal(lookupBareName("ag", "e.g"), null);
});

test("wiring: Files dock uses the VS server, file links don't select the message", () => {
  const fp = src("src/FilesPanel.tsx");
  assert.ok(!/daemonClient\.(readFile|listDirectory)/.test(fp));
  assert.match(fp, /data-testid="files-read-error"/);
  assert.match(fp, /data-testid="files-tree-error"/);
  assert.match(src("src/Timeline.tsx"), /classList\?\.contains\("tl-file-link"\)\) names\.push\("\.tl-actions"\)/);
});

// ── runner (rn-) agents + junction escape + gate ─────────────────────────────────────────────
import { agentCwdFor, isGatedRead } from "../server/vibesquad-api.mjs";
import { mkdtempSync as mk } from "node:fs";

test("agentCwdFor: rn- id resolves via the runner record (API first, then its on-disk log), then root", async () => {
  const repoRoot = join(root, "repo-root");
  const wt = join(root, "wt-lane");
  // 1. live runner API wins
  const fake = { fetchAgent: async (id) => ({ agent: { id, cwd: wt } }) };
  assert.equal(await agentCwdFor("rn-abc123", repoRoot, { runner: fake }), wt);
  // 2. runner API down → on-disk runner log (VIBESQUAD_HOME/runner/agents/<id>.jsonl)
  const home = mk(join(tmpdir(), "vs-home-"));
  mkdirSync(join(home, "runner/agents"), { recursive: true });
  writeFileSync(join(home, "runner/agents/rn-disk1.jsonl"), JSON.stringify({ type: "created", ts: 1, provider: "p", model: "m", cwd: wt, meta: {} }) + "\n");
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = home;
  try {
    const down = { fetchAgent: async () => { throw new Error("RUNNER_DOWN"); } };
    assert.equal(await agentCwdFor("rn-disk1", repoRoot, { runner: down }), wt);
    // 3. unknown rn- id and malformed ids fall back to the repo root
    assert.equal(await agentCwdFor("rn-nope", repoRoot, { runner: down }), repoRoot);
    assert.equal(await agentCwdFor("../evil", repoRoot, { runner: down }), repoRoot);
  } finally {
    if (prev === undefined) delete process.env.VIBESQUAD_HOME; else process.env.VIBESQUAD_HOME = prev;
  }
});

test("fs/resolve uses the runner agent's worktree, not the repo root", async () => {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "vs-wt-")));
  writeFileSync(join(wt, "only-in-worktree.png"), PNG);
  const res = mkRes();
  await handleFsResolve({ method: "GET", url: "/x?agentId=rn-abc123&name=only-in-worktree.png" }, res, (id) => agentCwdFor(id, root, { runner: { fetchAgent: async () => ({ agent: { cwd: wt } }) } }), sendJson);
  assert.equal(JSON.parse(res.body).path, "only-in-worktree.png");
});

test("junction/symlink escape (worktree node_modules) is blocked for read, list and nested paths", () => {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "vs-wt2-")));
  writeFileSync(join(outside, "stolen.txt"), "x");
  mkdirSync(join(outside, "pkg"), { recursive: true });
  writeFileSync(join(outside, "pkg/a.js"), "x");
  let ok = true;
  try { symlinkSync(outside, join(wt, "node_modules"), "junction"); } catch { ok = false; }
  if (!ok) return;
  assert.equal(fsRead(wt, "node_modules/stolen.txt").status, 403);
  assert.equal(fsRead(wt, "node_modules/pkg/a.js").status, 403);
  assert.equal(fsList(wt, "node_modules").status, 403);
  assert.equal(fsList(wt, "node_modules/pkg").status, 403);
});

test("new routes sit behind the same owner gate as the other /__vibesquad file reads", () => {
  for (const p of ["/__vibesquad/fs/list", "/__vibesquad/fs/read", "/__vibesquad/fs/resolve", "/__vibesquad/files"]) {
    assert.equal(isGatedRead(p, p), true, p);
  }
});
