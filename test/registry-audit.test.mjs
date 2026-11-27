// F2: 4-signal audit contract. Shape validator, the SB2/SB3/SB7 check id -> signal mapping, coverage findings
// (entities missing text/lore), signoff (asset status), and the runAudit wiring over the fake repo.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as audit from "../server/registry/audit.mjs";
import { makeSnapshot, entity } from "../server/registry/index.mjs";
import { runAudit, runChecks } from "../server/storybook/checks/index.mjs";
import { makeFakeRepo } from "./storybook-fake-repo.mjs";
import { makeReader } from "../server/storybook/git-read.mjs";
import { efiAdapter } from "../server/storybook/adapters/efi.mjs";
import { loadSnapshot } from "../server/storybook/adapter.mjs";

const src = { path: "data/x.json", line: 3 };

test("SIGNALS + CHECK_SIGNALS: every check id maps, integrity/cohesion/signoff split is exact", () => {
  assert.deepEqual(audit.SIGNALS, ["coverage", "integrity", "cohesion", "signoff"]);
  assert.deepEqual(Object.keys(audit.CHECK_SIGNALS).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))), [...Array.from({ length: 12 }, (_, i) => `#${i + 1}`), "#18"]);
  for (const id of ["#1", "#2", "#5", "#7"]) assert.equal(audit.CHECK_SIGNALS[id], "integrity", id);
  for (const id of ["#3", "#4", "#6", "#9", "#10", "#11", "#12", "#18"]) assert.equal(audit.CHECK_SIGNALS[id], "cohesion", id);
  assert.equal(audit.CHECK_SIGNALS["#8"], "signoff");
});

test("validateAuditFinding: good + each bad field", () => {
  const ok = audit.makeAuditFinding({ signal: "integrity", severity: "error", entityId: "efi:trader:doc", lane: "storybook", msg: "dangling", source: src });
  assert.deepEqual(ok, { signal: "integrity", severity: "error", entityId: "efi:trader:doc", lane: "storybook", msg: "dangling", source: src });
  assert.deepEqual(audit.validateAuditFinding(ok), { ok: true, errors: [] });
  assert.equal(audit.validateAuditFinding({ ...ok, entityId: null, lane: null, source: null }).ok, true);
  assert.equal(audit.validateAuditFinding({ ...ok, signal: "nope" }).ok, false);
  assert.equal(audit.validateAuditFinding({ ...ok, severity: "fatal" }).ok, false);
  assert.equal(audit.validateAuditFinding({ ...ok, entityId: "not-a-studio-id" }).ok, false);
  assert.equal(audit.validateAuditFinding({ ...ok, lane: "" }).ok, false);
  assert.equal(audit.validateAuditFinding({ ...ok, msg: "" }).ok, false);
  assert.equal(audit.validateAuditFinding({ ...ok, source: { path: "", line: 1 } }).ok, false);
  assert.equal(audit.validateAuditFinding(null).ok, false);
  assert.throws(() => audit.makeAuditFinding({ signal: "nope", severity: "error", msg: "x" }), /signal/);
  assert.throws(() => audit.makeAuditFinding({ signal: "integrity", severity: "fatal", msg: "x" }), /severity/);
});

test("auditFromFinding maps a storybook finding onto the shape (entityId + emitting lane)", () => {
  const f = audit.auditFromFinding({ check: "#1", severity: "error", entityRef: { kind: "quest_step", id: "popper_1" }, msg: "dangling", source: src }, { project: "efi", lane: "storybook" });
  assert.deepEqual(f, { signal: "integrity", severity: "error", entityId: "efi:quest_step:popper_1", lane: "storybook", msg: "dangling", source: src });
  const none = audit.auditFromFinding({ check: "#8", severity: "info", entityRef: null, msg: "comment", source: src }, { project: "efi", lane: "storybook" });
  assert.equal(none.entityId, null);
  assert.equal(none.signal, "signoff");
  assert.equal(none.lane, "storybook");
  // an id that itself contains colons stays whole in the studio id
  const line = audit.auditFromFinding({ check: "#4", severity: "info", entityRef: { kind: "line", id: "rel:doc:friendly" }, msg: "m", source: null }, { project: "efi", lane: "storybook" });
  assert.equal(line.entityId, "efi:line:rel:doc:friendly");
  assert.throws(() => audit.auditFromFinding({ check: "#99", severity: "info", entityRef: null, msg: "x", source: null }, { project: "efi" }), /no signal/);
});

test("coverageFindings flags entities whose text/lore slot is missing (per-kind slot lists)", () => {
  const snap = makeSnapshot({
    project: "efi", ref: "origin/main", sha: "abcdef1234",
    entities: [
      entity({ id: "popper", kind: "trader", display: "Popper", source: src, production: "missing" }),
      { ...entity({ id: "doc", kind: "trader", display: "Doc", source: src }), productionSlots: { text: "missing" } },
      entity({ id: "scav", kind: "enemy", display: "Scav", source: src, data: { boss: false } }), // no production -> not missing
      entity({ id: "p1", kind: "quest_step", display: "T", source: src, production: "placeholder", data: { trader: "popper", task: {} } }), // placeholder -> not coverage
    ],
  });
  const out = audit.coverageFindings(snap, { lane: "storybook" });
  assert.deepEqual(out.map((f) => f.entityId).sort(), ["efi:trader:doc", "efi:trader:popper"]);
  for (const f of out) {
    assert.equal(f.signal, "coverage");
    assert.equal(f.severity, "warn");
    assert.equal(f.lane, "storybook");
    assert.match(f.msg, /missing its text slot/);
  }
  // a reserved kind with no text/lore slot (art_slot) never emits coverage, even with production "missing"
  const art = makeSnapshot({ project: "efi", ref: "r", sha: "abcdef1234", entities: [entity({ id: "a", kind: "art_slot", display: "A", source: src, production: "missing" })] });
  assert.deepEqual(audit.coverageFindings(art, { lane: "storybook" }), []);
});

