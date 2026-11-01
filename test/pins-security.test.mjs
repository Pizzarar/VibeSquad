import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { laneWorkingDir } from "../server/brainstorm.mjs";
import { createVibesquadMiddleware, validateTeamsBody } from "../server/vibesquad-api.mjs";
import { refreshTeams, saveTeams, getTeams, snapshotTeams } from "../src/teams.ts";
import { mergeTeams } from "../src/teamsMerge.ts";
import { patchLane } from "../src/pins.ts";

const ENV_KEYS = ["VIBESQUAD_HOME", "VIBESQUAD_TEAMS_FILE", "VIBESQUAD_IGNORE_HOME_TEAMS"];

// Never touches the real ~/.vibesquad: VIBESQUAD_HOME points at a temp dir for every test.
function withEnv(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-pins-security-test-"));
    const repo = join(dir, "projects", "VibeSquad");
    const vsHome = join(dir, ".vibesquad");
    mkdirSync(join(repo, "docs", "brainstorm"), { recursive: true });
    mkdirSync(vsHome, { recursive: true });
    const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.VIBESQUAD_HOME = vsHome;
    try {
      await fn({ dir, repo, vsHome });
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const writeJson = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const put = (base, body) => fetch(`${base}/api/teams`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function withServer(rootDir, fn) {
  const srv = createServer(createVibesquadMiddleware(rootDir));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${srv.address().port}`);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

const seed = { teams: [{ id: "efi", name: "EFI", color: "#0f0", paths: [], lanes: [{ id: "scav-ui", name: "Scavenging UI", state: "pinned" }] }] };

test(
  "teams PUT with a stale revision gets 409 and the current registry",
  withEnv(async ({ repo, vsHome }) => {
    const file = join(vsHome, "teams.json");
    writeJson(file, seed);
    await withServer(repo, async (base) => {
      const got = await (await fetch(`${base}/api/teams`)).json();
      assert.match(got.revision, /^[0-9a-f]{40}$/);

      const stale = { teams: got.teams, revision: "0".repeat(40) };
      const r = await put(base, stale);
      assert.equal(r.status, 409);
      const body = await r.json();
      assert.equal(body.revision, got.revision);
      assert.deepEqual(body.teams, got.teams);

      const ok = await put(base, { teams: got.teams, revision: got.revision });
      assert.equal(ok.status, 200);
      const saved = readJson(file);
      assert.equal(saved.revision, undefined, "revision is never written into the file");
      assert.equal((await ok.json()).revision, (await (await fetch(`${base}/api/teams`)).json()).revision);
    });
  }),
);

test(
  "a lane added by vs pin new between the UI's GET and PUT survives the UI save",
  withEnv(async ({ repo, vsHome }) => {
    const file = join(vsHome, "teams.json");
    writeJson(file, seed);
    await withServer(repo, async (base) => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => realFetch(`${base}${url}`, init);
      try {
        await refreshTeams();
        assert.deepEqual(getTeams()[0].lanes.map((l) => l.id), ["scav-ui"]);

        const env = { ...process.env, VIBESQUAD_HOME: vsHome, VIBESQUAD_ROOT: repo, PASEO_AGENT_ID: "" };
        const cli = spawnSync(process.execPath, ["cli/vs.mjs", "pin", "new", "Crafting tree", "--brief", "tiers", "--team", "efi"], { env, encoding: "utf8" });
        assert.equal(cli.status, 0, cli.stderr);

        // The UI still holds the pre-CLI snapshot and renames a lane from it (plain array, as most callers do).
        const res = await saveTeams(patchLane(getTeams(), "efi", "scav-ui", { name: "Scav UI" }));
        assert.equal(res.disk, true);
        let lanes = readJson(file).teams[0].lanes;
        assert.deepEqual(lanes.map((l) => [l.id, l.name]), [["scav-ui", "Scav UI"], ["crafting-tree", "Crafting tree"]]);
        assert.deepEqual(getTeams()[0].lanes.map((l) => l.id), ["scav-ui", "crafting-tree"], "UI shows the merged registry");

        // Updater form re-runs on the fresh file.
        writeJson(file, { ...readJson(file), teams: [{ ...readJson(file).teams[0], lanes: [...lanes, { id: "audio", name: "Audio" }] }] });
        assert.equal((await saveTeams((cur) => patchLane(cur, "efi", "crafting-tree", { state: "done" }))).disk, true);
        lanes = readJson(file).teams[0].lanes;
        assert.deepEqual(lanes.map((l) => [l.id, l.state ?? null]), [["scav-ui", "pinned"], ["crafting-tree", "done"], ["audio", null]]);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  }),
);

// The settings modal edits a copy taken when it opened; the 10s poll may refresh TEAMS before it saves.
async function modalSaveAcrossPoll({ repo, vsHome }, editCopy) {
  const file = join(vsHome, "teams.json");
  writeJson(file, seed);
  let lanes;
  await withServer(repo, async (base) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => realFetch(`${base}${url}`, init);
    try {
      await refreshTeams();
      const opened = snapshotTeams();
      const copy = editCopy(JSON.parse(JSON.stringify(opened.teams)));

      const env = { ...process.env, VIBESQUAD_HOME: vsHome, VIBESQUAD_ROOT: repo, PASEO_AGENT_ID: "" };
      const cli = spawnSync(process.execPath, ["cli/vs.mjs", "pin", "new", "Crafting tree", "--brief", "tiers", "--team", "efi"], { env, encoding: "utf8" });
      assert.equal(cli.status, 0, cli.stderr);
      assert.equal(await refreshTeams(), true, "poll picked up the CLI lane");

      assert.equal((await saveTeams(copy, { base: opened })).disk, true);
      lanes = readJson(file).teams[0].lanes;
      assert.deepEqual(getTeams()[0].lanes, lanes, "UI shows what was written");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  return lanes;
}

test(
  "modal save after a poll keeps a lane the CLI added while it was open",
  withEnv(async (ctx) => {
    const lanes = await modalSaveAcrossPoll(ctx, (teams) => patchLane(teams, "efi", "scav-ui", { name: "Scav UI" }));
    assert.deepEqual(lanes.map((l) => [l.id, l.name]), [["scav-ui", "Scav UI"], ["crafting-tree", "Crafting tree"]]);
  }),
);

test(
  "modal save after a poll keeps a lane the user deleted deleted",
  withEnv(async (ctx) => {
    const lanes = await modalSaveAcrossPoll(ctx, (teams) => teams.map((t) => ({ ...t, lanes: t.lanes.filter((l) => l.id !== "scav-ui") })));
    assert.deepEqual(lanes.map((l) => l.id), ["crafting-tree"]);
  }),
);

test(
  "updater saves re-run on the fresh registry after a 409 and keep the concurrent lane",
  withEnv(async ({ repo, vsHome }) => {
    const file = join(vsHome, "teams.json");
    writeJson(file, seed);
    await withServer(repo, async (base) => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => realFetch(`${base}${url}`, init);
      try {
        await refreshTeams();
        // Someone else writes between our GET and our PUT.
        writeJson(file, { teams: [{ ...seed.teams[0], lanes: [...seed.teams[0].lanes, { id: "audio", name: "Audio" }] }] });
        const seen = [];
        const res = await saveTeams((cur) => {
          seen.push(cur[0].lanes.map((l) => l.id));
          return patchLane(cur, "efi", "scav-ui", { lastProfile: "Brainstorm - Gemini" });
        });
        assert.equal(res.disk, true);
        assert.deepEqual(seen, [["scav-ui"], ["scav-ui", "audio"]], "updater ran once locally, then once on the fresh file");
        const lanes = readJson(file).teams[0].lanes;
        assert.deepEqual(lanes.map((l) => [l.id, l.lastProfile ?? null]), [["scav-ui", "Brainstorm - Gemini"], ["audio", null]]);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  }),
);

test("mergeTeams keeps our edits, lanes added elsewhere, and our deletions", () => {
  const base = [{ id: "a", name: "A", lanes: [{ id: "x", name: "X" }, { id: "y", name: "Y" }] }];
  const mine = [{ id: "a", name: "A2", lanes: [{ id: "x", name: "X2" }, { id: "new", name: "New" }] }]; // renamed, dropped y, added new
  const fresh = [
    { id: "a", name: "A", color: "#fff", lanes: [{ id: "x", name: "X", state: "pinned" }, { id: "y", name: "Y" }, { id: "cli", name: "CLI" }] },
    { id: "b", name: "B", lanes: [] },
  ];
  assert.deepEqual(mergeTeams(base, mine, fresh), [
    { id: "a", name: "A2", color: "#fff", lanes: [{ id: "x", name: "X2", state: "pinned" }, { id: "new", name: "New" }, { id: "cli", name: "CLI" }] },
    { id: "b", name: "B", lanes: [] },
  ]);
});

test("teams PUT rejects bad shapes", withEnv(async ({ repo, vsHome }) => {
  writeJson(join(vsHome, "teams.json"), seed);
  assert.throws(() => validateTeamsBody([{ id: "../x", lanes: [] }]), /bad team id/);
  assert.throws(() => validateTeamsBody([{ id: "t", lanes: [{ id: "a b" }] }]), /bad lane id/);
  assert.throws(() => validateTeamsBody([{ id: "t", lanes: [{ id: "a", paths: [{}] }] }]), /paths must be strings/);
  assert.throws(() => validateTeamsBody([{ id: "t", paths: "C:/" }]), /paths must be an array/);
  assert.throws(() => validateTeamsBody([{ id: "t", lanes: [{ id: "a", path: 5 }] }]), /path must be a string/);
  validateTeamsBody(seed.teams);
  await withServer(repo, async (base) => {
    const r = await put(base, { teams: [{ id: "t", lanes: [{ id: "a", paths: [1] }] }] });
    assert.equal(r.status, 400);
    assert.deepEqual(readJson(join(vsHome, "teams.json")), seed, "file untouched");
  });
}));

test(
  "laneWorkingDir only accepts folders under the project roots",
  withEnv(async ({ dir, repo, vsHome }) => {
    const game = join(dir, "projects", "MyGame");
    const outside = join(dir, "outside");
    mkdirSync(game, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeJson(join(vsHome, "teams.json"), {
      teams: [
        {
          id: "t",
          name: "T",
          paths: [],
          lanes: [
            { id: "abs-out", name: "Abs", paths: [outside] },
            { id: "dotdot", name: "Dots", paths: ["../outside"] },
            { id: "root", name: "Root", paths: ["."] },
            { id: "sib", name: "Sibling", paths: ["MyGame"] },
            { id: "abs-sib", name: "Abs sibling", paths: [game] },
            { id: "main", name: "Main", paths: [repo] },
          ],
        },
      ],
    });
    const warn = console.warn;
    const warnings = [];
    console.warn = (m) => warnings.push(String(m));
    try {
      assert.equal(laneWorkingDir("t", "abs-out", repo), null);
      assert.equal(laneWorkingDir("t", "dotdot", repo), null);
      assert.equal(laneWorkingDir("t", "root", repo), null);
      assert.ok(warnings.some((w) => w.includes("outside the project folders")));
    } finally {
      console.warn = warn;
    }
    assert.equal(laneWorkingDir("t", "sib", repo), game);
    assert.equal(laneWorkingDir("t", "abs-sib", repo), game);
    assert.equal(laneWorkingDir("t", "main", repo), repo);
  }),
);

test(
  "brainstorm-restart refuses an agentId that isn't an id",
  withEnv(async ({ repo }) => {
    await withServer(repo, async (base) => {
      const r = await fetch(`${base}/__vibesquad/brainstorm-restart`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "../../x/y", teamId: "t", laneId: "l", reason: "start-brainstorm" }),
      });
      assert.equal(r.status, 400);
      assert.equal((await r.json()).error, "bad agentId");
    });
  }),
);

test("vs refuses only the chars that escape a double-quoted cmd.exe arg", () => {
  const src = readFileSync("cli/vs.mjs", "utf8");
  const m = src.match(/const UNSAFE_SHELL_ARG = (\/.*\/);/);
  assert.ok(m);
  const re = eval(m[1]);
  for (const c of ['"', "%", "\r", "\n", "\0"]) assert.ok(re.test(`a${c}b`), JSON.stringify(c));
  for (const ok of ["A & B", "done!", "a ^ b | c < d > e", "plain-arg_1 with spaces"]) assert.ok(!re.test(ok), ok);
});
