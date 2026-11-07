// R2-5 security fixes: spawn routes closed, vibeMode & registry pinning, required laneId, size caps,
// per-endpoint write rate limits, and response/error path scrubbing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  ENDPOINT_WRITE_LIMITS_PER_MIN,
  PINNED_LANE_KEYS,
  PINNED_TEAM_KEYS,
  REMOTE_ALLOW,
  REMOTE_BODY_POLICY,
  REMOTE_WRITES_CLOSED,
  WRITE_SCHEMAS,
  checkLaneExists,
  checkRemoteBody,
  checkRemoteRegistry,
  createRateLimiter,
  decideProxyRequest,
  isAllowedRoute,
  pinTeamsRegistry,
  redactBody,
  scrubResponseBody,
} from "../server/hooks/remote-proxy-rules.ts";

// Mock-Paseo-daemon tests: the runner has a single owner and is never lazily started, so pin every lane to Paseo (as 35e895e did for 11 other suites).
process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;

describe("1. Spawn endpoints: open-topic stays closed; Buddy start/restart and handoff POST reopen (Block 4)", () => {
  const disk = { teams: [{ id: "sq", name: "Squad", lanes: [{ id: "lane1", name: "One", lastProfile: "Brainstorm - Gemini" }] }] };
  const OK_BODIES = [
    ["/__vibesquad/brainstorm-restart", { reason: "start-brainstorm", mode: "quick-start", teamId: "sq", laneId: "lane1", laneName: "One" }],
    ["/__vibesquad/brainstorm-restart", { reason: "manual", teamId: "sq", laneId: "lane1", agentId: "bs-1", usedTokens: 50000 }],
    ["/__vibesquad/handoff", { team: "sq", lane: "lane1", agentId: "lead-1" }],
  ];

  test("inbox/open-topic is still closed with its documented reason", () => {
    const p = "/__vibesquad/inbox/open-topic";
    assert.equal(isAllowedRoute("POST", p), false);
    assert.equal(decideProxyRequest("POST", p).code, "not-allowed");
    assert.equal(REMOTE_ALLOW[p], undefined);
    assert.equal(REMOTE_BODY_POLICY[p], undefined);
    assert.equal(WRITE_SCHEMAS[p], undefined);
    assert.equal(checkRemoteBody("POST", p, '{"cardId":"idea-1"}').status, 403);
    assert.match(REMOTE_WRITES_CLOSED[p], /Spawns a live Buddy agent on the host/);
    for (const q of ["/__vibesquad/lead-handoff", "/__vibesquad/lead-handoff/confirm"]) assert.ok(REMOTE_WRITES_CLOSED[q], q);
    for (const q of ["/__vibesquad/brainstorm-restart", "/__vibesquad/handoff"]) assert.equal(REMOTE_WRITES_CLOSED[q], undefined, q);
  });

  test("brainstorm-restart and handoff POST are open with a lane-registry body policy and 5/min limits", () => {
    assert.deepEqual([...REMOTE_ALLOW["/__vibesquad/brainstorm-restart"]], ["POST"]);
    assert.deepEqual([...REMOTE_ALLOW["/__vibesquad/handoff"]], ["GET", "POST"]);
    for (const p of ["/__vibesquad/brainstorm-restart", "/__vibesquad/handoff"]) {
      assert.equal(decideProxyRequest("POST", p).ok, true, p);
      assert.equal(REMOTE_BODY_POLICY[p].registry, "lane", p);
      assert.equal(ENDPOINT_WRITE_LIMITS_PER_MIN[`POST ${p}`], 5, p);
    }
    assert.deepEqual(REMOTE_BODY_POLICY["/__vibesquad/brainstorm-restart"].require, ["laneId"]);
    assert.deepEqual(REMOTE_BODY_POLICY["/__vibesquad/handoff"].require, ["team", "lane"]);
  });

  test("the UI's bodies pass checkRemoteBody and checkRemoteRegistry", () => {
    for (const [p, body] of OK_BODIES) {
      assert.deepEqual(checkRemoteBody("POST", p, JSON.stringify(body)), { ok: true, value: body }, p);
      assert.deepEqual(checkRemoteRegistry(p, body, disk), { ok: true, value: body }, p);
    }
  });

  test("spawn config, prompt text, bad enums and unknown lanes are refused", () => {
    for (const [p, body] of OK_BODIES) {
      for (const k of ["profile", "cwd", "provider", "pendingPrompt", "summaryUpdate"]) {
        const r = checkRemoteBody("POST", p, JSON.stringify({ ...body, [k]: "x" }));
        assert.equal(r.status, 403, `${p} ${k}`);
        assert.match(r.error, new RegExp(`body key not allowed remotely: ${k}`));
      }
    }
    // `model` / `modeId` / `thinkingOptionId` are the one carve-out: allowlisted on brainstorm-restart for a
    // staged provider switch, but still refused on handoff (which does not list them).
    const BR = "/__vibesquad/brainstorm-restart";
    for (const body of OK_BODIES.filter(([p]) => p === BR).map(([, b]) => b)) {
      assert.deepEqual(
        checkRemoteBody("POST", BR, JSON.stringify({ ...body, model: "gemini-3.8-flash", modeId: "auto", thinkingOptionId: "high" })),
        { ok: true, value: { ...body, model: "gemini-3.8-flash", modeId: "auto", thinkingOptionId: "high" } },
      );
    }
    for (const k of ["model", "modeId", "thinkingOptionId"]) {
      const r = checkRemoteBody("POST", "/__vibesquad/handoff", JSON.stringify({ team: "sq", lane: "lane1", agentId: "lead-1", [k]: "x" }));
      assert.equal(r.status, 403, `handoff ${k}`);
      assert.match(r.error, new RegExp(`key not allowed remotely: body.${k}`));
    }
    assert.equal(checkRemoteBody("POST", BR, JSON.stringify({ reason: "auto-hard-limit", laneId: "lane1" })).status, 403);
    assert.equal(checkRemoteBody("POST", BR, JSON.stringify({ reason: "manual", mode: "full", laneId: "lane1" })).status, 403);
    assert.equal(checkRemoteBody("POST", BR, JSON.stringify({ reason: "start-brainstorm" })).status, 403);
    assert.equal(checkRemoteBody("POST", "/__vibesquad/handoff", JSON.stringify({ team: "sq" })).status, 403);
    assert.equal(checkRemoteRegistry(BR, { teamId: "sq", laneId: "ghost" }, disk).status, 403);
    assert.equal(checkRemoteRegistry(BR, { teamId: "other", laneId: "lane1" }, disk).status, 403);
    assert.equal(checkRemoteRegistry("/__vibesquad/handoff", { team: "sq", lane: "ghost" }, disk).status, 403);
  });

});