test("signoffFindings flags placeholder/ai-draft/needs-review, skips final/missing/null", () => {
  const ids = ["placeholder", "ai_draft", "needs_review", "final", "none", "missing"];
  const entities = ids.map((id) => {
    const production = id === "none" ? null : id === "ai_draft" ? "ai-draft" : id === "needs_review" ? "needs-review" : id;
    return entity({ id, kind: "trader", display: id, source: src, production });
  });
  const snap = makeSnapshot({ project: "efi", ref: "r", sha: "abcdef1234", entities });
  const out = audit.signoffFindings(snap, { lane: "storybook" });
  assert.deepEqual(out.map((f) => f.entityId).sort(), ["efi:trader:ai_draft", "efi:trader:needs_review", "efi:trader:placeholder"]);
  assert.deepEqual(out.map((f) => f.severity).sort(), ["info", "warn", "warn"]);
  for (const f of out) assert.equal(f.signal, "signoff");
});

test("runAudit over the fake repo: additive to runChecks, every finding validates, deterministic", async () => {
  const fake = makeFakeRepo();
  try {
    const snap = await loadSnapshot(efiAdapter, makeReader(fake.clone, fake.sha), { ref: "origin/main", generatedAt: "2026-01-01T00:00:00.000Z" });
    const auditA = await runAudit(snap, efiAdapter, { reader: null });
    for (const f of auditA) assert.equal(audit.validateAuditFinding(f).ok, true, JSON.stringify(f));
    assert.equal(auditA.some((f) => f.signal === "signoff"), true, "signoff findings present on the fixture");
    assert.equal(auditA.some((f) => f.signal === "integrity"), true, "integrity findings mapped from the checks");
    // the mapped part of the audit is a pure function of the check findings: passing precomputed findings gives the same result
    const findings = await runChecks(snap, efiAdapter, { reader: null });
    const fromFindings = await runAudit(snap, efiAdapter, { reader: null, findings });
    assert.deepEqual(fromFindings, auditA);
    assert.deepEqual(await runAudit(snap, efiAdapter, { reader: null }), auditA);
  } finally {
    fake.cleanup();
  }
});

test("artCoverageFindings: character with no linked art_slot or only missing art -> one info coverage finding; gated on a manifest", () => {
  const mk = (id, kind, extra = {}) => entity({ id, kind, source: src, ...extra });
  const art = (id, production, links) => mk(id, "art_slot", { production, links });
  const ents = [
    mk("a", "enemy"), mk("b", "enemy"), mk("c", "trader"), mk("d", "squad"), mk("i", "item"),
    art("enemy.a", "ai-draft", [{ rel: "portrait", kind: "enemy", id: "a" }]),
    art("enemy.b", "missing", [{ rel: "portrait", kind: "enemy", id: "b" }]),
    art("squad.d", null, [{ rel: "portrait", kind: "squad", id: "d" }]),
  ];
  const f = audit.artCoverageFindings(makeSnapshot({ project: "efi", entities: ents }), { lane: "storybook" });
  assert.deepEqual(f.map((x) => x.entityId).sort(), ["efi:enemy:b", "efi:trader:c"]);
  for (const x of f) { assert.equal(x.signal, "coverage"); assert.equal(x.severity, "info"); assert.equal(x.lane, "storybook"); assert.equal(audit.validateAuditFinding(x).ok, true); }
  // no art_slot entities at all (project without a manifest): nothing emitted
  assert.deepEqual(audit.artCoverageFindings(makeSnapshot({ project: "efi", entities: ents.filter((e) => e.kind !== "art_slot") })), []);
});

test("runAudit over the fake repo: art coverage = armored_scav, exo_trooper, doc(trader); not double-counted with text coverage", async () => {
  const fake = makeFakeRepo();
  try {
    const snap = await loadSnapshot(efiAdapter, makeReader(fake.clone, fake.sha), { ref: "origin/main", generatedAt: "2026-01-01T00:00:00.000Z" });
    const a = await runAudit(snap, efiAdapter, { reader: makeReader(fake.clone, fake.sha) });
    const art = a.filter((x) => x.signal === "coverage" && /has no art/.test(x.msg));
    assert.deepEqual(art.map((x) => x.entityId).sort(), ["efi:enemy:armored_scav", "efi:enemy:exo_trooper", "efi:trader:doc"]);
    assert.equal(new Set(a.filter((x) => x.signal === "coverage").map((x) => `${x.entityId}|${x.msg}`)).size, a.filter((x) => x.signal === "coverage").length);
  } finally { fake.cleanup(); }
});
