// idea-234: the teams.json writer re-checks lock ownership right before its rename (L4 parity with updateJsonFile), so
// a holder reaped as stale never clobbers the newer writer's file. idea-235: inbox routes answer a lock timeout with a
// generic retryable 503 that carries no lock path or holder pid (idea-232 parity with the teams/auth routes).
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const home = fs.mkdtempSync(path.join(tmpdir(), "vs-lock-owner-leak-"));
const ENV_KEYS = ["VIBESQUAD_HOME", "VIBESQUAD_TEAMS_FILE", "VIBESQUAD_IGNORE_HOME_TEAMS"];
const prevEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.VIBESQUAD_HOME = home;
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
const teamsFile = path.join(home, "teams.json");
process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
test.after(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const { isFileLockError, LOCK_LOST, LOCK_TIMEOUT, withFileLock } = await import("../server/file-lock.mjs");
const { writeTeamsRegistry, writeTeamsRegistryAsync } = await import("../server/teams-file.mjs");
const auth = await import("../server/auth.mjs");
const api = await import("../server/vibesquad-api.mjs");

const TEAM = (lanes) => [{ id: "t1", name: "T1", paths: [], lanes: lanes.map((id) => ({ id, name: id, code: id.slice(0, 3), state: "pinned" })) }];

/** While the next teams.json temp file is written, another writer reaps our lock and takes it over (fresh token). */
function stealLockDuringTempWrite(t) {
  const real = fs.writeFileSync;
  const takeover = JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: "ffffffffffffffff" });
  t.after(() => {
    fs.writeFileSync = real;
  });
  fs.writeFileSync = function (file, ...rest) {
    const out = real.call(this, file, ...rest);
    if (String(file).startsWith(`${teamsFile}.tmp-`)) {
      fs.writeFileSync = real;
      real(`${teamsFile}.lock`, takeover);
    }
    return out;
  };
  return takeover;
}

const tmpLeftovers = () => fs.readdirSync(home).filter((f) => f.startsWith("teams.json.tmp-"));

for (const [name, write] of [
  ["sync", (body) => writeTeamsRegistry(body)],
  ["async", (body) => writeTeamsRegistryAsync(body)],
]) {
  test(`idea-234 (${name}): a stolen teams.json lock means no rename, and the new holder's lock survives`, async (t) => {
    fs.writeFileSync(teamsFile, JSON.stringify({ teams: TEAM(["newer"]) }, null, 2) + "\n");
    const before = fs.readFileSync(teamsFile, "utf8");
    const takeover = stealLockDuringTempWrite(t);
    t.after(() => fs.rmSync(`${teamsFile}.lock`, { force: true }));
    await assert.rejects(async () => write({ teams: TEAM(["stale"]) }), (e) => {
      assert.match(String(e?.message), /lock lost/);
      assert.equal(e.code, LOCK_LOST);
      assert.ok(isFileLockError(e));
      return true;
    });
    assert.equal(fs.readFileSync(teamsFile, "utf8"), before, "the reaped writer must not rename over teams.json");
    assert.deepEqual(tmpLeftovers(), [], "the temp file is cleaned up");
    assert.equal(fs.readFileSync(`${teamsFile}.lock`, "utf8"), takeover, "release leaves the new holder's lock alone");
  });
}

test("idea-234: an owned teams.json write still lands", () => {
  fs.writeFileSync(teamsFile, JSON.stringify({ teams: TEAM(["a"]) }, null, 2) + "\n");
  const r = writeTeamsRegistry({ teams: TEAM(["a", "b"]) });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(teamsFile, "utf8")).teams[0].lanes.map((l) => l.id), ["a", "b"]);
  assert.ok(!fs.existsSync(`${teamsFile}.lock`));
});

test("file-lock: a timed-out wait carries code ELOCKTIMEOUT", async () => {
  const f = path.join(home, "probe.json");
  await withFileLock(f, async () => {
    await assert.rejects(withFileLock(f, () => {}, { timeoutMs: 0 }), (e) => e.code === LOCK_TIMEOUT && isFileLockError(e));
  });
});

test("idea-235: inbox lock contention is a generic 503 with no lock path or pid; a bad body stays a 400", async (t) => {
  const srv = createServer(api.createVibesquadMiddleware(path.resolve(import.meta.dirname, "..")));
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  t.after(async () => {
    srv.closeAllConnections?.();
    await new Promise((ok) => srv.close(ok));
  });
  const post = (url, body) =>
    fetch(`http://127.0.0.1:${srv.address().port}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vibesquad-token": auth.getLocalToken() },
      body: JSON.stringify(body),
    });

  const bad = await post("/__vibesquad/inbox", { text: "" });
  assert.equal(bad.status, 400, "a caller mistake is still a 400 with its reason");
  assert.match((await bad.json()).error, /No idea text/);

  // A live holder (this pid, fresh mtime, foreign token) never goes stale: the add waits out FILE_LOCK_TIMEOUT_MS.
  const inboxFile = path.join(home, "inbox.json");
  const lockFile = `${inboxFile}.lock`;
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: "eeeeeeeeeeeeeeee" }));
  t.after(() => fs.rmSync(lockFile, { force: true }));
  const warn = console.warn;
  const logged = [];
  console.warn = (...a) => logged.push(a.join(" "));
  t.after(() => {
    console.warn = warn;
  });

  for (const [url, body] of [
    ["/__vibesquad/inbox", { text: "lock contention probe", laneId: "" }],
    ["/__vibesquad/inbox/triage", { action: "archive", cardIds: ["idea-1"] }],
  ]) {
    const res = await post(url, body);
    const text = await res.text();
    assert.equal(res.status, 503, `${url}: ${text}`);
    const json = JSON.parse(text);
    assert.equal(json.ok, false);
    assert.equal(json.retryable, true);
    assert.equal(json.error, "inbox busy or unwritable; retry");
    for (const leak of [home, lockFile, "inbox.json", ".lock", String(process.pid), "Timed out"]) {
      assert.ok(!text.includes(leak), `${url}: body leaks ${JSON.stringify(leak)}: ${text}`);
    }
  }
  assert.ok(logged.some((l) => l.includes(lockFile)), "the lock detail goes to the server log");
});
