import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { PARENT_LABEL } from "../server/detach-children.mjs";
import {
  JANITOR_MAX_AGE_MS,
  createJanitorMiddleware,
  findJanitorCandidates,
  findStalledWorkers,
  handleJanitorRun,
  isJanitorCandidate,
  runSessionJanitor,
} from "../server/session-janitor.mjs";

const BASE_NOW = Date.parse("2026-11-02T12:00:00.000Z");
const THREE_HOURS_AGO = new Date(BASE_NOW - 3 * 3600_000).toISOString();
const EXACTLY_TWO_HOURS_AGO = new Date(BASE_NOW - 2 * 3600_000).toISOString();
const ONE_HOUR_AGO = new Date(BASE_NOW - 1 * 3600_000).toISOString();

describe("session-janitor · candidate selection", () => {
  it("selects only closed role=worker agents older than maxAgeMs", () => {
    const staleWorker = {
      id: "w-stale",
      status: "closed",
      labels: { role: "worker" },
      updatedAt: THREE_HOURS_AGO,
    };
    const exactBoundaryWorker = {
      id: "w-boundary",
      status: "closed",
      labels: { role: "Worker" },
      closedAt: EXACTLY_TWO_HOURS_AGO,
    };
    const recentWorker = {
      id: "w-recent",
      status: "closed",
      labels: { role: "worker" },
      updatedAt: ONE_HOUR_AGO,
    };
    const runningWorker = {
      id: "w-running",
      status: "running",
      labels: { role: "worker" },
      updatedAt: THREE_HOURS_AGO,
    };
    const idleWorker = {
      id: "w-idle",
      status: "idle",
      labels: { role: "worker" },
      updatedAt: THREE_HOURS_AGO,
    };
    const archivedWorker = {
      id: "w-archived",
      status: "closed",
      archivedAt: ONE_HOUR_AGO,
      labels: { role: "worker" },
      updatedAt: THREE_HOURS_AGO,
    };
    const closedLead = {
      id: "lead-closed",
      status: "closed",
      labels: { role: "lead" },
      updatedAt: THREE_HOURS_AGO,
    };
    const closedBuddy = {
      id: "buddy-closed",
      status: "closed",
      labels: { role: "brainstorm" },
      updatedAt: THREE_HOURS_AGO,
    };

    assert.equal(isJanitorCandidate(staleWorker, { now: BASE_NOW }), true);
    assert.equal(isJanitorCandidate(exactBoundaryWorker, { now: BASE_NOW }), true);
    assert.equal(isJanitorCandidate(recentWorker, { now: BASE_NOW }), false);
    assert.equal(isJanitorCandidate(runningWorker, { now: BASE_NOW }), false);
    assert.equal(isJanitorCandidate(idleWorker, { now: BASE_NOW }), false);
    assert.equal(isJanitorCandidate(archivedWorker, { now: BASE_NOW }), false);
    assert.equal(isJanitorCandidate(closedLead, { now: BASE_NOW }), false);
    assert.equal(isJanitorCandidate(closedBuddy, { now: BASE_NOW }), false);
    assert.equal(isJanitorCandidate(null, { now: BASE_NOW }), false);

    // Support maxAgeMs = 0 for manual cleanup of all closed workers
    assert.equal(isJanitorCandidate(recentWorker, { now: BASE_NOW, maxAgeMs: 0 }), true);
    assert.equal(isJanitorCandidate(closedLead, { now: BASE_NOW, maxAgeMs: 0 }), false);

    const list = [
      staleWorker,
      exactBoundaryWorker,
      recentWorker,
      runningWorker,
      idleWorker,
      archivedWorker,
      closedLead,
      closedBuddy,
    ];
    const candidates = findJanitorCandidates(list, { now: BASE_NOW });
    assert.deepEqual(
      candidates.map((c) => c.id),
      ["w-stale", "w-boundary"],
    );
  });
});

describe("session-janitor · stalled workers", () => {
  const w = (id, status, ts, extra = {}) => ({ id, status, labels: { role: "worker" }, updatedAt: ts, ...extra });
  const FIVE_MIN_AGO = new Date(BASE_NOW - 5 * 60_000).toISOString();

  it("flags queued-never-started and silent running workers only", () => {
    const list = [
      w("q-stalled", "queued", ONE_HOUR_AGO),
      w("q-fresh", "queued", FIVE_MIN_AGO),
      w("r-stalled", "running", THREE_HOURS_AGO),
      w("r-active", "running", THREE_HOURS_AGO, { lastActivityAt: FIVE_MIN_AGO }),
      w("closed", "closed", THREE_HOURS_AGO),
      w("idle", "idle", THREE_HOURS_AGO),
      w("archived", "running", THREE_HOURS_AGO, { archivedAt: ONE_HOUR_AGO }),
      { id: "lead", status: "running", labels: { role: "lead" }, updatedAt: THREE_HOURS_AGO },
    ];
    assert.deepEqual(findStalledWorkers(list, { now: BASE_NOW }), [
      { id: "q-stalled", status: "queued", silentMs: 3600_000 },
      { id: "r-stalled", status: "running", silentMs: 3 * 3600_000 },
    ]);
  });

  it("surfaces stalled workers in the janitor result without archiving them", async () => {
    const archivedIds = [];
    const agents = [w("q-stalled", "queued", ONE_HOUR_AGO)];
    const fakeClient = {
      fetchAgents: async () => ({ entries: agents, pageInfo: { hasMore: false } }),
      detachAgent: async () => {},
      archiveAgent: async (id) => archivedIds.push(id),
    };
    const res = await runSessionJanitor(fakeClient, { now: BASE_NOW });
    assert.deepEqual(res.stalled, [{ id: "q-stalled", status: "queued", silentMs: 3600_000 }]);
    assert.deepEqual(archivedIds, []);
  });
});

