// PLAN_X1_IDENTITY X1a guard tests ("403 on spoof"): the per-agent token the runner mints, the admin/agent split on the
// runner API, the scope rules for agent callers, and "the token never lands on disk or in a log".
// Fake adapters, in-process runner + HTTP server on an ephemeral port, temp dirs only: nothing touches ~/.vibesquad.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Runner, agentEnv, agentMay, protectedMetaIn, spawnMetaForAgent } from "../runner/runner.mjs";
import { createServer as createRunnerServer, hubLaneReader, writeDiscovery } from "../runner/server.mjs";
import { createClaudeAdapter } from "../runner/adapters/claude.mjs";
import { createAcpAdapter } from "../runner/adapters/acp.mjs";
import { LogStore, redactSecrets } from "../runner/log.mjs";
import { RunnerClient, RunnerHttpError, agentCallerFromEnv, authHeadersFor } from "../server/backend/runner-client.mjs";
import * as runnerClientModule from "../server/backend/runner-client.mjs";
import { RunnerBackend } from "../server/backend/runner-backend.mjs";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p = "vs-auth-") => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error("timed out"); await tick(10); } };
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const close = (srv) => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });
const ADMIN = "adm1n-t0k";

/** Fake provider: records the env of every start, counts cancels, parks (session) and reports a turn on demand. */
function fakeAdapter() {
  const starts = [];
  const adapter = {
    canPark: true,
    start({ id, env, emit, resume }) {
      const rec = { id, env, resume, emit, cancels: 0, killed: 0 };
      starts.push(rec);
      setImmediate(() => emit("session", { sessionId: `sess-${id}` }));
      return {
        pid: 5000 + starts.length,
        ready: Promise.resolve(),
        send(text) { emit("status", { status: "running" }); if (!String(text).startsWith("HOLD:")) { emit("output", { text: `echo:${text}` }); emit("status", { status: "idle" }); } },
        cancel() { rec.cancels += 1; },
        kill() { rec.killed += 1; },
      };
    },
  };
  return { adapter, starts };
}

