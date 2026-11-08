import test from "node:test";
import assert from "node:assert/strict";
import { RunnerBackend } from "../server/backend/runner-backend.mjs";
import { commandAgentVerb, main, runAgentVerb, suggestVerb } from "../cli/vs.mjs";

function createFakeRunnerServer() {
  const calls = [];
  const records = new Map([
    [
      "rn-w1",
      {
        id: "rn-w1",
        provider: "claude",
        model: "claude-sonnet-5-5",
        cwd: "/work",
        status: "running",
        createdAt: 1700000000000,
        updatedAt: 1700000005000,
        meta: {
          title: "Worker 1",
          team: "vibesquad",
          lane: "runner-pilot",
          role: "worker",
          profile: "Implement - Sonnet",
        },
      },
    ],
    [
      "rn-w2",
      {
        id: "rn-w2",
        provider: "claude",
        model: "claude-sonnet-5-5",
        cwd: "/work",
        status: "idle",
        createdAt: 1700000001000,
        updatedAt: 1700000006000,
        meta: {
          title: "Other Lane Worker",
          team: "vibesquad",
          lane: "bug-chaser",
          role: "worker",
          profile: "Implement - Sonnet",
        },
      },
    ],
    [
      "rn-arch",
      {
        id: "rn-arch",
        provider: "claude",
        model: "claude-sonnet-5-5",
        cwd: "/work",
        status: "exited",
        archivedAt: 1700000009000,
        meta: {
          title: "Archived Worker",
          team: "vibesquad",
          lane: "runner-pilot",
          role: "worker",
        },
      },
    ],
  ]);

  const events = [
    { seq: 0, ts: 1700000000000, type: "input", text: "first prompt" },
    { seq: 1, ts: 1700000001000, type: "output", text: "first reply" },
    { seq: 2, ts: 1700000002000, type: "turn_done" },
    { seq: 3, ts: 1700000003000, type: "input", text: "second prompt" },
    { seq: 4, ts: 1700000004000, type: "output", text: "second reply" },
  ];

  const client = {
    async requireRunning() {},
    async request(method, route, body) {
      calls.push({ method, route, body });
      if (method === "GET" && route === "/agents?full=1") {
        return { ids: [...records.keys()], agents: [...records.values()] };
      }
      const mAgent = /^\/agents\/([^/]+)$/.exec(route);
      if (method === "GET" && mAgent) {
        const id = decodeURIComponent(mAgent[1]);
        const rec = records.get(id);
        if (!rec) throw new Error(`no such agent: ${id}`);
        return rec;
      }
      const mTimeline = /^\/agents\/([^/]+)\/timeline$/.exec(route);
      if (method === "GET" && mTimeline) {
        const id = decodeURIComponent(mTimeline[1]);
        if (!records.has(id)) throw new Error(`no such agent: ${id}`);
        return { events };
      }
      const mAction = /^\/agents\/([^/]+)\/(cancel|archive)$/.exec(route);
      if (method === "POST" && mAction) {
        const id = decodeURIComponent(mAction[1]);
        const action = mAction[2];
        const rec = records.get(id);
        if (!rec) throw new Error(`no such agent: ${id}`);
        if (action === "cancel") rec.status = "idle";
        if (action === "archive") rec.archivedAt = 1700000010000;
        return { ok: true };
      }
      throw new Error(`unexpected ${method} ${route}`);
    },
  };

  const backend = new RunnerBackend({
    client,
    buildPrefix: async () => "",
    whosHere: () => {},
    hooks: false,
  });
  backend.deleteHeartbeat = async () => {};

  const makeContext = ({ identity } = {}) => ({
    identity: identity ?? { agentId: "rn-lead", team: "vibesquad", lane: "runner-pilot", role: "lead" },
    withBackend: (_opts, fn) => fn(backend),
  });

  return { calls, records, backend, makeContext };
}

