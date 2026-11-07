import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createVibesquadMiddleware } from "../server/vibesquad-api.mjs";
import {
  PINNED_PASEO_VERSION,
  ensurePaseoDaemon,
  inspectFirstRunStatus,
} from "../server/first-run.mjs";
import { ownerHeaders } from "./helpers/local-owner.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "../../");
const tmp = mkdtempSync(join(tmpdir(), "vs-first-run-"));

const notListening = async () => false;
const listening = async () => true;
const noDaemon = () => {};

// An empty PATH/APPDATA means no pre-existing Paseo is found on the test machine.
const cleanEnv = { PATH: "", APPDATA: join(tmp, "no-appdata"), LOCALAPPDATA: join(tmp, "no-local") };

async function withApi(firstRun, fn) {
  const mw = createVibesquadMiddleware(ROOT, { firstRun });
  const server = createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((ok) => server.close(ok));
  }
}

test("GET /__vibesquad/first-run/status has the full shape", async () => {
  await withApi({ env: cleanEnv, prefix: join(tmp, "p0"), isListening: notListening, probeVersions: false }, async (base) => {
    const r = await fetch(`${base}/__vibesquad/first-run/status`);
    assert.equal(r.status, 200);
    const s = await r.json();
    assert.equal(s.pinnedPaseoVersion, "0.14.0");
    for (const k of ["paseo", "claude", "gemini", "git", "ready"]) assert.ok(k in s, `missing ${k}`);
    assert.equal(s.paseo.installed, false);
    assert.equal(s.paseo.source, "none");
    assert.ok(!("installing" in s.paseo), "no install state: the checklist has no Paseo install");
    assert.match(s.claude.installUrl, /anthropic/);
    assert.match(s.git.installUrl, /git-scm/);
  });
});

test("existing daemon is reported as source existing; the install-paseo route is gone", async () => {
  const opts = { env: cleanEnv, prefix: join(tmp, "p1"), isListening: listening, probeVersions: false, spawn: noDaemon };
  const st = await inspectFirstRunStatus(opts);
  assert.equal(st.paseo.source, "existing");
  assert.equal(st.paseo.installed, true);
  await withApi(opts, async (base) => {
    const r = await fetch(`${base}/__vibesquad/first-run/install-paseo`, { method: "POST", headers: ownerHeaders() });
    assert.equal(r.status, 404);
  });
});

test("first run is ready without Paseo: only an agent CLI is required", async () => {
  const base = { env: cleanEnv, prefix: join(tmp, "p-none"), isListening: notListening, probeVersions: false, cli: null, spawn: noDaemon };
  const st = await inspectFirstRunStatus(base);
  assert.equal(st.paseo.installed, false);
  assert.equal(st.ready, Boolean(st.claude.installed || st.gemini.installed), "ready ignores Paseo");
});

test("ensurePaseoDaemon never spawns a second daemon", async () => {
  let spawned = 0;
  const res = await ensurePaseoDaemon({ isListening: listening, spawn: () => { spawned++; } });
  assert.equal(res.started, false);
  assert.equal(res.reason, "already-running");
  assert.equal(spawned, 0);
});

test("third-party licenses credit Node.js and the pinned Paseo CLI", () => {
  const text = readFileSync(join(ROOT, "public", "THIRD-PARTY-LICENSES.txt"), "utf8");
  assert.match(text, /Copyright Node\.js contributors/);
  assert.match(text, /@getpaseo\/cli@0\.14\.0/);
});
