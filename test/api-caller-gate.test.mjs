// X1c (docs/PLAN_X1_IDENTITY.md): the VS server resolves one caller per request (owner | agent | unknown), the middleware
// is default-deny for non-owner writes except AGENT_WRITE_ALLOWLIST, and every allow-listed handler re-checks the role.
// A real Runner + runner HTTP server answers GET /verify-agent; the VS middleware runs on a temp VIBESQUAD_HOME.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p = "vs-gate-") => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const close = (srv) => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });
const ADMIN = "adm1n-t0k";
const sha256Hex = (v) => createHash("sha256").update(v).digest("hex");

// Env first: the server modules read VIBESQUAD_HOME / teams per call, but the runner store must live under it.
const HOME = tmp("vs-gate-home-");
const ROOT = tmp("vs-gate-root-");
process.env.VIBESQUAD_HOME = HOME;
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
delete process.env.VS_AGENT_ID;
delete process.env.PASEO_AGENT_ID;
delete process.env.VS_AGENT_TOKEN;

const { Runner } = await import("../runner/runner.mjs");
const { createServer: createRunnerServer, writeDiscovery } = await import("../runner/server.mjs");
const { RunnerClient, agentCallerFromEnv, authHeadersFor } = await import("../server/backend/runner-client.mjs");
const { RunnerBackend } = await import("../server/backend/runner-backend.mjs");
const { localTokenHeaders } = await import("../server/local-token.mjs");
const { getLocalToken, callerFromRequest } = await import("../server/auth.mjs");
const { writeInboxCards } = await import("../server/inbox.mjs");
const { authorizeBuddyRestartRequest } = await import("../server/brainstorm.mjs");
const { createVibesquadMiddleware, AGENT_WRITE_ALLOWLIST } = await import("../server/vibesquad-api.mjs");

const TEAMS = [
  { id: "sq", name: "Squad", paths: [], lanes: [{ id: "sq", name: "Hub", hub: true }, { id: "art", name: "Art" }, { id: "fresh", name: "Fresh" }, { id: "ui", name: "UI" }] },
  { id: "oth", name: "Other", paths: [], lanes: [{ id: "oth", name: "Oth Hub", hub: true }, { id: "oth-main", name: "Oth Main" }] },
];
writeFileSync(path.join(ROOT, "teams.json"), JSON.stringify({ teams: TEAMS }), "utf8");
mkdirSync(path.join(ROOT, "docs", "brainstorm"), { recursive: true });
// A stand-in `vs handoff` (cli/vs.mjs is X1b's file): writes the packet for the lane it is run for and records the env it saw.
mkdirSync(path.join(ROOT, "cli"), { recursive: true });
writeFileSync(path.join(ROOT, "cli", "vs.mjs"), `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const d = join(process.env.VIBESQUAD_HOME, "teams", "sq");
mkdirSync(d, { recursive: true });
writeFileSync(join(d, "packet-art.md"), "packet by " + (process.env.PASEO_AGENT_ID || "owner") + "\\n");
`, "utf8");

/** Fake provider: parks (session), echoes a turn on demand. */
function fakeAdapter() {
  return {
    canPark: true,
    start({ id, emit }) {
      setImmediate(() => emit("session", { sessionId: `sess-${id}` }));
      return {
        pid: 5000,
        ready: Promise.resolve(),
        send(text) { emit("status", { status: "running" }); if (!String(text).startsWith("HOLD:")) { emit("output", { text: `echo:${text}` }); emit("status", { status: "idle" }); } },
        cancel() {},
        kill() {},
      };
    },
  };
}

// One runner + one VS server for the whole file (the squad is static; each test uses its own cards / log lines).
const runnerHome = path.join(HOME, "runner");
const runner = new Runner({ dir: path.join(runnerHome, "agents"), adapters: { claude: fakeAdapter() }, parkGraceMs: 60_000, bgProbe: null });
const mk = (meta) => runner.create({ provider: "claude", cwd: ROOT, meta });
const ids = {
  overlord: mk({ team: "sq", lane: "sq", role: "lead", labels: {} }),
  buddy: mk({ team: "sq", lane: "art", role: "brainstorm", labels: {} }),
  lead: mk({ team: "sq", lane: "art", role: "lead", labels: {} }),
  freshBuddy: mk({ team: "sq", lane: "fresh", role: "brainstorm", labels: {} }), // a lane with a Buddy and no lead
  uiLead: mk({ team: "sq", lane: "ui", role: "lead", labels: {} }),
  othLead: mk({ team: "oth", lane: "oth-main", role: "lead", labels: {} }),
};
ids.worker = mk({ team: "sq", lane: "art", role: "worker", labels: { "vs.parent": ids.lead } });
ids.digest = mk({ team: "sq", lane: "art", role: "worker", profile: "Pre-check - Flash", labels: { digestFor: ids.worker } });
const runnerSrv = createRunnerServer(runner, { token: ADMIN, hash: "h" });
const runnerPort = await listen(runnerSrv);
writeDiscovery(runnerHome, { port: runnerPort, token: ADMIN });

