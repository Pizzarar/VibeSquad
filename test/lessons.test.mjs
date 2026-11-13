import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  LESSONS_BEGIN,
  LESSONS_END,
  STANDING_RULES,
  appendLesson,
  readLessons,
  renderLessonsDigest,
  resolveLessonsStorePath,
} from "../server/lessons.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempStore = () => join(mkdtempSync(join(tmpdir(), "vs-lessons-")), "lessons.jsonl");

const BASE_TS = Date.parse("2026-11-03T12:00:00.000Z");

function lesson(overrides = {}) {
  return {
    category: "windows",
    title: "PowerShell UTF-8 BOM corrupts JSON",
    cause: "Set-Content writes a BOM that JSON.parse rejects",
    rule: "Use node fs.writeFileSync(..., 'utf8')",
    refs: ["docs/PLAN_BUGS_BATCH1.md"],
    ...overrides,
  };
}

describe("lessons · resolveLessonsStorePath", () => {
  it("defaults to the VibeSquad home dir", () => {
    assert.match(resolveLessonsStorePath(), /lessons\.jsonl$/);
    assert.ok(!resolveLessonsStorePath().includes(join("docs", "LESSONS.jsonl")));
  });

  it("uses <rootDir>/docs/LESSONS.jsonl when rootDir is given", () => {
    const root = join(tmpdir(), "repo");
    assert.equal(resolveLessonsStorePath(root), join(root, "docs", "LESSONS.jsonl"));
  });
});

describe("lessons · appendLesson", () => {
  it("writes one UTF-8 JSONL line with no BOM and returns the saved entry", () => {
    const store = tempStore();
    const saved = appendLesson(lesson(), { storePath: store });

    assert.ok(saved.id);
    assert.ok(saved.createdAt);
    assert.equal(saved.category, "windows");

    const raw = readFileSync(store);
    assert.equal(raw[0], 0x7b, "first byte must be '{', not a UTF-8 BOM");
    const text = raw.toString("utf8");
    assert.ok(!text.startsWith("\uFEFF"));
    const lines = text.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), saved);
  });

  it("appends successive lessons as separate lines", () => {
    const store = tempStore();
    appendLesson(lesson({ id: "a" }), { storePath: store });
    appendLesson(lesson({ id: "b", category: "identity" }), { storePath: store });
    const lines = readFileSync(store, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).id, "a");
    assert.equal(JSON.parse(lines[1]).id, "b");
  });

  it("generates a unique id when omitted and honors an explicit id", () => {
    const store = tempStore();
    const withId = appendLesson(lesson({ id: "explicit-1" }), { storePath: store });
    const noId = appendLesson(lesson(), { storePath: store });
    assert.equal(withId.id, "explicit-1");
    assert.ok(noId.id && noId.id !== "explicit-1");
  });

  it("rejects invalid entries", () => {
    const store = tempStore();
    assert.throws(() => appendLesson(null, { storePath: store }), /must be an object/);
    assert.throws(() => appendLesson({}, { storePath: store }), /category is required/);
    assert.throws(() => appendLesson(lesson({ title: "" }), { storePath: store }), /title is required/);
    assert.throws(() => appendLesson(lesson({ cause: "   " }), { storePath: store }), /cause is required/);
    assert.throws(() => appendLesson(lesson({ rule: undefined }), { storePath: store }), /rule is required/);
    assert.throws(() => appendLesson(lesson({ refs: ["ok", 42] }), { storePath: store }), /refs entries must be strings/);
  });

  it("writes through rootDir (docs/LESSONS.jsonl)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-lessons-root-"));
    const saved = appendLesson(lesson(), { rootDir: dir });
    assert.ok(existsSync(join(dir, "docs", "LESSONS.jsonl")));
    assert.equal(readLessons({ rootDir: dir }).length, 1);
    assert.equal(readLessons({ rootDir: dir })[0].id, saved.id);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("lessons · readLessons", () => {
  function seed(store) {
    appendLesson(
      lesson({ id: "old", category: "paseo", createdAt: new Date(BASE_TS - 2000).toISOString(), title: "spawn hang" }),
      { storePath: store },
    );
    appendLesson(
      lesson({ id: "mid", category: "worktrees", createdAt: new Date(BASE_TS - 1000).toISOString(), title: "worktree sprawl" }),
      { storePath: store },
    );
    appendLesson(
      lesson({ id: "new", category: "paseo", createdAt: new Date(BASE_TS).toISOString(), title: "paseo ls deadlock" }),
      { storePath: store },
    );
  }

  it("returns entries newest first", () => {
    const store = tempStore();
    seed(store);
    const all = readLessons({ storePath: store });
    assert.deepEqual(all.map((l) => l.id), ["new", "mid", "old"]);
  });

  it("filters by category (case-insensitive)", () => {
    const store = tempStore();
    seed(store);
    const paseo = readLessons({ category: "PASEO", storePath: store });
    assert.deepEqual(paseo.map((l) => l.id), ["new", "old"]);
  });

  it("filters by a case-insensitive query across fields", () => {
    const store = tempStore();
    seed(store);
    const hits = readLessons({ query: "SPRAWL", storePath: store });
    assert.deepEqual(hits.map((l) => l.id), ["mid"]);
    const none = readLessons({ query: "does-not-exist", storePath: store });
    assert.equal(none.length, 0);
  });

  it("applies the limit", () => {
    const store = tempStore();
    seed(store);
    assert.equal(readLessons({ storePath: store, limit: 2 }).length, 2);
    assert.equal(readLessons({ storePath: store, limit: 0 }).length, 0);
  });

  it("returns [] for a missing store", () => {
    assert.deepEqual(readLessons({ storePath: join(tmpdir(), "nope", "missing.jsonl") }), []);
  });

  it("skips malformed lines instead of throwing", () => {
    const store = tempStore();
    appendLesson(lesson({ id: "good" }), { storePath: store });
    appendFileSync(store, "{ not json }\n", "utf8");
    appendLesson(lesson({ id: "good2" }), { storePath: store });
    const all = readLessons({ storePath: store });
    assert.deepEqual(all.map((l) => l.id), ["good2", "good"]);
  });
});