describe("2 & 3. PINNED_TEAM_KEYS (vibeMode) and hardened pinTeamsRegistry", () => {
  const disk = {
    teams: [
      {
        id: "alpha",
        name: "Alpha Squad",
        aliases: ["alp"],
        paths: ["C:\\Users\\Owner\\alpha"],
        vibeMode: true,
        extraTeamField: "keep-alpha",
        lanes: [
          {
            id: "lane-a",
            name: "Lane A",
            aliases: ["la"],
            paths: ["C:\\Users\\Owner\\alpha\\a"],
            worktree: "C:\\Users\\Owner\\alpha\\.wt\\a",
            branch: "feat-a",
            cwd: "C:\\Users\\Owner\\alpha\\a",
            lastProfile: "ProfA",
            extraLaneField: "keep-lane-a",
          },
          {
            id: "lane-b",
            name: "Lane B",
          },
        ],
      },
      {
        id: "beta",
        name: "Beta Squad",
        paths: ["C:\\Users\\Owner\\beta"],
        vibeMode: false,
        lanes: [
          {
            id: "lane-c",
            name: "Lane C",
            worktree: "C:\\Users\\Owner\\beta\\.wt\\c",
          },
        ],
      },
    ],
  };
  const redact = (s) => redactBody(s, "C:\\Users\\Owner", "Owner");

  test("vibeMode is pinned on existing teams and forbidden when truthy on new teams", () => {
    assert.deepEqual(PINNED_TEAM_KEYS, ["paths", "path", "vibeMode"]);
    assert.ok(PINNED_LANE_KEYS.includes("worktree") && PINNED_LANE_KEYS.includes("branch") && PINNED_LANE_KEYS.includes("cwd"));

    // Flipping vibeMode on alpha (true -> false) is 403
    const flipOff = pinTeamsRegistry(
      {
        teams: [
          { id: "alpha", vibeMode: false, lanes: [{ id: "lane-a" }, { id: "lane-b" }] },
          { id: "beta", lanes: [{ id: "lane-c" }] },
        ],
        revision: "r1",
      },
      disk,
      redact,
    );
    assert.equal(flipOff.ok, false);
    assert.equal(flipOff.status, 403);
    assert.equal(flipOff.error, "RemoteDenied: team paths and vibeMode are pinned on host");

    // Flipping vibeMode on beta (false -> true) is 403
    const flipOn = pinTeamsRegistry(
      {
        teams: [
          { id: "alpha", lanes: [{ id: "lane-a" }, { id: "lane-b" }] },
          { id: "beta", vibeMode: true, lanes: [{ id: "lane-c" }] },
        ],
        revision: "r1",
      },
      disk,
      redact,
    );
    assert.equal(flipOn.ok, false);
    assert.equal(flipOn.status, 403);
    assert.equal(flipOn.error, "RemoteDenied: team paths and vibeMode are pinned on host");

    // Enabling vibeMode on a new team is 403
    const newTeamVibe = pinTeamsRegistry(
      {
        teams: [
          { id: "alpha", lanes: [{ id: "lane-a" }, { id: "lane-b" }] },
          { id: "beta", lanes: [{ id: "lane-c" }] },
          { id: "gamma", vibeMode: true, lanes: [] },
        ],
        revision: "r1",
      },
      disk,
      redact,
    );
    assert.equal(newTeamVibe.ok, false);
    assert.equal(newTeamVibe.status, 403);
    assert.equal(newTeamVibe.error, "RemoteDenied: new remote teams cannot enable vibeMode");
  });

  test("case-insensitive matching, unknown on-disk fields preserved, pinned lane keys restored", () => {
    const res = pinTeamsRegistry(
      {
        teams: [
          { id: "ALPHA", name: "Alpha Updated", lanes: [{ id: "LANE-A", name: "Lane A2" }, { id: "lane-b" }] },
          { id: "BETA", lanes: [{ id: "LANE-C" }] },
          { id: "gamma", name: "Gamma", vibeMode: false, lanes: [{ id: "lane-d", name: "Lane D" }] },
        ],
        revision: "r1",
      },
      disk,
      redact,
    );
    assert.equal(res.ok, true, res.error);
    const [alpha, beta, gamma] = res.value.teams;
    assert.equal(alpha.id, "alpha");
    assert.equal(alpha.name, "Alpha Updated");
    assert.equal(alpha.vibeMode, true);
    assert.equal(alpha.extraTeamField, "keep-alpha");
    assert.deepEqual(alpha.paths, ["C:\\Users\\Owner\\alpha"]);
    assert.equal(alpha.lanes[0].id, "lane-a");
    assert.equal(alpha.lanes[0].name, "Lane A2");
    assert.equal(alpha.lanes[0].worktree, "C:\\Users\\Owner\\alpha\\.wt\\a");
    assert.equal(alpha.lanes[0].branch, "feat-a");
    assert.equal(alpha.lanes[0].cwd, "C:\\Users\\Owner\\alpha\\a");
    assert.equal(alpha.lanes[0].lastProfile, "ProfA");
    assert.equal(alpha.lanes[0].extraLaneField, "keep-lane-a");
    assert.equal(beta.id, "beta");
    assert.equal(beta.vibeMode, false);
    assert.equal("vibeMode" in gamma, false);
  });

  test("refuses deleting or reordering teams or lanes, caps new teams/lanes, blocks collisions & cross-team moves", () => {
    // Delete team beta
    const dropTeam = pinTeamsRegistry(
      { teams: [{ id: "alpha", lanes: [{ id: "lane-a" }, { id: "lane-b" }] }], revision: "r1" },
      disk,
    );
    assert.deepEqual(dropTeam, {
      ok: false,
      status: 403,
      error: "RemoteDenied: cannot delete teams remotely (set state to removed)",
    });

    // Delete lane-b from alpha
    const dropLane = pinTeamsRegistry(
      {
        teams: [
          { id: "alpha", lanes: [{ id: "lane-a" }] },
          { id: "beta", lanes: [{ id: "lane-c" }] },
        ],
        revision: "r1",
      },
      disk,
    );
    assert.deepEqual(dropLane, {
      ok: false,
      status: 403,
      error: "RemoteDenied: cannot delete lanes remotely (set state to removed)",
    });

    // Reorder teams (beta before alpha)
    const reorderTeams = pinTeamsRegistry(
      {
        teams: [
          { id: "beta", lanes: [{ id: "lane-c" }] },
          { id: "alpha", lanes: [{ id: "lane-a" }, { id: "lane-b" }] },
        ],
        revision: "r1",
      },
      disk,
    );
    assert.deepEqual(reorderTeams, {
      ok: false,
      status: 403,
      error: "RemoteDenied: cannot reorder existing teams remotely",
    });

    // Reorder lanes (lane-b before lane-a)
    const reorderLanes = pinTeamsRegistry(
      {
        teams: [
          { id: "alpha", lanes: [{ id: "lane-b" }, { id: "lane-a" }] },
          { id: "beta", lanes: [{ id: "lane-c" }] },
        ],
        revision: "r1",
      },
      disk,
    );
    assert.deepEqual(reorderLanes, {
      ok: false,
      status: 403,
      error: "RemoteDenied: cannot reorder existing lanes remotely",
    });

    // Cap: > 1 new team
    const twoNewTeams = pinTeamsRegistry(
      {
        teams: [
          { id: "alpha", lanes: [{ id: "lane-a" }, { id: "lane-b" }] },
          { id: "beta", lanes: [{ id: "lane-c" }] },
          { id: "gamma", lanes: [] },
          { id: "delta", lanes: [] },
        ],
        revision: "r1",
      },
      disk,
    );
    assert.deepEqual(twoNewTeams, {
      ok: false,
      status: 403,
      error: "RemoteDenied: at most 1 new team per remote save",
    });

    // Cap: > 3 new lanes
    const fourNewLanes = pinTeamsRegistry(
      {
        teams: [
          { id: "alpha", lanes: [{ id: "lane-a" }, { id: "lane-b" }, { id: "n1" }, { id: "n2" }] },
          { id: "beta", lanes: [{ id: "lane-c" }, { id: "n3" }, { id: "n4" }] },
        ],
        revision: "r1",
      },
      disk,
    );
    assert.deepEqual(fourNewLanes, {
      ok: false,
      status: 403,
      error: "RemoteDenied: at most 3 new lanes per remote save",
    });

    // Cross-team lane collision (moving/copying lane-a or alias "la" into beta)
    const crossTeamMove = pinTeamsRegistry(
      {
        teams: [
          { id: "alpha", lanes: [{ id: "lane-a" }, { id: "lane-b" }] },
          { id: "beta", lanes: [{ id: "lane-c" }, { id: "LA" }] },
        ],
        revision: "r1",
      },
      disk,
    );
    assert.equal(crossTeamMove.ok, false);
    assert.equal(crossTeamMove.status, 403);

    // Modifying an existing lane's aliases or name to match another team's lane id/name/alias is rejected with 403
    for (const badLaneA of [
      { id: "lane-a", aliases: ["lane-c"] },
      { id: "lane-a", aliases: ["Lane C"] },
      { id: "lane-a", name: "lane-c" },
      { id: "lane-a", name: "Lane C" },
    ]) {
      const collideExisting = pinTeamsRegistry(
        {
          teams: [
            { id: "alpha", lanes: [badLaneA, { id: "lane-b" }] },
            { id: "beta", lanes: [{ id: "lane-c" }] },
          ],
          revision: "r1",
        },
        disk,
      );
      assert.deepEqual(collideExisting, {
        ok: false,
        status: 403,
        error: "RemoteDenied: lane id, name, or alias collides with an existing lane",
      });
    }

    // Modifying an existing lane in beta to collide with alpha's existing lane alias "la"
    const collideBetaAlias = pinTeamsRegistry(
      {
        teams: [
          { id: "alpha", lanes: [{ id: "lane-a" }, { id: "lane-b" }] },
          { id: "beta", lanes: [{ id: "lane-c", aliases: ["LA"] }] },
        ],
        revision: "r1",
      },
      disk,
    );
    assert.deepEqual(collideBetaAlias, {
      ok: false,
      status: 403,
      error: "RemoteDenied: lane id, name, or alias collides with an existing lane",
    });

    // Cross-team collision between two newly added aliases in the same payload
    const collideSamePayload = pinTeamsRegistry(
      {
        teams: [
          { id: "alpha", lanes: [{ id: "lane-a", aliases: ["brand-new"] }, { id: "lane-b" }] },
          { id: "beta", lanes: [{ id: "lane-c", aliases: ["BRAND-NEW"] }] },
        ],
        revision: "r1",
      },
      disk,
    );
    assert.deepEqual(collideSamePayload, {
      ok: false,
      status: 403,
      error: "RemoteDenied: lane id, name, or alias collides with an existing lane",
    });

    // Pre-existing shared generic lane name on disk is allowed if unchanged on those lanes, but rejected on another lane
    const sharedDisk = {
      teams: [
        { id: "alpha", lanes: [{ id: "lane-a", name: "main" }, { id: "lane-b", name: "secondary" }] },
        { id: "beta", lanes: [{ id: "lane-c", name: "main" }] },
      ],
    };
    const keepShared = pinTeamsRegistry(
      {
        teams: [
          { id: "alpha", lanes: [{ id: "lane-a", name: "main" }, { id: "lane-b", name: "secondary" }] },
          { id: "beta", lanes: [{ id: "lane-c", name: "main" }] },
        ],
        revision: "r1",
      },
      sharedDisk,
    );
    assert.equal(keepShared.ok, true);

    const stealShared = pinTeamsRegistry(
      {
        teams: [
          { id: "alpha", lanes: [{ id: "lane-a", name: "main" }, { id: "lane-b", name: "main" }] },
          { id: "beta", lanes: [{ id: "lane-c", name: "main" }] },
        ],
        revision: "r1",
      },
      sharedDisk,
    );
    assert.equal(stealShared.ok, false);
    assert.equal(stealShared.status, 403);
  });
});