/** A runner + server with a Squad: Overlord (hub lane = team id), lane Buddy, lane lead, two lane workers, a second Squad's worker. */
async function squad({ parkGraceMs = 60_000 } = {}) {
  const dir = path.join(tmp(), "agents");
  const fake = fakeAdapter();
  const runner = new Runner({ dir, adapters: { claude: fake.adapter }, parkGraceMs, bgProbe: null });
  const mk = (meta, extra = {}) => runner.create({ provider: "claude", cwd: process.cwd(), meta, ...extra });
  const ids = {
    overlord: mk({ team: "sq", lane: "sq", role: "lead", labels: {} }),
    buddy: mk({ team: "sq", lane: "art", role: "brainstorm", labels: { topic: "art" } }),
    lead: mk({ team: "sq", lane: "art", role: "lead", labels: {} }),
    other: mk({ team: "sq", lane: "ui", role: "lead", labels: {} }),
  };
  ids.worker = mk({ team: "sq", lane: "art", role: "worker", labels: { "vs.parent": ids.lead } });
  ids.worker2 = mk({ team: "sq", lane: "art", role: "worker", labels: { "vs.parent": ids.other } }); // spawned by another lead
  ids.uiWorker = mk({ team: "sq", lane: "ui", role: "worker", labels: { "vs.parent": ids.other } });
  ids.foreign = mk({ team: "other-squad", lane: "other-squad", role: "lead", labels: {} });
  const srv = createRunnerServer(runner, { token: ADMIN, hash: "h", onShutdown: () => { srv.shutdowns = (srv.shutdowns ?? 0) + 1; } });
  const port = await listen(srv);
  const hdr = (who) => (who === "admin" ? { authorization: `Bearer ${ADMIN}` } : who === "none" ? {} : { "x-vs-agent-id": who.id, "x-vs-agent-token": who.token ?? runner.tokensById.get(who.id) });
  const call = async (who, method, route, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { ...hdr(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* SSE / empty */ }
    return { status: r.status, body: json, text };
  };
  const as = (id) => ({ id });
  const stop = async () => { await close(srv); runner.shutdown(); };
  return { dir, runner, fake, ids, srv, port, call, as, stop };
}

test("X1a: every route refuses x-vs-agent-id with a wrong or missing token (403), whatever else the request carries", async () => {
  const s = await squad();
  try {
    const { ids } = s;
    const startsBefore = s.fake.starts.length; // setup starts one child per agent
    const routes = [
      ["GET", "/health"], ["GET", "/verify-agent"], ["POST", "/shutdown", {}], ["GET", "/events"], ["GET", "/agents"], ["POST", "/agents", { provider: "claude", cwd: process.cwd() }],
      ["GET", `/agents/${ids.worker}`], ["GET", `/agents/${ids.worker}/timeline`], ["POST", `/agents/${ids.worker}/input`, { text: "x" }], ["POST", `/agents/${ids.worker}/resume`, {}],
      ["POST", `/agents/${ids.worker}/unwedge`, {}], ["POST", `/agents/${ids.worker}/cancel`, {}], ["POST", `/agents/${ids.worker}/meta`, { title: "t" }],
      ["POST", `/agents/${ids.worker}/config`, { model: "m" }], ["POST", `/agents/${ids.worker}/archive`, {}], ["POST", `/agents/${ids.worker}/unarchive`, {}],
    ];
    for (const [method, route, body] of routes) {
      for (const bad of [{ id: ids.lead, token: "nope" }, { id: ids.lead, token: "" }, { id: "rn-ghost", token: "nope" }]) {
        const r = await s.call(bad, method, route, body);
        assert.equal(r.status, 403, `${method} ${route} with ${JSON.stringify(bad)} → ${r.status} ${r.text}`);
      }
      // A valid admin bearer does not rescue a bad agent header: agent headers win and are verified.
      const r = await fetch(`http://127.0.0.1:${s.port}${route}`, { method, headers: { authorization: `Bearer ${ADMIN}`, "x-vs-agent-id": ids.lead, "x-vs-agent-token": "nope", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      assert.equal(r.status, 403, `${method} ${route} bearer + bad agent token`);
      await r.text();
    }
    assert.equal(s.fake.starts.length, startsBefore, "nothing was created or started by a spoofed call");
    assert.equal(s.runner.list().length, Object.keys(ids).length, "no agent was created by a spoofed call");
  } finally { await s.stop(); }
});

test("X1a: the admin bearer without agent headers keeps today's behaviour on every route; no bearer at all is 401", async () => {
  const s = await squad();
  try {
    const { ids } = s;
    const want = [
      ["GET", "/health", 200], ["GET", "/agents", 200], ["GET", `/agents/${ids.worker}`, 200], ["GET", `/agents/${ids.worker}/timeline`, 200],
      ["POST", `/agents/${ids.worker}/meta`, 202, { role: "lead", labels: { digestFor: "x" } }],
      ["POST", `/agents/${ids.worker}/input`, 202, { text: "HOLD: hi", owner: true }], ["POST", `/agents/${ids.worker}/cancel`, 202, {}], ["POST", `/agents/${ids.worker}/config`, 202, { model: "m2" }],
      ["POST", `/agents/${ids.uiWorker}/archive`, 202, {}], ["POST", `/agents/${ids.uiWorker}/unarchive`, 202, {}], ["POST", `/agents/${ids.uiWorker}/resume`, 202, {}], ["POST", "/agents/rn-nope/resume", 404, {}],
      ["POST", `/agents/rn-nope/unwedge`, 404, {}], ["POST", "/agents", 201, { provider: "claude", cwd: process.cwd(), meta: { role: "lead", lane: "new", team: "sq" } }],
      ["GET", "/verify-agent", 400], ["POST", "/nope", 404], ["POST", "/shutdown", 202, {}],
    ];
    for (const [method, route, status, body] of want) {
      const r = await s.call("admin", method, route, body);
      assert.equal(r.status, status, `${method} ${route} → ${r.status} ${r.text}`);
    }
    await tick(5);
    assert.equal(s.srv.shutdowns, 1, "admin shutdown is served");
    const tl = await s.call("admin", "GET", `/agents/${ids.worker}/timeline`);
    const input = tl.body.events.find((e) => e.type === "input");
    assert.equal(input.owner, true, "admin input keeps the body's owner flag");
    assert.equal(input.senderId, undefined);
    assert.equal(s.runner.status(ids.worker).meta.role, "lead", "admin meta may relabel");
    for (const [method, route, body] of [["GET", "/health"], ["POST", `/agents/${ids.worker}/input`, { text: "x" }]]) {
      assert.equal((await s.call("none", method, route, body)).status, 401, `${route} without any credential`);
    }
  } finally { await s.stop(); }
});

test("X1a: GET /verify-agent: a parked agent (> park grace idle) verifies with its meta; archived / former-lead / exited / orphan ids are 403", async () => {
  const s = await squad({ parkGraceMs: 30 });
  try {
    const { ids, runner } = s;
    runner.send(ids.worker, "work");
    await until(() => runner.status(ids.worker).status === "parked", 3000);
    assert.equal(runner.live.has(ids.worker), false, "parked: no longer live");
    const r = await s.call(s.as(ids.worker), "GET", "/verify-agent");
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, { id: ids.worker, role: "worker", lane: "art", team: "sq", profile: null, digest: false, digestFor: null, status: "parked", overlord: false });
    const o = await s.call(s.as(ids.overlord), "GET", "/verify-agent");
    assert.equal(o.body.overlord, true, "a lead on the hub lane (lane id = team id) is the Overlord");
    assert.equal((await s.call(s.as(ids.lead), "GET", "/verify-agent")).body.overlord, false);
    const digest = runner.create({ provider: "claude", cwd: process.cwd(), meta: { team: "sq", lane: "art", role: "worker", profile: "Pre-check - Flash", labels: { digestFor: ids.worker } } });
    const d = await s.call(s.as(digest), "GET", "/verify-agent");
    assert.equal(d.body.digest, true);
    assert.equal(d.body.digestFor, ids.worker);
    // Gone or retired: 403 even with the right token.
    runner.archive(ids.worker2);
    assert.equal((await s.call(s.as(ids.worker2), "GET", "/verify-agent")).status, 403, "archived");
    runner.unarchive(ids.worker2);
    assert.equal((await s.call(s.as(ids.worker2), "GET", "/verify-agent")).status, 200, "unarchived again");
    runner.updateMeta(ids.other, { role: "former-lead" });
    assert.equal((await s.call(s.as(ids.other), "GET", "/verify-agent")).status, 403, "former-lead");
    runner.updateMeta(ids.uiWorker, { labels: { orphan: "1" } });
    assert.equal((await s.call(s.as(ids.uiWorker), "GET", "/verify-agent")).status, 403, "orphan");
    runner.store.append(ids.buddy, "exit", { code: 0 });
    assert.equal((await s.call(s.as(ids.buddy), "GET", "/verify-agent")).status, 403, "exited");
    // A live lead mid-handoff keeps its identity: the handoff-* / vs.handoff-from labels are not retirement (lead-handoff.mjs:659, 1110).
    runner.updateMeta(ids.lead, { labels: { "handoff-nudged": "1", "vs.handoff-from": "rn-old" } });
    assert.equal((await s.call(s.as(ids.lead), "GET", "/verify-agent")).status, 200, "a lead with handoff markers is still live");
  } finally { await s.stop(); }
});

test("X1a: input: another Squad's token → 403; same Squad → 202 with senderId = caller and owner false even when the body says owner:true", async () => {
  const s = await squad();
  try {
    const { ids, runner } = s;
    assert.equal((await s.call(s.as(ids.foreign), "POST", `/agents/${ids.worker}/input`, { text: "hi", owner: true })).status, 403);
    const r = await s.call(s.as(ids.worker), "POST", `/agents/${ids.lead}/input`, { text: "report", owner: true, senderId: ids.overlord });
    assert.equal(r.status, 202, r.text);
    assert.equal(r.body.senderId, ids.worker);
    const input = runner.timeline(ids.lead).find((e) => e.type === "input");
    assert.equal(input.text, "report");
    assert.equal(input.owner, undefined, "owner is never taken from an agent's body");
    assert.equal(input.senderId, ids.worker, "senderId is the verified caller, not the body's");
    assert.equal((await s.call(s.as(ids.worker), "POST", "/agents/rn-missing/input", { text: "x" })).status, 404);
  } finally { await s.stop(); }
});

test("X1a: a worker's input with activeTurnBehavior:interrupt on its lead does not cancel the lead's turn; a lead's interrupt on its worker does", async () => {
  const s = await squad();
  try {
    const { ids, runner, fake } = s;
    runner.send(ids.lead, "HOLD: long turn"); // stays running
    runner.send(ids.worker, "HOLD: long turn");
    await tick(30);
    assert.equal(runner.live.get(ids.lead).status, "running");
    const r = await s.call(s.as(ids.worker), "POST", `/agents/${ids.lead}/input`, { text: "steer me", activeTurnBehavior: "interrupt" });
    assert.equal(r.status, 202, r.text);
    const leadRec = fake.starts.find((x) => x.id === ids.lead);
    assert.equal(leadRec.cancels, 0, "the lead's turn was not cancelled");
    assert.equal(runner.timeline(ids.lead).some((e) => e.type === "cancel"), false);
    const r2 = await s.call(s.as(ids.lead), "POST", `/agents/${ids.worker}/input`, { text: "stop that", activeTurnBehavior: "interrupt" });
    assert.equal(r2.status, 202, r2.text);
    assert.equal(fake.starts.find((x) => x.id === ids.worker).cancels, 1, "a lead may interrupt its lane worker");
  } finally { await s.stop(); }
});

test("X1a: cancel: worker on its lead → 403; lead on its lane worker → 202; self → 202; Overlord on any Squad agent → 202; worker on a foreign lane worker → 403", async () => {
  const s = await squad();
  try {
    const { ids, runner } = s;
    for (const id of [ids.lead, ids.worker, ids.worker2, ids.uiWorker, ids.overlord]) runner.send(id, "HOLD: turn");
    await tick(30);
    assert.equal((await s.call(s.as(ids.worker), "POST", `/agents/${ids.lead}/cancel`, {})).status, 403);
    assert.equal((await s.call(s.as(ids.worker), "POST", `/agents/${ids.uiWorker}/cancel`, {})).status, 403);
    assert.equal((await s.call(s.as(ids.worker), "POST", `/agents/${ids.worker}/cancel`, {})).status, 202, "self");
    assert.equal((await s.call(s.as(ids.lead), "POST", `/agents/${ids.worker2}/cancel`, {})).status, 202, "lead on a lane worker it did not spawn");
    assert.equal((await s.call(s.as(ids.lead), "POST", `/agents/${ids.uiWorker}/cancel`, {})).status, 403, "lead on another lane's worker");
    assert.equal((await s.call(s.as(ids.lead), "POST", `/agents/${ids.overlord}/cancel`, {})).status, 403, "lead on the Overlord");
    assert.equal((await s.call(s.as(ids.overlord), "POST", `/agents/${ids.lead}/cancel`, {})).status, 202, "Overlord on a Squad lead");
    assert.equal((await s.call(s.as(ids.overlord), "POST", `/agents/${ids.foreign}/cancel`, {})).status, 403, "Overlord on another Squad");
  } finally { await s.stop(); }
});

test("X1a: POST /agents from an agent: lead spawns need a Buddy (own lane) or the Overlord (its Squad) and a leadless lane; brainstorm is 403; everything else is a worker in the caller's lane with vs.parent", async () => {
  const s = await squad();
  try {
    const { ids, runner } = s;
    const spawn = (who, meta) => s.call(s.as(who), "POST", "/agents", { provider: "claude", cwd: process.cwd(), meta });
    assert.equal((await spawn(ids.worker, { role: "lead", lane: "art", team: "sq" })).status, 403, "worker + role lead");
    assert.equal((await spawn(ids.worker, { labels: { role: "lead" } })).status, 403, "worker + labels.role lead (both shapes are enforced)");
    assert.equal((await spawn(ids.lead, { role: "lead", lane: "ui" })).status, 403, "a non-hub lead may not spawn leads");
    assert.equal((await spawn(ids.buddy, { role: "lead", lane: "art" })).status, 403, "Buddy + role lead while the lane has a live lead");
    for (const who of [ids.worker, ids.lead, ids.buddy, ids.overlord]) {
      assert.equal((await spawn(who, { role: "brainstorm", lane: "art" })).status, 403, "role brainstorm");
      assert.equal((await spawn(who, { profile: "Brainstorm - Claude", lane: "art" })).status, 403, "Brainstorm profile");
      assert.equal((await spawn(who, { profile: "Pre-check - Flash", labels: { digestFor: ids.worker } })).status, 403, "Pre-check profile");
    }
    runner.updateMeta(ids.lead, { role: "former-lead" }); // the lane is now leadless
    const b = await spawn(ids.buddy, { role: "lead", lane: "art", team: "other-squad", labels: { ord: "9", digestFor: "x", "vs.parent": ids.foreign, "vs.handoff-from": "y", "vs.auto-archived": "1", job: "ship" } });
    assert.equal(b.status, 201, b.text);
    const newLead = runner.status(b.body.id).meta;
    assert.equal(newLead.role, "lead");
    assert.equal(newLead.lane, "art");
    assert.equal(newLead.team, "sq", "team is the caller's, never the body's");
    assert.deepEqual(newLead.labels, { role: "lead", lane: "art", team: "sq", "vs.parent": ids.buddy, job: "ship" }, "ord/digestFor/handoff/auto-archived stripped, parent = Buddy");
    assert.equal(newLead.ord, undefined);
    assert.equal((await spawn(ids.buddy, { role: "lead", lane: "art" })).status, 403, "the lane has a live lead again");
    runner.updateMeta(ids.other, { role: "former-lead" });
    const o = await spawn(ids.overlord, { role: "lead", lane: "ui" });
    assert.equal(o.status, 201, "Overlord + role lead on another lane of its Squad");
    assert.equal(runner.status(o.body.id).meta.labels["vs.parent"], ids.overlord);
    assert.equal((await spawn(ids.overlord, { role: "lead", lane: "sq" })).status, 403, "the Overlord's own lane already has one (itself)");
    const w = await spawn(ids.worker, { lane: "ui", team: "other-squad", labels: { role: "", profile: "Implement - Opus" } });
    assert.equal(w.status, 201, w.text);
    const worker = runner.status(w.body.id).meta;
    assert.equal(worker.role, "worker");
    assert.equal(worker.lane, "art", "a worker's spawn lands in the caller's lane");
    assert.equal(worker.team, "sq");
    assert.equal(worker.labels["vs.parent"], ids.worker);
    assert.equal(worker.labels.profile, "Implement - Opus");
    const ow = await spawn(ids.overlord, { lane: "ui", role: "worker" });
    assert.equal(runner.status(ow.body.id).meta.lane, "ui", "the Overlord may place a worker on another lane of its Squad");
  } finally { await s.stop(); }
});

test("X1a: archive/unarchive/resume/meta/config scope: a lead on a lane worker spawned by another lead → 202; a worker on its lead → 403; config on self → 202", async () => {
  const s = await squad();
  try {
    const { ids, runner } = s;
    runner.archive(ids.worker2);
    assert.equal((await s.call(s.as(ids.worker), "POST", `/agents/${ids.worker2}/unarchive`, {})).status, 403, "a worker may not unarchive a peer");
    assert.equal((await s.call(s.as(ids.lead), "POST", `/agents/${ids.worker2}/unarchive`, {})).status, 202, "lead unarchives a lane worker it did not spawn (revive-on-send)");
    assert.equal(runner.status(ids.worker2).archivedAt, null);
    assert.equal((await s.call(s.as(ids.worker), "POST", `/agents/${ids.lead}/archive`, {})).status, 403);
    assert.equal((await s.call(s.as(ids.lead), "POST", `/agents/${ids.overlord}/archive`, {})).status, 403);
    assert.equal((await s.call(s.as(ids.lead), "POST", `/agents/${ids.uiWorker}/archive`, {})).status, 403, "another lane's worker");
    assert.equal((await s.call(s.as(ids.overlord), "POST", `/agents/${ids.uiWorker}/archive`, {})).status, 202, "the Overlord on any Squad worker");
    assert.equal((await s.call(s.as(ids.overlord), "POST", `/agents/${ids.lead}/archive`, {})).status, 403, "but not on a lead");
    assert.equal((await s.call(s.as(ids.worker), "POST", `/agents/${ids.lead}/resume`, {})).status, 403);
    assert.equal((await s.call(s.as(ids.worker), "POST", `/agents/${ids.lead}/config`, { model: "m" })).status, 403);
    assert.equal((await s.call(s.as(ids.worker), "POST", `/agents/${ids.worker}/config`, { model: "m" })).status, 202, "config on self");
    assert.equal((await s.call(s.as(ids.lead), "POST", `/agents/${ids.worker2}/meta`, { title: "renamed", labels: { job: "x" } })).status, 202, "unprotected meta on a lane worker");
    assert.equal(runner.status(ids.worker2).meta.title, "renamed");
    assert.equal((await s.call(s.as(ids.worker), "POST", `/agents/${ids.worker2}/meta`, { title: "nope" })).status, 403, "a worker may not relabel a peer");
    assert.equal((await s.call(s.as(ids.worker), "POST", `/agents/${ids.worker}/meta`, { title: "me" })).status, 403, "nor itself (meta is for parents/leads)");
  } finally { await s.stop(); }
});

test("X1a: meta {role:lead} / {labels:{digestFor}} / handoff / vs.parent with an agent token → 403 (even the Overlord on its own child), with admin → 202", async () => {
  const s = await squad();
  try {
    const { ids, runner } = s;
    const child = runner.create({ provider: "claude", cwd: process.cwd(), meta: { team: "sq", lane: "sq", role: "worker", labels: { "vs.parent": ids.overlord } } });
    const patches = [{ role: "lead" }, { labels: { role: "lead" } }, { lane: "sq" }, { team: "x" }, { ord: "1" }, { profile: "Lead - Claude" }, { labels: { digestFor: "rn-x" } }, { labels: { "vs.parent": ids.worker } },
      { labels: { "vs.handoff-from": "rn-x" } }, { labels: { "handoff-flagged": "1" } }, { labels: { orphan: "" } }, { labels: { "vs.auto-archived": "" } }, { labels: { lead: ids.worker } }, { labels: { topic: "t" } }, { labels: { "paseo.parent-agent-id": "p" } }];
    for (const patch of patches) {
      const r = await s.call(s.as(ids.overlord), "POST", `/agents/${child}/meta`, patch);
      assert.equal(r.status, 403, `${JSON.stringify(patch)} → ${r.status}`);
    }
    assert.equal(runner.status(child).meta.role, "worker");
    assert.equal((await s.call("admin", "POST", `/agents/${child}/meta`, { role: "lead", labels: { digestFor: "rn-x" } })).status, 202);
    assert.equal(runner.status(child).meta.role, "lead");
    assert.equal(runner.status(child).meta.labels.digestFor, "rn-x");
    assert.equal(protectedMetaIn({ title: "t", labels: { job: "x" } }), null);
    assert.deepEqual(protectedMetaIn({ role: "lead", labels: { digestFor: "a", job: "x" } }), ["role", "labels.digestFor"]);
  } finally { await s.stop(); }
});

test("X1a: /shutdown, /events and unwedge with an agent token → 403 (even the Overlord)", async () => {
  const s = await squad();
  try {
    const { ids } = s;
    assert.equal((await s.call(s.as(ids.overlord), "POST", "/shutdown", {})).status, 403);
    assert.equal(s.srv.shutdowns, undefined);
    assert.equal((await s.call(s.as(ids.overlord), "GET", "/events")).status, 403);
    assert.equal((await s.call(s.as(ids.overlord), "POST", `/agents/${ids.worker}/unwedge`, {})).status, 403);
  } finally { await s.stop(); }
});

test("X1a: the token is minted once per id per runner lifetime: unchanged across park + resume and every later turn; the child env carries it", async () => {
  const s = await squad({ parkGraceMs: 30 });
  try {
    const { ids, runner, fake } = s;
    const token = runner.tokensById.get(ids.worker);
    assert.match(token, /^[0-9a-f]{64}$/);
    runner.send(ids.worker, "one");
    await until(() => runner.status(ids.worker).status === "parked");
    assert.equal(runner.resume(ids.worker), true);
    await until(() => runner.live.has(ids.worker));
    runner.send(ids.worker, "two");
    await tick(30);
    const starts = fake.starts.filter((x) => x.id === ids.worker);
    assert.ok(starts.length >= 2, `park + resume started a second child (${starts.length})`);
    for (const st of starts) {
      assert.equal(st.env.VS_AGENT_TOKEN, token, "every child of the agent carries the same token");
      assert.equal(st.env.VS_AGENT_ID, ids.worker);
    }
    assert.equal(runner.tokensById.get(ids.worker), token);
    assert.equal(runner.tokenFor(ids.worker), token);
    assert.equal((await s.call(s.as(ids.worker), "GET", "/verify-agent")).status, 200);
  } finally { await s.stop(); }
});

test("X1a: after a runner restart every non-exited, non-archived id has a token (boot-mint), exited/archived ones do not, and the old tokens are gone", async () => {
  const dir = path.join(tmp(), "agents");
  const a1 = fakeAdapter();
  const r1 = new Runner({ dir, adapters: { claude: a1.adapter }, bgProbe: null });
  const mk = (meta) => r1.create({ provider: "claude", cwd: process.cwd(), meta });
  const live = mk({ team: "sq", lane: "art", role: "worker" });
  const parked = mk({ team: "sq", lane: "art", role: "lead" });
  const archived = mk({ team: "sq", lane: "art", role: "worker" });
  const exited = mk({ team: "sq", lane: "art", role: "worker" });
  const retired = mk({ team: "sq", lane: "art", role: "former-lead" });
  r1.send(live, "HOLD: mid-turn when the runner goes");
  r1.send(parked, "work");
  await tick(30);
  r1.park(parked);
  r1.archive(archived);
  r1.store.append(exited, "exit", { code: 0 });
  const old = r1.tokensById.get(live);
  r1.shutdown({ keepResumable: true });
  const a2 = fakeAdapter();
  const r2 = new Runner({ dir, adapters: { claude: a2.adapter }, bgProbe: null });
  assert.equal(r2.tokensById.size, 0, "a fresh runner holds no tokens until it boots");
  r2.recoverQueued(); // the boot pass (runner/server.mjs main calls it)
  assert.deepEqual([...r2.tokensById.keys()].sort(), [live, parked, retired].sort(), "lost + parked + retired (non-exited, non-archived) ids are minted");
  assert.notEqual(r2.tokensById.get(live), old, "a new process means new secrets");
  assert.equal(r2.verifyAgent(live, r2.tokensById.get(live))?.status, "lost");
  assert.equal(r2.verifyAgent(parked, r2.tokensById.get(parked))?.status, "parked");
  assert.equal(r2.verifyAgent(retired, r2.tokensById.get(retired)), null, "minted, but a retired role never verifies");
  assert.equal(r2.verifyAgent(live, old), null, "the previous runner's token is refused");
  assert.equal(r2.verifyAgent(archived, "x"), null);
  r2.shutdown();
});

test("X1a: the token string never lands on disk or in a log line: JSONL (stderr/raw/error/output redacted), runner.json, <id>.mcp.json (literal ${VS_AGENT_TOKEN}), prompt file", async () => {
  const root = tmp();
  const home = path.join(root, "runner");
  const promptsDir = path.join(home, "prompts");
  const spawned = [];
  const spawnImpl = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit("exit", null, "SIGTERM");
    child.pid = 777;
    spawned.push({ file, args, opts, child });
    return child;
  };
  const claude = createClaudeAdapter({ spawnImpl, command: process.execPath, mcp: true, mcpPath: "vs-mcp.mjs", promptsDir });
  const runner = new Runner({ dir: path.join(home, "agents"), adapters: { claude }, bgProbe: null });
  writeDiscovery(home, { port: 1, token: ADMIN });
  const id = runner.create({ provider: "claude", cwd: process.cwd(), prompt: "go", systemPrompt: "You are a worker.", meta: { team: "sq", lane: "art", role: "worker" } });
  const token = runner.tokensById.get(id);
  await tick(20);
  const { opts, args, child } = spawned[0];
  assert.equal(opts.env.VS_AGENT_TOKEN, token, "the spawn env carries the literal (the CLI expands ${VS_AGENT_TOKEN} from it)");
  const mcpFile = args[args.indexOf("--mcp-config") + 1];
  const mcpText = readFileSync(mcpFile, "utf8");
  assert.ok(!mcpText.includes(token), "mcp.json never holds the token");
  assert.equal(JSON.parse(mcpText).mcpServers.vibesquad.env.VS_AGENT_TOKEN, "${VS_AGENT_TOKEN}");
  assert.equal(JSON.parse(mcpText).mcpServers.vibesquad.env.VS_AGENT_ID, id);
  // Every way a secret could reach the log: the child's stderr, an unparseable stdout line, an error, an echo in a reply, a meta patch.
  child.stderr.write(`warning: token=${token} leaked\n`);
  child.stdout.write(`not json ${token}\n`);
  child.stdout.write(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `my token is ${token}` }] } })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "result", subtype: "error", is_error: true, result: `boom ${token}` })}\n`);
  runner.updateMeta(id, { title: `t ${token}`, labels: { note: token } });
  runner.store.append(id, "custom", { nested: { list: [token, { deep: `x${token}y` }] } });
  await tick(30);
  const jsonl = readFileSync(path.join(home, "agents", `${id}.jsonl`), "utf8");
  assert.ok(!jsonl.includes(token), "the agent JSONL never holds the token");
  assert.ok(jsonl.includes("[redacted]"), "the lines were written, redacted");
  const evs = runner.timeline(id);
  assert.equal(evs.find((e) => e.type === "stderr").line, "warning: token=[redacted] leaked");
  assert.equal(evs.find((e) => e.type === "raw").line, "not json [redacted]");
  assert.equal(evs.find((e) => e.type === "output").text, "my token is [redacted]");
  assert.equal(evs.find((e) => e.type === "error").message, "boom [redacted]");
  assert.equal(runner.status(id).meta.title, "t [redacted]");
  assert.deepEqual(evs.find((e) => e.type === "custom").nested, { list: ["[redacted]", { deep: "x[redacted]y" }] });
  for (const f of readdirSync(home)) if (f !== "agents" && f !== "prompts") assert.ok(!readFileSync(path.join(home, f), "utf8").includes(token), `${f} never holds the token`);
  for (const f of readdirSync(promptsDir)) assert.ok(!readFileSync(path.join(promptsDir, f), "utf8").includes(token), `${f} never holds the token`);
  assert.ok(readFileSync(path.join(promptsDir, `${id}.md`), "utf8").includes("You are a worker."));
  // The SSE tail sees the same clean event (listeners get the redacted object).
  const seen = [];
  const off = runner.subscribe((_id, ev) => seen.push(ev));
  child.stderr.write(`again ${token}\n`);
  await tick(20);
  off();
  assert.equal(seen.at(-1).line, "again [redacted]");
  runner.shutdown();
});

test("X1a: the ACP adapter carries the token as a literal in the in-memory session/new mcpServers env (stdin only); raw stdout echoes are redacted by the runner", async () => {
  let child;
  const spawnImpl = () => {
    child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit("exit", null, "SIGTERM");
    child.pid = 778;
    child.written = [];
    child.stdin.on("data", (d) => { for (const l of String(d).split("\n").filter(Boolean)) { const m = JSON.parse(l); child.written.push(m); if (m.method === "initialize") child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} })}\n`); } });
    return child;
  };
  const acp = createAcpAdapter({ spawnImpl, provider: "opencode", mcp: true, mcpPath: "vs-mcp.mjs", resolved: { file: "/bin/fake", args: [] } });
  const runner = new Runner({ dir: path.join(tmp(), "agents"), adapters: { opencode: acp }, bgProbe: null });
  const id = runner.create({ provider: "opencode", cwd: process.cwd(), prompt: "go", meta: { team: "sq", lane: "art", role: "worker" } });
  const token = runner.tokensById.get(id);
  await until(() => child?.written.some((m) => m.method === "session/new"));
  const env = child.written.find((m) => m.method === "session/new").params.mcpServers[0].env;
  assert.deepEqual(env.find((e) => e.name === "VS_AGENT_TOKEN"), { name: "VS_AGENT_TOKEN", value: token });
  assert.ok(env.some((e) => e.name === "VS_AGENT_ID" && e.value === id));
  child.stdout.write(`garbage ${token}\n`);
  await tick(20);
  const jsonl = readFileSync(runner.store.file(id), "utf8");
  assert.ok(!jsonl.includes(token));
  assert.equal(runner.timeline(id).find((e) => e.type === "raw").line, "garbage [redacted]");
  runner.shutdown();
});

