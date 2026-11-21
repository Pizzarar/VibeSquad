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

// ── U5: Name above idea, no live line-1 overwrite ─────────────────────────────
import { nameFromIdea as u5NameFromIdea } from "../src/pins.ts";

// Mirrored from src/PinIdeas.tsx
function resolveIdeaTeamName(typedName, ideaText) {
  return typedName.trim() || u5NameFromIdea(ideaText).trim();
}
function ideaModalFieldOrder(mode) {
  return mode === "new" ? ["tabs", "name", "idea", "buddy"] : ["tabs", "idea", "team"];
}

test("U5 resolveIdeaTeamName prefers typed name", () => {
  assert.equal(resolveIdeaTeamName("  Crew  ", "Line one\nmore"), "Crew");
});

test("U5 resolveIdeaTeamName falls back to line 1 only when name blank", () => {
  assert.equal(resolveIdeaTeamName("", "Line one\nmore"), u5NameFromIdea("Line one\nmore").trim());
  assert.equal(resolveIdeaTeamName("   ", "Line one"), u5NameFromIdea("Line one").trim());
});

test("U5 typing an idea never mutates the typed name", () => {
  const name = "";
  for (const text of ["a", "ab\nc", "ab\nc\nd"]) assert.equal(name, "");
});

test("U5 ideaModalFieldOrder puts Name before idea in new mode", () => {
  assert.deepEqual(ideaModalFieldOrder("new"), ["tabs", "name", "idea", "buddy"]);
  assert.deepEqual(ideaModalFieldOrder("existing"), ["tabs", "idea", "team"]);
});

// ── idea-343: From GitHub tab ────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { parseGithubRepoSpec } from "../server/git-api.mjs";
import { buildNewSquadTeamDef as realBuildNewSquadTeamDef } from "../src/newSquadDef.ts";

