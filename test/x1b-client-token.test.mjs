// X1b (docs/PLAN_X1_IDENTITY.md): the vs CLI resolves its caller from VS_AGENT_TOKEN. Every write goes to the VS server
// with x-vs-agent-id + x-vs-agent-token (never the owner's local token), the server verifies the pair against runner
// memory and re-attributes the entry; a wrong token is a 403 from the CLI; `vs handoff` stays a packet writer; an agent
// id without a token (rollout fallback, VS_AGENT_TOKEN_REQUIRED unset) keeps working exactly as before X1.
// A real Runner + runner HTTP server answers GET /verify-agent; the VS middleware runs on a temp VIBESQUAD_HOME.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const close = (srv) => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });
const ADMIN = "adm1n-t0k";
const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "cli", "vs.mjs");

// Env first: the server modules read VIBESQUAD_HOME / teams per call; the runner store must live under it. The home
// teams.json is the one registry both the in-process server and the spawned CLI read.
const HOME = tmp("vs-x1b-home-");
process.env.VIBESQUAD_HOME = HOME;
delete process.env.VIBESQUAD_IGNORE_HOME_TEAMS;
for (const k of ["VS_AGENT_ID", "PASEO_AGENT_ID", "VS_AGENT_TOKEN", "VS_AGENT_TOKEN_REQUIRED", "VS_TEAM", "VS_LANE", "VS_ROLE", "VS_DIGEST"]) delete process.env[k];

const { Runner } = await import("../runner/runner.mjs");
const { createServer: createRunnerServer, writeDiscovery } = await import("../runner/server.mjs");
const { RunnerClient } = await import("../server/backend/runner-client.mjs");
const { RunnerBackend } = await import("../server/backend/runner-backend.mjs");
const { getLocalToken } = await import("../server/auth.mjs");
const { writeInboxCards, readInboxCards } = await import("../server/inbox.mjs");
const { createVibesquadMiddleware } = await import("../server/vibesquad-api.mjs");

const TEAMS = [{ id: "sq", name: "Squad", paths: [], lanes: [{ id: "sq", name: "Hub", hub: true }, { id: "art", name: "Art" }] }];
writeFileSync(path.join(HOME, "teams.json"), JSON.stringify({ teams: TEAMS }), "utf8");

function fakeAdapter() {
  return {
    canPark: true,
    start({ id, emit }) {
      setImmediate(() => emit("session", { sessionId: `sess-${id}` }));
      return { pid: 5000, ready: Promise.resolve(), send(text) { emit("status", { status: "running" }); emit("output", { text: `echo:${text}` }); emit("status", { status: "idle" }); }, cancel() {}, kill() {} };
    },
  };
}

const runnerHome = path.join(HOME, "runner");
const runner = new Runner({ dir: path.join(runnerHome, "agents"), adapters: { claude: fakeAdapter() }, parkGraceMs: 60_000, bgProbe: null });
const mk = (meta) => runner.create({ provider: "claude", cwd: HOME, meta });
const ids = {
  overlord: mk({ team: "sq", lane: "sq", role: "lead", labels: {} }),
  lead: mk({ team: "sq", lane: "art", role: "lead", labels: {} }),
  buddy: mk({ team: "sq", lane: "art", role: "brainstorm", labels: {} }),
};
ids.worker = mk({ team: "sq", lane: "art", role: "worker", labels: { "vs.parent": ids.lead } });
ids.digest = mk({ team: "sq", lane: "art", role: "worker", profile: "Pre-check - Flash", labels: { digestFor: ids.worker } });
const runnerSrv = createRunnerServer(runner, { token: ADMIN, hash: "h" });
const runnerPort = await listen(runnerSrv);
writeDiscovery(runnerHome, { port: runnerPort, token: ADMIN });

const backend = new RunnerBackend({ client: new RunnerClient({ home: runnerHome, env: {} }), hooks: false, buildPrefix: async () => "", whosHere: async () => {} });
const api = createVibesquadMiddleware(ROOT, { backend });
const hits = [];
const vsSrv = http.createServer((req, res) => {
  hits.push({ method: req.method, url: req.url.split("?")[0], headers: { ...req.headers } });
  api(req, res, () => { res.statusCode = 404; res.end("no"); });
});
const vsPort = await listen(vsSrv);
after(async () => { await close(vsSrv); await close(runnerSrv); runner.shutdown(); });
const OWNER_TOKEN = getLocalToken(); // creates HOME/local-token, as a started server would
const tokenOf = (id) => runner.tokensById.get(id);