const backend = new RunnerBackend({ client: new RunnerClient({ home: runnerHome, env: {} }), hooks: false, buildPrefix: async () => "", whosHere: async () => {} });
const api = createVibesquadMiddleware(ROOT, { backend });
const hits = [];
const vsSrv = http.createServer((req, res) => { hits.push(`${req.method} ${req.url.split("?")[0]}`); api(req, res, () => { res.statusCode = 404; res.end("no"); }); });
const vsPort = await listen(vsSrv);
after(async () => { await close(vsSrv); await close(runnerSrv); runner.shutdown(); });

const OWNER_TOKEN = getLocalToken();
const ownerCookie = () => ({ cookie: `vs_local=${sha256Hex(`vs_local-cookie:${OWNER_TOKEN}`)}` });
const agentHeaders = (id, token = runner.tokensById.get(id)) => ({ "x-vs-agent-id": id, "x-vs-agent-token": token });
/** who: "header" (x-vibesquad-token, the desktop proxy / owner shell shape), "cookie" (vs_local), "none", an agent id, or { headers }. */
const hdr = (who) => (who === "header" ? { "x-vibesquad-token": OWNER_TOKEN } : who === "cookie" ? ownerCookie() : who === "none" ? {} : typeof who === "string" ? agentHeaders(who) : who.headers);
async function call(who, method, route, body, extra = {}) {
  const r = await fetch(`http://127.0.0.1:${vsPort}${route}`, { method, headers: { ...hdr(who), ...extra, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* empty / html */ }
  return { status: r.status, body: json, text };
}
const seedCards = () => writeInboxCards([
  { id: "idea-1", text: "sq card", teamId: "sq", laneId: "art", status: "parked", createdAt: "2026-11-11T00:00:00.000Z" },
  { id: "idea-2", text: "sq card 2", teamId: "sq", laneId: "art", status: "parked", createdAt: "2026-11-11T00:00:00.000Z" },
  { id: "idea-9", text: "oth card", teamId: "oth", laneId: "oth-main", status: "parked", createdAt: "2026-11-11T00:00:00.000Z" },
]);
const logBody = (over = {}) => ({ team: "sq", lane: "art", type: "metric", text: "t", ...over });

test("X1c: callerFromRequest: owner header / cookie → owner; nothing → unknown (an empty id is never the owner); agent headers win over owner proof; bad agent headers → denied 403", async () => {
  const req = (headers) => ({ headers: { host: "127.0.0.1", ...headers }, socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" }, method: "POST" });
  const verify = async ({ id, token }) => { if (id === ids.worker && token === "ok") return { id, role: "worker", lane: "art", team: "sq" }; const e = new Error("no"); e.status = 403; throw e; };
  assert.equal((await callerFromRequest(req({ "x-vibesquad-token": OWNER_TOKEN }), { verifyAgent: verify })).kind, "owner");
  assert.equal((await callerFromRequest(req(ownerCookie()), { verifyAgent: verify })).kind, "owner");
  assert.equal((await callerFromRequest(req({}), { verifyAgent: verify })).kind, "unknown");
  assert.equal((await callerFromRequest(req({ "x-vs-agent-id": "", "x-vibesquad-token": "" }), { verifyAgent: verify })).kind, "unknown");
  const agent = await callerFromRequest(req({ ...agentHeaders(ids.worker, "ok"), "x-vibesquad-token": OWNER_TOKEN }), { verifyAgent: verify });
  assert.equal(agent.kind, "agent");
  assert.equal(agent.id, ids.worker);
  assert.equal(agent.role, "worker");
  assert.equal(JSON.stringify(agent).includes("ok"), false, "the token is never serialised");
  const bad = await callerFromRequest(req({ ...agentHeaders(ids.worker, "wrong"), "x-vibesquad-token": OWNER_TOKEN }), { verifyAgent: verify });
  assert.equal(bad.kind, "denied");
  assert.equal(bad.status, 403);
  const r = req(agentHeaders(ids.worker, "ok"));
  let n = 0;
  const first = await callerFromRequest(r, { verifyAgent: async (c) => { n++; return verify(c); } });
  assert.equal(await callerFromRequest(r, { verifyAgent: async () => { n++; throw new Error("second call"); } }), first, "cached per request");
  assert.equal(n, 1);
  const down = await callerFromRequest(req(agentHeaders(ids.worker, "ok")), { verifyAgent: async () => { const e = new Error("runner not responding"); e.status = 504; throw e; } });
  assert.equal(down.kind, "denied");
  assert.equal(down.status, 503, "cannot verify → fail closed, not 403");
  // No injected verifier: the default path asks the shared runner backend (discovery under VIBESQUAD_HOME/runner).
  const live = await callerFromRequest(req(agentHeaders(ids.worker)));
  assert.equal(live.kind, "agent");
  assert.equal(live.id, ids.worker);
  assert.equal((await callerFromRequest(req(agentHeaders(ids.worker, "nope")))).status, 403);
});

test("X1c: default-deny: agent headers → POST /restart-runner 403, POST /terminals 403, POST /inbox/send 403 (not on the allow-list); gated reads too; GETs still open", async () => {
  for (const who of [ids.lead, ids.overlord, ids.buddy, ids.worker]) {
    assert.equal((await call(who, "POST", "/__vibesquad/restart-runner", {})).status, 403, `${who} restart-runner`);
    assert.equal((await call(who, "POST", "/__vibesquad/terminals", { cwd: ROOT })).status, 403, `${who} terminals`);
    assert.equal((await call(who, "POST", "/__vibesquad/inbox/send", { cardId: "idea-1" })).status, 403, `${who} inbox/send`);
    assert.equal((await call(who, "POST", `/__vibesquad/runner/agents/${ids.worker}/config`, { model: "x" })).status, 403, `${who} config`);
    assert.equal((await call(who, "POST", "/__vibesquad/runner/sweep", {})).status, 403, `${who} sweep`);
    assert.equal((await call(who, "GET", "/__vibesquad/schedules")).status, 403, `${who} gated read`);
    assert.equal((await call(who, "GET", "/__vibesquad/runner/agents")).status, 200, `${who} plain read`);
  }
  assert.ok(!AGENT_WRITE_ALLOWLIST.some((r) => /restart-runner|terminals|inbox\/send|config|sweep/.test(String(r))), "the allow-list is explicit");
});

test("X1c: a wrong or missing agent token is 403 on every route, with or without the owner header; the runner's /verify-agent is the only source", async () => {
  const wrong = { headers: { ...agentHeaders(ids.lead, "nope"), "x-vibesquad-token": OWNER_TOKEN } };
  assert.equal((await call(wrong, "GET", "/__vibesquad/runner/agents")).status, 403);
  assert.equal((await call(wrong, "POST", "/__vibesquad/vs-log", logBody())).status, 403);
  assert.equal((await call({ headers: { "x-vs-agent-id": ids.lead } }, "GET", "/__vibesquad/vs-log?team=sq&lane=art")).status, 403, "id without a token");
  assert.equal((await call({ headers: agentHeaders("rn-nobody", "x") }, "GET", "/__vibesquad/runner/agents")).status, 403);
  assert.equal((await call({ headers: { "x-vs-agent-id": "../../etc", "x-vs-agent-token": "x" } }, "GET", "/__vibesquad/runner/agents")).status, 403, "malformed id never reaches the runner");
});

test("X1c: runner spawn: worker + {labels:{role:lead}} → 403; Buddy on its leadless lane → 201 as lead with vs.parent = Buddy; worker spawn → worker in its lane", async () => {
  const spawn = (who, labels) => call(who, "POST", "/__vibesquad/runner/spawn", { config: { provider: "claude", cwd: ROOT, title: "t" }, labels });
  assert.equal((await spawn(ids.worker, { role: "lead", lane: "art", team: "sq" })).status, 403);
  const r = await spawn(ids.freshBuddy, { role: "lead", lane: "fresh", team: "sq" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.agent.labels.role, "lead");
  assert.equal(r.body.agent.labels.lane, "fresh");
  assert.equal(r.body.agent.parentAgentId, ids.freshBuddy);
  assert.equal(runner.status(r.body.agent.id).meta.labels["vs.parent"], ids.freshBuddy);
  assert.equal((await spawn(ids.freshBuddy, { role: "lead", lane: "fresh", team: "sq" })).status, 403, "the lane has a lead now");
  const w = await spawn(ids.worker, { lane: "ui", team: "oth" });
  assert.equal(w.status, 201);
  assert.equal(w.body.agent.labels.role, "worker");
  assert.equal(w.body.agent.labels.lane, "art");
  assert.equal(w.body.agent.labels.team, "sq");
  assert.equal((await spawn(ids.lead, { role: "brainstorm", lane: "art", team: "sq" })).status, 403, "Buddies are spawned by the server");
  // The body cannot name the caller: an owner-shaped request with a `caller` key is still the owner (admin) call.
  const own = await call("header", "POST", "/__vibesquad/runner/spawn", { config: { provider: "claude", cwd: ROOT, title: "o" }, labels: { role: "worker", lane: "ui", team: "sq" }, caller: { id: ids.worker, token: runner.tokensById.get(ids.worker) } });
  assert.equal(own.status, 201);
  assert.equal(own.body.agent.labels.lane, "ui");
  assert.equal(own.body.agent.parentAgentId ?? undefined, undefined);
});

test("X1c: runner agent routes: worker cancel on its lead → 403; lead on its worker → 200; worker input on its lead is a steer with senderId = worker and never owner", async () => {
  assert.equal((await call(ids.worker, "POST", `/__vibesquad/runner/agents/${ids.lead}/cancel`, {})).status, 403);
  assert.equal((await call(ids.lead, "POST", `/__vibesquad/runner/agents/${ids.worker}/cancel`, {})).status, 200);
  const r = await call(ids.worker, "POST", `/__vibesquad/runner/agents/${ids.lead}/input`, { text: "hi lead", owner: true, activeTurnBehavior: "interrupt" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const input = runner.timeline(ids.lead).findLast((e) => e.type === "input");
  assert.equal(input.senderId, ids.worker);
  assert.equal(input.owner, undefined);
  assert.equal((await call(ids.worker, "POST", `/__vibesquad/runner/agents/${ids.lead}/meta`, { labels: { role: "lead" } })).status, 403);
  assert.equal((await call(ids.worker, "POST", `/__vibesquad/runner/agents/${ids.lead}/archive`, {})).status, 403);
  assert.equal((await call(ids.worker, "POST", `/__vibesquad/runner/agents/${ids.othLead}/input`, { text: "x" })).status, 403, "another Squad");
  // Owner input is still the human turn.
  assert.equal((await call("header", "POST", `/__vibesquad/runner/agents/${ids.lead}/input`, { text: "from the owner" })).status, 200);
  const own = runner.timeline(ids.lead).findLast((e) => e.type === "input");
  assert.equal(own.owner, true);
  assert.equal(own.senderId, undefined);
});

test("X1c: /vs-log attribution: worker `you` 403, `decision` 403, `done` refs forced to self and agent forced to the id; digest done → agent = digest, refs = [digestFor]; lead/Buddy keep today's types minus `you`", async () => {
  assert.equal((await call(ids.worker, "POST", "/__vibesquad/vs-log", logBody({ type: "you", text: "spoof" }))).status, 403);
  assert.equal((await call(ids.worker, "POST", "/__vibesquad/vs-log", logBody({ type: "decision" }))).status, 403);
  assert.equal((await call(ids.worker, "POST", "/__vibesquad/vs-log", logBody({ type: "needs-you" }))).status, 403);
  assert.equal((await call(ids.worker, "POST", "/__vibesquad/vs-log", logBody({ type: "handoff" }))).status, 403);
  const done = await call(ids.worker, "POST", "/__vibesquad/vs-log", logBody({ type: "done", agent: "the-owner", refs: [ids.lead, "abc123"] }));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body.entry.refs, [ids.worker]);
  assert.equal(done.body.entry.agent, ids.worker);
  const blocker = await call(ids.worker, "POST", "/__vibesquad/vs-log", logBody({ type: "blocker", agent: ids.lead, refs: [ids.lead] }));
  assert.equal(blocker.status, 200);
  assert.deepEqual(blocker.body.entry.refs, [ids.worker]);
  assert.equal(blocker.body.entry.agent, ids.worker);
  const metric = await call(ids.worker, "POST", "/__vibesquad/vs-log", logBody({ type: "metric", refs: [ids.lead, "f1a2b3"] }));
  assert.equal(metric.status, 200);
  assert.deepEqual(metric.body.entry.refs, ["f1a2b3"], "a worker metric never refs another agent");
  assert.equal(metric.body.entry.agent, ids.worker);
  const digest = await call(ids.digest, "POST", "/__vibesquad/vs-log", logBody({ type: "done", agent: "the-owner", refs: [ids.worker, ids.lead] }));
  assert.equal(digest.status, 200, JSON.stringify(digest.body));
  assert.equal(digest.body.entry.agent, ids.digest);
  assert.deepEqual(digest.body.entry.refs, [ids.worker]);
  assert.equal((await call(ids.digest, "POST", "/__vibesquad/vs-log", logBody({ type: "blocker" }))).status, 403, "digest: done and metric only");
  for (const who of [ids.lead, ids.buddy, ids.overlord]) {
    assert.equal((await call(who, "POST", "/__vibesquad/vs-log", logBody({ type: "you" }))).status, 403, `${who} you`);
    const d = await call(who, "POST", "/__vibesquad/vs-log", logBody({ type: "decision", agent: "the-owner", refs: [ids.worker] }));
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.entry.agent, who);
    assert.deepEqual(d.body.entry.refs, [ids.worker]);
    assert.equal((await call(who, "POST", "/__vibesquad/vs-log", logBody({ type: "needs-you" }))).status, 200);
  }
  // The same rules on the UI route (/log): a worker may only post a metric there.
  assert.equal((await call(ids.worker, "POST", "/__vibesquad/log", logBody({ type: "you" }))).status, 403);
  assert.equal((await call(ids.worker, "POST", "/__vibesquad/log", logBody({ type: "decision" }))).status, 403);
  const uiMetric = await call(ids.worker, "POST", "/__vibesquad/log", logBody({ type: "metric", agent: "the-owner" }));
  assert.equal(uiMetric.status, 200);
  assert.equal(uiMetric.body.agent, ids.worker);
  const lines = readFileSync(path.join(HOME, "logs", "sq--art.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.every((l) => l.type !== "you"), "no `you` line was written by an agent");
  assert.ok(lines.every((l) => l.agent !== "the-owner"), "no agent line is attributed to the owner");
});

test("X1c: /inbox/triage: worker delete 403; Squad lead archive 200; other-Squad lead archive 403; agent delete 403; worker add via /inbox is allowed", async () => {
  seedCards();
  assert.equal((await call(ids.worker, "POST", "/__vibesquad/inbox/triage", { action: "delete", cardId: "idea-1" })).status, 403);
  assert.equal((await call(ids.worker, "POST", "/__vibesquad/inbox/triage", { action: "archive", cardId: "idea-1" })).status, 403);
  assert.equal((await call(ids.lead, "POST", "/__vibesquad/inbox/triage", { action: "delete", cardId: "idea-1" })).status, 403, "delete is owner-only");
  assert.equal((await call(ids.othLead, "POST", "/__vibesquad/inbox/triage", { action: "archive", cardId: "idea-1" })).status, 403);
  assert.equal((await call(ids.lead, "POST", "/__vibesquad/inbox/triage", { action: "merge", targetId: "idea-1", sourceIds: ["idea-9"] })).status, 403, "a merge touching another Squad's card");
  const ok = await call(ids.lead, "POST", "/__vibesquad/inbox/triage", { action: "archive", cardId: "idea-1" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.card.status, "archived");
  assert.equal((await call(ids.buddy, "POST", "/__vibesquad/inbox/triage", { action: "archive", cardId: "idea-2" })).status, 200);
  assert.equal((await call(ids.othLead, "POST", "/__vibesquad/inbox/triage", { action: "archive", cardId: "idea-9" })).status, 200, "own Squad");
  seedCards();
  assert.equal((await call(ids.overlord, "POST", "/__vibesquad/inbox/triage", { action: "archive", cardId: "idea-1" })).status, 200, "the Overlord is a lead of the Squad");
  const add = await call(ids.worker, "POST", "/__vibesquad/inbox", { text: "a worker idea", laneId: "art", teamId: "sq" });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  // Owner: as today, including delete.
  assert.equal((await call("header", "POST", "/__vibesquad/inbox/triage", { action: "delete", cardId: "idea-2" })).status, 200);
});

test("X1c: /brainstorm-summary: worker 403; that lane's Buddy 200; its lead 200; the Overlord 200; another lane's lead 403; other Squad 403", async () => {
  const post = (who, over = {}) => call(who, "POST", "/__vibesquad/brainstorm-summary", { lane: "art", teamId: "sq", content: "brief", ...over });
  assert.equal((await post(ids.worker)).status, 403);
  assert.equal((await post(ids.uiLead)).status, 403);
  assert.equal((await post(ids.othLead)).status, 403);
  assert.equal((await post(ids.othLead, { lane: "art", teamId: "oth" })).status, 403, "a lane name of another Squad");
  const b = await post(ids.buddy);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.laneId, "art");
  assert.equal((await post(ids.lead)).status, 200);
  assert.equal((await post(ids.overlord)).status, 200);
  assert.equal((await post(ids.overlord, { lane: "oth-main", teamId: "oth" })).status, 403, "the Overlord stays inside its Squad");
  assert.equal((await post("header")).status, 200);
});

test("X1c: /handoff: worker 403; the lane's lead 200 and the packet exists with no second POST; other lane lead 403; Overlord 200", async () => {
  const packet = path.join(HOME, "teams", "sq", "packet-art.md");
  rmSync(packet, { force: true });
  assert.equal((await call(ids.worker, "POST", "/__vibesquad/handoff", { team: "sq", lane: "art" })).status, 403);
  assert.equal((await call(ids.uiLead, "POST", "/__vibesquad/handoff", { team: "sq", lane: "art" })).status, 403);
  assert.equal((await call(ids.othLead, "POST", "/__vibesquad/handoff", { team: "sq", lane: "art" })).status, 403);
  assert.equal((await call(ids.lead, "POST", "/__vibesquad/handoff", { team: "sq", lane: "art", agentId: ids.uiLead })).status, 403, "a lead hands off itself only");
  assert.equal(existsSync(packet), false);
  const before = hits.filter((h) => h === "POST /__vibesquad/handoff").length;
  const r = await call(ids.lead, "POST", "/__vibesquad/handoff", { team: "sq", lane: "art" });
  assert.ok(r.status === 200 || r.status === 202, JSON.stringify(r.body));
  if (r.status === 202) { for (let i = 0; i < 100 && !existsSync(packet); i++) await new Promise((ok) => setTimeout(ok, 50)); }
  assert.equal(existsSync(packet), true, "the packet was written by `vs handoff`");
  assert.equal(readFileSync(packet, "utf8").trim(), `packet by ${ids.lead}`, "the handoff runs as the verified lead");
  assert.equal(hits.filter((h) => h === "POST /__vibesquad/handoff").length, before + 1, "no HTTP loop");
  rmSync(packet, { force: true });
  assert.ok([200, 202].includes((await call(ids.overlord, "POST", "/__vibesquad/handoff", { team: "sq", lane: "art", agentId: ids.lead })).status));
  assert.equal((await call(ids.lead, "GET", "/__vibesquad/handoff?team=sq&lane=art")).status, 200, "the GET stays a plain read");
});

test("X1c: /lead-handoff and /brainstorm-restart: an agent's callerId must be the verified id (403 otherwise); the body cannot smuggle a roster", async () => {
  assert.equal((await call(ids.worker, "POST", "/__vibesquad/lead-handoff", { trigger: "self", agentId: ids.lead, callerId: ids.lead })).status, 403);
  assert.equal((await call(ids.buddy, "POST", "/__vibesquad/lead-handoff", { trigger: "buddy", agentId: ids.lead, callerId: ids.overlord })).status, 403);
  assert.equal((await call(ids.worker, "POST", "/__vibesquad/lead-handoff/confirm", { confirmSuccessorId: ids.lead, callerId: ids.lead })).status, 403);
  assert.equal((await call(ids.worker, "POST", "/__vibesquad/brainstorm-restart", { agentId: ids.buddy, callerId: ids.lead })).status, 403);
  const own = await call(ids.worker, "POST", "/__vibesquad/brainstorm-restart", { agentId: ids.buddy });
  assert.equal(own.status, 403, JSON.stringify(own.body));
  assert.match(String(own.body.error), /only a live lead/);
  assert.equal((await call(ids.lead, "POST", "/__vibesquad/brainstorm-restart", { agentId: ids.buddy, callerId: ids.overlord })).status, 403);
});

test("X1c: authorizeBuddyRestartRequest / performLeadHandoffHttp: a roster in the body never identifies the caller (DI-only agentsForTest)", async () => {
  const fakeLead = { id: "rn-fake-lead", status: "idle", labels: { role: "lead", team: "sq", lane: "art" } };
  const fakeBuddy = { id: ids.buddy, status: "idle", labels: { role: "brainstorm", team: "sq", lane: "art" } };
  await assert.rejects(authorizeBuddyRestartRequest({ callerId: "rn-fake-lead", agentId: ids.buddy, agents: [fakeLead, fakeBuddy], agentClient: backend }, ROOT), (e) => e.status === 403 && /caller not found/.test(e.message));
  await assert.rejects(authorizeBuddyRestartRequest({ callerId: "rn-fake-lead", agentId: ids.buddy, agentClient: backend }, ROOT, { agentsForTest: [fakeBuddy] }), (e) => e.status === 403);
  await authorizeBuddyRestartRequest({ callerId: "rn-fake-lead", agentId: ids.buddy, agentClient: backend }, ROOT, { agentsForTest: [fakeLead, fakeBuddy] });
  const { performLeadHandoffHttp } = await import("../server/lead-handoff.mjs");
  const lead = { id: ids.lead, status: "idle", labels: { role: "lead", team: "sq", lane: "art" } };
  await assert.rejects(performLeadHandoffHttp({ trigger: "buddy", agentId: ids.lead, callerId: "rn-fake-buddy", agents: [lead, { id: "rn-fake-buddy", status: "idle", labels: { role: "brainstorm", team: "sq", lane: "art" } }], skipBackend: true }, ROOT), (e) => e.status === 403 && /caller not found/.test(e.message));
});

test("X1c: the x-vibesquad-token header alone (desktop proxy / owner shell) and the vs_local cookie behave exactly as today", async () => {
  seedCards();
  for (const who of ["header", "cookie"]) {
    const you = await call(who, "POST", "/__vibesquad/vs-log", logBody({ type: "you", agent: "the-owner", text: "hi", refs: [ids.lead] }));
    assert.equal(you.status, 200, `${who}: ${JSON.stringify(you.body)}`);
    assert.equal(you.body.entry.agent, "the-owner");
    assert.deepEqual(you.body.entry.refs, [ids.lead]);
    assert.equal((await call(who, "POST", "/__vibesquad/log", logBody({ type: "you", text: "ui" }))).status, 200);
    assert.equal((await call(who, "GET", "/__vibesquad/schedules")).status, 200, `${who} gated read`);
    assert.equal((await call(who, "POST", "/__vibesquad/inbox/triage", { action: "archive", cardId: who === "header" ? "idea-1" : "idea-2" })).status, 200);
    assert.equal((await call(who, "POST", `/__vibesquad/runner/agents/${ids.worker}/cancel`, {})).status, 200);
    assert.equal((await call(who, "POST", "/__vibesquad/brainstorm-summary", { lane: "ui", teamId: "sq", content: "owner brief" })).status, 200);
    assert.equal((await call(who, "POST", "/__vibesquad/lead-handoff", { trigger: "overlord", agentId: ids.lead })).status, 403, "the Overlord trigger still needs a callerId even for the owner (as today)");
  }
  assert.equal((await call("none", "GET", "/__vibesquad/runner/agents")).status, 200, "unknown: reads");
  assert.equal((await call("none", "POST", "/__vibesquad/vs-log", logBody())).status, 403, "unknown: no writes");
  assert.equal((await call("none", "GET", "/__vibesquad/schedules")).status, 403, "unknown: no gated reads");
  assert.equal((await call({ headers: { "x-vibesquad-token": "not-the-token" } }, "POST", "/__vibesquad/vs-log", logBody())).status, 403);
});

test("X1d guard: a process with VS_AGENT_ID and no VS_AGENT_TOKEN is 403 at the VS server and nothing is written or delivered; the old flag and the owner header do not rescue it; with its token the same process is a worker", async () => {
  const env = { VS_AGENT_ID: ids.worker, VIBESQUAD_HOME: HOME };
  assert.deepEqual(agentCallerFromEnv(env), { id: ids.worker, token: "" }, "X1d: no token → the id goes alone, never the admin bearer / local token");
  assert.deepEqual(agentCallerFromEnv({ ...env, VS_AGENT_TOKEN_REQUIRED: "0" }), { id: ids.worker, token: "" }, "the X1a-X1b rollout flag is gone");
  // The runner client refuses the incomplete pair in-process (R1 H1); `headers` is the wire shape, should anything send it.
  assert.throws(() => authHeadersFor(agentCallerFromEnv(env)), (e) => e.status === 403);
  const headers = { "x-vs-agent-id": ids.worker, "x-vs-agent-token": "" };
  const logFile = path.join(HOME, "logs", "sq--art.jsonl");
  const logLen = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean).length : 0);
  const n = logLen();
  const r = await call({ headers }, "POST", "/__vibesquad/vs-log", logBody({ type: "done", agent: ids.worker, refs: [ids.lead] }));
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(logLen(), n, "nothing was written");
  assert.equal((await call({ headers }, "POST", `/__vibesquad/runner/agents/${ids.lead}/input`, { text: "x1d-no-token-turn" })).status, 403);
  assert.equal(JSON.stringify(runner.timeline(ids.lead)).includes("x1d-no-token-turn"), false, "the lead got no turn");
  // The owner's local token next to a token-less id does not rescue it: the agent identity wins and fails closed.
  assert.equal((await call({ headers: { ...localTokenHeaders(), ...headers } }, "POST", "/__vibesquad/vs-log", logBody())).status, 403, "an id without its token is refused whatever else the request carries");
  assert.equal(logLen(), n);
  // With the token (exactly what cli/vs.mjs and tools.mjs send) the same process is a worker.
  const withToken = authHeadersFor(agentCallerFromEnv({ ...env, VS_AGENT_TOKEN: runner.tokensById.get(ids.worker) }));
  const w = await call({ headers: withToken }, "POST", "/__vibesquad/vs-log", logBody({ type: "done", agent: "the-owner", refs: [ids.lead] }));
  assert.equal(w.status, 200);
  assert.deepEqual(w.body.entry.refs, [ids.worker]);
  assert.equal(w.body.entry.agent, ids.worker);
});

test("idea-134: verifyAgent treats labels.orphan \"true\" like \"1\" (both are 403 at the VS server)", async () => {
  const one = mk({ team: "sq", lane: "art", role: "worker", labels: { orphan: "1" } });
  const word = mk({ team: "sq", lane: "art", role: "worker", labels: { orphan: "true" } });
  const fine = mk({ team: "sq", lane: "art", role: "worker", labels: { orphan: "" } });
  assert.equal(runner.verifyAgent(one, runner.tokenFor(one)), null);
  assert.equal(runner.verifyAgent(word, runner.tokenFor(word)), null);
  assert.equal(runner.verifyAgent(fine, runner.tokenFor(fine))?.id, fine);
  assert.equal((await call(word, "POST", "/__vibesquad/vs-log", logBody())).status, 403);
  assert.equal((await call(fine, "POST", "/__vibesquad/vs-log", logBody())).status, 200);
});

test("idea-137 (X1b): /inbox/triage checks the role before the body: a worker gets 403 with no card ids, a bogus action or a missing card; a lead/owner still gets the validation answer", async () => {
  seedCards();
  for (const body of [{}, { action: "bogus" }, { action: "archive" }, { action: "archive", cardId: "idea-nope" }, { action: "merge", targetId: "idea-1" }]) {
    const r = await call(ids.worker, "POST", "/__vibesquad/inbox/triage", body);
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.match(String(r.body?.error), /leads and Buddies/, JSON.stringify(body));
  }
  assert.equal((await call(ids.lead, "POST", "/__vibesquad/inbox/triage", {})).status, 400, "a lead reaches validation");
  assert.equal((await call(ids.lead, "POST", "/__vibesquad/inbox/triage", { action: "archive", cardId: "idea-nope" })).status, 404, "a lead reaches the card lookup");
  assert.equal((await call("header", "POST", "/__vibesquad/inbox/triage", {})).status, 400, "the owner reaches validation");
});
