import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EVERYONE_LAYER,
  MAX_INJECT_BRIEF_CHARS,
  MAX_INJECT_OPEN_UNITS,
  composeSpawnPromptParts,
  dedupeNotesAgainst,
  injectedPrefix,
  laneArtifactBlock,
  laneBriefBlock,
} from "./agent-duties.ts";
import { buildDefaultPackNotesMap } from "../profiles.mjs";

const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const RULE_MARKERS = [
  "Team rules (VibeSquad):",
  "- R1 (Search/Read)",
  "- R4 (Large files)",
  "- R8 (Worktrees & Lanes)",
  "- R12 (Owner principles)",
  "- Attribution (Community Accolades)",
  "Project rules first:",
  "To find your current lead:",
];

// toPaseoSpawnConfig sets systemPrompt = the profile's notes, so the plugin sees the same notes twice.
const notesMap = buildDefaultPackNotesMap();
const CASES: Array<[string, string, string]> = [
  ["lead", "Lead - Claude", "Role: lead"],
  ["worker", "Implement - Sonnet", "Role: worker."],
  ["brainstorm", "Brainstorm - Claude", "Role: brainstorm"],
];

for (const [role, profile] of CASES) {
  test(`spawn prompt carries each rule block exactly once (${role})`, () => {
    const notes = notesMap[profile];
    assert.ok(notes, `default notes for ${profile}`);
    const prefix = injectedPrefix(role, process.cwd());
    const profileNotes = dedupeNotesAgainst(notes.trim(), prefix);
    const prompt = composeSpawnPromptParts(prefix, profileNotes, notes, null).join("\n\n");
    for (const m of RULE_MARKERS) assert.equal(count(prompt, m), 1, `${role}: "${m}" appears once`);
    assert.equal(count(prompt, "Role: " + role.slice(0, 4)), 1, `${role}: role text appears once`);
    assert.ok(prompt.includes(EVERYONE_LAYER));
  });
}

test("a caller systemPrompt that is not the profile notes is kept once", () => {
  const prefix = injectedPrefix("worker", process.cwd());
  const parts = composeSpawnPromptParts(prefix, "", "Custom task text.", "Starting git state: x");
  assert.equal(parts.filter((p) => p === "Custom task text.").length, 1);
  assert.equal(parts[parts.length - 1], "Starting git state: x");
});

test("TASKS.json injection shows open units only, capped, with done and overflow counts", () => {
  const root = mkdtempSync(join(tmpdir(), "vs-k3-"));
  try {
    mkdirSync(join(root, "docs", "lanes", "demo"), { recursive: true });
    const units = [
      ...Array.from({ length: MAX_INJECT_OPEN_UNITS + 5 }, (_, i) => ({ id: `open-${i}`, status: "todo" })),
      ...Array.from({ length: 7 }, (_, i) => ({ id: `done-${i}`, status: "done" })),
    ];
    writeFileSync(join(root, "docs", "lanes", "demo", "TASKS.json"), JSON.stringify({ laneId: "demo", units }), "utf8");
    const block = laneArtifactBlock(root, "demo");
    assert.equal(count(block, '"id": "open-'), MAX_INJECT_OPEN_UNITS);
    assert.equal(count(block, '"id": "done-'), 0);
    assert.match(block, /5 more open units, 7 done units/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("brief injection is capped with a pointer to the file", () => {
  const root = mkdtempSync(join(tmpdir(), "vs-k3-"));
  try {
    mkdirSync(join(root, "docs", "brainstorm"), { recursive: true });
    const body = Array.from({ length: 2000 }, (_, i) => `line ${i} of the brief`).join("\n");
    writeFileSync(join(root, "docs", "brainstorm", "demo.md"), body, "utf8");
    const block = laneBriefBlock(root, "demo");
    assert.ok(block.length < MAX_INJECT_BRIEF_CHARS + 600, `block ${block.length} chars`);
    assert.match(block, /more chars not shown; read docs\/brainstorm\/demo\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
