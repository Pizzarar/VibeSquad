import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSchedulesStore, nextCronRun, handleSchedulesApi } from "../server/schedules.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vs-sch-"));
const fakeBackend = () => {
  const calls = [];
  return {
    calls,
    async createAgent(a) { calls.push(["create", a]); return { id: "rn-new1" }; },
    async sendAgentPrompt(id, t) { calls.push(["send", id, t]); },
  };
};
const mk = (over = {}) => {
  const clock = { t: Date.UTC(2026, 0, 1, 0, 0, 0) };
  const backend = over.backend ?? fakeBackend();
  const home = over.home ?? tmp();
  const store = createSchedulesStore({ home, backend, now: () => clock.t });
  return { store, clock, backend, home };
};
const newAgent = { type: "new-agent", config: { provider: "claude", cwd: "/x" } };
const every = { type: "every", everyMs: 60_000 };

test("create/list/get/update/delete CRUD", () => {
  const { store } = mk();
  const s = store.create({ name: "n", prompt: "hi", cadence: every, target: newAgent });
  assert.match(s.id, /^sch-/);
  assert.equal(s.status, "active");
  assert.equal(store.list().length, 1);
  assert.equal(store.get(s.id).backend, "vs");
  const u = store.update({ id: s.id, name: null, prompt: "yo", maxRuns: 3 });
  assert.equal(u.name, undefined);
  assert.equal(u.prompt, "yo");
  assert.equal(u.maxRuns, 3);
  assert.deepEqual(store.delete(s.id), { ok: true });
  assert.equal(store.list().length, 0);
  assert.throws(() => store.get(s.id), /not found/);
});

test("validation rejects bad input", () => {
  const { store } = mk();
  assert.throws(() => store.create({ prompt: "", cadence: every, target: newAgent }), /prompt/);
  assert.throws(() => store.create({ prompt: "x", cadence: { type: "every", everyMs: 5 }, target: newAgent }), /10 seconds/);
  assert.throws(() => store.create({ prompt: "x", cadence: { type: "cron", expression: "61 * * * *" }, target: newAgent }), /outside/);
  assert.throws(() => store.create({ prompt: "x", cadence: every, target: { type: "agent" } }), /target/);
});

test("pause/resume recompute next run", () => {
  const { store, clock } = mk();
  const s = store.create({ prompt: "p", cadence: every, target: newAgent });
  assert.equal(store.pause(s.id).status, "paused");
  assert.equal(store.get(s.id).nextRunAt, null);
  clock.t += 3_600_000;
  const r = store.resume(s.id);
  assert.equal(r.status, "active");
  assert.equal(Date.parse(r.nextRunAt), clock.t + 60_000);
});

test("next-run computation: cron, timezone, dom/dow, impossible dates", () => {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0); // Thu
  assert.equal(nextCronRun("*/15 * * * *", base), base + 15 * 60_000);
  assert.equal(nextCronRun("0 2 * * *", base), Date.UTC(2026, 0, 1, 2, 0));
  assert.equal(nextCronRun("0 9 * * 1", base), Date.UTC(2026, 0, 5, 9, 0)); // next Monday
  assert.equal(nextCronRun("30 4 1 3 *", base), Date.UTC(2026, 2, 1, 4, 30));
  assert.equal(nextCronRun("0 9 * * *", base, "America/New_York"), Date.UTC(2026, 0, 1, 14, 0));
  assert.equal(nextCronRun("0 0 30 2 *", base), null);
});

test("tick fires due schedules once, advances, honours maxRuns", async () => {
  const { store, clock, backend } = mk();
  const s = store.create({ prompt: "go", cadence: every, target: newAgent, maxRuns: 2 });
  assert.deepEqual(await store.tick(), []);
  clock.t += 60_000;
  assert.deepEqual(await store.tick(), [s.id]);
  assert.equal(backend.calls[0][0], "create");
  assert.equal(backend.calls[0][1].initialPrompt, "go");
  assert.equal(backend.calls[0][1].labels.schedule, s.id);
  assert.deepEqual(await store.tick(), []);
  clock.t += 60_000;
  await store.tick();
  const done = store.get(s.id);
  assert.equal(done.runCount, 2);
  assert.equal(done.status, "completed");
  clock.t += 600_000;
  assert.deepEqual(await store.tick(), []);
  assert.equal(backend.calls.length, 2);
});

test("agent and self targets send a message", async () => {
  const { store, backend } = mk();
  const a = store.create({ prompt: "ping", cadence: every, target: { type: "agent", agentId: "rn-a" } });
  const h = store.create({ prompt: "beat", cadence: every, target: { type: "self", agentId: "rn-b" } });
  await store.runOnce(a.id);
  await store.runOnce(h.id);
  assert.deepEqual(backend.calls, [["send", "rn-a", "ping"], ["send", "rn-b", "beat"]]);
});