test("X1a: agentEnv: an inherited VS_AGENT_TOKEN in base is replaced by the agent's own, or dropped when none is given", () => {
  const base = { PATH: "p", VS_AGENT_TOKEN: "leaders-token", VS_AGENT_ID: "rn-leader", VS_LANE: "hub" };
  const env = agentEnv("rn-child", { team: "sq", lane: "art", role: "worker" }, base, { token: "childs-token" });
  assert.equal(env.VS_AGENT_TOKEN, "childs-token");
  assert.equal(env.VS_AGENT_ID, "rn-child");
  assert.equal(env.PASEO_AGENT_ID, "rn-child");
  assert.equal(env.VS_LANE, "art");
  assert.equal(env.PATH, "p");
  assert.equal(agentEnv("rn-child", {}, base).VS_AGENT_TOKEN, undefined, "no token given: the inherited one is still dropped");
  assert.equal(base.VS_AGENT_TOKEN, "leaders-token", "base is not mutated");
});

test("X1a: redactSecrets / LogStore.secrets: replaces every occurrence in nested strings, leaves other values untouched, no-op without secrets", () => {
  assert.equal(redactSecrets("a S1 b S1 S2", ["S1", "S2"]), "a [redacted] b [redacted] [redacted]");
  const v = { n: 1, b: true, s: "S1", arr: ["x", "S2", { t: "S1S2" }], nul: null };
  assert.deepEqual(redactSecrets(v, ["S1", "S2"]), { n: 1, b: true, s: "[redacted]", arr: ["x", "[redacted]", { t: "[redacted][redacted]" }], nul: null });
  const clean = { s: "fine", arr: [1, 2] };
  assert.equal(redactSecrets(clean, ["S1"]), clean, "unchanged objects are returned as is");
  assert.equal(redactSecrets("S1", []), "S1");
  assert.equal(redactSecrets("S1", ["", null]), "S1", "empty secrets never match");
  const store = new LogStore(path.join(tmp(), "logs"));
  store.secrets = () => ["sec"];
  const ev = store.append("rn-a", "stderr", { line: "a sec b" });
  assert.equal(ev.line, "a [redacted] b");
  assert.ok(!readFileSync(store.file("rn-a"), "utf8").includes("sec"));
});