/** Run the real CLI as `who` (an agent id, with its right token unless `token` is given; "" = the owner's shell). Async: the VS server lives in this process. */
function vs(args, { who = "", token, extra = {} } = {}) {
  const env = { ...process.env, VIBESQUAD_HOME: HOME, VIBESQUAD_PORT: String(vsPort), VS_AGENT_ID: who, PASEO_AGENT_ID: who, VS_AGENT_TOKEN: token ?? (who ? tokenOf(who) : "") };
  for (const k of ["VS_TEAM", "VS_LANE", "VS_ROLE", "VS_DIGEST", "VS_AGENT_TOKEN_REQUIRED"]) delete env[k];
  Object.assign(env, extra);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, cwd: HOME, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr, json: () => JSON.parse(stdout.trim().split(String.fromCharCode(10)).map((l) => l.replace(String.fromCharCode(13), "")).at(-1)) }));
  });
}
const laneLog = () => (existsSync(path.join(HOME, "logs", "sq--art.jsonl")) ? readFileSync(path.join(HOME, "logs", "sq--art.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const lastHit = () => hits.at(-1);

test("vs log: an agent with a token posts to /vs-log with agent headers only; the server attributes the entry from runner memory", async () => {
  const before = hits.length;
  const r = await vs(["log", "done", "finished the thing", "--ref", ids.lead], { who: ids.worker });
  assert.equal(r.status, 0, r.stderr);
  const entry = r.json();
  assert.deepEqual([entry.agent, entry.type, entry.refs], [ids.worker, "done", [ids.worker]], "a worker's done refs itself, whatever --ref said");
  assert.equal(hits.length, before + 1);
  const h = lastHit();
  assert.deepEqual([h.method, h.url], ["POST", "/__vibesquad/vs-log"]);
  assert.deepEqual([h.headers["x-vs-agent-id"], h.headers["x-vs-agent-token"]], [ids.worker, tokenOf(ids.worker)]);
  assert.equal(h.headers["x-vibesquad-token"], undefined, "an agent with a token never sends the owner's local token");
  assert.equal(h.headers.cookie, undefined);
  assert.equal(laneLog().at(-1).agent, ids.worker);
  // a lead keeps its types; the server saw the lead's own token
  const lead = await vs(["log", "decision", "we go with b"], { who: ids.lead });
  assert.equal(lead.status, 0, lead.stderr);
  assert.deepEqual([lead.json().agent, lead.json().type], [ids.lead, "decision"]);
  assert.equal(lastHit().headers["x-vs-agent-id"], ids.lead);
  // the digest worker's done is attributed to it with refs forced to the worker it digests
  const dg = await vs(["log", "done", "worker finished", "--ref", ids.lead], { who: ids.digest });
  assert.equal(dg.status, 0, dg.stderr);
  assert.deepEqual([dg.json().agent, dg.json().refs], [ids.digest, [ids.worker]]);
});

test("vs log: a wrong or missing token is a 403 and nothing is written; `you` / worker decision / --digest are refused client-side", async () => {
  const n = laneLog().length;
  const wrong = await vs(["log", "decision", "spoof"], { who: ids.lead, token: "not-the-token" });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /403/);
  const missing = await vs(["log", "decision", "spoof"], { who: ids.lead, token: "", extra: { VS_AGENT_TOKEN_REQUIRED: "1" } });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /403/);
  assert.equal(laneLog().length, n, "no entry landed");
  const you = await vs(["log", "you", "I am the owner"], { who: ids.lead });
  assert.notEqual(you.status, 0);
  assert.match(you.stderr, /owner's/);
  const dec = await vs(["log", "decision", "nope"], { who: ids.worker });
  assert.notEqual(dec.status, 0);
  assert.match(dec.stderr, /role=worker cannot write/);
  const dig = await vs(["log", "done", "as digest", "--digest"], { who: ids.worker });
  assert.notEqual(dig.status, 0);
  assert.match(dig.stderr, /--digest \/ VS_DIGEST is ignored/);
  const digEnv = await vs(["log", "done", "as digest"], { who: ids.worker, extra: { VS_DIGEST: "1" } });
  assert.notEqual(digEnv.status, 0);
  assert.match(digEnv.stderr, /--digest \/ VS_DIGEST is ignored/);
  assert.equal(laneLog().length, n);
  // the real digest may pass --digest (a no-op: its record decides)
  const realDigest = await vs(["log", "metric", "digested", "--digest"], { who: ids.digest });
  assert.equal(realDigest.status, 0, realDigest.stderr);
});

test("vs log: an agent id without a token (rollout fallback, flag unset) still works as before X1; the owner's shell posts with the local token", async () => {
  const fb = await vs(["log", "decision", "pre-X1a child"], { who: ids.lead, token: "" });
  assert.equal(fb.status, 0, fb.stderr);
  assert.equal(fb.json().agent, ids.lead);
  assert.equal(lastHit().headers["x-vibesquad-token"], OWNER_TOKEN, "the fallback rides the owner header (removed in X1d)");
  assert.equal(lastHit().headers["x-vs-agent-id"], undefined);
  const owner = await vs(["log", "you", "owner says hi"]);
  assert.equal(owner.status, 0, owner.stderr);
  assert.equal(owner.json().type, "you");
  assert.equal(lastHit().headers["x-vibesquad-token"], OWNER_TOKEN);
  assert.equal(lastHit().headers["x-vs-agent-id"], undefined);
});

test("vs inbox triage: a verified lead archives through the server; a worker and --delete are refused before any card is looked at; a wrong token is 403", async () => {
  writeInboxCards([
    { id: "idea-1", text: "sq card", teamId: "sq", laneId: "art", status: "parked", createdAt: "2026-11-11T00:00:00.000Z" },
    { id: "idea-2", text: "sq card 2", teamId: "sq", laneId: "art", status: "parked", createdAt: "2026-11-11T00:00:00.000Z" },
  ]);
  const status = (id) => readInboxCards().find((c) => c.id === id)?.status;
  const w = await vs(["inbox", "triage", "--archive", "idea-nope"], { who: ids.worker });
  assert.notEqual(w.status, 0);
  assert.match(w.stderr, /leads and Buddies of the card's Squad/, "role first: no card lookup for a worker");
  const wrong = await vs(["inbox", "triage", "--archive", "idea-1"], { who: ids.lead, token: "bad" });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /403/);
  assert.equal(status("idea-1"), "parked");
  const del = await vs(["inbox", "triage", "--delete", "idea-1"], { who: ids.lead });
  assert.notEqual(del.status, 0);
  assert.match(del.stderr, /owner-only/);
  const before = hits.length;
  const ok = await vs(["inbox", "triage", "--archive", "idea-1"], { who: ids.lead });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /archived idea-1/);
  assert.equal(status("idea-1"), "archived");
  assert.equal(hits.length, before + 1);
  assert.deepEqual([lastHit().url, lastHit().headers["x-vs-agent-id"], lastHit().headers["x-vibesquad-token"]], ["/__vibesquad/inbox/triage", ids.lead, undefined]);
  const buddy = await vs(["inbox", "triage", "--park", "idea-2"], { who: ids.buddy });
  assert.equal(buddy.status, 0, buddy.stderr);
  assert.equal(status("idea-2"), "parked");
  // the owner's shell may delete (through the server, with the local token)
  const own = await vs(["inbox", "triage", "--delete", "idea-2"]);
  assert.equal(own.status, 0, own.stderr);
  assert.equal(status("idea-2"), undefined);
  assert.equal(lastHit().headers["x-vibesquad-token"], OWNER_TOKEN);
});

test("vs handoff from a lead writes the packet and makes no HTTP call", async () => {
  const before = hits.length;
  const r = await vs(["handoff"], { who: ids.lead });
  assert.equal(r.status, 0, r.stderr);
  const packet = path.join(HOME, "teams", "sq", "packet-art.md");
  assert.equal(r.stdout.trim(), packet);
  assert.ok(existsSync(packet));
  assert.equal(hits.length, before, "no request reached the VS server");
});

test("vs restart from an agent shell: the gate verifies the token with the runner (a worker is refused, a wrong token is 403); nothing is launched", async () => {
  const worker = await vs(["restart"], { who: ids.worker });
  assert.notEqual(worker.status, 0);
  assert.match(worker.stderr, /only the owner or the Overlord/);
  const wrong = await vs(["restart"], { who: ids.overlord, token: "bad" });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /403/);
  const scrubbed = await vs(["restart"], { extra: { VIBESQUAD_HOME: tmp("vs-x1b-nohome-") } });
  assert.notEqual(scrubbed.status, 0);
  assert.match(scrubbed.stderr, /no owner proof/, "a scrubbed shell with no local token is not the owner");
});

