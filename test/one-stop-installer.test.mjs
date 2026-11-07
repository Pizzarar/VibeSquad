// First-run checklist (server/first-run.mjs): only an agent CLI is required; there is no Paseo to detect, install or start.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createVibesquadMiddleware } from "../server/vibesquad-api.mjs";
import * as firstRun from "../server/first-run.mjs";
import { ownerHeaders } from "./helpers/local-owner.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "../../");
const tmp = mkdtempSync(join(tmpdir(), "vs-first-run-"));

// An empty PATH/APPDATA means no agent CLI is found on the test machine.
const cleanEnv = { PATH: "", APPDATA: join(tmp, "no-appdata"), LOCALAPPDATA: join(tmp, "no-local") };

async function withApi(opts, fn) {
  const mw = createVibesquadMiddleware(ROOT, { firstRun: opts });
  const server = createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((ok) => server.close(ok));
  }
}

test("GET /__vibesquad/first-run/status has the agent-CLI shape and no Paseo block", async () => {
  await withApi({ env: cleanEnv, probeVersions: false }, async (base) => {
    const r = await fetch(`${base}/__vibesquad/first-run/status`);
    assert.equal(r.status, 200);
    const s = await r.json();
    for (const k of ["claude", "gemini", "git", "ready"]) assert.ok(k in s, `missing ${k}`);
    for (const k of ["paseo", "pinnedPaseoVersion"]) assert.ok(!(k in s), `${k} is gone`);
    assert.match(s.claude.installUrl, /anthropic/);
    assert.match(s.git.installUrl, /git-scm/);
  });
});

test("first run is ready with one agent CLI: Paseo is never part of the check", async () => {
  const st = await firstRun.inspectFirstRunStatus({ env: cleanEnv, probeVersions: false });
  assert.equal(st.ready, Boolean(st.claude.installed || st.gemini.installed));
});

test("the Paseo installer / daemon starter exports and the install-paseo route are gone", async () => {
  for (const name of ["ensurePaseoDaemon", "findPaseoCli", "managedPaseoPrefix", "PINNED_PASEO_VERSION", "isDaemonListening"]) {
    assert.ok(!(name in firstRun), `${name} is gone`);
  }
  await withApi({ env: cleanEnv, probeVersions: false }, async (base) => {
    const r = await fetch(`${base}/__vibesquad/first-run/install-paseo`, { method: "POST", headers: ownerHeaders() });
    assert.equal(r.status, 404);
  });
});

test("third-party licenses credit Node.js and keep the Paseo credit without a Paseo package", () => {
  const text = readFileSync(join(ROOT, "public", "THIRD-PARTY-LICENSES.txt"), "utf8");
  assert.match(text, /Copyright Node\.js contributors/);
  assert.match(text, /originally built on\s+Paseo/i);
  assert.doesNotMatch(text, /@getpaseo\/cli@/);
});
