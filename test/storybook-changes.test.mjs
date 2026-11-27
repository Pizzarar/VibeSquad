// V8: changes.mjs (new / changed / gone vs last-seen) + the /changes API routes. Synthetic snapshots; fake repo for the routes.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { makeFakeRepo } from "./storybook-fake-repo.mjs";
import { diffChanges, readSeen, rowIndex, seenRecord, writeSeen } from "../server/storybook/changes.mjs";

const csv = (file, dp, text, line = 1) => ({ id: `csv:${file}:${line}:${dp}`, kind: "line", display: text, source: { path: file, line }, data: { origin: "csv", file, data_path: dp, text, rowClass: "ui" } });
const nat = (id, text) => ({ id, kind: "line", display: text, source: { path: "data/x.json", line: 1 }, data: { origin: "squad", text } });
const snap = (sha, entities, dropped) => ({ project: "efi", sha, ref: "origin/main", generatedAt: "2026-11-27T00:00:00Z", entities, ...(dropped ? { dropped } : {}) });

// ── routes (fake repo) ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb8r-"));
process.env.VIBESQUAD_HOME = path.join(tmp, "home");
const fake = makeFakeRepo();
after(() => { fake.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); });
const { ADAPTERS, buildSnapshot, handleStorybookRoute, clearStorybookCache } = await import("../server/storybook/api.mjs");


test("row key survives csv line shifts (file + data_path)", () => {
  const a = snap("a1", [csv("data/s.json", "x.title", "Hello", 10)]);
  const b = snap("b2", [csv("data/s.json", "x.title", "Hello", 99)]);
  const d = diffChanges(seenRecord(a), b);
  assert.deepEqual([d.counts.new, d.counts.changed, d.counts.gone], [0, 0, 0]);
});

test("new / changed / gone with old+new text, and no-session = first", () => {
  const a = snap("a1", [csv("f.json", "a", "one"), csv("f.json", "b", "two"), nat("squad:x:bark", "bark")]);
  const b = snap("b2", [csv("f.json", "a", "one"), csv("f.json", "b", "two!"), csv("f.json", "c", "three")]);
  assert.equal(diffChanges(null, b).first, true);
  const d = diffChanges(seenRecord(a), b);
  assert.deepEqual(d.changed.map((c) => [c.old, c.new]), [["two", "two!"]]);
  assert.deepEqual(d.new.map((n) => n.text), ["three"]);
  assert.deepEqual(d.gone.map((g) => [g.text, g.reason]), [["bark", "efi"]]);
  assert.deepEqual(d.changedIds.length + d.newIds.length, 2);
  assert.equal(d.from.sha, "a1"); assert.equal(d.to.sha, "b2");
});

test("gone says why: adapter-dropped dev string / twin vs EFI removal", () => {
  const a = snap("a1", [csv("g.gd", "", "DEBUG ok"), nat("squad:x:bark", "bark"), csv("h.json", "z", "gone in EFI")]);
  const b = snap("b2", [], [
    { kind: "line", id: null, origin: "csv", reason: "dev-string", file: "g.gd", data_path: "", text: "DEBUG ok" },
    { kind: "line", id: "squad:x:bark", origin: "squad", reason: "twin" },
  ]);
  const d = diffChanges(seenRecord(a), b);
  const by = Object.fromEntries(d.gone.map((g) => [g.text, g.reason]));
  assert.deepEqual(by, { "DEBUG ok": "dev-string", bark: "twin", "gone in EFI": "efi" });
  assert.deepEqual(d.counts.goneBy, { "dev-string": 1, twin: 1, efi: 1 });
});

test("a moved row (same file + text, new key) is not new+gone; an edited keyless gd row at the same line is changed", () => {
  const a = snap("a1", [csv("f.json", "old.path", "same"), csv("s.gd", "", "Build now", 14)]);
  const b = snap("b2", [csv("f.json", "new.path", "same"), csv("s.gd", "", "Build later", 14)]);
  const d = diffChanges(seenRecord(a), b);
  assert.deepEqual([d.counts.new, d.counts.changed, d.counts.gone], [0, 1, 0]);
  assert.deepEqual([d.changed[0].old, d.changed[0].new], ["Build now", "Build later"]);
});