test("run-once leaves cadence alone and writes a per-schedule log", async () => {
  const { store, clock } = mk();
  const s = store.create({ prompt: "x", cadence: every, target: newAgent });
  const before = store.get(s.id);
  clock.t += 5000;
  const r = await store.runOnce(s.id);
  assert.equal(r.schedule.nextRunAt, before.nextRunAt);
  assert.equal(r.schedule.runCount, 0);
  assert.ok(r.schedule.lastRunAt);
  const logs = store.logs(s.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].ok, true);
  assert.match(logs[0].message, /rn-new1/);
  store.delete(s.id);
  assert.throws(() => store.logs(s.id), /not found/);
});

test("failed runs are logged, not thrown", async () => {
  const backend = { async createAgent() { throw new Error("boom"); }, async sendAgentPrompt() {} };
  const { store } = mk({ backend });
  const s = store.create({ prompt: "x", cadence: every, target: newAgent });
  await store.runOnce(s.id);
  const [l] = store.logs(s.id);
  assert.equal(l.ok, false);
  assert.match(l.error, /boom/);
});

test("restart recovery: next run recomputed from now, missed runs not replayed", async () => {
  const { store, clock, backend, home } = mk();
  const s = store.create({ prompt: "x", cadence: every, target: newAgent });
  const p = store.pause(store.create({ prompt: "p", cadence: every, target: newAgent }).id);
  clock.t += 10 * 3_600_000; // server "down" for 10h
  const store2 = createSchedulesStore({ home, backend, now: () => clock.t });
  store2.recover();
  assert.equal(Date.parse(store2.get(s.id).nextRunAt), clock.t + 60_000);
  assert.equal(store2.get(p.id).status, "paused");
  assert.deepEqual(await store2.tick(), []);
  clock.t += 60_000;
  assert.deepEqual(await store2.tick(), [s.id]);
  assert.equal(backend.calls.length, 1);
});

test("heartbeat cleanup removes only self-targets for that agent", () => {
  const { store } = mk();
  const hb = store.create({ prompt: "b", cadence: every, target: { type: "self", agentId: "rn-1" } });
  const other = store.create({ prompt: "b", cadence: every, target: { type: "self", agentId: "rn-2" } });
  const plain = store.create({ prompt: "b", cadence: every, target: { type: "agent", agentId: "rn-1" } });
  assert.deepEqual(store.deleteHeartbeat("rn-1"), [hb.id]);
  assert.deepEqual(store.list().map((s) => s.id).sort(), [other.id, plain.id].sort());
  assert.deepEqual(store.pruneHeartbeats(["rn-9"]), [other.id]);
  assert.deepEqual(store.list().map((s) => s.id), [plain.id]);
  assert.deepEqual(store.deleteHeartbeat("rn-none"), []);
});

test("atomic write: valid utf8 JSON, no temp files left, survives garbage", () => {
  const { store, home } = mk();
  store.create({ prompt: "é✓", cadence: every, target: newAgent });
  assert.deepEqual(fs.readdirSync(home).filter((n) => n.endsWith(".tmp")), []);
  const data = JSON.parse(fs.readFileSync(path.join(home, "schedules.json"), "utf8"));
  assert.equal(data.schedules[0].prompt, "é✓");
  fs.writeFileSync(path.join(home, "schedules.json"), "{not json", "utf8");
  assert.deepEqual(store.list(), []);
});

test("HTTP routes", async () => {
  const { store } = mk();
  const call = async (method, url, body) => {
    let out;
    await handleSchedulesApi({ method, url }, {}, { store, readBody: async () => body, sendJson: (_r, status, json) => (out = { status, json }) });
    return out;
  };
  const c = await call("POST", "/__vibesquad/schedules", { prompt: "x", cadence: every, target: newAgent });
  assert.equal(c.status, 201);
  const id = c.json.schedule.id;
  assert.equal((await call("GET", "/__vibesquad/schedules")).json.schedules.length, 1);
  assert.equal((await call("POST", `/__vibesquad/schedules/${id}/pause`)).json.schedule.status, "paused");
  assert.equal((await call("POST", `/__vibesquad/schedules/${id}/resume`)).json.schedule.status, "active");
  assert.equal((await call("POST", `/__vibesquad/schedules/${id}/run-once`)).status, 200);
  assert.equal((await call("GET", `/__vibesquad/schedules/${id}/logs`)).json.logs.length, 1);
  assert.equal((await call("GET", "/__vibesquad/schedules/bad..id")).status, 400);
  assert.equal((await call("DELETE", `/__vibesquad/schedules/${id}`)).status, 200);
  assert.equal((await call("GET", `/__vibesquad/schedules/${id}`)).status, 404);
  assert.equal((await call("POST", "/__vibesquad/schedules", { prompt: "" })).status, 400);
});

