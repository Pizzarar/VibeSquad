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
for (const k of ["VS_AGENT_ID", "VS_AGENT_TOKEN", "PASEO_AGENT_ID"]) delete process.env[k];
writeFileSync(path.join(ROOT, "teams.json"), JSON.stringify({ teams: [{ id: "sq", name: "Squad", paths: [], lanes: [{ id: "sq", hub: true }] }] }), "utf8");

const { readJsonFileWithBom } = await import("../server/user-settings.mjs");
const { getLocalToken } = await import("../server/auth.mjs");
const { createVibesquadMiddleware } = await import("../server/vibesquad-api.mjs");
const { handleProvidersApi } = await import("../server/providers-catalog.mjs");

// ---- fs fault injection (live ESM bindings: syncBuiltinESMExports updates `import { readFileSync } from "node:fs"`) ----
const real = { readFileSync: fs.readFileSync, renameSync: fs.renameSync };
const nodeError = (code, syscall, p) => Object.assign(new Error(`${code}: operation failed, ${syscall} '${p}'`), { code, syscall, path: p });
function failFs(name, match, code = "EACCES") {
  fs[name] = function (...args) {
    const hit = args.slice(0, 2).find((a) => typeof a === "string" && match(a)); // rename(src, dest): either side
    if (hit) throw nodeError(code, name === "renameSync" ? "rename" : "open", hit);
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