describe("session-janitor · runSessionJanitor", () => {
  it("detaches live children before archiving and leaves closed children alone", async () => {
    const callOrder = [];
    const agents = [
      {
        id: "w-parent",
        status: "closed",
        labels: { role: "worker" },
        updatedAt: THREE_HOURS_AGO,
      },
      {
        id: "child-live",
        status: "running",
        labels: { role: "worker", [PARENT_LABEL]: "w-parent" },
        updatedAt: ONE_HOUR_AGO,
      },
      {
        id: "child-closed",
        status: "closed",
        labels: { role: "worker", [PARENT_LABEL]: "w-parent" },
        updatedAt: ONE_HOUR_AGO,
      },
      {
        id: "lead-closed",
        status: "closed",
        labels: { role: "lead" },
        updatedAt: THREE_HOURS_AGO,
      },
    ];

    const fakeClient = {
      fetchAgents: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false } }),
      detachAgent: async (id) => {
        callOrder.push(`detach:${id}`);
      },
      archiveAgent: async (id) => {
        callOrder.push(`archive:${id}`);
      },
    };

    const res = await runSessionJanitor(fakeClient, { now: BASE_NOW, maxAgeMs: JANITOR_MAX_AGE_MS });
    assert.equal(res.ok, true);
    assert.equal(res.scanned, 4);
    assert.equal(res.candidates, 1);
    assert.deepEqual(res.archived, ["w-parent"]);
    assert.deepEqual(res.detachedChildren, ["child-live"]);
    assert.deepEqual(res.skipped, []);
    assert.deepEqual(res.errors, []);
    assert.deepEqual(callOrder, ["detach:child-live", "archive:w-parent"]);
  });

  it("skips archiving a worker when detaching its live child fails", async () => {
    const archivedIds = [];
    const agents = [
      {
        id: "w-unsafe",
        status: "closed",
        labels: { role: "worker" },
        updatedAt: THREE_HOURS_AGO,
      },
      {
        id: "child-live-fail",
        status: "idle",
        labels: { role: "lead", [PARENT_LABEL]: "w-unsafe" },
        updatedAt: ONE_HOUR_AGO,
      },
    ];

    const fakeClient = {
      fetchAgents: async () => ({ entries: agents, pageInfo: { hasMore: false } }),
      detachAgent: async () => {
        throw new Error("daemon detach refused");
      },
      archiveAgent: async (id) => {
        archivedIds.push(id);
      },
    };

    const res = await runSessionJanitor(fakeClient, { now: BASE_NOW });
    assert.equal(res.ok, true);
    assert.deepEqual(res.archived, []);
    assert.equal(archivedIds.length, 0);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].id, "w-unsafe");
    assert.equal(res.skipped[0].reason, "detach-failed");
    assert.equal(res.skipped[0].failed[0].id, "child-live-fail");
  });
});

describe("session-janitor · HTTP endpoint /__vibesquad/janitor/run", () => {
  it("serves GET preview without archiving and POST execution with optional maxAgeMs", async () => {
    const archivedIds = [];
    const agents = [
      {
        id: "w-old",
        status: "closed",
        labels: { role: "worker" },
        updatedAt: THREE_HOURS_AGO,
      },
      {
        id: "w-fresh",
        status: "closed",
        labels: { role: "worker" },
        updatedAt: ONE_HOUR_AGO,
      },
    ];

    const fakeClient = {
      fetchAgents: async () => ({ entries: agents, pageInfo: { hasMore: false } }),
      detachAgent: async () => {},
      archiveAgent: async (id) => {
        archivedIds.push(id);
      },
    };

    const mw = createJanitorMiddleware({ client: fakeClient, now: () => BASE_NOW });
    const server = http.createServer((req, res) => {
      mw(req, res, () => {
        res.writeHead(404);
        res.end("not found");
      });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // 1. GET preview only reports w-old and does not archive
      const getRes = await fetch(`${baseUrl}/__vibesquad/janitor/run`);
      assert.equal(getRes.status, 200);
      const getBody = await getRes.json();
      assert.equal(getBody.ok, true);
      assert.equal(getBody.candidates, 1);
      assert.deepEqual(getBody.candidateIds, ["w-old"]);
      assert.deepEqual(archivedIds, []);

      // 2. POST default archives w-old
      const postRes = await fetch(`${baseUrl}/__vibesquad/janitor/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(postRes.status, 200);
      const postBody = await postRes.json();
      assert.equal(postBody.ok, true);
      assert.deepEqual(postBody.archived, ["w-old"]);
      assert.deepEqual(archivedIds, ["w-old"]);

      // 3. POST with maxAgeMs = 0 archives both closed workers
      archivedIds.length = 0;
      const postAllRes = await fetch(`${baseUrl}/__vibesquad/janitor/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxAgeMs: 0 }),
      });
      assert.equal(postAllRes.status, 200);
      const postAllBody = await postAllRes.json();
      assert.deepEqual(postAllBody.archived, ["w-old", "w-fresh"]);
      assert.deepEqual(archivedIds, ["w-old", "w-fresh"]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