function captureCli(argv) {
  let stdout = "";
  let stderr = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => {
    stdout += String(chunk);
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr += String(chunk);
    return true;
  };
  try {
    const code = main(argv);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

test("vs --help lists ls, logs, inspect, stop, and archive", () => {
  const { code, stdout } = captureCli(["--help"]);
  assert.equal(code, 0);
  for (const verb of ["vs ls", "vs logs <agent>", "vs inspect <agent>", "vs stop <agent>", "vs archive <agent>"]) {
    assert.ok(stdout.includes(verb), `missing "${verb}" in --help`);
  }
});

test("vs ls lists live agents in the caller's lane via GET /agents?full=1", async () => {
  const srv = createFakeRunnerServer();
  let out = "";
  const code = await commandAgentVerb("ls", { _: [], lane: "runner-pilot", team: "vibesquad" }, srv.makeContext, (s) => {
    out += s;
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, [
    {
      id: "rn-w1",
      title: "Worker 1",
      status: "running",
      role: "worker",
      profile: "Implement - Sonnet",
    },
  ]);
  assert.deepEqual(srv.calls, [{ method: "GET", route: "/agents?full=1", body: undefined }]);
});

test("vs inspect <id> fetches the full agent record via GET /agents/:id", async () => {
  const srv = createFakeRunnerServer();
  let out = "";
  const code = await commandAgentVerb("inspect", { _: ["rn-w1"] }, srv.makeContext, (s) => {
    out += s;
  });
  assert.equal(code, 0);
  const agent = JSON.parse(out);
  assert.equal(agent.id, "rn-w1");
  assert.equal(agent.title, "Worker 1");
  assert.equal(agent.status, "running");
  assert.equal(agent.provider, "claude");
  assert.equal(agent.labels.lane, "runner-pilot");
  assert.equal(agent.labels.role, "worker");
  assert.deepEqual(srv.calls, [{ method: "GET", route: "/agents/rn-w1", body: undefined }]);
});

test("vs logs <id> fetches timeline entries via GET /agents/:id/timeline and honors --limit", async () => {
  const srv = createFakeRunnerServer();
  let out = "";
  const code = await commandAgentVerb("logs", { _: ["rn-w1"] }, srv.makeContext, (s) => {
    out += s;
  });
  assert.equal(code, 0);
  const full = JSON.parse(out);
  assert.equal(full.id, "rn-w1");
  assert.equal(full.entries.length, 4);
  assert.deepEqual(
    full.entries.map((e) => [e.item.type, e.item.text]),
    [
      ["user_message", "first prompt"],
      ["assistant_message", "first reply"],
      ["user_message", "second prompt"],
      ["assistant_message", "second reply"],
    ],
  );

  const tail = await runAgentVerb("logs", { _: ["rn-w1"], limit: "2" }, srv.makeContext());
  assert.equal(tail.entries.length, 2);
  assert.equal(tail.hasOlder, true);
  assert.deepEqual(
    tail.entries.map((e) => [e.item.type, e.item.text]),
    [
      ["user_message", "second prompt"],
      ["assistant_message", "second reply"],
    ],
  );

  await assert.rejects(runAgentVerb("logs", { _: ["rn-w1"], limit: "0" }, srv.makeContext()), /--limit must be a positive integer/);
});

test("vs stop <id> and vs archive <id> hit POST /agents/:id/cancel and /archive for a single id only", async () => {
  const srv = createFakeRunnerServer();
  let stopOut = "";
  const stopCode = await commandAgentVerb("stop", { _: ["rn-w1"] }, srv.makeContext, (s) => {
    stopOut += s;
  });
  assert.equal(stopCode, 0);
  assert.deepEqual(JSON.parse(stopOut), { id: "rn-w1", cancelled: true });
  assert.deepEqual(srv.calls, [{ method: "POST", route: "/agents/rn-w1/cancel", body: {} }]);

  srv.calls.length = 0;
  let archOut = "";
  const archCode = await commandAgentVerb("archive", { _: ["rn-w1"] }, srv.makeContext, (s) => {
    archOut += s;
  });
  assert.equal(archCode, 0);
  const archParsed = JSON.parse(archOut);
  assert.equal(archParsed.id, "rn-w1");
  assert.equal(archParsed.archived, true);
  assert.ok(archParsed.archivedAt);
  assert.ok(srv.calls.some((c) => c.method === "POST" && c.route === "/agents/rn-w1/archive"));

  // Never act on 0 or multiple ids
  srv.calls.length = 0;
  for (const verb of ["stop", "archive", "inspect", "logs"]) {
    await assert.rejects(commandAgentVerb(verb, { _: [] }, srv.makeContext, () => {}), new RegExp(`usage: vs ${verb} <agent>`));
    await assert.rejects(commandAgentVerb(verb, { _: ["rn-w1", "rn-w2"] }, srv.makeContext, () => {}), new RegExp(`usage: vs ${verb} <agent>`));
    await assert.rejects(runAgentVerb(verb, { _: [] }, srv.makeContext()), new RegExp(`usage: vs ${verb} <agent>`));
    await assert.rejects(runAgentVerb(verb, { _: ["rn-w1", "rn-w2"] }, srv.makeContext()), new RegExp(`usage: vs ${verb} <agent>`));
  }
  assert.equal(srv.calls.length, 0, "rejected multi-id/empty calls must not touch the backend");
});

test("unknown verb prints closest-match hint and exits non-zero", () => {
  const cases = [
    ["lss", "ls"],
    ["list", "ls"],
    ["hwo", "who"],
    ["insepct", "inspect"],
    ["stpo", "stop"],
    ["cancel", "stop"],
    ["archvie", "archive"],
    ["lgos", "logs"],
    ["spwan", "spawn"],
    ["statu", "status"],
  ];
  for (const [bad, expected] of cases) {
    assert.equal(suggestVerb(bad), expected, `suggestVerb(${bad})`);
    const { code, stderr } = captureCli([bad]);
    assert.equal(code, 1, `exit code for ${bad}`);
    assert.match(stderr, new RegExp(`unknown verb "${bad}", did you mean "${expected}"\\?`));
  }

  const none = captureCli(["zzzzzzzzzz"]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /unknown verb "zzzzzzzzzz"\. Try "vs --help"\./);
});
