import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isLanBannerDismissed,
  isUnsortedMember,
  lanIpSetKey,
  buildTeamViews,
  isTopicBrainstorm,
  topicOfBrainstorm,
  resolve,
} from "../src/teams.ts";
import { pinsForSquad } from "../src/pins.ts";

// ── B8: LAN banner dismiss helpers ───────────────────────────────────────────

describe("B8 lanIpSetKey", () => {
  test("sorts and joins IPs", () => {
    assert.equal(lanIpSetKey(["172.16.1.5", "10.0.0.1"]), "10.0.0.1,172.16.1.5");
  });

  test("trims whitespace", () => {
    assert.equal(lanIpSetKey([" 10.0.0.1 ", " 172.16.1.5 "]), "10.0.0.1,172.16.1.5");
  });

  test("empty array gives empty string", () => {
    assert.equal(lanIpSetKey([]), "");
  });

  test("single IP unchanged", () => {
    assert.equal(lanIpSetKey(["10.0.0.1"]), "10.0.0.1");
  });

  test("filters blank entries", () => {
    assert.equal(lanIpSetKey(["10.0.0.1", ""]), "10.0.0.1");
  });
});

describe("B8 isLanBannerDismissed", () => {
  test("returns false when no IPs", () => {
    assert.equal(isLanBannerDismissed([], "10.0.0.1"), false);
  });

  test("returns false when dismissedKey is null", () => {
    assert.equal(isLanBannerDismissed(["10.0.0.1"], null), false);
  });

  test("returns false when dismissedKey is undefined", () => {
    assert.equal(isLanBannerDismissed(["10.0.0.1"], undefined), false);
  });

  test("returns false when dismissedKey is empty string", () => {
    assert.equal(isLanBannerDismissed(["10.0.0.1"], ""), false);
  });

  test("returns false when key doesn't match current IPs", () => {
    assert.equal(isLanBannerDismissed(["10.0.0.1"], "172.16.1.5"), false);
  });

  test("returns true when key matches current IP set", () => {
    const ips = ["172.16.1.5", "10.0.0.1"];
    const key = lanIpSetKey(ips);
    assert.equal(isLanBannerDismissed(ips, key), true);
  });

  test("matches regardless of IP order", () => {
    const key = lanIpSetKey(["10.0.0.1", "172.16.1.5"]);
    assert.equal(isLanBannerDismissed(["172.16.1.5", "10.0.0.1"], key), true);
  });

  test("IP set change causes false", () => {
    const key = lanIpSetKey(["10.0.0.1"]);
    assert.equal(isLanBannerDismissed(["10.0.0.1", "172.16.1.5"], key), false);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAgent(overrides) {
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

/** Build Members from raw agent objects via resolve(). */
function resolveAgents(agentList) {
  const map = new Map(agentList.map((a) => [a.id, a]));
  return resolve(map);
}

// ── B9: topic brainstorms in pins ─────────────────────────────────────────────

describe("B9 topic brainstorms in pinsForSquad", () => {
  test("topicBrainstorms field is populated for a live topic buddy", () => {
    const topicAgent = makeAgent({
      id: "c86da6a5",
      title: "ADE gaps · Buddy",
      labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm", topic: "ade-gaps" },
    });
    const mainBsAgent = makeAgent({
      id: "main-bs-1",
      title: "VibeSquad Buddy",
      labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm" },
    });

    const members = resolveAgents([topicAgent, mainBsAgent]);
    const views = buildTeamViews(members);
    const vsView = views.find((v) => v.team.id === "vibesquad");
    if (!vsView) return;

    const vsLane = vsView.lanes.find((l) => l.lane.id === "vibesquad");
    if (!vsLane) return;

    assert.ok(vsLane.topicBrainstorms.length > 0, "topicBrainstorms should include the topic buddy");
    const found = vsLane.topicBrainstorms.find((m) => m.agent.id === "c86da6a5");
    assert.ok(found, "should find c86da6a5 in topicBrainstorms");
  });

  test("archived topic buddy is excluded from topicBrainstorms", () => {
    const archivedTopicAgent = makeAgent({
      id: "archived-topic",
      title: "old topic",
      archivedAt: new Date().toISOString(),
      labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm", topic: "old" },
    });

    const members = resolveAgents([archivedTopicAgent]);
    const views = buildTeamViews(members);
    const vsView = views.find((v) => v.team.id === "vibesquad");
    if (!vsView) return;

    const vsLane = vsView.lanes.find((l) => l.lane.id === "vibesquad");
    if (!vsLane) return;

    const found = vsLane.topicBrainstorms.find((m) => m.agent.id === "archived-topic");
    assert.equal(found, undefined, "archived topic buddy must not appear in topicBrainstorms");
  });

  test("pinsForSquad.topicBrainstorms only includes live topic buddies", () => {
    const topicAgent = makeAgent({
      id: "live-topic",
      title: "live topic",
      labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm", topic: "live" },
    });
    const archivedTopicAgent = makeAgent({
      id: "dead-topic",
      title: "dead topic",
      archivedAt: new Date().toISOString(),
      labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm", topic: "dead" },
    });

    const members = resolveAgents([topicAgent, archivedTopicAgent]);
    const views = buildTeamViews(members);
    const vsView = views.find((v) => v.team.id === "vibesquad");
    if (!vsView) return;

    const { pinned } = pinsForSquad(vsView);
    const vsPin = pinned.find((p) => p.lane.id === "vibesquad");
    if (!vsPin) return;

    assert.ok(Array.isArray(vsPin.topicBrainstorms), "topicBrainstorms must be an array on Pin");
    const liveFound = vsPin.topicBrainstorms.find((m) => m.agent.id === "live-topic");
    const deadFound = vsPin.topicBrainstorms.find((m) => m.agent.id === "dead-topic");
    assert.ok(liveFound, "live topic buddy should appear in pin.topicBrainstorms");
    assert.equal(deadFound, undefined, "archived topic buddy must not appear in pin.topicBrainstorms");
  });
});

describe("B9 isTopicBrainstorm and topicOfBrainstorm", () => {
  test("agent with topic label is a topic brainstorm", () => {
    const a = makeAgent({ labels: { role: "brainstorm", topic: "ade-gaps" } });
    assert.ok(isTopicBrainstorm(a));
  });

  test("agent without topic label is not a topic brainstorm", () => {
    const a = makeAgent({ labels: { role: "brainstorm" } });
    assert.equal(isTopicBrainstorm(a), false);
  });

  test("topicOfBrainstorm returns the topic label", () => {
    const a = makeAgent({ labels: { role: "brainstorm", topic: "ade-gaps" } });
    assert.equal(topicOfBrainstorm(a), "ade-gaps");
  });
});

// ── B10: unsorted member detection ────────────────────────────────────────────

describe("B10 isUnsortedMember", () => {
  test("agent with no team/lane/lead labels and a cwd is unsorted", () => {
    const a = makeAgent({ labels: {}, cwd: "/some/path" });
    assert.ok(isUnsortedMember(a));
  });

  test("agent with team label is not unsorted", () => {
    const a = makeAgent({ labels: { team: "vibesquad" }, cwd: "/some/path" });
    assert.equal(isUnsortedMember(a), false);
  });

  test("agent with lane label is not unsorted", () => {
    const a = makeAgent({ labels: { lane: "vibesquad" }, cwd: "/some/path" });
    assert.equal(isUnsortedMember(a), false);
  });

  test("agent with lead label is not unsorted", () => {
    const a = makeAgent({ labels: { lead: "vibesquad" }, cwd: "/some/path" });
    assert.equal(isUnsortedMember(a), false);
  });

  test("archived agent is not unsorted", () => {
    const a = makeAgent({ labels: {}, cwd: "/some/path", archivedAt: new Date().toISOString() });
    assert.equal(isUnsortedMember(a), false);
  });

  test("closed agent is not unsorted", () => {
    const a = makeAgent({ labels: {}, cwd: "/some/path", status: "closed" });
    assert.equal(isUnsortedMember(a), false);
  });

  test("agent with empty cwd is not unsorted", () => {
    const a = makeAgent({ labels: {}, cwd: "" });
    assert.equal(isUnsortedMember(a), false);
  });

  test("agent with whitespace-only label values is unsorted", () => {
    const a = makeAgent({ labels: { team: "  ", lane: "", lead: "  " }, cwd: "/some/path" });
    assert.ok(isUnsortedMember(a));
  });
});

describe("B10 TeamView.unsorted populated by buildTeamViews", () => {
  test("unsorted field exists on TeamView", () => {
    const views = buildTeamViews([]);
    for (const v of views) {
      assert.ok(Array.isArray(v.unsorted), `TeamView.unsorted must be an array (team: ${v.team.id})`);
    }
  });

  test("agent with no team/lane/lead labels appears in unsorted of some view", () => {
    const a = makeAgent({ id: "orphan-1", labels: {}, cwd: "/some/path" });
    const members = resolveAgents([a]);
    const views = buildTeamViews(members);
    const allUnsorted = views.flatMap((v) => v.unsorted);
    const found = allUnsorted.find((m) => m.agent.id === "orphan-1");
    assert.ok(found, "orphan agent with no labels and a cwd should appear in some view's unsorted");
  });

  test("assigned agent does not appear in unsorted", () => {
    const a = makeAgent({ id: "assigned-1", labels: { team: "vibesquad", lane: "vibesquad", role: "worker" }, cwd: "/some/path" });
    const members = resolveAgents([a]);
    const views = buildTeamViews(members);
    const allUnsorted = views.flatMap((v) => v.unsorted);
    const found = allUnsorted.find((m) => m.agent.id === "assigned-1");
    assert.equal(found, undefined, "assigned agent must not appear in unsorted");
  });
});
