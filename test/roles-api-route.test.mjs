// P5d r2 (code review finding 6): the middleware guards on /__vibesquad/roles and the legacy /__vibesquad/profiles
// write after migration. Same harness shape as test/api-path-echo.test.mjs: a real middleware on an ephemeral port, a
// temp VIBESQUAD_HOME (never the real ~/.vibesquad), callers as owner (local token), read-only (no token) or agent.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const dirs = [];
const tmp = (p) => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const HOME = tmp("vs-roles-home-");
const ROOT = tmp("vs-roles-root-");
process.env.VIBESQUAD_HOME = HOME;
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
delete process.env.VIBESQUAD_TEAMS_FILE;
for (const k of ["VS_AGENT_ID", "VS_AGENT_TOKEN", "PASEO_AGENT_ID", "VIBESQUAD_PROFILES_PATH"]) delete process.env[k];
writeFileSync(path.join(ROOT, "teams.json"), JSON.stringify({ teams: [{ id: "sq", name: "Squad", paths: [], lanes: [{ id: "sq", hub: true }, { id: "cw", path: ROOT }] }] }), "utf8");
const PROFILES = path.join(HOME, "profiles.json");
const LADDER = path.join(HOME, "stakes-ladder.json");
copyFileSync(new URL("./fixtures/profiles-v1-2026-11-17.json", import.meta.url), PROFILES);

const { AGENT_ID_HEADER, AGENT_TOKEN_HEADER, getLocalToken } = await import("../server/auth.mjs");
const { createVibesquadMiddleware } = await import("../server/vibesquad-api.mjs");
const { loadRoles } = await import("../server/profiles-v2.mjs");

after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function listen(api) {
  const srv = http.createServer((req, res) => api(req, res, () => { res.statusCode = 404; res.end("no"); }));
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  after(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  return port;
}
const port = await listen(createVibesquadMiddleware(ROOT));
// Any agent id verifies as the Squad's Overlord: the most trusted agent caller still may not edit roles.
const agentPort = await listen(createVibesquadMiddleware(ROOT, { verifyAgent: async ({ id }) => ({ id, team: "sq", lane: "sq", role: "lead", overlord: true }) }));

/** who: "owner" (local token), "read-only" (no token), "agent" (verified agent headers). */
async function as(who, method, route, body) {
  const headers = who === "owner" ? { "x-vibesquad-token": getLocalToken() } : who === "agent" ? { [AGENT_ID_HEADER]: "probe-lead", [AGENT_TOKEN_HEADER]: "t0k" } : {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`http://127.0.0.1:${who === "agent" ? agentPort : port}${route}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
}

test("PUT /roles: read-only and agent callers get a 403 and nothing is written", async () => {
  const before = readFileSync(PROFILES, "utf8");
  const lead = loadRoles(PROFILES).roles.lead;
  for (const who of ["read-only", "agent"]) {
    const r = await as(who, "PUT", "/__vibesquad/roles", { roles: { lead: { ...lead, prompt: `edited by ${who}` } } });
    assert.equal(r.status, 403, `${who}: ${r.text}`);
    const l = await as(who, "PUT", "/__vibesquad/roles", { ladder: { claude: { top: { model: "claude-opus-5-5" } } } });
    assert.equal(l.status, 403, `${who} ladder: ${l.text}`);
  }
  assert.equal(readFileSync(PROFILES, "utf8"), before, "profiles.json untouched");
  assert.equal(existsSync(LADDER), false, "no ladder file written");
  // GET is a read: a read-only caller may look.
  const g = await as("read-only", "GET", "/__vibesquad/roles");
  assert.equal(g.status, 200, g.text);
  assert.ok(g.json.roles?.lead, g.text);
});

test("PUT /roles: an owner with a bad tier gets a 400 and the file stays v1", async () => {
  const before = readFileSync(PROFILES, "utf8");
  const lead = loadRoles(PROFILES).roles.lead;
  const r = await as("owner", "PUT", "/__vibesquad/roles", { roles: { lead: { ...lead, tier: "ultra" } } });
  assert.equal(r.status, 400, r.text);
  assert.match(r.json?.error ?? r.text, /tier/i);
  assert.equal(readFileSync(PROFILES, "utf8"), before, "a refused save does not migrate");
});

test("POST /profiles after migration: a role-changing legacy write is a 409 with the fix-it text; v1 accepted it", async () => {
  // v1: the legacy editor still writes.
  const v1 = await as("owner", "POST", "/__vibesquad/profiles", { profile: { name: "Review - Gemini", notes: "v1 edit" } });
  assert.equal(v1.status, 200, v1.text);
  // The first owner role save migrates profiles.json to v2.
  const lead = loadRoles(PROFILES).roles.lead;
  const saved = await as("owner", "PUT", "/__vibesquad/roles", { roles: { lead } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(JSON.parse(readFileSync(PROFILES, "utf8")).schemaVersion, 2);
  const migrated = readFileSync(PROFILES, "utf8");
  const r = await as("owner", "POST", "/__vibesquad/profiles", { profile: { name: "Review - Gemini", notes: "after migration" } });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json?.ok, false);
  assert.match(r.json?.error ?? "", /Edit Roles and Tier Ladder/);
  assert.equal(readFileSync(PROFILES, "utf8"), migrated, "the refused write left the file alone");
});