test("cron DST: steps by local calendar day (America/New_York, 2026-03-08 spring forward / 2026-11-01 fall back)", () => {
  const ny = "America/New_York";
  // Sun Mar 8 00:00 EST (05:00Z) is a 23h day; Monday 00:30 EDT = 04:30Z must not be skipped.
  assert.equal(nextCronRun("30 0 * * 1", Date.UTC(2026, 2, 8, 5, 0), ny), Date.UTC(2026, 2, 9, 4, 30));
  assert.equal(nextCronRun("0 0 * * 1", Date.UTC(2026, 2, 7, 12, 0), ny), Date.UTC(2026, 2, 9, 4, 0));
  // Sun Nov 1 is a 25h day; Monday 00:30 EST = 05:30Z.
  assert.equal(nextCronRun("30 0 * * 1", Date.UTC(2026, 10, 1, 4, 0), ny), Date.UTC(2026, 10, 2, 5, 30));
  assert.equal(nextCronRun("0 0 * * 1", Date.UTC(2026, 9, 31, 12, 0), ny), Date.UTC(2026, 10, 2, 5, 0));
  // Daily 00:30 across the spring-forward day itself.
  assert.equal(nextCronRun("30 0 * * *", Date.UTC(2026, 2, 8, 6, 0), ny), Date.UTC(2026, 2, 9, 4, 30));
});

const agentsBackend = (agents) => ({ ...fakeBackend(), async listAgents() { return agents; } });

test("heartbeats for gone runner agents are pruned from tick; live ones and Paseo ids survive", async () => {
  const agents = [{ id: "rn-live", status: "idle" }, { id: "rn-closed", status: "closed" }, { id: "rn-arch", status: "idle", archivedAt: "x" }];
  const { store, clock } = mk({ backend: agentsBackend(agents) });
  const self = (agentId) => store.create({ prompt: "b", cadence: every, target: { type: "self", agentId } });
  const live = self("rn-live");
  self("rn-closed");
  self("rn-arch");
  self("rn-missing");
  const paseo = self("paseo-uuid");
  clock.t += 30_000;
  await store.tick();
  assert.deepEqual(store.list().map((s) => s.id).sort(), [live.id, paseo.id].sort());
});

test("pruneDead does nothing when the live list cannot be read", async () => {
  const backend = { ...fakeBackend(), async listAgents() { throw new Error("runner down"); } };
  const { store, clock } = mk({ backend });
  store.create({ prompt: "b", cadence: every, target: { type: "self", agentId: "rn-1" } });
  clock.t += 30_000;
  await store.tick();
  assert.equal(store.list().length, 1);
});