describe("4 & 5. Required laneId, team-lane verification, and tightened size caps", () => {
  const disk = {
    teams: [
      { id: "alpha", name: "Alpha", lanes: [{ id: "lane-a", aliases: ["la"] }] },
      { id: "beta", name: "Beta", lanes: [{ id: "lane-b" }] },
    ],
  };

  test("checkLaneExists fails closed (400) when laneId/lane is missing, and verifies lane belongs to team", () => {
    assert.deepEqual(checkLaneExists({}, disk), {
      ok: false,
      status: 400,
      error: "BadRequest: laneId is required",
    });
    assert.deepEqual(checkLaneExists({ laneId: "   " }, disk), {
      ok: false,
      status: 400,
      error: "BadRequest: laneId is required",
    });
    assert.deepEqual(checkLaneExists({ teamId: "ghost", laneId: "lane-a" }, disk), {
      ok: false,
      status: 403,
      error: 'RemoteDenied: unknown team "ghost"',
    });
    assert.deepEqual(checkLaneExists({ teamId: "alpha", laneId: "lane-b" }, disk), {
      ok: false,
      status: 403,
      error: 'RemoteDenied: lane "lane-b" does not belong to team "alpha"',
    });
    assert.deepEqual(checkLaneExists({ teamId: "alpha", laneId: "lane-a" }, disk), { ok: true });
    assert.deepEqual(checkLaneExists({ team: "alpha", lane: "LA" }, disk), { ok: true });

    for (const p of [
      "/__vibesquad/brainstorm-summary",
      "/__vibesquad/inbox",
      "/__vibesquad/inbox/triage",
      "/__vibesquad/log",
      "/__vibesquad/vs-log",
    ]) {
      assert.equal(REMOTE_BODY_POLICY[p].registry, "lane", p);
      const r = checkRemoteRegistry(p, { teamId: "alpha", laneId: "lane-b", text: "x" }, disk);
      assert.equal(r.ok, false, p);
      assert.equal(r.status, 403, p);
    }

    // defaultLaneId validation
    assert.deepEqual(checkLaneExists({ teamId: "alpha", laneId: "lane-a", defaultLaneId: "lane-a" }, disk), { ok: true });
    assert.deepEqual(checkLaneExists({ teamId: "alpha", laneId: "lane-a", defaultLaneId: "lane-b" }, disk), {
      ok: false,
      status: 403,
      error: 'RemoteDenied: lane "lane-b" does not belong to team "alpha"',
    });
    assert.deepEqual(checkLaneExists({ laneId: "lane-a", defaultLaneId: "ghost" }, disk), {
      ok: false,
      status: 403,
      error: "RemoteDenied: lane ghost is not in teams.json",
    });

    // ideas[i].laneId / teamId validation
    assert.deepEqual(
      checkLaneExists({ teamId: "alpha", laneId: "lane-a", ideas: [{ text: "ok", laneId: "lane-a" }] }, disk),
      { ok: true },
    );
    assert.deepEqual(
      checkLaneExists({ teamId: "alpha", laneId: "lane-a", ideas: [{ text: "ok", teamId: "beta", laneId: "lane-b" }] }, disk),
      { ok: true },
    );
    assert.deepEqual(
      checkLaneExists({ teamId: "alpha", laneId: "lane-a", ideas: [{ text: "bad", laneId: "lane-b" }] }, disk),
      {
        ok: false,
        status: 403,
        error: 'RemoteDenied: lane "lane-b" does not belong to team "alpha"',
      },
    );
    assert.deepEqual(
      checkLaneExists({ teamId: "alpha", laneId: "lane-a", ideas: [{ text: "bad", teamId: "beta" }] }, disk),
      {
        ok: false,
        status: 403,
        error: 'RemoteDenied: lane "lane-a" does not belong to team "beta"',
      },
    );
    assert.deepEqual(
      checkLaneExists({ laneId: "lane-a", ideas: [{ text: "bad", lane: "ghost" }] }, disk),
      {
        ok: false,
        status: 403,
        error: "RemoteDenied: lane ghost is not in teams.json",
      },
    );
  });

  test("field size caps on brainstorm-summary (19,999) and inbox ideas (max 20, text 5000)", () => {
    assert.equal(
      checkRemoteBody("POST", "/__vibesquad/brainstorm-summary", JSON.stringify({ laneId: "lane-a", content: "a".repeat(19_999), revision: "r" })).ok,
      true,
    );
    assert.equal(
      checkRemoteBody("POST", "/__vibesquad/brainstorm-summary", JSON.stringify({ laneId: "lane-a", content: "a".repeat(20_000), revision: "r" })).status,
      403,
    );
    assert.equal(
      checkRemoteBody("POST", "/__vibesquad/inbox", JSON.stringify({ laneId: "lane-a", ideas: Array(20).fill("idea") })).ok,
      true,
    );
    assert.equal(
      checkRemoteBody("POST", "/__vibesquad/inbox", JSON.stringify({ laneId: "lane-a", ideas: Array(21).fill("idea") })).status,
      403,
    );
    assert.equal(
      checkRemoteBody("POST", "/__vibesquad/inbox", JSON.stringify({ laneId: "lane-a", ideas: ["a".repeat(5000)] })).ok,
      true,
    );
    assert.equal(
      checkRemoteBody("POST", "/__vibesquad/inbox", JSON.stringify({ laneId: "lane-a", ideas: ["a".repeat(5001)] })).status,
      403,
    );
  });
});

