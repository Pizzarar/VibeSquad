// idea-242 L1: an fs failure behind an API answer must never echo the host path to the caller (the detail goes to the server
// log only). Node's fs messages carry the path ("EACCES: permission denied, open '<path>'"), so each test makes one fs call
// fail the way Node does and checks the answer for the temp dir names. Fixtures live under os.tmpdir() only.
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";

const dirs = [];
const tmp = (p) => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const HOME = tmp("vs-echo-home-");
const ROOT = tmp("vs-echo-root-");
process.env.VIBESQUAD_HOME = HOME;
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
delete process.env.VIBESQUAD_TEAMS_FILE;
for (const k of ["VS_AGENT_ID", "VS_AGENT_TOKEN", "PASEO_AGENT_ID", "VIBESQUAD_PROFILES_PATH"]) delete process.env[k];
writeFileSync(path.join(ROOT, "teams.json"), JSON.stringify({ teams: [{ id: "sq", name: "Squad", paths: [], lanes: [{ id: "sq", hub: true }, { id: "cw", path: ROOT }] }] }), "utf8");

const { readJsonFileWithBom } = await import("../server/user-settings.mjs");
const { AGENT_ID_HEADER, AGENT_TOKEN_HEADER, callerFromRequest, getLocalToken } = await import("../server/auth.mjs");
const { createVibesquadMiddleware, redactHostPaths } = await import("../server/vibesquad-api.mjs");
const { performBrainstormRestart, resetBrainstormRestartState } = await import("../server/brainstorm.mjs");
const { removeTeamWorktrees } = await import("../server/team-worktrees.mjs");
const { handleProvidersApi } = await import("../server/providers-catalog.mjs");

