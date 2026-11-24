// SB4: Storybook API (buildSnapshot, routes, auth guard) + `vs storybook check`. Fake repo only; never the real project repo.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { makeFakeRepo, git } from "./storybook-fake-repo.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb4-"));
process.env.VIBESQUAD_HOME = path.join(tmp, "home"); // fetch stamps live here, never the real home
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
delete process.env.VIBESQUAD_TEAMS_FILE;
const fake = makeFakeRepo();
after(() => { fake.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); });

const { buildSnapshot, buildSnapshotDetailed, clearStorybookCache, resolveProject, summaryLine } = await import("../server/storybook/api.mjs");
const { validateSnapshot } = await import("../server/storybook/schema.mjs");
const { commandStorybook } = await import("../cli/vs.mjs");
const { createVibesquadMiddleware } = await import("../server/vibesquad-api.mjs");
const { localTokenHeaders } = await import("../server/local-token.mjs");
const { getLocalToken } = await import("../server/auth.mjs");
getLocalToken(); // mints the owner token under the temp VIBESQUAD_HOME

const teams = [{ id: "efi", paths: ["nope-dir", "fake-efi"] }, { id: "other", paths: ["x"] }];
const resolvePath = (p) => (p === "fake-efi" ? fake.clone : null);
const mkChecks = (findings) => { const f = async () => { f.calls++; return findings; }; f.calls = 0; return f; };
const FIND = [
  { check: "#2", severity: "error", entityRef: null, msg: "a", source: null },
  { check: "#2", severity: "warn", entityRef: null, msg: "b", source: null },
  { check: "#10", severity: "info", entityRef: null, msg: "c", source: null },
];
const deps = (extra = {}) => ({ teams, resolvePath, runChecks: mkChecks(FIND), ...extra });

test("resolveProject: team.paths -> repo; unknown / adapter-less team -> null", async () => {
  assert.equal((await resolveProject("efi", { teams, resolvePath })).repoPath, fake.clone);
  assert.equal(await resolveProject("other", { teams, resolvePath }), null); // no adapter
  assert.equal(await resolveProject("nope", { teams, resolvePath }), null);
  assert.equal(await resolveProject("efi", { teams: [{ id: "efi", paths: ["zzz"] }], resolvePath }), null); // path does not resolve
});

test("buildSnapshot: valid snapshot at origin/<default> sha with findings filled", async () => {
  clearStorybookCache();
  const d = deps();
  const snap = await buildSnapshot("efi", d);
  assert.equal(snap.sha, fake.sha);
  assert.equal(snap.ref, "origin/main");
  assert.equal(snap.findings.length, 3);
  assert.deepEqual(validateSnapshot(snap), { ok: true, errors: [] });
  assert.equal(d.runChecks.calls, 1);
});

test("cache hit per sha; new sha rebuilds", async () => {
  clearStorybookCache();
  const d = deps();
  const a = await buildSnapshot("efi", d);
  const b = await buildSnapshot("efi", d);
  assert.equal(a, b);
  assert.equal(d.runChecks.calls, 1);
  fs.writeFileSync(path.join(fake.origin, "NEW.txt"), "x");
  git(fake.origin, "add", "-A"); git(fake.origin, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "two");
  git(fake.clone, "fetch", "-q", "origin");
  const c = await buildSnapshot("efi", d);
  assert.notEqual(c.sha, a.sha);
  assert.equal(d.runChecks.calls, 2);
});

test("coalescing: concurrent builds for one project run the adapter once", async () => {
  clearStorybookCache();
  let release; const gate = new Promise((r) => { release = r; });
  const slow = async () => { slow.calls++; await gate; return []; }; slow.calls = 0;
  const d = deps({ runChecks: slow });
  const ps = [buildSnapshot("efi", d), buildSnapshot("efi", d), buildSnapshot("efi", d)];
  await new Promise((r) => setTimeout(r, 300));
  release();
  const [a, b, c] = await Promise.all(ps);
  assert.equal(slow.calls, 1);
  assert.equal(a, b); assert.equal(b, c);
});

