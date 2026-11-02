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
  resetFirstRunState,
  startManagedPaseoInstall,
} from "../server/first-run.mjs";
import { ownerHeaders } from "./helpers/local-owner.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "../../");
const tmp = mkdtempSync(join(tmpdir(), "vs-first-run-"));

const notListening = async () => false;
const listening = async () => true;
const noDaemon = () => {};

/** A fake managed Paseo install so findPaseoCli() sees it. */
function fakeManagedPaseo(prefix) {
  const pkgDir = join(prefix, "node_modules", "@getpaseo", "cli");
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@getpaseo/cli", version: PINNED_PASEO_VERSION, bin: { paseo: "bin/paseo" } }));
  writeFileSync(join(pkgDir, "bin", "paseo"), "#!/usr/bin/env node\n");
}

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
  resetFirstRunState();
  await withApi({ env: cleanEnv, prefix: join(tmp, "p0"), isListening: notListening, probeVersions: false }, async (base) => {
    const r = await fetch(`${base}/__vibesquad/first-run/status`);
    assert.equal(r.status, 200);
    const s = await r.json();
    assert.equal(s.pinnedPaseoVersion, "0.14.0");
    for (const k of ["paseo", "claude", "gemini", "git", "ready"]) assert.ok(k in s, `missing ${k}`);
    assert.equal(s.paseo.installed, false);
    assert.equal(s.paseo.source, "none");
    assert.equal(s.paseo.installing, false);
    assert.equal(s.paseo.error, null);
    assert.match(s.claude.installUrl, /anthropic/);
    assert.match(s.git.installUrl, /git-scm/);
  });
});

test("existing daemon is reused: source existing, install does not run npm", async () => {
  resetFirstRunState();
  let ran = 0;
  const opts = {
    env: cleanEnv,
    prefix: join(tmp, "p1"),
    isListening: listening,
    probeVersions: false,
    installRunner: async () => {
      ran++;
      return { code: 0 };
    },
    spawn: noDaemon,
  };
  const st = await inspectFirstRunStatus(opts);
  assert.equal(st.paseo.source, "existing");
  assert.equal(st.paseo.installed, true);
  await withApi(opts, async (base) => {
    const r = await fetch(`${base}/__vibesquad/first-run/install-paseo`, { method: "POST", headers: ownerHeaders() });
    const body = await r.json();
    assert.equal(body.alreadyInstalled, true);
  });
  assert.equal(ran, 0);
});

test("ensurePaseoDaemon never spawns a second daemon", async () => {
  let spawned = 0;
  const res = await ensurePaseoDaemon({ isListening: listening, spawn: () => { spawned++; } });
  assert.equal(res.started, false);
  assert.equal(res.reason, "already-running");
  assert.equal(spawned, 0);
});

test("managed install transitions installing -> installed and records duration", async () => {
  resetFirstRunState();
  const prefix = join(tmp, "p2");
  let release;
  const gate = new Promise((ok) => (release = ok));
  const opts = {
    env: cleanEnv,
    prefix,
    isListening: notListening,
    probeVersions: false,
    spawn: noDaemon,
    installRunner: async ({ prefix: p, spec, onProgress }) => {
      assert.equal(spec, "@getpaseo/cli@0.14.0");
      onProgress("added 509 packages");
      await gate;
      fakeManagedPaseo(p);
      return { code: 0 };
    },
  };
  const first = await startManagedPaseoInstall(opts);
  assert.equal(first.installing, true);
  assert.equal(first.status.paseo.installing, true);
  assert.equal(first.status.paseo.installed, false);
  // A second request while running does not start another install.
  const again = await startManagedPaseoInstall(opts);
  assert.equal(again.installing, true);
  assert.equal((await inspectFirstRunStatus(opts)).paseo.progress, "added 509 packages");
  release();
  await new Promise((ok) => setTimeout(ok, 50));
  const done = await inspectFirstRunStatus(opts);
  assert.equal(done.paseo.installing, false);
  assert.equal(done.paseo.installed, true);
  assert.equal(done.paseo.source, "managed");
  assert.equal(done.paseo.version, "0.14.0");
  assert.equal(typeof done.paseo.installDurationMs, "number");
});

test("failed install surfaces an error and a retry succeeds", async () => {
  resetFirstRunState();
  const prefix = join(tmp, "p3");
  let attempt = 0;
  const opts = {
    env: cleanEnv,
    prefix,
    isListening: notListening,
    probeVersions: false,
    spawn: noDaemon,
    wait: true,
    installRunner: async ({ prefix: p }) => {
      attempt++;
      if (attempt === 1) return { code: 1, error: "getaddrinfo ENOTFOUND registry.npmjs.org" };
      fakeManagedPaseo(p);
      return { code: 0 };
    },
  };
  await withApi(opts, async (base) => {
    await (await fetch(`${base}/__vibesquad/first-run/install-paseo`, { method: "POST", headers: ownerHeaders() })).json();
    const failed = await (await fetch(`${base}/__vibesquad/first-run/status`)).json();
    assert.equal(failed.paseo.installing, false);
    assert.equal(failed.paseo.installed, false);
    assert.match(failed.paseo.error, /ENOTFOUND/);

    await (await fetch(`${base}/__vibesquad/first-run/install-paseo`, { method: "POST", headers: ownerHeaders() })).json();
    const ok = await (await fetch(`${base}/__vibesquad/first-run/status`)).json();
    assert.equal(ok.paseo.installed, true);
    assert.equal(ok.paseo.error, null);
    assert.equal(ok.paseo.installing, false);
  });
  assert.equal(attempt, 2);
});

test("third-party licenses credit Node.js and the pinned Paseo CLI", () => {
  const text = readFileSync(join(ROOT, "public", "THIRD-PARTY-LICENSES.txt"), "utf8");
  assert.match(text, /Copyright Node\.js contributors/);
  assert.match(text, /@getpaseo\/cli@0\.14\.0/);
});
