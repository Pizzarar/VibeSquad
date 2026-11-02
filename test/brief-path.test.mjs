import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { buildBrainstormInitialPrompt, readBrainstormSummary, writeBrainstormSummary } from "../server/brainstorm.mjs";

const prevTeams = process.env.VIBESQUAD_TEAMS_FILE;
afterEach(() => {
  if (prevTeams === undefined) delete process.env.VIBESQUAD_TEAMS_FILE;
  else process.env.VIBESQUAD_TEAMS_FILE = prevTeams;
});

function setup() {
  const base = mkdtempSync(join(tmpdir(), "vs-brief-path-"));
  const runtime = join(base, "runtime"); // stands in for %LOCALAPPDATA%\VibeSquad\runtime
  const project = join(base, "MyProj");
  mkdirSync(runtime, { recursive: true });
  mkdirSync(join(project, "docs", "brainstorm"), { recursive: true });
  const teamsFile = join(base, "teams.json");
  writeFileSync(teamsFile, JSON.stringify({ teams: [{ id: "myproj", name: "MyProj", paths: ["MyProj"], lanes: [{ id: "myproj", name: "MyProj", aliases: ["mp"] }] }] }));
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

test("a lane alias resolves to the project dir and the canonical brief", () => {
  const { runtime, project } = setup();
  writeFileSync(join(project, "docs", "brainstorm", "myproj.md"), "alias brief text");
  assert.equal(readBrainstormSummary("mp", runtime).content, "alias brief text");
  writeBrainstormSummary("MP", "written via alias", runtime);
  assert.equal(readFileSync(join(project, "docs", "brainstorm", "myproj.md"), "utf8"), "written via alias");
  assert.ok(!existsSync(join(runtime, "docs", "brainstorm")));
});

test("a stale runtime brief is ignored once the project dir resolves", () => {
  const { runtime } = setup();
  mkdirSync(join(runtime, "docs", "brainstorm"), { recursive: true });
  writeFileSync(join(runtime, "docs", "brainstorm", "myproj.md"), "STALE runtime copy");
  assert.equal(readBrainstormSummary("myproj", runtime).content, "(no brief yet)");
});

test("with no project dir the rootDir brief is used (dev)", () => {
  const { runtime } = setup();
  mkdirSync(join(runtime, "docs", "brainstorm"), { recursive: true });
  writeFileSync(join(runtime, "docs", "brainstorm", "unknown-lane.md"), "dev brief");
  assert.equal(readBrainstormSummary("unknown-lane", runtime).content, "dev brief");
});
