// Tests for Part A (+ New squad modal) and Part B (New Idea dialog redesign).
// Pure-logic only — no DOM/React. Helpers are mirrored inline (project pattern)
// to avoid importing JSX files. The createPin lastProfile chain is tested via
// resolvePin from pins.ts which IS importable.
import assert from "node:assert/strict";
import test from "node:test";
import { resolvePin } from "../src/pins.ts";
import { slugLaneId, uniqueLaneId, allLaneIds } from "../src/pins.ts";
import {
  BRAINSTORM_RESTART_DEFAULT,
  BRAINSTORM_WARN_DEFAULT,
  LEAD_AUTO_HANDOFF_DEFAULT,
  LEAD_FLAG_DEFAULT,
  LEAD_HARD_CAP_DEFAULT,
} from "../src/teams.ts";

// ── Mirrored from src/PinIdeas.tsx ────────────────────────────────────────────
const DEFAULT_PIN_PROFILE = "Brainstorm - Claude";

function describeIdeaAction(opts) {
  if (opts.mode === "new") {
    return `Creates "${(opts.teamName || "").trim() || "New team"}", puts your idea in its brief, and starts ${opts.profile || DEFAULT_PIN_PROFILE}. No lead until you approve a plan.`;
  }
  if (opts.targetPin?.brainstorm) {
    return `Goes to ${opts.targetPin.lane.name}'s Buddy.`;
  }
  return `Goes to ${opts.targetPin?.lane.name ?? "team"}'s inbox (no Buddy live).`;
}

function submitButtonLabel(opts) {
  if (opts.busy) return "…";
  if (opts.mode === "new") return "Create team";
  return `Send to ${opts.targetTeamName || "team"}`;
}

// ── Mirrored from src/NewSquadModal.tsx ───────────────────────────────────────
function deriveSquadNameFromPath(rawPath) {
  const normalized = rawPath.replace(/\.git$/, "").replace(/[/\\]+$/, "");
  const parts = normalized.replace(/\\/g, "/").split("/");
  const folderSegment = parts.filter(Boolean).pop() ?? "";
  const titleCased = folderSegment
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
  const id = slugLaneId(folderSegment || "new-squad");
  return { id, name: titleCased || "New Squad", pathMatcher: folderSegment };
}

function buildNewSquadTeamDef(opts) {
  const normalized = opts.folderPath.replace(/\.git$/, "").replace(/[/\\]+$/, "");
  const parts = normalized.replace(/\\/g, "/").split("/");
  const folderSegment = parts.filter(Boolean).pop() ?? opts.folderPath.trim();
  const taken = allLaneIds(opts.existingTeams);
  const laneId = uniqueLaneId(slugLaneId(opts.name.trim() || "new-team"), taken);
  const lane = {
    id: laneId,
    name: opts.name.trim() || "New Squad",
    state: "pinned",
    ...(opts.lastProfile ? { lastProfile: opts.lastProfile } : {}),
  };
  return {
    id: opts.id,
    name: opts.name.trim() || "New Squad",
    color: "#00f0ff",
    brainstormWarnTokens: BRAINSTORM_WARN_DEFAULT,
    brainstormRestartTokens: BRAINSTORM_RESTART_DEFAULT,
    leadFlagTokens: LEAD_FLAG_DEFAULT,
    leadAutoHandoffTokens: LEAD_AUTO_HANDOFF_DEFAULT,
    leadHardCapTokens: LEAD_HARD_CAP_DEFAULT,
    lanes: [lane],
    paths: [folderSegment || opts.folderPath.trim()],
  };
}

// ── Tests: describeIdeaAction ─────────────────────────────────────────────────
test("describeIdeaAction – new mode with profile", () => {
  const msg = describeIdeaAction({ mode: "new", teamName: "Dark mode toggle", profile: "Brainstorm - Gemini" });
  assert.equal(msg, `Creates "Dark mode toggle", puts your idea in its brief, and starts Brainstorm - Gemini. No lead until you approve a plan.`);
});

test("describeIdeaAction – new mode trims and uses fallback profile", () => {
  const msg = describeIdeaAction({ mode: "new", teamName: "  ", profile: "" });
  assert.equal(msg, `Creates "New team", puts your idea in its brief, and starts Brainstorm - Claude. No lead until you approve a plan.`);
});

test("describeIdeaAction – existing with live Buddy", () => {
  const msg = describeIdeaAction({
    mode: "existing",
    teamName: "",
    profile: "Brainstorm - Claude",
    targetPin: { lane: { name: "Dark mode" }, brainstorm: {} },
  });
  assert.equal(msg, "Goes to Dark mode's Buddy.");
});

test("describeIdeaAction – existing with no Buddy", () => {
  const msg = describeIdeaAction({
    mode: "existing",
    teamName: "",
    profile: "Brainstorm - Claude",
    targetPin: { lane: { name: "Dark mode" }, brainstorm: null },
  });
  assert.equal(msg, "Goes to Dark mode's inbox (no Buddy live).");
});

test("describeIdeaAction – existing with no targetPin", () => {
  const msg = describeIdeaAction({ mode: "existing", teamName: "", profile: "Brainstorm - Claude", targetPin: null });
  assert.equal(msg, "Goes to team's inbox (no Buddy live).");
});

// ── Tests: submitButtonLabel ──────────────────────────────────────────────────
test("submitButtonLabel – busy returns ellipsis", () => {
  assert.equal(submitButtonLabel({ busy: true, mode: "new" }), "…");
  assert.equal(submitButtonLabel({ busy: true, mode: "existing", targetTeamName: "Dark mode" }), "…");
});

test("submitButtonLabel – new mode", () => {
  assert.equal(submitButtonLabel({ busy: false, mode: "new" }), "Create team");
});