test("owner verbs (pair, devices, open, archive --sweep) never run from an agent shell and make no server call", async () => {
  const before = hits.length;
  for (const args of [["pair"], ["devices"], ["devices", "revoke", "x"], ["open"], ["archive", "--sweep"]]) {
    const r = await vs(args, { who: ids.overlord });
    assert.notEqual(r.status, 0, args.join(" "));
    assert.match(r.stderr, /owner verb/, args.join(" "));
  }
  assert.equal(hits.length, before, "no request reached the VS server");
});

// ---------- X1b review R1 (Bug17): H1 an empty id without owner proof is not the owner; M1 a leftover token is not the owner ----------
test("R1 H1: a scrubbed shell (no agent id, no local token) is refused on vs inbox triage (--delete and --archive) and vs log you; nothing is written", async () => {
  const home = tmp("vs-x1b-scrubbed-");
  writeFileSync(path.join(home, "teams.json"), JSON.stringify({ teams: TEAMS }), "utf8");
  writeInboxCards([{ id: "idea-s1", text: "scrubbed card", teamId: "sq", laneId: "art", status: "parked", createdAt: "2026-11-11T00:00:00.000Z" }], home);
  const status = () => readInboxCards(home).find((c) => c.id === "idea-s1")?.status;
  const before = hits.length;
  for (const args of [["inbox", "triage", "--delete", "idea-s1"], ["inbox", "triage", "--archive", "idea-s1"], ["log", "you", "I am the owner"], ["log", "decision", "as nobody"]]) {
    const r = await vs(args, { extra: { VIBESQUAD_HOME: home } });
    assert.notEqual(r.status, 0, args.join(" "));
    assert.match(r.stderr, /no owner proof/, args.join(" "));
  }
  assert.equal(status(), "parked", "the card is untouched");
  assert.equal(existsSync(path.join(home, "logs")), false, "no log file was written");
  assert.equal(hits.length, before, "nothing reached the VS server");
});