test("X1a: agentMay / spawnMetaForAgent are pure rule tables", () => {
  const lead = { id: "rn-lead", role: "lead", lane: "art", team: "sq", overlord: false };
  const worker = { id: "rn-w", role: "worker", lane: "art", team: "sq", overlord: false };
  const overlord = { id: "rn-ov", role: "lead", lane: "sq", team: "sq", overlord: true };
  const t = (id, meta) => ({ id, meta });
  const laneWorker = t("rn-x", { team: "sq", lane: "art", role: "worker", labels: {} });
  assert.equal(agentMay(lead, "cancel", laneWorker), true);
  assert.equal(agentMay(worker, "cancel", laneWorker), false);
  assert.equal(agentMay(worker, "cancel", t("rn-c", { team: "sq", lane: "art", role: "worker", labels: { "vs.parent": "rn-w" } })), true, "own child");
  assert.equal(agentMay(worker, "input", t("rn-l", { team: "sq", lane: "ui", role: "lead" })), true, "any Squad agent");
  assert.equal(agentMay(worker, "input", t("rn-f", { team: "other", lane: "ui", role: "lead" })), false);
  assert.equal(agentMay(overlord, "archive", t("rn-l", { labels: { team: "sq", lane: "ui", role: "worker" } })), true, "labels-only shape");
  assert.equal(agentMay(overlord, "archive", t("rn-l", { team: "sq", lane: "ui", role: "lead" })), false);
  assert.equal(agentMay(lead, "resume", laneWorker), true);
  assert.equal(agentMay(lead, "shutdown", laneWorker), false, "unknown actions are refused");
  assert.equal(agentMay(lead, "input", null), false);
  assert.equal(agentMay({ id: "rn-n", role: "worker", lane: null, team: null }, "input", laneWorker), false, "a caller without a team reaches nobody");
  assert.throws(() => spawnMetaForAgent(worker, { role: "lead" }), /may not spawn a lead/);
  assert.throws(() => spawnMetaForAgent(worker, { labels: { role: "buddy" } }), /brainstorm/);
  assert.throws(() => spawnMetaForAgent(worker, { role: "overseer" }), /role "overseer"/);
  assert.throws(() => spawnMetaForAgent({ ...lead, role: "brainstorm" }, { role: "lead", lane: "ui" }), /only that lane's Buddy or the Squad's Overlord/);
  assert.throws(() => spawnMetaForAgent({ ...lead, role: "brainstorm" }, { role: "lead" }, { laneHasLiveLead: () => true }), /already has a live lead/);
  const m = spawnMetaForAgent({ ...lead, role: "brainstorm" }, { role: "lead", title: "L" });
  assert.equal(m.role, "lead");
  assert.equal(m.lane, "art");
  assert.equal(m.title, "L");
  assert.equal(m.labels["vs.parent"], "rn-lead");
  const w = spawnMetaForAgent(worker, { lane: "ui" });
  assert.equal(w.lane, "art");
  assert.equal(spawnMetaForAgent(overlord, { lane: "ui" }).lane, "ui");
});