test("RunnerBackend.archiveAgent drops the agent self-heartbeats via the shared store", async () => {
  const home = tmp();
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = home; // sharedSchedules() reads this on first use in this process
  try {
    const { RunnerBackend } = await import("../server/backend/runner-backend.mjs");
    const { sharedSchedules } = await import("../server/schedules.mjs");
    const st = await sharedSchedules();
    const hb = st.create({ prompt: "b", cadence: every, target: { type: "self", agentId: "rn-z" } });
    const keep = st.create({ prompt: "b", cadence: every, target: { type: "self", agentId: "rn-y" } });
    const b = new RunnerBackend({ client: { async request() { return {}; }, async ensureRunning() {} } });
    await b.archiveAgent("rn-z");
    const ids = st.list().map((s) => s.id);
    assert.ok(!ids.includes(hb.id));
    assert.ok(ids.includes(keep.id));
    await b.deleteHeartbeat("rn-y");
    assert.ok(!st.list().some((s) => s.id === keep.id));
  } finally {
    if (prev === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prev;
  }
});

test("new-agent schedules pass role worker plus team/lane from the identity resolver", async () => {
  const backend = fakeBackend();
  const withId = createSchedulesStore({ home: tmp(), backend, resolveIdentity: async (cwd) => (cwd === "/x" ? { team: "t1", lane: "l1" } : null) });
  const s = withId.create({ prompt: "p", cadence: every, target: newAgent });
  await withId.runOnce(s.id);
  const { role, team, lane } = backend.calls[0][1].labels;
  assert.deepEqual({ role, team, lane }, { role: "worker", team: "t1", lane: "l1" });
  const plain = createSchedulesStore({ home: tmp(), backend });
  const s2 = plain.create({ prompt: "p", cadence: every, target: newAgent });
  await plain.runOnce(s2.id);
  assert.equal(backend.calls[1][1].labels.role, "worker");
  assert.equal(backend.calls[1][1].labels.team, undefined);
});

const gate = () => {
  let release;
  const wait = new Promise((r) => (release = r));
  return { wait, release };
};

test("fire: deleting mid-run leaves no orphan log file", async () => {
  const g = gate();
  const backend = { async createAgent() { await g.wait; return { id: "rn-n" }; }, async sendAgentPrompt() {} };
  const { store, home } = mk({ backend });
  const s = store.create({ prompt: "x", cadence: every, target: newAgent });
  const p = store.runOnce(s.id);
  store.delete(s.id);
  g.release();
  await p.catch(() => {});
  assert.equal(fs.existsSync(path.join(home, "schedule-logs", `${s.id}.jsonl`)), false);
  assert.deepEqual(store.list(), []);
});

test("fire: a run-once in flight when the schedule is due is counted, not skipped then refired", async () => {
  const g = gate();
  let n = 0;
  const backend = { async createAgent() { n++; if (n === 1) await g.wait; return { id: `rn-${n}` }; }, async sendAgentPrompt() {} };
  const { store, clock } = mk({ backend });
  const s = store.create({ prompt: "x", cadence: every, target: newAgent });
  const manual = store.runOnce(s.id);
  clock.t += 60_000;
  assert.deepEqual(await store.tick(), [s.id]); // due, but skipped: the manual run is in flight
  g.release();
  await manual;
  const after = store.get(s.id);
  assert.equal(after.runCount, 1);
  assert.equal(Date.parse(after.nextRunAt), clock.t + 60_000);
  assert.equal(n, 1);
  assert.deepEqual(await store.tick(), []);
});

test("runOnCreate with maxRuns 1 runs exactly once and completes", async () => {
  const { store, clock, backend } = mk();
  const s = store.create({ prompt: "x", cadence: every, target: newAgent, maxRuns: 1, runOnCreate: true });
  await new Promise((r) => setTimeout(r, 30));
  clock.t += 600_000;
  await store.tick();
  assert.equal(backend.calls.length, 1);
  const done = store.get(s.id);
  assert.equal(done.runCount, 1);
  assert.equal(done.status, "completed");
});

test("validation: bad expiresAt / maxRuns / never-firing cron are 400s", async () => {
  const { store } = mk();
  const bad = (over) => assert.throws(() => store.create({ prompt: "x", cadence: every, target: newAgent, ...over }), (e) => e.status === 400);
  bad({ expiresAt: "bad" });
  bad({ maxRuns: "abc" });
  bad({ maxRuns: -1 });
  bad({ maxRuns: 1.5 });
  bad({ cadence: { type: "cron", expression: "0 0 30 2 *" } });
  const s = store.create({ prompt: "x", cadence: every, target: newAgent, maxRuns: null });
  assert.equal(s.maxRuns, undefined);
  assert.throws(() => store.update({ id: s.id, expiresAt: "nope" }), (e) => e.status === 400);
  assert.throws(() => store.update({ id: s.id, maxRuns: 0 }), (e) => e.status === 400);
  assert.throws(() => store.update({ id: s.id, cadence: { type: "cron", expression: "0 0 31 2 *" } }), (e) => e.status === 400);
  const http = [];
  await handleSchedulesApi({ method: "POST", url: "/__vibesquad/schedules" }, {}, { store, readBody: async () => ({ prompt: "x", cadence: every, target: newAgent, expiresAt: "bad" }), sendJson: (_r, st) => http.push(st) });
  assert.deepEqual(http, [400]);
});

test("update: extending a completed schedule reactivates it; shrinking an active one finishes it", async () => {
  const { store, clock } = mk();
  const s = store.create({ prompt: "x", cadence: every, target: newAgent, maxRuns: 1 });
  clock.t += 60_000;
  await store.tick();
  assert.equal(store.get(s.id).status, "completed");
  const r = store.update({ id: s.id, maxRuns: 3 });
  assert.equal(r.status, "active");
  assert.equal(Date.parse(r.nextRunAt), clock.t + 60_000);
  assert.equal(store.update({ id: s.id, maxRuns: null }).status, "active");
  const done = store.update({ id: s.id, maxRuns: 1 }); // runCount is already 1
  assert.equal(done.status, "completed");
  assert.equal(done.nextRunAt, null);
  const exp = store.update({ id: s.id, maxRuns: null, expiresAt: new Date(clock.t + 3_600_000).toISOString() });
  assert.equal(exp.status, "active");
  assert.equal(store.update({ id: s.id, expiresAt: new Date(clock.t - 1000).toISOString() }).status, "completed");
  assert.equal(store.update({ id: s.id, name: "renamed" }).status, "completed"); // untouched limits do not resurrect it
});
