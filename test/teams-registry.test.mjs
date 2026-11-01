import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { laneWorkingDir } from "../server/brainstorm.mjs";
import { resolveTeamsFilePath, resolveTeamsWritePath } from "../server/teams-file.mjs";
import { createVibesquadMiddleware, performBrainstormRestart, resetBrainstormRestartState, seedDefaultPack } from "../server/vibesquad-api.mjs";

const ENV_KEYS = ["VIBESQUAD_HOME", "VIBESQUAD_TEAMS_FILE", "VIBESQUAD_IGNORE_HOME_TEAMS"];

// Never touches the real ~/.vibesquad: VIBESQUAD_HOME points at a temp dir for every test.
function withEnv(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-teams-registry-test-"));
    const repo = join(dir, "projects", "VibeSquad");
    const vsHome = join(dir, ".vibesquad");
    mkdirSync(repo, { recursive: true });
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

async function withServer(rootDir, fn) {
  const srv = createServer(createVibesquadMiddleware(rootDir));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${srv.address().port}`);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

test(
  "resolver order: TEAMS_FILE > VIBESQUAD_HOME > repo teams.json > example; writes never hit the example",
  withEnv(async ({ dir, repo, vsHome }) => {
    writeJson(join(repo, "teams.example.json"), { teams: [] });
    assert.equal(resolveTeamsFilePath(repo), join(repo, "teams.example.json"));
    assert.equal(resolveTeamsWritePath(repo), join(vsHome, "teams.json"), "example-only saves go to the home file");

    writeJson(join(repo, "teams.json"), { teams: [] });
    assert.equal(resolveTeamsFilePath(repo), join(repo, "teams.json"));
    assert.equal(resolveTeamsWritePath(repo), join(repo, "teams.json"));

    writeJson(join(vsHome, "teams.json"), { teams: [] });
    assert.equal(resolveTeamsFilePath(repo), join(vsHome, "teams.json"));

    process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
    assert.equal(resolveTeamsFilePath(repo), join(repo, "teams.json"));
    delete process.env.VIBESQUAD_IGNORE_HOME_TEAMS;

    const explicit = join(dir, "explicit.json");
    process.env.VIBESQUAD_TEAMS_FILE = explicit;
    assert.equal(resolveTeamsFilePath(repo), join(vsHome, "teams.json"), "a missing TEAMS_FILE falls through on read");
    writeJson(explicit, { teams: [] });
    assert.equal(resolveTeamsFilePath(repo), explicit);
    assert.equal(resolveTeamsWritePath(repo), explicit);
  }),
);

test(
  "GET /api/teams returns the home file and PUT writes it back, keeping other top-level keys",
  withEnv(async ({ repo, vsHome }) => {
    writeJson(join(repo, "teams.json"), { teams: [{ id: "repo-only", name: "Repo", lanes: [], paths: [] }] });
    const homeFile = join(vsHome, "teams.json");
    writeJson(homeFile, {
      leadFlagTokens: 123_000,
      customKey: { keep: true },
      teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "pinned", name: "Pinned" }], paths: ["VibeSquad"] }],
    });
    await withServer(repo, async (base) => {
      const got = await (await fetch(`${base}/api/teams`)).json();
      assert.deepEqual(got.teams.map((t) => t.id), ["vibesquad"]);
      assert.equal(got.teams[0].lanes[0].id, "pinned");

      const teams = [{ ...got.teams[0], lanes: [...got.teams[0].lanes, { id: "fresh", name: "Fresh", state: "pinned" }] }];
      const put = await fetch(`${base}/api/teams`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ teams }) });
      assert.equal(put.status, 200);

      const saved = readJson(homeFile);
      assert.deepEqual(saved.teams[0].lanes.map((l) => l.id), ["pinned", "fresh"]);
      assert.deepEqual(saved.customKey, { keep: true });
      assert.equal(saved.leadFlagTokens, 123_000);
      assert.equal(readJson(join(repo, "teams.json")).teams[0].id, "repo-only", "repo teams.json untouched");

      const again = await (await fetch(`${base}/__vibesquad/teams`)).json();
      assert.deepEqual(again.teams[0].lanes.map((l) => l.id), ["pinned", "fresh"]);
    });
  }),
);

test(
  "PUT with only the example present creates the home file",
  withEnv(async ({ repo, vsHome }) => {
    writeJson(join(repo, "teams.example.json"), { teams: [], exampleKey: 1 });
    await withServer(repo, async (base) => {
      const teams = [{ id: "t", name: "T", lanes: [], paths: [] }];
      const put = await fetch(`${base}/__vibesquad/teams`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ teams }) });
      assert.equal(put.status, 200);
    });
    const saved = readJson(join(vsHome, "teams.json"));
    assert.equal(saved.teams[0].id, "t");
    assert.equal(saved.exampleKey, 1);
    assert.deepEqual(readJson(join(repo, "teams.example.json")).teams, [], "example untouched");
  }),
);

test(
  "quick start with no old agent runs in the lane's repo, not the VibeSquad root",
  withEnv(async ({ dir, repo, vsHome }) => {
    const game = join(dir, "projects", "MyGame");
    mkdirSync(game, { recursive: true });
    mkdirSync(join(repo, "docs", "brainstorm"), { recursive: true });
    writeJson(join(vsHome, "teams.json"), {
      teams: [
        { id: "efi", name: "EFI", paths: ["MyGame", "mygame-"], lanes: [{ id: "efi-pin", name: "EFI Pin", paths: ["MyGame"] }, { id: "bare", name: "Bare" }] },
        { id: "nowhere", name: "Nowhere", paths: ["does-not-exist"], lanes: [{ id: "lost", name: "Lost" }] },
      ],
    });

    assert.equal(laneWorkingDir("efi", "efi-pin", repo), game);
    assert.equal(laneWorkingDir("efi", "bare", repo), game, "falls back to the team paths");
    assert.equal(laneWorkingDir("nowhere", "lost", repo), null);

    const profilesPath = join(vsHome, "profiles.json");
    seedDefaultPack(profilesPath);
    resetBrainstormRestartState();
    const created = [];
    const daemon = {
      async fetchAgents() {
        return [];
      },
      async createAgent(req) {
        created.push(req);
        return { id: "new-1", labels: {} };
      },
      async archiveAgent() {},
      async updateAgent() {},
      async cancelAgent() {},
    };
    const r = await performBrainstormRestart(
      { reason: "start-brainstorm", mode: "quick-start", teamId: "efi", laneId: "efi-pin", profile: "Brainstorm - Claude", daemonClient: daemon, profilesPath },
      repo,
    );
    assert.equal(r.ok, true);
    assert.equal(created.length, 1);
    assert.equal(created[0].config.cwd, game);
    assert.equal(created[0].labels.lane, "efi-pin");
  }),
);