describe("lessons · renderLessonsDigest", () => {
  it("wraps content in the begin/end markers and includes standing rules", () => {
    const digest = renderLessonsDigest({ storePath: join(tmpdir(), "missing.jsonl") });
    assert.ok(digest.startsWith(LESSONS_BEGIN));
    assert.ok(digest.endsWith(LESSONS_END));
    assert.match(digest, /vs who lead/);
    assert.match(digest, /VibeSquad standing rules/);
  });

  it("lists recent logged lessons", () => {
    const store = tempStore();
    appendLesson(
      lesson({ id: "l1", category: "paseo", title: "CLI deadlock on every turn" }),
      { storePath: store },
    );
    const digest = renderLessonsDigest({ storePath: store });
    assert.match(digest, /\[paseo\] CLI deadlock on every turn/);
  });
});

describe("lessons · docs/LESSONS.md catalog", () => {
  it("exists and documents the core lessons", () => {
    const catalogPath = join(ROOT, "docs", "LESSONS.md");
    assert.ok(existsSync(catalogPath), "docs/LESSONS.md must exist");
    const text = readFileSync(catalogPath, "utf8");
    // Paseo CLI / spawn hang
    assert.match(text, /paseo ls/i);
    assert.match(text, /spawn hang/i);
    // Worktree sanctuary
    assert.match(text, /worktree/i);
    assert.match(text, /LOCALAPPDATA/i);
    // Provider cap failover
    assert.match(text, /failover/i);
    assert.match(text, /Claude/i);
    // BOM lesson
    assert.match(text, /BOM/i);
    assert.match(text, /Set-Content|writeFileSync/i);
  });
});

describe("coordinated drain standing rule (PLAN_COORDINATED_DRAIN D0)", () => {
  it("is a standing rule (injected into every role), <=240 chars, names the drain handshake and the owner gate", () => {
    const rule = STANDING_RULES.find((r) => r.startsWith("Shared-machine actions"));
    assert.ok(rule, "rule present");
    assert.ok(rule.length <= 240, `${rule.length} chars`);
    assert.match(rule, /vs restart, full-suite slot, runtime sync/);
    assert.match(rule, /holders' leads to drain/);
    assert.match(rule, /`drained`/);
    assert.match(rule, /`<action>-done`/);
    assert.match(rule, /No timer retries/);
    assert.match(rule, /`--kill-background` only with the owner's per-run OK/);
    assert.ok(renderLessonsDigest({ storePath: tempStore() }).includes(`- ${rule}`), "rendered into the injected digest");
  });
});