test("X1a: hubLaneReader mirrors isHubLane: a lane flagged hub wins, else the lane whose id is the team id; no file → the default rule; the file is re-read when it changes", () => {
  const home = tmp();
  const hub = hubLaneReader(home, {});
  assert.equal(hub("sq"), "sq", "no registry: lane id = team id");
  writeFileSync(path.join(home, "teams.json"), JSON.stringify({ teams: [{ id: "sq", lanes: [{ id: "sq" }, { id: "hubby", hub: true }] }, { id: "t2", lanes: [{ id: "t2" }] }] }));
  assert.equal(hub("sq"), "hubby");
  assert.equal(hub("t2"), "t2");
  assert.equal(hub("unknown"), "unknown");
  const viaEnv = hubLaneReader(tmp(), { VIBESQUAD_TEAMS_FILE: path.join(home, "teams.json") });
  assert.equal(viaEnv("sq"), "hubby", "VIBESQUAD_TEAMS_FILE wins");
});

test("X1a: the runner honours an injected hubLane: the Overlord is the lead on that lane, and lead spawns follow it", async () => {
  const dir = path.join(tmp(), "agents");
  const fake = fakeAdapter();
  const runner = new Runner({ dir, adapters: { claude: fake.adapter }, bgProbe: null, hubLane: (team) => `${team}-hub` });
  const ov = runner.create({ provider: "claude", cwd: process.cwd(), meta: { team: "sq", lane: "sq-hub", role: "lead" } });
  const notOv = runner.create({ provider: "claude", cwd: process.cwd(), meta: { team: "sq", lane: "sq", role: "lead" } });
  assert.equal(runner.verifyAgent(ov, runner.tokensById.get(ov)).overlord, true);
  assert.equal(runner.verifyAgent(notOv, runner.tokensById.get(notOv)).overlord, false);
  runner.shutdown();
});

