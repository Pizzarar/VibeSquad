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