test("duplicate keys get stable #n suffixes", () => {
  const idx = rowIndex(snap("a", [csv("f.json", "a", "x", 1), csv("f.json", "a", "y", 2)]));
  assert.deepEqual([...idx.keys()], ["csv|f.json|a", "csv|f.json|a#2"]);
});

test("seen store: read/write per project under the given home", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sb8-"));
  try {
    assert.equal(readSeen("efi", { home }), null);
    const rec = seenRecord(snap("a1", [csv("f.json", "a", "one")]));
    writeSeen("efi", rec, { home });
    assert.equal(readSeen("efi", { home }).sha, "a1");
    assert.equal(readSeen("other", { home }), null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

function call(method, url, body, deps) {
  return new Promise((resolve) => {
    const req = new PassThrough(); req.method = method; req.url = url;
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { resolve({ status: this.statusCode, body: JSON.parse(b) }); } };
    assert.equal(handleStorybookRoute(req, res, deps), true);
    if (body != null) req.write(JSON.stringify(body));
    req.end();
  });
}

test("routes: GET first session, POST seen (explicit), GET again = nothing new; stale sha -> 409", async () => {
  clearStorybookCache();
  const deps = { teams: [{ id: "efi", paths: ["fake-efi"] }], resolvePath: (p) => (p === "fake-efi" ? fake.clone : null), runChecks: async () => [], seenHome: path.join(tmp, "seen") };
  const g1 = await call("GET", "/api/storybook/efi/changes", null, deps);
  assert.equal(g1.status, 200, JSON.stringify(g1.body)); assert.equal(g1.body.first, true);
  assert.equal(readSeen("efi", { home: deps.seenHome }), null); // loading never marks seen
  assert.equal((await call("POST", "/api/storybook/efi/changes/seen", { sha: "deadbeef" }, deps)).status, 409);
  assert.equal((await call("POST", "/api/storybook/efi/changes/seen", {}, deps)).status, 400);
  const p = await call("POST", "/api/storybook/efi/changes/seen", { sha: fake.sha.slice(0, 10) }, deps);
  assert.equal(p.status, 200); assert.equal(p.body.sha, fake.sha);
  const g2 = await call("GET", "/api/storybook/efi/changes", null, deps);
  assert.equal(g2.body.first, false); assert.equal(g2.body.sameSha, true);
  assert.equal((await call("PUT", "/api/storybook/efi/changes", null, deps)).status, 405);
});

test("view logic: wordDiff, goneBreakdown, signalCard counts equal what the click opens", async () => {
  const L = await import("../src/storybookLogic.ts");
  const R = await import("../src/storybookReview.ts");
  assert.deepEqual(R.wordDiff("a b c", "a x c").map((g) => [g.k, g.t.trim()]), [["same", "a"], ["del", "b"], ["add", "x"], ["same", "c"]]);
  assert.match(L.goneBreakdown({ counts: { goneBy: { "dev-string": 181, twin: 108, efi: 0 } } }), /181 dev.*108 duplicates merged|181 dev.*108 duplicate/);
  const it = (check, category) => ({ key: check + Math.random(), category, check, severity: "warn", msg: "", entityRef: null, source: null });
  const items = [it("#1", "broken"), it("#7", "inconsistent"), it("#14", "inconsistent"), it("#4", "inconsistent"), it("#15", "missing"), { ...it(null, "unreviewed") }];
  const audit = { coverage: 5, integrity: 4, cohesion: 3, signoff: 9 };
  const c = Object.fromEntries(["integrity", "cohesion", "coverage", "signoff"].map((s) => [s, L.signalCard(s, items, audit)]));
  assert.equal(c.integrity.n, 3); assert.equal(c.integrity.rest, 1); assert.deepEqual(c.integrity.target.checks, L.SIGNAL_CHECKS.integrity);
  assert.equal(c.cohesion.n, 1); assert.equal(c.coverage.n, 1); assert.equal(c.coverage.rest, 4);
  assert.equal(c.signoff.n, 1); assert.equal(c.signoff.target.tab, "review");
});

test("buildSnapshot keeps adapter dropped list non-enumerable (server-only, not in JSON)", async () => {
  clearStorybookCache();
  const dropped = [{ kind: "line", id: null, origin: "csv", reason: "dev-string", file: "g.gd", data_path: "", text: "DEBUG" }];
  const adapter = {
    ...ADAPTERS.efi,
    load: async () => ({ entities: [csv("f.json", "a", "one")], warnings: [], dropped }),
  };
  const s = await buildSnapshot("efi", {
    teams: [{ id: "efi", paths: ["fake-efi"] }],
    adapters: { efi: adapter },
    resolvePath: (p) => (p === "fake-efi" ? fake.clone : null),
    runChecks: async () => [],
  });
  assert.equal(Object.keys(s).includes("dropped"), false);
  assert.equal("dropped" in JSON.parse(JSON.stringify(s)), false);
  assert.deepEqual(s.dropped, dropped);
});

test("goneAtLine pairs keyless gd rows only; keyed native/csv rows on the same line stay gone + new", () => {
  const a = snap("a1", [
    nat("squad:doc:flaw", "Hates needles"),
    csv("data/squad.json", "members.doc.note", "Old note", 42),
    csv("scripts/ui.gd", "", "Build now", 14),
  ]);
  const b = snap("b2", [
    nat("squad:doc:synergy", "Works well with Popper"),
    csv("data/squad.json", "members.doc.tag", "New tag", 42),
    csv("scripts/ui.gd", "", "Build later", 14),
  ]);
  const d = diffChanges(seenRecord(a), b);
  assert.deepEqual([d.counts.new, d.counts.changed, d.counts.gone], [2, 1, 2]);
  assert.deepEqual(d.changed.map((c) => [c.old, c.new]), [["Build now", "Build later"]]);
  assert.deepEqual(d.new.map((r) => r.text).sort(), ["New tag", "Works well with Popper"]);
  assert.deepEqual(d.gone.map((r) => r.text).sort(), ["Hates needles", "Old note"]);
});

test("buildTextChanges + isRowChanged include all changedIds past the 500-row sample cap", async () => {
  const L = await import("../src/storybookLogic.ts");
  const aEnts = Array.from({ length: 5 }, (_, i) => csv("f.json", `k${i}`, `old ${i}`, i + 1));
  const bEnts = [
    ...Array.from({ length: 5 }, (_, i) => csv("f.json", `k${i}`, `new ${i}`, i + 1)),
    csv("f.json", "k5", "brand new", 6),
  ];
  const d = diffChanges(seenRecord(snap("a1", aEnts)), snap("b2", bEnts), { cap: 2 });
  assert.equal(d.counts.changed, 5);
  assert.equal(d.changed.length, 2);
  assert.equal(d.changedIds.length, 5);
  const tc = L.buildTextChanges(d);
  assert.ok(tc);
  assert.equal(Object.keys(tc.changed).length, 2);
  assert.equal(tc.changedIds.size, 5);
  const matched = bEnts.filter((e) => L.isRowChanged(L.entityKey("line", e.id), tc));
  assert.equal(matched.length, d.counts.changed + d.counts.new);
});

test("V8 UI/CSS regressions: gone preview cap matches summary, no --sb-dim, 44px summary, real checks button, changesSeq guard", () => {
  const home = fs.readFileSync(new URL("../src/StorybookHome.tsx", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../src/storybook.css", import.meta.url), "utf8");
  const view = fs.readFileSync(new URL("../src/StorybookView.tsx", import.meta.url), "utf8");
  assert.match(home, /const shownGone = ch\.gone\.slice\(0, GONE_PREVIEW_CAP\)/);
  assert.match(home, /first \$\{shownGone\.length\} of \$\{ch\.counts\.gone\}/);
  assert.ok(!css.includes("--sb-dim"), "no undefined --sb-dim token in storybook.css");
  assert.match(css, /\.sb-changes-gonelist summary\s*\{[^}]*min-height:\s*44px/);
  assert.match(view, /<button type="button" className="sb-fbtn"[^>]*data-testid="sb-checks-chip"[^>]*onClick=\{\(\) => clearChecks\?\.\(\)\}/);
  assert.match(view, /const changesSeq = useRef\(0\)/);
  assert.match(view, /if \(changesSeq\.current !== my\) return;/);
  assert.match(view, /changesSeq\.current\+\+;\s*setChanges\(null\);/);
});
