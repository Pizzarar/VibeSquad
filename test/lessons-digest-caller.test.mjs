import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  MAX_LESSONS_DIGEST_CHARS,
  MAX_LESSONS_DIGEST_LESSONS,
  createPlugin,
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

  it("renders a lessons-only digest (no standing rules) when a lesson is logged", () => {
    const store = tempStore();
    appendLesson(lesson({ title: "BOM corrupts JSON" }), { storePath: store });
    const block = lessonsDigestBlock({ storePath: store });
    assert.ok(block.startsWith(LESSONS_BEGIN), "begins with the lessons marker");
    assert.ok(block.endsWith(LESSONS_END), "ends with the lessons marker");
    assert.match(block, /\[worktrees\] BOM corrupts JSON/);
    assert.doesNotMatch(block, /VibeSquad standing rules/, "standing rules are not repeated in the digest");
    assert.ok(block.length <= MAX_LESSONS_DIGEST_CHARS, `digest ${block.length} chars`);
  });

  it("hard caps the block at MAX_LESSONS_DIGEST_CHARS even with many long lessons", () => {
    const store = tempStore();
    for (let i = 0; i < 10; i++) {
      appendLesson(lesson({ id: `l${i}`, title: `lesson ${i}`, rule: "x".repeat(500) }), { storePath: store });
    }
    const block = lessonsDigestBlock({ storePath: store });
    assert.ok(block.length <= MAX_LESSONS_DIGEST_CHARS, `capped block ${block.length} chars`);
    assert.ok(block.includes("[... lessons digest truncated]"), "truncation is marked");
    const bullets = block.split("\n").filter((l) => l.startsWith("- ["));
    assert.ok(bullets.length < 10, `not all ${bullets.length} lessons fit`);
    assert.ok(bullets.length <= MAX_LESSONS_DIGEST_LESSONS, `at most ${MAX_LESSONS_DIGEST_LESSONS} lessons`);
  });

  it("lane-scopes: the lane's own lessons come before global lessons", () => {
    const store = tempStore();
    appendLesson(lesson({ id: "g", category: "general", title: "global lesson" }), { storePath: store });
    appendLesson(lesson({ id: "o", category: "windows", title: "other topical" }), { storePath: store });
    appendLesson(lesson({ id: "l", category: "bug-chaser", title: "lane own lesson" }), { storePath: store });
    const block = lessonsDigestBlock({ storePath: store, lane: "bug-chaser" });
    const laneIdx = block.indexOf("lane own lesson");
    const globalIdx = block.indexOf("global lesson");
    assert.ok(laneIdx >= 0, "lane lesson present");
    assert.ok(globalIdx >= 0, "global lesson present");
    assert.ok(laneIdx < globalIdx, "lane lesson listed before the global lesson");
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

  it("defaults the count cap to MAX_LESSONS_DIGEST_LESSONS", () => {
    assert.equal(MAX_LESSONS_DIGEST_LESSONS, 5);
  });
});

describe("lessons digest wiring in before(agent.create)", () => {
  function withEnv(fn) {
    return async () => {
      const dir = mkdtempSync(join(tmpdir(), "vs-lessons-hook-"));
      const vsHome = join(dir, ".vibesquad");
      mkdirSync(vsHome, { recursive: true });
      writeFileSync(
        join(vsHome, "teams.json"),
        JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "vibesquad", paths: ["VibeSquad"] }], paths: ["VibeSquad"] }] }),
        "utf8",
      );
      writeFileSync(join(vsHome, "profiles.json"), JSON.stringify({ profiles: [] }), "utf8");
      const prev = {
        VIBESQUAD_HOME: process.env.VIBESQUAD_HOME,
        VIBESQUAD_TEAMS_FILE: process.env.VIBESQUAD_TEAMS_FILE,
        VIBESQUAD_PROFILES_PATH: process.env.VIBESQUAD_PROFILES_PATH,
      };
      process.env.VIBESQUAD_HOME = vsHome;
      process.env.VIBESQUAD_TEAMS_FILE = join(vsHome, "teams.json");
      process.env.VIBESQUAD_PROFILES_PATH = join(vsHome, "profiles.json");
      try {
        await fn({ vsHome });
      } finally {
        for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  function harness() {
    const before = new Map();
    const on = new Map();
    const server = {
      before: (name, fn) => (before.set(name, fn), () => before.delete(name)),
      on: (name, fn) => (on.set(name, fn), () => on.delete(name)),
    };
    const stop = createPlugin({ startWatcher: false, setLabels: async () => {}, archiveAgent: async () => {} })(server);
    const spawn = async (labels, config = {}) => {
      const req = { config: { cwd: "/projects/VibeSquad/.worktrees/lessons-test", ...config }, labels };
      return (await before.get("agent.create")({ request: req })) ?? req;
    };
    return { stop, spawn };
  }

  const LABELS = { team: "vibesquad", lane: "vibesquad", role: "worker" };

  it(
    "a thrown error in the lessons step leaves the spawn prompt unchanged",
    withEnv(async ({ vsHome }) => {
      // Empty store: no lessons section.
      const h1 = harness();
      const outA = await h1.spawn(LABELS, { provider: "claude" });
      h1.stop();

      // A directory at the store path makes readLessons throw (EISDIR); the hook must catch it.
      mkdirSync(join(vsHome, "lessons.jsonl"), { recursive: true });
      const h2 = harness();
      const outB = await h2.spawn(LABELS, { provider: "claude" });
      h2.stop();

      const sysA = String(outA?.config?.systemPrompt ?? "");
      const sysB = String(outB?.config?.systemPrompt ?? "");
      assert.ok(!sysA.includes("<!-- vibesquad:lessons:begin -->"), "empty store adds no section");
      assert.equal(sysB, sysA, "a thrown lessons read must not change the assembled prompt");
    }),
  );

  it(
    "injects the lessons digest when a lesson is logged",
    withEnv(async ({ vsHome }) => {
      appendLesson(lesson({ category: "vibesquad", title: "lane lesson" }), { storePath: join(vsHome, "lessons.jsonl") });
      const h = harness();
      try {
        const out = await h.spawn(LABELS, { provider: "claude" });
        const sys = String(out?.config?.systemPrompt ?? "");
        assert.ok(sys.includes("<!-- vibesquad:lessons:begin -->"), "digest marker present");
        assert.match(sys, /\[vibesquad\] lane lesson/);
      } finally {
        h.stop?.();
      }
    }),
  );
});