test("runChecks missing module -> findings [] + warning; throwing checks -> warning, no crash", async () => {
  clearStorybookCache();
  // no injected runChecks: ./checks/index.mjs may or may not exist on this branch
  const snap = await buildSnapshot("efi", { teams, resolvePath });
  assert.ok(Array.isArray(snap.findings));
  clearStorybookCache();
  const boom = await buildSnapshot("efi", deps({ runChecks: async () => { throw new Error("kaput"); } }));
  assert.deepEqual(boom.findings, []);
  assert.ok(boom.warnings.some((w) => /checks failed: kaput/.test(w)));
});

test("refresh: fetch rate-limited to once per hour, then rebuilds", async () => {
  clearStorybookCache();
  const home = path.join(tmp, "stamp-home");
  const d = deps({ fetchOpts: { home } });
  const r1 = await buildSnapshotDetailed("efi", { ...d, refresh: true });
  assert.equal(r1.fetch.fetched, true);
  assert.ok(Date.parse(r1.fetch.nextFetchAt) > Date.now() + 59 * 60 * 1000);
  const r2 = await buildSnapshotDetailed("efi", { ...d, refresh: true });
  assert.equal(r2.fetch.fetched, false);
  assert.equal(r2.fetch.skipped, "rate-limited");
  assert.equal(r2.fetch.nextFetchAt, r1.fetch.nextFetchAt);
  assert.equal(r2.snapshot.sha, r1.snapshot.sha);
});

test("summaryLine + CLI: line format, --json shape, usage exit 2, report-only exit 0", async () => {
  clearStorybookCache();
  const snap = await buildSnapshot("efi", deps());
  assert.equal(summaryLine(snap), `[STORYBOOK] sha=${snap.sha.slice(0, 8)} #2=2 #10=1 total=3`);
  assert.equal(summaryLine({ sha: "abcdef1234", findings: [] }), "[STORYBOOK] sha=abcdef12 total=0");
  const run = async (flags, build) => { let o = "", e = ""; const code = await commandStorybook(flags, { out: (s) => { o += s; }, err: (s) => { e += s; }, build }); return { code, o, e }; };
  const ok = await run({ _: ["check", "efi"] }, async () => snap);
  assert.deepEqual([ok.code, ok.o], [0, `[STORYBOOK] sha=${snap.sha.slice(0, 8)} #2=2 #10=1 total=3\n`]);
  const js = await run({ _: ["check", "efi"], json: true }, async () => snap);
  const parsed = JSON.parse(js.o);
  assert.equal(js.code, 0);
  assert.deepEqual(Object.keys(parsed), ["schemaVersion", "project", "ref", "sha", "generatedAt", "entities", "findings", "warnings"]);
  assert.equal(parsed.findings.length, 3);
  assert.equal((await run({ _: [] })).code, 2);
  assert.equal((await run({ _: ["check"] })).code, 2);
  assert.equal((await run({ _: ["check", "a", "b"] })).code, 2);
  assert.equal((await run({ _: ["bogus", "efi"] })).code, 2);
  const bad = await run({ _: ["check", "nope"] }, async () => { throw new Error("unknown storybook project: nope"); });
  assert.equal(bad.code, 0);
  assert.match(bad.e, /unknown storybook project/);
});

// ---- HTTP: routes behind the real VS API middleware (the auth guard serve.mjs sits behind) ----
const ROOT = path.join(tmp, "root");
fs.mkdirSync(ROOT);
fs.writeFileSync(path.join(ROOT, "teams.json"), JSON.stringify({ teams: [{ id: "sq", name: "Sq", paths: [], lanes: [] }] }));
const mw = createVibesquadMiddleware(ROOT, { storybook: deps({ fetchOpts: { home: path.join(tmp, "http-home") } }) }); // L3: routes live inside the middleware
const srv = http.createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end("no"); }));
const port = await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
after(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
const call = (method, url, headers = {}) => new Promise((resolve, reject) => {
  const rq = http.request({ host: "127.0.0.1", port, method, path: url, headers }, (res) => {
    let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, body: b }));
  });
  rq.on("error", reject); rq.end();
});