/** A fetch that records the headers of every call and answers 200 {} (or the status the route map says). */
function recordingFetch(statusFor = () => 200) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {} });
    const status = statusFor(String(url), init);
    return { ok: status >= 200 && status < 300, status, json: async () => ({ ok: true, id: "rn-new" }), body: null };
  };
  f.calls = calls;
  return f;
}
function clientHome() {
  const home = tmp();
  writeDiscovery(home, { port: 4242, token: ADMIN });
  return home;
}

test("X1a: runner-client: VS_AGENT_TOKEN set → agent headers only (no bearer); neither id nor token → the admin bearer; a per-call caller wins; caller:null forces admin", async () => {
  const home = clientHome();
  const fetchImpl = recordingFetch();
  const agent = new RunnerClient({ home, fetchImpl, env: { VS_AGENT_ID: "rn-me", VS_AGENT_TOKEN: "tok" } });
  await agent.request("GET", "/agents/rn-x");
  assert.deepEqual(fetchImpl.calls.at(-1).headers, { "x-vs-agent-id": "rn-me", "x-vs-agent-token": "tok" });
  await agent.request("POST", "/agents/rn-x/input", { text: "hi" });
  const h = fetchImpl.calls.at(-1).headers;
  assert.equal(h.authorization, undefined, "an agent never sends the bearer");
  assert.equal(h["x-vs-agent-id"], "rn-me");
  const admin = new RunnerClient({ home, fetchImpl, env: { PATH: "p" } });
  await admin.request("GET", "/health");
  assert.deepEqual(fetchImpl.calls.at(-1).headers, { authorization: `Bearer ${ADMIN}` });
  await admin.request("GET", "/verify-agent", undefined, { caller: { id: "rn-them", token: "t2" } });
  assert.deepEqual(fetchImpl.calls.at(-1).headers, { "x-vs-agent-id": "rn-them", "x-vs-agent-token": "t2" }, "the server forwards a verified agent's headers");
  await agent.request("POST", "/agents/rn-x/meta", { title: "t" }, { caller: null });
  assert.deepEqual(fetchImpl.calls.at(-1).headers, { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, "caller:null forces the admin bearer");
  const pinned = new RunnerClient({ home, fetchImpl, env: { VS_AGENT_ID: "rn-env", VS_AGENT_TOKEN: "e" }, caller: null });
  await pinned.request("GET", "/health");
  assert.deepEqual(fetchImpl.calls.at(-1).headers, { authorization: `Bearer ${ADMIN}` }, "a client pinned to admin ignores the env identity");
  assert.deepEqual(authHeadersFor(undefined, "b"), { authorization: "Bearer b" });
});

test("X1d guard: runner-client with VS_AGENT_ID and no VS_AGENT_TOKEN never falls back to the admin bearer: the id goes alone, the runner says 403 and the target gets nothing; the admin bearer without VS_AGENT_ID still gets 2xx", async () => {
  assert.deepEqual(agentCallerFromEnv({ VS_AGENT_ID: "rn-a" }), { id: "rn-a", token: "" }, "no token: the id is sent alone (no fallback)");
  assert.deepEqual(agentCallerFromEnv({ VS_AGENT_ID: "rn-a", VS_AGENT_TOKEN_REQUIRED: "0" }), { id: "rn-a", token: "" }, "the X1a-X1b rollout flag is gone: 0 changes nothing");
  assert.deepEqual(agentCallerFromEnv({ PASEO_AGENT_ID: "rn-p", VS_AGENT_TOKEN: "t" }), { id: "rn-p", token: "t" });
  assert.equal(agentCallerFromEnv({}), null);
  assert.equal("agentTokenRequired" in runnerClientModule, false, "the flag reader is gone");
  const s = await squad();
  try {
    const home = tmp();
    writeDiscovery(home, { port: s.port, token: ADMIN });
    const noToken = new RunnerClient({ home, env: { VS_AGENT_ID: s.ids.worker } });
    await assert.rejects(() => noToken.request("GET", "/health"), (e) => e instanceof RunnerHttpError && e.status === 403, "an id without a token is 403, never the bearer");
    await assert.rejects(() => noToken.request("POST", `/agents/${s.ids.lead}/input`, { text: "x1d-spoof-turn" }), (e) => e instanceof RunnerHttpError && e.status === 403);
    assert.equal(JSON.stringify(s.runner.timeline(s.ids.lead)).includes("x1d-spoof-turn"), false, "the lead got no turn");
    const flagged = new RunnerClient({ home, env: { VS_AGENT_ID: s.ids.worker, VS_AGENT_TOKEN_REQUIRED: "0" } });
    await assert.rejects(() => flagged.request("GET", "/health"), (e) => e instanceof RunnerHttpError && e.status === 403, "the old flag does not bring the fallback back");
    const adminTurn = await s.call("admin", "POST", `/agents/${s.ids.worker}/input`, { text: "admin turn" });
    assert.ok(adminTurn.status >= 200 && adminTurn.status < 300, `admin input: ${adminTurn.status} ${adminTurn.text}`);
    assert.equal((await new RunnerClient({ home, env: { PATH: "p" } }).request("GET", "/health")).ok, true, "no VS_AGENT_ID: the admin bearer, as before");
    const real = new RunnerClient({ home, env: { VS_AGENT_ID: s.ids.worker, VS_AGENT_TOKEN: s.runner.tokensById.get(s.ids.worker) } });
    assert.equal((await real.verifyAgent({ id: s.ids.worker, token: s.runner.tokensById.get(s.ids.worker) })).role, "worker");
    assert.equal((await real.request("GET", "/verify-agent")).id, s.ids.worker, "the env identity is used when no per-call caller is given");
    await assert.rejects(() => real.verifyAgent({ id: s.ids.lead, token: "nope" }), (e) => e.status === 403);
    const admin = new RunnerClient({ home, env: {} });
    await assert.rejects(() => admin.request("POST", "/shutdown", {}, { caller: { id: s.ids.overlord, token: s.runner.tokensById.get(s.ids.overlord) } }), (e) => e.status === 403, "forwarded agent headers are scoped like the agent");
  } finally { await s.stop(); }
});

test("X1a: runner-backend passes the caller through: an agent caller's spawn is stamped by the runner, protected meta is refused before any request, admin calls are unchanged", async () => {
  const s = await squad();
  try {
    const home = tmp();
    writeDiscovery(home, { port: s.port, token: ADMIN });
    process.env.VIBESQUAD_HOME = tmp(); // keep the backend's lane-refresh and profile lookups off the real home
    const rc = new RunnerClient({ home, env: {} });
    const backend = new RunnerBackend({ client: rc, hooks: false, buildPrefix: async () => "", whosHere: async () => {} });
    const lead = { id: s.ids.lead, token: s.runner.tokensById.get(s.ids.lead) };
    const worker = { id: s.ids.worker, token: s.runner.tokensById.get(s.ids.worker) };
    await assert.rejects(() => backend.createAgent({ config: { provider: "claude", cwd: process.cwd() }, labels: { role: "lead", lane: "art" }, caller: worker }), (e) => e.status === 403);
    const spawned = await backend.createAgent({ config: { provider: "claude", cwd: process.cwd(), title: "w" }, labels: { lane: "ui", team: "other", profile: "Implement - Opus" }, caller: worker });
    assert.equal(spawned.labels.role, "worker");
    assert.equal(spawned.labels.lane, "art");
    assert.equal(spawned.labels.team, "sq");
    assert.equal(spawned.parentAgentId, s.ids.worker);
    assert.rejects(() => backend.updateAgent(s.ids.worker2, { labels: { role: "lead" } }, { caller: lead }), (e) => e instanceof RunnerHttpError && e.status === 403);
    await backend.updateAgent(s.ids.worker2, { name: "n", labels: { job: "j" } }, { caller: lead });
    assert.equal(s.runner.status(s.ids.worker2).meta.title, "n");
    await assert.rejects(() => backend.updateAgent(s.ids.lead, { name: "x" }, { caller: worker }), (e) => e.status === 403);
    await backend.updateAgent(s.ids.lead, { labels: { role: "lead" } }); // admin: as today
    await assert.rejects(() => backend.cancelAgent(s.ids.lead, { caller: worker }), (e) => e.status === 403);
    await backend.sendAgentPrompt(s.ids.lead, "hello", { caller: worker, owner: true });
    const input = s.runner.timeline(s.ids.lead).findLast((e) => e.type === "input");
    assert.equal(input.senderId, s.ids.worker);
    assert.equal(input.owner, undefined);
    await assert.rejects(() => backend.verifyAgent({ id: s.ids.lead, token: "nope" }), (e) => e.status === 403);
    assert.equal((await backend.verifyAgent(lead)).role, "lead");
    // Revive-on-send of an auto-archived lane worker by its lead: the unarchive is scoped (lead on a lane worker), the marker clear is admin.
    await backend.updateAgent(s.ids.worker2, { labels: { "vs.auto-archived": "1" } });
    await backend.archiveAgent(s.ids.worker2);
    await backend.fetchAgents(); // seed live.archived like the stream would
    s.runner.live.delete(s.ids.worker2);
    await backend.sendAgentPrompt(s.ids.worker2, "wake", { caller: lead });
    assert.equal(s.runner.status(s.ids.worker2).archivedAt, null, "revived");
    assert.equal(s.runner.status(s.ids.worker2).meta.labels["vs.auto-archived"], "", "marker cleared by the backend as admin");
    assert.equal(s.runner.timeline(s.ids.worker2).findLast((e) => e.type === "input").senderId, s.ids.lead);
    await assert.rejects(() => backend.sendAgentPrompt(s.ids.worker2, "x", { caller: { id: s.ids.foreign, token: s.runner.tokensById.get(s.ids.foreign) } }), (e) => e.status === 403);
  } finally { delete process.env.VIBESQUAD_HOME; await s.stop(); }
});
