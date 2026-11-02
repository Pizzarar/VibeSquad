import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildBrainstormInitialPrompt, readBrainstormSummary, writeBrainstormSummary } from "../server/brainstorm.mjs";

function setup() {
  const base = mkdtempSync(join(tmpdir(), "vs-brief-path-"));
  const runtime = join(base, "runtime"); // stands in for %LOCALAPPDATA%\VibeSquad\runtime
  const project = join(base, "MyProj");
  mkdirSync(runtime, { recursive: true });
  mkdirSync(join(project, "docs", "brainstorm"), { recursive: true });
  const teamsFile = join(base, "teams.json");
  writeFileSync(teamsFile, JSON.stringify({ teams: [{ id: "myproj", name: "MyProj", paths: ["MyProj"], lanes: [{ id: "myproj", name: "MyProj" }] }] }));
  process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
  return { runtime, project };
}

test("Buddy start prompt carries the project brief, not the blank template, when rootDir is the runtime folder", () => {
  const { runtime, project } = setup();
  writeFileSync(join(project, "docs", "brainstorm", "myproj.md"), "# Brief\n## Decided\n- ship the real thing\n");
  const summary = readBrainstormSummary("myproj", runtime);
  const prompt = buildBrainstormInitialPrompt({ laneId: "myproj", laneUpper: "MYPROJ", summaryContent: summary.content, latestPlan: "docs/PLAN_X.md" });
  assert.ok(prompt.includes("ship the real thing"));
  assert.ok(!prompt.includes("VibeSquad fills this in"));
});

test("writes land in the project dir, and a missing brief is one line, not the skeleton", () => {
  const { runtime, project } = setup();
  assert.equal(readBrainstormSummary("myproj", runtime).content, "(no brief yet)");
  writeBrainstormSummary("myproj", "# new\n", runtime);
  assert.equal(readFileSync(join(project, "docs", "brainstorm", "myproj.md"), "utf8"), "# new\n");
  assert.ok(!existsSync(join(runtime, "docs", "brainstorm", "myproj.md")));
});