describe("6 & 7. Per-endpoint write rate limits and response/error path scrubbing", () => {
  test("createRateLimiter enforces ENDPOINT_WRITE_LIMITS_PER_MIN via check(method, path) and acquire", () => {
    assert.equal(ENDPOINT_WRITE_LIMITS_PER_MIN["POST /api/teams"], 5);
    assert.equal(ENDPOINT_WRITE_LIMITS_PER_MIN["POST /__vibesquad/brainstorm-summary"], 5);
    assert.equal(ENDPOINT_WRITE_LIMITS_PER_MIN["POST /__vibesquad/inbox"], 10);
    assert.equal(ENDPOINT_WRITE_LIMITS_PER_MIN["POST /__vibesquad/inbox/triage"], 10);
    assert.equal(ENDPOINT_WRITE_LIMITS_PER_MIN["POST /__vibesquad/park-topic"], 10);
    assert.equal(ENDPOINT_WRITE_LIMITS_PER_MIN["POST /__vibesquad/handoff-topic"], 10);
    assert.equal(ENDPOINT_WRITE_LIMITS_PER_MIN["POST /__vibesquad/log"], 10);
    assert.equal(ENDPOINT_WRITE_LIMITS_PER_MIN["POST /__vibesquad/vs-log"], 10);

    let now = 10_000;
    const limiter = createRateLimiter({ now: () => now });
    for (let i = 0; i < 5; i++) {
      const r = limiter.check("POST", "/api/teams");
      assert.equal(r.ok, true);
    }
    const sixth = limiter.check("POST", "/api/teams");
    assert.equal(sixth.ok, false);
    assert.equal(sixth.status, 429);
    // Another endpoint still has budget within the global cap
    assert.equal(limiter.check("POST", "/__vibesquad/log").ok, true);
  });

});