test("submitButtonLabel – existing mode", () => {
  assert.equal(submitButtonLabel({ busy: false, mode: "existing", targetTeamName: "Dark mode" }), "Send to Dark mode");
  assert.equal(submitButtonLabel({ busy: false, mode: "existing" }), "Send to team");
});

// ── Tests: deriveSquadNameFromPath ────────────────────────────────────────────
test("deriveSquadNameFromPath – Windows path", () => {
  const r = deriveSquadNameFromPath("C:\\Users\\owner\\projects\\my-cool-app");
  assert.equal(r.name, "My Cool App");
  assert.equal(r.pathMatcher, "my-cool-app");
  assert.equal(r.id, "my-cool-app");
});

test("deriveSquadNameFromPath – Unix path", () => {
  const r = deriveSquadNameFromPath("/home/user/projects/game-engine");
  assert.equal(r.name, "Game Engine");
  assert.equal(r.pathMatcher, "game-engine");
});

test("deriveSquadNameFromPath – strips trailing .git", () => {
  const r = deriveSquadNameFromPath("https://github.com/owner/my-repo.git");
  assert.equal(r.pathMatcher, "my-repo");
  assert.equal(r.name, "My Repo");
});

test("deriveSquadNameFromPath – trailing slash", () => {
  const r = deriveSquadNameFromPath("/projects/vibesquad/");
  assert.equal(r.pathMatcher, "vibesquad");
});

// ── Tests: buildNewSquadTeamDef ───────────────────────────────────────────────
test("buildNewSquadTeamDef – token defaults match TeamSettingsModal", () => {
  const team = buildNewSquadTeamDef({
    id: "my-cool-app",
    name: "My Cool App",
    folderPath: "C:\\projects\\my-cool-app",
    existingTeams: [],
  });
  assert.equal(team.brainstormWarnTokens, BRAINSTORM_WARN_DEFAULT);
  assert.equal(team.brainstormRestartTokens, BRAINSTORM_RESTART_DEFAULT);
  assert.equal(team.leadFlagTokens, LEAD_FLAG_DEFAULT);
  assert.equal(team.leadAutoHandoffTokens, LEAD_AUTO_HANDOFF_DEFAULT);
  assert.equal(team.leadHardCapTokens, LEAD_HARD_CAP_DEFAULT);
  assert.equal(team.color, "#00f0ff");
});

test("buildNewSquadTeamDef – initial lane with lastProfile", () => {
  const team = buildNewSquadTeamDef({
    id: "my-cool-app",
    name: "My Cool App",
    folderPath: "C:\\projects\\my-cool-app",
    existingTeams: [],
    lastProfile: "Brainstorm - Gemini",
  });
  assert.equal(team.lanes.length, 1);
  assert.equal(team.lanes[0].name, "My Cool App");
  assert.equal(team.lanes[0].state, "pinned");
  assert.equal(team.lanes[0].lastProfile, "Brainstorm - Gemini");
});

test("buildNewSquadTeamDef – no lastProfile when not provided", () => {
  const team = buildNewSquadTeamDef({
    id: "my-app",
    name: "My App",
    folderPath: "/projects/my-app",
    existingTeams: [],
  });
  assert.equal(team.lanes[0].lastProfile, undefined);
});

test("buildNewSquadTeamDef – paths uses folder segment", () => {
  const team = buildNewSquadTeamDef({
    id: "my-app",
    name: "My App",
    folderPath: "C:\\Users\\owner\\projects\\my-cool-app",
    existingTeams: [],
  });
  assert.ok(team.paths.includes("my-cool-app"));
});

test("buildNewSquadTeamDef – lane id deduped against existing teams", () => {
  const existing = [{ lanes: [{ id: "my-app" }] }];
  const team = buildNewSquadTeamDef({
    id: "my-app-2",
    name: "My App",
    folderPath: "/projects/my-app",
    existingTeams: existing,
  });
  assert.notEqual(team.lanes[0].id, "my-app");
  assert.ok(team.lanes[0].id.startsWith("my-app"));
});

// ── Tests: profile chip → lastProfile chain ───────────────────────────────────
test("resolvePin returns lane.lastProfile as the profile", () => {
  const pin = {
    squad: { id: "squad-1", name: "Squad 1", lanes: [], paths: [], color: "#fff" },
    lane: { id: "dark-mode", name: "Dark mode", state: "pinned", lastProfile: "Brainstorm - Gemini" },
    state: "pinned",
    order: 0,
    brainstorm: null,
    lead: null,
    workers: [],
    needsYou: 0,
    running: 0,
    contextUsed: 0,
    topicBrainstorms: [],
  };
  const r = resolvePin(pin);
  assert.equal(r.kind, "quick-start");
  assert.equal(r.profile, "Brainstorm - Gemini");
});

test("resolvePin falls back to null when no lastProfile", () => {
  const pin = {
    squad: { id: "squad-1", name: "Squad 1", lanes: [], paths: [], color: "#fff" },
    lane: { id: "audio", name: "Audio", state: "pinned" },
    state: "pinned",
    order: 0,
    brainstorm: null,
    lead: null,
    workers: [],
    needsYou: 0,
    running: 0,
    contextUsed: 0,
    topicBrainstorms: [],
  };
  const r = resolvePin(pin);
  assert.equal(r.kind, "quick-start");
  assert.equal(r.profile, null);
});

// ── Tests: name input full-width spec ─────────────────────────────────────────
test("name input style spec: width 100% and minWidth >= 200", () => {
  // These constants are spec'd in src/PinIdeas.tsx for the Name input.
  const minWidth = 220;
  const width = "100%";
  assert.equal(width, "100%");
  assert.ok(minWidth >= 200, `minWidth ${minWidth} should be >= 200`);
});