test("HTTP GET /api/storybook/:project -> snapshot; unknown project -> 404 {error}", async () => {
  clearStorybookCache();
  const ok = await call("GET", "/api/storybook/efi");
  assert.equal(ok.status, 200);
  assert.match(JSON.parse(ok.body).sha, /^[0-9a-f]{40}$/);
  assert.equal(JSON.parse(ok.body).findings.length, 3);
  const none = await call("GET", "/api/storybook/nope");
  assert.equal(none.status, 404);
  assert.match(JSON.parse(none.body).error, /unknown storybook project/);
  assert.equal((await call("GET", "/api/storybook/other")).status, 404); // team without adapter
});

test("HTTP POST refresh -> snapshot + {fetched,nextFetchAt}; wrong method 405", async () => {
  clearStorybookCache();
  const r = JSON.parse((await call("POST", "/api/storybook/efi/refresh", localTokenHeaders())).body);
  assert.equal(typeof r.fetched, "boolean");
  assert.ok(r.nextFetchAt);
  assert.equal(r.findings.length, 3);
  assert.equal((await call("GET", "/api/storybook/efi/refresh")).status, 405);
  assert.equal((await call("POST", "/api/storybook/efi", localTokenHeaders())).status, 405);
});

test("auth: refresh (a write) needs the owner; a trusted non-owner gets the read-only refusal", async () => {
  const r = await call("POST", "/api/storybook/efi/refresh");
  assert.equal(r.status, 403);
  assert.doesNotMatch(r.body, /entities/);
});

test("auth: an untrusted (non-loopback Host) caller is refused on both routes, no snapshot leaks", async () => {
  clearStorybookCache();
  for (const [m, u] of [["GET", "/api/storybook/efi"], ["POST", "/api/storybook/efi/refresh"]]) {
    const r = await call(m, u, { host: "evil.example" });
    assert.ok([401, 403].includes(r.status), `${m} ${u} -> ${r.status}`);
    assert.doesNotMatch(r.body, /entities/);
  }
});

test("REAL checks/index.mjs runs against the fake repo (findings non-empty, signature runChecks(snap, adapter, {reader}))", async () => {
  clearStorybookCache();
  const snap = await buildSnapshot("efi", { teams, resolvePath });
  assert.ok(snap.findings.length > 0, "real runChecks produced findings");
  assert.ok(!snap.warnings.some((w) => /checks (failed|module)/.test(w)), snap.warnings.join("|"));
  assert.ok(snap.findings.some((f) => f.check === "#8"), `check ids: ${[...new Set(snap.findings.map((f) => f.check))]}`);
});

test("M1: a 404 for an unresolvable ref carries no host path", async () => {
  clearStorybookCache();
  const bare = fs.mkdtempSync(path.join(tmp, "bare-"));
  git(bare, "init", "-q");
  const warns = []; const w = console.warn; console.warn = (m) => warns.push(String(m));
  try {
    await assert.rejects(buildSnapshot("efi", { teams, resolvePath: () => bare, runChecks: mkChecks([]) }), (e) => {
      assert.equal(e.status, 404);
      assert.doesNotMatch(e.message, /\//);
      assert.match(e.message, /ref not resolvable/);
      return true;
    });
  } finally { console.warn = w; }
  assert.ok(warns.some((m) => m.includes(bare) || /cannot resolve/.test(m)), "detail logged server-side");
});

test("M2: a refresh never skips fetchRepo by joining a plain build that a third caller restarted", async () => {
  clearStorybookCache();
  let release; const gate = new Promise((r) => { release = r; });
  let fetches = 0;
  const fetchRepo = async () => { fetches++; return { fetched: true, nextAllowedAt: Date.now() + 3600e3 }; };
  const slow = async () => { await gate; return []; };
  const d = { teams, resolvePath, runChecks: slow, fetchRepo };
  const p1 = buildSnapshotDetailed("efi", d); // plain, in flight
  let p3;
  p1.then(() => { p3 = buildSnapshotDetailed("efi", { ...d, runChecks: async () => [] }); }); // registered before the refresh waiter: starts a new plain build the instant p1 settles
  const r = buildSnapshotDetailed("efi", { ...d, refresh: true });
  release();
  const [, rr] = await Promise.all([p1, r]);
  await p3;
  assert.equal(fetches, 1, "refresh ran fetchRepo exactly once");
  assert.equal(rr.fetch?.fetched, true);
});