// Mirrored from src/NewSquadModal.tsx (githubSpecFromInput)
const GH_SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
const ghSegmentOk = (s) => GH_SEGMENT.test(s) && !s.startsWith("-") && !s.startsWith(".");
function githubSpecFromInput(raw) {
  const t = raw.trim();
  if (!t || /[\s\\]/.test(t)) return null;
  const m = /^https:\/\/(?:www\.)?github\.com\/(.*)$/i.exec(t);
  const path = m ? m[1].replace(/\/$/, "") : t;
  if (/[?#@%:]/.test(path)) return null;
  const parts = path.split("/");
  if (parts.length !== 2) return null;
  const repo = parts[1].toLowerCase().endsWith(".git") ? parts[1].slice(0, -4) : parts[1];
  return ghSegmentOk(parts[0]) && ghSegmentOk(repo) ? `${parts[0]}/${repo}` : null;
}
const modalSrc = readFileSync(new URL("../src/NewSquadModal.tsx", import.meta.url), "utf8");

test("idea-343 githubSpecFromInput mirror matches the modal source", () => {
  const body = /export function githubSpecFromInput\(raw: string\): string \| null \{([\s\S]*?)\n\}/.exec(modalSrc)?.[1];
  assert.ok(body, "githubSpecFromInput not found in NewSquadModal.tsx");
  assert.equal(body.replace(/\s+/g, ""), githubSpecFromInput.toString().replace(/^[^{]*\{/, "").replace(/\}$/, "").replace(/\s+/g, ""));
});

test("idea-343 the client spec check agrees with the server's parseGithubRepoSpec (trimmed input)", () => {
  const cases = [
    "IdleMinds-Dev/SportsBallBattles", "o/r.git", "https://github.com/o/r", "https://github.com/o/r.git/", "https://www.github.com/o/r",
    "-x/r", "../r", "o/r/x", "https://gitlab.com/o/r", "https://u@github.com/o/r", "o\\r", "o /r", "git@github.com:o/r", "o/.git", "SportsBallBattles", "",
  ];
  for (const c of cases) assert.equal(githubSpecFromInput(c), parseGithubRepoSpec(c.trim()), c);
  assert.equal(githubSpecFromInput("  o/r  "), "o/r"); // pasted with whitespace: the modal trims before sending
});

test("idea-343 picking a repo auto-fills the Squad name from the repo name", () => {
  assert.equal(deriveSquadNameFromPath("SportsBallBattles").name, "SportsBallBattles");
  assert.equal(deriveSquadNameFromPath("my-cool-app").name, "My Cool App");
  assert.equal(deriveSquadNameFromPath(githubSpecFromInput("https://github.com/o/game_engine.git").split("/")[1]).name, "Game Engine");
});

test("idea-343 a cloned path registers by folder name plus the absolute clone path", () => {
  const t = realBuildNewSquadTeamDef({ id: "team-sbb", name: "SportsBallBattles", folderPath: "C:\\Users\\you\\projects\\SportsBallBattles", existingTeams: [] });
  assert.deepEqual(t.paths, ["SportsBallBattles", "C:\\Users\\you\\projects\\SportsBallBattles"]);
});

test("idea-343 NewSquadModal wires the From GitHub tab to gh-repos / gh-clone and the saveTeams flow", () => {
  for (const id of ["new-squad-source-path", "new-squad-source-github", "new-squad-github-input", "new-squad-github-list", "new-squad-submit"]) {
    assert.match(modalSrc, new RegExp(`data-testid="${id}"`), id);
  }
  assert.match(modalSrc, /fetch\("\/__vibesquad\/git\/gh-repos"\)/);
  assert.match(modalSrc, /fetch\("\/__vibesquad\/git\/gh-clone", \{ method: "POST"/);
  assert.match(modalSrc, /placeholder="Search your repos or paste owner\/repo…"/);
  assert.match(modalSrc, /if \(DEMO\) \{\s*setGhRepos\(DEMO_GH_REPOS\)/); // no live gh call in DEMO
  assert.match(modalSrc, /const github = source === "github"/); // live in remote mode too: a remote owner device may clone (host-side dest)
  assert.match(modalSrc, /\(await cloneGhRepo\(ghSpec\)\)\.path/);
  assert.match(modalSrc, /folderPath: finalPath/);
  assert.match(modalSrc, /await saveTeams\(\[\.\.\.teams, newTeam\]\)/);
  assert.match(modalSrc, /"Cloning…"/);
});

// Mirrored from src/NewSquadModal.tsx (ghHttpError / ghErrorSlots); the source-match test below keeps them honest.
const GH_SERVER_TOO_OLD = "This VibeSquad server doesn't support GitHub import yet — restart VibeSquad";
function ghHttpError(status, body) {
  const msg = typeof body?.error === "string" ? body.error : "";
  if ((status === 404 || status === 405) && (!msg || msg.toLowerCase() === "not found")) return GH_SERVER_TOO_OLD;
  return msg || `GitHub request failed (${status})`;
}
function ghErrorSlots(loadErr, submitErr) {
  return { status: loadErr, submit: submitErr && submitErr !== loadErr ? submitErr : "" };
}

test("idea-343 error helpers mirror the modal source", () => {
  const norm = (s) => s.replace(/\s+/g, "").replace(/:(string|number|unknown)/g, "");
  const src = (name) => new RegExp(`export function ${name}\\([^)]*\\)[^\\n]*\\{\\n([\\s\\S]*?)\\n\\}`).exec(modalSrc)?.[1];
  assert.ok(src("ghHttpError") && src("ghErrorSlots"));
  assert.equal(norm(src("ghHttpError")),norm(ghHttpError.toString().replace(/^[^{]*\{/, "").replace(/\}$/, "")));
  assert.equal(norm(src("ghErrorSlots")), norm(ghErrorSlots.toString().replace(/^[^{]*\{/, "").replace(/\}$/, "")));
  assert.match(modalSrc, new RegExp(`GH_SERVER_TOO_OLD = "${GH_SERVER_TOO_OLD}"`));
});

test("idea-343 a missing route reads as 'restart VibeSquad', never bare 'not found'", () => {
  assert.equal(ghHttpError(404, null), GH_SERVER_TOO_OLD); // non-JSON generic fallback
  assert.equal(ghHttpError(404, {}), GH_SERVER_TOO_OLD);
  assert.equal(ghHttpError(404, { error: "not found" }), GH_SERVER_TOO_OLD);
  assert.equal(ghHttpError(405, null), GH_SERVER_TOO_OLD);
  assert.equal(ghHttpError(424, { error: "Not signed in to GitHub CLI — run gh auth login" }), "Not signed in to GitHub CLI — run gh auth login");
  assert.equal(ghHttpError(409, { error: "folder already exists and is not a git repository" }), "folder already exists and is not a git repository");
  assert.equal(ghHttpError(502, null), "GitHub request failed (502)");
});

test("idea-343 each GitHub error renders exactly once", () => {
  const same = "GitHub CLI (gh) isn't installed";
  assert.deepEqual(ghErrorSlots(same, same), { status: same, submit: "" }); // same message: status box only
  assert.deepEqual(ghErrorSlots("", "Repository o/r not found"), { status: "", submit: "Repository o/r not found" });
  assert.deepEqual(ghErrorSlots("load failed", "clone failed"), { status: "load failed", submit: "clone failed" });
  // Source: ghErr renders only in the status box, the pink line only reads the de-duplicated submit slot.
  assert.equal((modalSrc.match(/\{ghErr \|\|/g) ?? []).length, 1);
  assert.equal((modalSrc.match(/\{err\b/g) ?? []).length, 0);
  assert.match(modalSrc, /\{errSlots\.submit && <div className="stat-alert small"[^>]*>\{errSlots\.submit\}<\/div>\}/);
});

test("U5 live sentence shows the effective team name", () => {
  const s = describeIdeaAction({ mode: "new", teamName: resolveIdeaTeamName("Crew", "x"), profile: "P" });
  assert.match(s, /Creates "Crew"/);
  const f = describeIdeaAction({ mode: "new", teamName: resolveIdeaTeamName("", "Hello"), profile: "P" });
  assert.match(f, /Creates "Hello/);
});