test("R1 M1: a leftover VS_AGENT_TOKEN with the agent id cleared is not the owner: triage/log/restart are refused and the local token is never sent", async () => {
  writeInboxCards([{ id: "idea-m1", text: "m1 card", teamId: "sq", laneId: "art", status: "parked", createdAt: "2026-11-11T00:00:00.000Z" }]);
  const before = hits.length;
  const leftover = { extra: { VS_AGENT_TOKEN: tokenOf(ids.lead) } }; // who = "" (ids cleared), HOME holds the owner's local token
  const del = await vs(["inbox", "triage", "--delete", "idea-m1"], leftover);
  assert.notEqual(del.status, 0);
  assert.match(del.stderr, /403/);
  assert.equal(readInboxCards().find((c) => c.id === "idea-m1")?.status, "parked");
  const you = await vs(["log", "you", "owner?"], leftover);
  assert.notEqual(you.status, 0);
  assert.match(you.stderr, /403|owner/);
  const restart = await vs(["restart"], leftover);
  assert.notEqual(restart.status, 0);
  assert.match(restart.stderr, /no owner proof/);
  const pair = await vs(["pair"], leftover);
  assert.notEqual(pair.status, 0);
  assert.match(pair.stderr, /owner verb/);
  const mine = hits.slice(before);
  assert.ok(mine.length >= 1, "the triage/log attempts reached the server as an agent and were refused there");
  for (const h of mine) assert.equal(h.headers["x-vibesquad-token"], undefined, `${h.method} ${h.url}: the local token was presented`);
  // masked id: PASEO_AGENT_ID="" must not hide VS_AGENT_ID (the lead still logs as itself)
  const masked = await vs(["log", "decision", "still me"], { who: ids.lead, extra: { PASEO_AGENT_ID: "" } });
  assert.equal(masked.status, 0, masked.stderr);
  assert.equal(masked.json().agent, ids.lead);
});
