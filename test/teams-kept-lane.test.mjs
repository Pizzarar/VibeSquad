import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildTeamViews, findCrossTeamBrainstorm, resolve } from "../src/teams.ts";

function makeAgent(overrides = {}) {
  const id = overrides.id ?? "test-id";
  return {
    id,
    title: overrides.title ?? "",
    status: overrides.status ?? "idle",
    archivedAt: overrides.archivedAt ?? null,
    cwd: overrides.cwd ?? "/some/path",
    labels: overrides.labels ?? {},
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    provider: overrides.provider ?? "claude",
    pendingPermissions: [],
    ...overrides,
  };
}

function resolveAgents(agentList) {
  const map = new Map(agentList.map((a) => [a.id, a]));
  return resolve(map);
}

describe("teams keptLane & findCrossTeamBrainstorm", () => {
  const pluginsBrainstorm = makeAgent({
    id: "b50a67e8-0bb5-4b47-911d-08f2841c6a54",
    title: "BRAINSTORM · PLUGINS",
    labels: { team: "plugins", lane: "plugins", lead: "plugins", role: "brainstorm" },
    cwd: "C:\\Users\\Fugma\\AppData\\Local\\VibeSquad\\runtime",
    status: "idle",
  });

  test("resolve() preserves explicit callerLane on cwd-autofix (does not assign laneId 'vibesquad' to BRAINSTORM · PLUGINS)", () => {
    const members = resolveAgents([pluginsBrainstorm]);
    assert.equal(members.length, 1);
    assert.notEqual(members[0].laneId, "vibesquad");
    assert.equal(members[0].laneId, "plugins");
  });

  test("findCrossTeamBrainstorm() never returns BRAINSTORM · PLUGINS for vibesquad, even if laneId was mutated, and returns it for plugins", () => {
    const members = resolveAgents([pluginsBrainstorm]);

    assert.equal(findCrossTeamBrainstorm(members, "vibesquad"), null);
    assert.equal(findCrossTeamBrainstorm(members, "vibesquad", "", { includeClosed: true }), null);

    const matchedPlugins = findCrossTeamBrainstorm(members, "plugins");
    assert.ok(matchedPlugins);
    assert.equal(matchedPlugins.agent.id, pluginsBrainstorm.id);

    // Even if a Member had laneId mutated to "vibesquad", explicit labels.lane === "plugins" guards it
    const mutatedMembers = [{ ...members[0], laneId: "vibesquad" }];
    assert.equal(findCrossTeamBrainstorm(mutatedMembers, "vibesquad"), null);
    assert.equal(findCrossTeamBrainstorm(mutatedMembers, "vibesquad", "", { includeClosed: true }), null);

    // Same explicit labels.lane guard in the former-brainstorm fallback
    const formerPluginsAgent = makeAgent({
      id: "former-plugins-bs",
      title: "(old) BRAINSTORM · PLUGINS",
      labels: { team: "plugins", lane: "plugins", lead: "plugins", role: "former-brainstorm" },
      cwd: "C:\\Users\\Fugma\\AppData\\Local\\VibeSquad\\runtime",
      status: "closed",
    });
    const formerMembers = resolveAgents([formerPluginsAgent]);
    assert.equal(findCrossTeamBrainstorm(formerMembers, "vibesquad", "", { includeClosed: true }), null);
    assert.equal(
      findCrossTeamBrainstorm(formerMembers, "plugins", "", { includeClosed: true })?.agent.id,
      formerPluginsAgent.id,
    );
    const mutatedFormerMembers = formerMembers.map((m) => ({ ...m, laneId: "vibesquad" }));
    assert.equal(findCrossTeamBrainstorm(mutatedFormerMembers, "vibesquad", "", { includeClosed: true }), null);
  });

  test("buildTeamViews() does not attach BRAINSTORM · PLUGINS as VibeSquad's RiffBot/hub brainstorm", () => {
    const members = resolveAgents([pluginsBrainstorm]);
    const views = buildTeamViews(members);
    const vsView = views.find((v) => v.team.id === "vibesquad");
    assert.ok(vsView, "Expected vibesquad team view");

    const vsMainLane = vsView.lanes.find((l) => l.lane.id === "vibesquad");
    assert.ok(vsMainLane, "Expected vibesquad hub lane");
    assert.equal(vsMainLane.brainstorm, null);

    for (const laneEntry of vsView.lanes) {
      if (laneEntry.lane.id !== "plugins") {
        assert.notEqual(
          laneEntry.brainstorm?.agent.id,
          pluginsBrainstorm.id,
          `Lane ${laneEntry.lane.id} should not adopt BRAINSTORM · PLUGINS`,
        );
      }
    }
  });
});