// ---- fs fault injection (live ESM bindings: syncBuiltinESMExports updates `import { readFileSync } from "node:fs"`) ----
const real = { readFileSync: fs.readFileSync, renameSync: fs.renameSync, writeFileSync: fs.writeFileSync, mkdirSync: fs.mkdirSync };
const SYSCALL = { renameSync: "rename", mkdirSync: "mkdir" };
const nodeError = (code, syscall, p) => Object.assign(new Error(`${code}: operation failed, ${syscall} '${p}'`), { code, syscall, path: p });
function failFs(name, match, code = "EACCES") {
  fs[name] = function (...args) {
    const hit = args.slice(0, 2).find((a) => typeof a === "string" && match(a)); // rename(src, dest): either side
    if (hit) throw nodeError(code, SYSCALL[name] ?? "open", hit);
    return real[name].apply(this, args);
  };
  syncBuiltinESMExports();
}
function restoreFs() {
  Object.assign(fs, real);
  syncBuiltinESMExports();
}
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(" ")); };
afterEach(() => { restoreFs(); warnings.length = 0; });
after(() => { restoreFs(); console.warn = realWarn; for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** True when `text` names either temp dir (their random basenames are unique and have no separators to escape). */
const leaks = (text) => [HOME, ROOT].some((d) => String(text).includes(path.basename(d)));

const api = createVibesquadMiddleware(ROOT);
const srv = http.createServer((req, res) => api(req, res, () => { res.statusCode = 404; res.end("no"); }));
const port = await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
after(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
// The same API with a fake runner check: any agent id is a live Overlord (hub lead) of Squad "sq".
const agentApi = createVibesquadMiddleware(ROOT, { verifyAgent: async ({ id }) => ({ id, team: "sq", lane: "sq", role: "lead", overlord: true }) });
const agentSrv = http.createServer((req, res) => agentApi(req, res, () => { res.statusCode = 404; res.end("no"); }));
const agentPort = await new Promise((r) => agentSrv.listen(0, "127.0.0.1", () => r(agentSrv.address().port)));
after(() => new Promise((r) => { agentSrv.closeAllConnections?.(); agentSrv.close(() => r()); }));
/** who: "owner" (local token), "read-only" (no token: a trusted local caller without owner proof), "agent" (verified agent headers). */
async function as(who, method, route, body, { raw } = {}) {
  const headers = who === "owner" ? { "x-vibesquad-token": getLocalToken() } : who === "agent" ? { [AGENT_ID_HEADER]: "probe-lead", [AGENT_TOKEN_HEADER]: "t0k" } : {};
  const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
  if (payload !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`http://127.0.0.1:${who === "agent" ? agentPort : port}${route}`, { method, headers, body: payload });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
}
async function owner(method, route, body) {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { "x-vibesquad-token": getLocalToken(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, text: await r.text() };
}

test("readJsonFileWithBom: a read failure's `error` names no path; the full Node message stays in `detail` for the server log", () => {
  const file = path.join(HOME, "probe.json");
  writeFileSync(file, "{}", "utf8");
  failFs("readFileSync", (p) => p === file);
  const r = readJsonFileWithBom(file, { label: "probe.json", recordWarning: false });
  assert.equal(r.ok, false);
  assert.equal(leaks(r.error), false, r.error);
  assert.match(r.error, /EACCES/);
  assert.ok(leaks(r.detail), "detail keeps the path for the server log");
});

test("idea-242 L1: GET /api/teams with an unreadable teams.json answers a generic 500 with no host path; the detail is logged", async () => {
  failFs("readFileSync", (p) => p.endsWith("teams.json"));
  for (const route of ["/api/teams", "/__vibesquad/teams"]) {
    const r = await owner("GET", route);
    assert.equal(r.status, 500, r.text);
    assert.equal(leaks(r.text), false, `${route}: ${r.text}`);
    assert.match(JSON.parse(r.text).error, /teams/);
  }
  assert.ok(warnings.some((w) => leaks(w)), `server log has the detail: ${JSON.stringify(warnings)}`);
});

test("idea-242 L1: /settings GET (unreadable file) and POST (refused read, failed write) never echo the host path", async () => {
  const file = path.join(HOME, "settings.json");
  writeFileSync(file, JSON.stringify({ userName: "dev" }), "utf8");
  failFs("readFileSync", (p) => p === file);
  const get = await owner("GET", "/__vibesquad/settings");
  assert.equal(get.status, 200);
  const body = JSON.parse(get.text);
  assert.equal(leaks(body.parseError ?? ""), false, `parseError: ${body.parseError}`);
  for (const w of body.configWarnings ?? []) assert.equal(leaks(w.error), false, `configWarnings[].error: ${w.error}`);
  const refused = await owner("POST", "/__vibesquad/settings", { userName: "dev2" });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(leaks(refused.text), false, refused.text);
  restoreFs();
  failFs("renameSync", (p) => p === file, "EIO");
  const failed = await owner("POST", "/__vibesquad/settings", { userName: "dev3" });
  assert.equal(failed.status, 500, failed.text);
  assert.equal(leaks(failed.text), false, failed.text);
  assert.ok(warnings.some((w) => leaks(w)), `server log has the detail: ${JSON.stringify(warnings)}`);
});

test("idea-242 L1 (providers-catalog re-audit): POST /providers/settings never echoes the host path on a refused read or a failed write", async () => {
  const home = tmp("vs-echo-prov-");
  const file = path.join(home, "settings.json");
  writeFileSync(file, JSON.stringify({ runner: {} }), "utf8");
  const run = async (body) => {
    let out;
    const req = Object.assign(new http.IncomingMessage(null), { url: "/__vibesquad/providers/settings", method: "POST" });
    await handleProvidersApi(req, {}, { home, sendJson: (_res, status, data) => { out = { status, text: JSON.stringify(data) }; }, readBody: async () => body });
    return out;
  };
  const provLeaks = (t) => leaks(t) || t.includes(path.basename(home));
  failFs("readFileSync", (p) => p === file);
  const refused = await run({ runner: { providers: {} } });
  assert.ok(refused.status >= 400, refused.text);
  assert.equal(provLeaks(refused.text), false, refused.text);
  restoreFs();
  failFs("renameSync", (p) => p === file, "EIO");
  const failed = await run({ runner: { providers: {} } });
  assert.equal(failed.status, 500, failed.text);
  assert.equal(provLeaks(failed.text), false, failed.text);
  assert.ok(warnings.some((w) => w.includes(path.basename(home))), `server log has the detail: ${JSON.stringify(warnings)}`);
});

// ---- idea-249: the catch-all sweep. A handler's own validation text still reaches the caller; an fs fault never does. ----

test("idea-249: POST /brainstorm-summary with an unwritable brief folder answers a generic 500 with no host path; the detail is logged", async () => {
  failFs("mkdirSync", (p) => p.startsWith(ROOT) && p.includes("brainstorm"));
  const r = await owner("POST", "/__vibesquad/brainstorm-summary", { lane: "sq", teamId: "sq", content: "a short brief" });
  assert.equal(r.status, 500, r.text);
  assert.equal(leaks(r.text), false, r.text);
  assert.equal(JSON.parse(r.text).ok, false);
  assert.ok(warnings.some((w) => leaks(w)), `server log has the detail: ${JSON.stringify(warnings)}`);
  restoreFs();
  // A caller's own mistake keeps its specific 400 text.
  const big = await owner("POST", "/__vibesquad/brainstorm-summary", { lane: "sq", teamId: "sq", content: "x".repeat(20_000) });
  assert.equal(big.status, 400, big.text);
  assert.match(JSON.parse(big.text).error, /20000 chars/);
});

test("idea-249: GET /push/vapid-public-key with an unwritable vapid.json answers a generic 500 with no host path", async () => {
  failFs("writeFileSync", (p) => p.startsWith(HOME) && p.endsWith("vapid.json"));
  const r = await owner("GET", "/__vibesquad/push/vapid-public-key");
  assert.equal(r.status, 500, r.text);
  assert.equal(leaks(r.text), false, r.text);
  assert.ok(warnings.some((w) => leaks(w)), `server log has the detail: ${JSON.stringify(warnings)}`);
});

test("idea-249: POST /profiles with an unwritable profiles.json answers a generic 500 with no host path (was a 400 echoing it)", async () => {
  const hit = (p) => p.startsWith(HOME) && p.includes("profiles.json");
  failFs("renameSync", hit, "EPERM");
  failFs("writeFileSync", hit, "EPERM");
  const r = await owner("POST", "/__vibesquad/profiles", { profiles: [{ name: "echo-probe", provider: "claude", model: "x" }] });
  assert.equal(r.status, 500, r.text);
  assert.equal(leaks(r.text), false, r.text);
  assert.ok(warnings.some((w) => leaks(w)), `server log has the detail: ${JSON.stringify(warnings)}`);
});

test("idea-249: a failed runner agent check is a 503 that names no host path; the detail is logged", async () => {
  const where = path.join(ROOT, "runner", "token");
  const req = { headers: { [AGENT_ID_HEADER]: "probe-agent", [AGENT_TOKEN_HEADER]: "t0k" }, socket: {} };
  const verifyAgent = async () => { throw nodeError("ENOENT", "open", where); };
  const c = await callerFromRequest(req, { verifyAgent });
  assert.equal(c.kind, "denied");
  assert.equal(c.status, 503);
  assert.equal(leaks(c.error), false, c.error);
  assert.match(c.error, /could not verify the agent caller/);
  assert.ok(warnings.some((w) => leaks(w)), `server log has the detail: ${JSON.stringify(warnings)}`);
});

// ---- idea-249 fix round (Bug23 review of fea3906): a non-owner caller (agent, read-only) never gets a host path; the owner
// keeps the path fields its UI shows. Statuses of the caller's own mistakes (400/403/404/409/413) survive the catch-alls. ----

test("idea-249 M1: GET /handoff names the packet path to the owner only (read-only and agent callers get none)", async () => {
  const route = "/__vibesquad/handoff?team=sq&lane=sq";
  const own = await as("owner", "GET", route);
  assert.equal(own.status, 200, own.text);
  assert.ok(leaks(own.json.path), "the owner's HandoffModal keeps the packet path");
  for (const who of ["read-only", "agent"]) {
    const r = await as(who, "GET", route);
    assert.equal(r.status, 200, `${who}: ${r.text}`);
    assert.equal(r.json.path, undefined, `${who}: ${r.text}`);
    assert.equal(leaks(r.text), false, `${who}: ${r.text}`);
    assert.equal(typeof r.json.exists, "boolean");
  }
});

test("idea-249 M1: POST /handoff as the Squad's Overlord answers without the packet path", async () => {
  const r = await as("agent", "POST", "/__vibesquad/handoff", { team: "sq", lane: "sq" });
  assert.equal(r.status, 200, r.text); // ROOT has no cli/vs.mjs: ran:false, nothing spawned
  assert.equal(r.json.ran, false);
  assert.equal(r.json.path, undefined, r.text);
  assert.equal(leaks(r.text), false, r.text);
});

test("idea-249 M2: GET /profiles and GET /brainstorm-summary keep host paths (profiles path, lane cwd) for the owner only", async () => {
  const own = await as("owner", "GET", "/__vibesquad/profiles");
  assert.equal(own.status, 200, own.text);
  assert.ok(leaks(own.json.path), "the owner's settings screen keeps the profiles path");
  const ro = await as("read-only", "GET", "/__vibesquad/profiles");
  assert.equal(ro.status, 200, ro.text);
  assert.equal(ro.json.path, undefined, ro.text);
  assert.equal(leaks(ro.text), false, ro.text);
  const brief = "/__vibesquad/brainstorm-summary?lane=cw&teamId=sq";
  const ownBrief = await as("owner", "GET", brief);
  assert.equal(ownBrief.status, 200, ownBrief.text);
  assert.ok(leaks(ownBrief.json.cwd), `owner keeps the lane cwd: ${ownBrief.text}`);
  for (const who of ["read-only", "agent"]) {
    const r = await as(who, "GET", brief);
    assert.equal(r.status, 200, `${who}: ${r.text}`);
    assert.equal(leaks(r.text), false, `${who}: ${r.text}`);
    assert.equal(r.json.path, ownBrief.json.path, "the repo-relative brief path stays");
  }
});

test("idea-249 M3: redactHostPaths drops host-path fields and path-bearing error text at any depth; relative paths and content stay", () => {
  const home = os.homedir();
  const result = {
    ok: true,
    packetPath: path.join(HOME, "teams", "sq", "packet-sq.md"),
    prompt: `read the handoff packet at ${path.join(HOME, "teams", "sq", "packet-sq.md")}`,
    summaryPath: "docs/brainstorm/sq.md",
    content: "brief text may quote anything",
    successor: { id: "rn-2", cwd: ROOT, labels: { lane: "sq" } },
    spawnConfig: { cwd: path.join(home, "projects", "x"), provider: "claude" },
    refs: ["rn-1"],
    error: `could not retire the old lead: EPERM, open '${path.join(HOME, "runner", "agents.json")}'`,
  };
  const out = redactHostPaths(result, ROOT);
  assert.equal(leaks(JSON.stringify(out)), false, JSON.stringify(out));
  assert.equal(JSON.stringify(out).includes(JSON.stringify(home).slice(1, -1)), false, "no home dir");
  assert.equal(out.summaryPath, "docs/brainstorm/sq.md");
  assert.equal(out.content, result.content);
  assert.equal(out.successor.id, "rn-2");
  assert.equal(out.spawnConfig.provider, "claude");
  assert.match(out.error, /could not retire the old lead/);
  assert.equal(result.successor.cwd, ROOT, "the input is not mutated");
});

test("idea-249 M3: a Buddy reopen that fails with a non-runner error reports no raw message (a runner's own answer stays)", async () => {
  const bs = { id: "rn-1", title: "BRAINSTORM", status: "closed", updatedAt: "2026-11-02T04:00:00Z", labels: { team: "sq", lane: "sq", role: "brainstorm" } };
  const client = (refreshError) => ({
    isConnected: () => true,
    fetchAgents: async () => ({ entries: [{ agent: { ...bs } }], pageInfo: { hasMore: false, nextCursor: null } }),
    fetchAgent: async () => ({ agent: { ...bs } }),
    updateAgent: async () => {},
    refreshAgent: async () => { throw refreshError; },
    createAgent: async () => { throw new Error("must not spawn"); },
  });
  resetBrainstormRestartState();
  const r = await performBrainstormRestart({ reason: "start-brainstorm", teamId: "sq", laneId: "sq", agentClient: client(nodeError("EPIPE", "write", path.join(HOME, "runner", "ipc"))) }, ROOT);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.reason, "reopen-failed");
  assert.match(r.error, /Could not reopen/);
  assert.equal(leaks(r.error), false, r.error);
  assert.ok(warnings.some((w) => leaks(w)), `server log has the detail: ${JSON.stringify(warnings)}`);
});

test("idea-249 L1: a failed git step in remove-team-worktrees names no host path in its reason", () => {
  const wt = path.join(ROOT, "wt-probe");
  fs.mkdirSync(wt, { recursive: true });
  const git = (args) => {
    if (args[0] === "rev-parse") return args[1] === "--git-dir" ? path.join(ROOT, ".git", "worktrees", "wt-probe") : path.join(ROOT, ".git");
    if (args[0] === "worktree") throw Object.assign(new Error(`Command failed: git worktree remove ${wt}`), { stderr: `fatal: '${wt}' contains modified or untracked files, use --force to delete it\n` });
    return "";
  };
  const [r] = removeTeamWorktrees([{ path: wt, branch: "unit-x" }], { git });
  assert.equal(r.worktree, "kept");
  assert.match(r.reason, /contains modified or untracked files/);
  assert.equal(leaks(r.reason), false, r.reason);
});

test("idea-249 L2: the catch-alls keep a bad body's 400 and an oversized body's 413 (/handoff, /push/test)", async () => {
  for (const route of ["/__vibesquad/handoff", "/__vibesquad/push/test"]) {
    const bad = await as("owner", "POST", route, undefined, { raw: "{not json" });
    assert.equal(bad.status, 400, `${route}: ${bad.text}`);
    const big = await as("owner", "POST", route, undefined, { raw: JSON.stringify({ pad: "x".repeat(2_000_000) }) });
    assert.equal(big.status, 413, `${route}: ${big.text}`);
  }
});