describe("Block 4 server side: lane lastProfile, spawn budget, async handoff", () => {
  let api;
  let auth;
  let root;
  let vsHome;
  let srv;
  let port;
  const prevEnv = {};
  const ENV_KEYS = ["VIBESQUAD_HOME", "VIBESQUAD_TEAMS_FILE", "PASEO_HOME", "VS_TEST_PACKET"];
  const owner = () => ({ "x-vibesquad-token": auth.getLocalToken(), "content-type": "application/json" });
  const call = async (path, { method = "GET", body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: owner(), body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  before(async () => {
    for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
    root = mkdtempSync(join(tmpdir(), "vs-b4-root-"));
    vsHome = join(root, ".vibesquad");
    mkdirSync(join(root, "docs", "brainstorm"), { recursive: true });
    writeFileSync(join(root, "docs", "brainstorm", "lane1.md"), "# Brief\n", "utf8");
    const teamsFile = join(root, "teams.json");
    writeFileSync(teamsFile, JSON.stringify({ teams: [{ id: "sq", name: "Squad", paths: ["sq"], lanes: [{ id: "lane1", name: "One", lastProfile: "Brainstorm - Gemini" }] }] }));
    // A `vs handoff` stand-in that writes the packet after 2.6 s, past the 2 s HTTP wait.
    mkdirSync(join(root, "cli"));
    writeFileSync(
      join(root, "cli", "vs.mjs"),
      'import { mkdirSync, writeFileSync } from "node:fs"; import { dirname } from "node:path";\n' +
        "setTimeout(() => { const p = process.env.VS_TEST_PACKET; mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, '# packet'); }, 3500);\n",
    );
    process.env.VIBESQUAD_HOME = vsHome;
    process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
    process.env.PASEO_HOME = join(root, ".paseo");
    process.env.VS_TEST_PACKET = join(vsHome, "teams", "sq", "packet-lane1.md");
    auth = await import("../server/auth.mjs");
    api = await import("../server/vibesquad-api.mjs");
    srv = createServer(api.createVibesquadMiddleware(root));
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    port = srv.address().port;
  });
  after(async () => {
    srv?.closeAllConnections?.();
    if (srv) await new Promise((r) => srv.close(r));
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("performBrainstormRestart takes the lane's lastProfile from teams.json when body.profile is omitted", async () => {
    const profilesPath = join(vsHome, "profiles.json");
    api.seedDefaultPack(profilesPath);
    api.resetBrainstormRestartState();
    const created = [];
    const daemonClient = {
      async fetchAgents() {
        return [];
      },
      async createAgent(req) {
        created.push(req);
        return { id: `new-${created.length}`, labels: req.labels };
      },
      async archiveAgent() {},
      async updateAgent() {},
      async cancelAgent() {},
    };
    const res = await api.performBrainstormRestart(
      { reason: "start-brainstorm", mode: "quick-start", teamId: "sq", laneId: "lane1", laneName: "One", daemonClient, profilesPath },
      root,
    );
    assert.equal(created.length, 1);
    assert.equal(created[0].labels.profile, "Brainstorm - Gemini");
    assert.equal(res.profile, "Brainstorm - Gemini");
    const gemini = api.loadProfiles(profilesPath).profiles.find((p) => p.name === "Brainstorm - Gemini");
    assert.equal(created[0].config.provider, api.toPaseoSpawnConfig(gemini).provider);
  });

  test("spawnBudget: start and restart are refused with 429 once 10 spawns landed this minute", async () => {
    api.spawnBudget.reset();
    api.archiveBudget.reset();
    try {
      assert.equal(api.SPAWN_BUDGET_PER_MIN, 10);
      for (let i = 0; i < api.SPAWN_BUDGET_PER_MIN; i++) assert.equal(api.spawnBudget.take(), true);
      const start = await call("/__vibesquad/brainstorm-restart", { method: "POST", body: { reason: "start-brainstorm", teamId: "sq", laneId: "lane1" } });
      assert.equal(start.status, 429);
      assert.match(start.body.error, /too many agent spawns: 10 per minute/);
      const restart = await call("/__vibesquad/brainstorm-restart", { method: "POST", body: { reason: "manual", teamId: "sq", laneId: "lane1", agentId: "bs-1" } });
      assert.equal(restart.status, 429);
      assert.match(restart.body.error, /too many agent spawns/);
    } finally {
      api.spawnBudget.reset();
      api.archiveBudget.reset();
    }
  });

  test("POST /handoff answers 202 when vs handoff outlives the 2 s wait; GET reports running, then the packet", async () => {
    assert.equal(api.HANDOFF_HTTP_WAIT_MS, 2000);
    const t0 = Date.now();
    const post = await call("/__vibesquad/handoff", { method: "POST", body: { team: "sq", lane: "lane1", agentId: "lead-1" } });
    assert.equal(post.status, 202, JSON.stringify(post.body));
    assert.ok(Date.now() - t0 < 6000, "answered well under the 10 s proxy timeout");
    assert.equal(post.body.accepted, true);
    assert.equal(post.body.running, true);
    assert.equal(post.body.exists, false);
    const mid = await call("/__vibesquad/handoff?team=sq&lane=lane1");
    assert.equal(mid.body.running, true);
    let done = mid;
    for (let i = 0; i < 40 && done.body.running; i++) {
      await new Promise((r) => setTimeout(r, 250));
      done = await call("/__vibesquad/handoff?team=sq&lane=lane1");
    }
    assert.equal(done.status, 200);
    assert.equal(done.body.running, false);
    assert.equal(done.body.exists, true);
    assert.equal(done.body.error, undefined);
  });
});
