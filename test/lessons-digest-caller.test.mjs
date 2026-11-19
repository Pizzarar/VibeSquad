import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  MAX_LESSONS_DIGEST_CHARS,
  MAX_LESSONS_DIGEST_LESSONS,
  lessonsDigestBlock,
} from "../server/hooks/agent-duties.ts";
import { LESSONS_BEGIN, LESSONS_END, appendLesson } from "../server/lessons.mjs";

const tempStore = () => join(mkdtempSync(join(tmpdir(), "vs-lessons-digest-")), "lessons.jsonl");

const lesson = (overrides = {}) => ({
  category: "worktrees",
  title: "Never git worktree add into projects/",
  cause: "managed sanctuary",
  rule: "Use vs worktree create",
  ...overrides,
});

describe("lessonsDigestBlock (the before(agent.create) caller)", () => {
  it("returns '' for an empty store (no section)", () => {
    assert.equal(lessonsDigestBlock({ storePath: join(tmpdir(), "nope", "missing.jsonl") }), "");
  });

  it("renders the digest block when a lesson is logged", () => {
    const store = tempStore();
    appendLesson(lesson({ title: "BOM corrupts JSON" }), { storePath: store });
    const block = lessonsDigestBlock({ storePath: store });
    assert.ok(block.startsWith(LESSONS_BEGIN), "begins with the lessons marker");
    assert.ok(block.endsWith(LESSONS_END), "ends with the lessons marker");
    assert.match(block, /\[worktrees\] BOM corrupts JSON/);
    assert.match(block, /VibeSquad standing rules/);
    assert.ok(block.length <= MAX_LESSONS_DIGEST_CHARS + 60, `default digest ${block.length} chars`);
  });

  it("caps the most recent lessons by count", () => {
    const store = tempStore();
    appendLesson(lesson({ id: "a", title: "oldest" }), { storePath: store });
    appendLesson(lesson({ id: "b", title: "middle" }), { storePath: store });
    appendLesson(lesson({ id: "c", title: "newest" }), { storePath: store });
    const block = lessonsDigestBlock({ storePath: store, limit: 2 });
    assert.match(block, /newest/);
    assert.match(block, /middle/);
    assert.doesNotMatch(block, /oldest/);
  });

  it("respects a hard char cap and marks the truncation", () => {
    const store = tempStore();
    appendLesson(lesson({ rule: "x".repeat(500) }), { storePath: store });
    const cap = 300;
    const block = lessonsDigestBlock({ storePath: store, maxChars: cap });
    assert.ok(block.includes("[... lessons digest truncated]"), "truncation is marked");
    assert.ok(
      block.length <= cap + "[... lessons digest truncated]".length + 1,
      `capped block ${block.length} chars`,
    );
  });

  it("defaults the count cap to MAX_LESSONS_DIGEST_LESSONS", () => {
    assert.equal(MAX_LESSONS_DIGEST_LESSONS, 10);
  });
});
