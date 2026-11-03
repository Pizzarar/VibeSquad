// R2-5 security fixes: spawn routes closed, vibeMode & registry pinning, required laneId, size caps,
// per-endpoint write rate limits, and response/error path scrubbing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
} from "../plugin/server/remote-proxy-rules.ts";
import { makeVsHttpHandler } from "../plugin/server/remote-proxy.ts";

describe("1. Spawn endpoints remain closed remotely", () => {
  test("inbox/open-topic and brainstorm-restart are closed with documented reasons", () => {
    for (const p of ["/__vibesquad/inbox/open-topic", "/__vibesquad/brainstorm-restart"]) {
      assert.equal(isAllowedRoute("POST", p), false, p);
      assert.equal(decideProxyRequest("POST", p).ok, false, p);
      assert.equal(decideProxyRequest("POST", p).code, "not-allowed", p);
      assert.equal(REMOTE_ALLOW[p], undefined, p);
      assert.equal(REMOTE_BODY_POLICY[p], undefined, p);
      assert.equal(WRITE_SCHEMAS[p], undefined, p);
      assert.ok(REMOTE_WRITES_CLOSED[p], p);
      assert.equal(checkRemoteBody("POST", p, '{"cardId":"idea-1"}').status, 403, p);
    }
    assert.match(REMOTE_WRITES_CLOSED["/__vibesquad/inbox/open-topic"], /Spawns a live Buddy agent on the host/);
    assert.match(REMOTE_WRITES_CLOSED["/__vibesquad/brainstorm-restart"], /Spawns a replacement Buddy agent on the host/);
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

  test("scrubResponseBody strips path and teamLogPath on writes and scrubs >= 400 error bodies", async () => {
    const h = mkdtempSync(join(tmpdir(), "vs-remote-writes-"));
    const token = "b".repeat(64);
    writeFileSync(join(h, "local-token"), token);
    writeFileSync(join(h, "settings.json"), JSON.stringify({ userName: "Owner", remote: { enabled: true } }));

    const srv = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/teams" && req.method === "GET") {
        return res.end(JSON.stringify({ teams: [{ id: "sq", name: "Squad", lanes: [{ id: "l1", name: "L1" }] }], revision: "r1" }));
      }
      if (req.url === "/__vibesquad/vs-log") {
        return res.end(
          JSON.stringify({
            ok: true,
            path: "C:\\Users\\Owner\\.vibesquad\\logs\\sq--l1.jsonl",
            teamLogPath: "C:\\Users\\Owner\\proj\\.vibesquad\\log.jsonl",
          }),
        );
      }
      res.statusCode = 500;
      res.end(
        JSON.stringify({
          ok: false,
          error: "Failed at /Users/owner/secret/server.js",
          path: "/Users/owner/secret/server.js",
          cwd: "/Users/owner/secret",
          worktree: "/Users/owner/wt",
          stack: "Error: Failed\n    at /Users/owner/secret/server.js:10:2",
        }),
      );
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    try {
      const handler = makeVsHttpHandler({ port, home: h });
      const okRes = await handler({
        method: "POST",
        path: "/__vibesquad/vs-log",
        body: JSON.stringify({ teamId: "sq", laneId: "l1", text: "hello" }),
      });
      assert.equal(okRes.status, 200);
      assert.deepEqual(JSON.parse(okRes.body), { ok: true });

      const errRes = await handler({
        method: "POST",
        path: "/__vibesquad/inbox",
        body: JSON.stringify({ teamId: "sq", laneId: "l1", text: "idea" }),
      });
      assert.equal(errRes.status, 500);
      assert.deepEqual(JSON.parse(errRes.body), {
        ok: false,
        error: "Failed at [redacted-path]",
      });
    } finally {
      srv.closeAllConnections?.();
      await new Promise((r) => srv.close(r));
      rmSync(h, { recursive: true, force: true });
    }
  });
});
