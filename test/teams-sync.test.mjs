import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commandPin, commandPinMerge } from "../cli/vs.mjs";
import { teamsRevision, writeTeamsRegistry } from "../server/teams-file.mjs";

const teams = readFileSync(new URL("../src/teams.ts", import.meta.url), "utf8");
const paseo = readFileSync(new URL("../src/paseo.ts", import.meta.url), "utf8");

test("saveTeams always refreshes an unknown revision and bases on disk teams", () => {
  const fn = teams.slice(teams.indexOf("export async function saveTeams"));
  assert.match(fn, /if \(teamsRevision === "unknown"\) \{\s*await refreshTeams\(\);/);
  assert.doesNotMatch(fn.slice(0, 200), /isRemote\(\) && teamsRevision/);
  assert.match(fn, /opts\.base\?\.teams \?\? \(teamsRevision !== "unknown" \? diskTeams\(\) : TEAMS\)/);
});

test("loadTeams ignores legacy bare arrays and accepts revisioned caches", () => {
  const fn = teams.slice(teams.indexOf("function loadTeams"), teams.indexOf("export let TEAMS"));
  assert.doesNotMatch(fn, /if \(Array\.isArray\(parsed\)\) return parsed/);
  assert.match(fn, /!Array\.isArray\(parsed\)/);
  assert.match(fn, /parsed\.revision !== "unknown"/);
  assert.match(fn, /Array\.isArray\(parsed\.teams\)/);
  assert.match(teams, /JSON\.stringify\(\{ revision: teamsRevision, teams: next \}\)/);
  assert.match(teams, /export function resetTeamsToDisk[\s\S]*?localStorage\.removeItem\(TEAMS_KEY\)/);
});

test("paseo refreshes teams on connected transition", () => {
  assert.match(paseo, /import \{ refreshTeams, retiredLeadTitle \} from "\.\/teams"/);
  assert.match(paseo, /void refetchProviderUsage\(\);\s*void refreshTeams\(\);/);
});

test("user registry names efi Escape From Idle", (t) => {
  let j;
  try {
    j = JSON.parse(readFileSync(join(homedir(), ".vibesquad", "teams.json"), "utf8"));
  } catch {
    return t.skip("no ~/.vibesquad/teams.json on this machine");
  }
  assert.equal(j.teams.find((x) => x.id === "efi")?.name, "Escape From Idle");
});

const ENV_KEYS = ["VIBESQUAD_HOME", "VIBESQUAD_ROOT", "VIBESQUAD_TEAMS_FILE", "VIBESQUAD_IGNORE_HOME_TEAMS", "PASEO_AGENT_ID", "VS_TEAMS_REVISION"];

function withTempHome(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-teams-sync-cli-"));
    const home = join(dir, "home");
    const root = join(dir, "root");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(root, "docs", "brainstorm"), { recursive: true });
    const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.VIBESQUAD_HOME = home;
    process.env.VIBESQUAD_ROOT = root;
    process.env.PASEO_AGENT_ID = "";
    try {
      await fn({ dir, home, root, teamsFile: join(home, "teams.json") });
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  "CLI pin with current revision succeeds and bumps revision; stale revision after concurrent server write is refused and leaves teams.json unchanged",
  withTempHome(({ home, root, teamsFile }) => {
    const initial = {
      teams: [
        {
          id: "efi",
          name: "EFI",
          paths: [],
          lanes: [
            { id: "scav-ui", name: "Scavenging UI", code: "Sca", state: "pinned" },
            { id: "fishing", name: "Fishing", code: "Fis", state: "done", doneAt: "2026-11-01T00:00:00.000Z" },
          ],
        },
      ],
    };
    writeFileSync(teamsFile, JSON.stringify(initial, null, 2) + "\n", "utf8");
    const rev0 = teamsRevision(teamsFile);
    assert.match(rev0, /^[0-9a-f]{40}$/);

    const env = { ...process.env, VIBESQUAD_HOME: home, VIBESQUAD_ROOT: root, PASEO_AGENT_ID: "" };
    const vs = (...args) => spawnSync(process.execPath, ["cli/vs.mjs", "pin", ...args], { env, encoding: "utf8" });

    // 1. CLI pin new with the current revision succeeds and bumps revision.
    const ok = vs("new", "Crafting tree", "--brief", "tiers", "--team", "efi", "--revision", rev0, "--json");
    assert.equal(ok.status, 0, ok.stderr);
    const rev1 = teamsRevision(teamsFile);
    assert.notEqual(rev1, rev0, "revision bumped after CLI pin");
    const okOut = JSON.parse(ok.stdout);
    assert.equal(okOut.revision, rev1);
    const afterOk = JSON.parse(readFileSync(teamsFile, "utf8"));
    assert.deepEqual(
      afterOk.teams[0].lanes.map((l) => l.id),
      ["scav-ui", "fishing", "crafting-tree"],
    );

    // 2. Simulate a server write in between, making rev1 stale.
    const serverEdit = structuredClone(afterOk.teams);
    serverEdit[0].lanes.push({ id: "audio", name: "Audio", code: "Aud", state: "pinned" });
    const srvRes = writeTeamsRegistry({ teams: serverEdit, revision: rev1 }, root);
    assert.equal(srvRes.status, 200);
    const rev2 = teamsRevision(teamsFile);
    assert.notEqual(rev2, rev1);
    const snapshotAfterServer = readFileSync(teamsFile, "utf8");

    // 3. CLI pin new with stale revision (rev1) is refused and teams.json + brief are unchanged.
    const staleNew = vs("new", "Weather system", "--brief", "rain and fog", "--team", "efi", "--revision", rev1);
    assert.equal(staleNew.status, 1);
    assert.match(staleNew.stderr, /teams\.json changed.*stale revision/i);
    assert.equal(readFileSync(teamsFile, "utf8"), snapshotAfterServer);
    assert.equal(teamsRevision(teamsFile), rev2);
    assert.equal(existsSync(join(root, "docs", "brainstorm", "weather-system.md")), false);

    // 4. CLI pin reopen and merge with a concurrent server write in between read and write are also refused.
    let expectedAfterServerReopen;
    const inBetweenServerWrite = () => {
      const cur = JSON.parse(readFileSync(teamsFile, "utf8"));
      cur.teams[0].lanes.push({ id: "lighting", name: "Lighting", code: "Lig", state: "pinned" });
      const r = writeTeamsRegistry({ teams: cur.teams, revision: teamsRevision(teamsFile) }, root);
      assert.equal(r.status, 200);
      expectedAfterServerReopen = readFileSync(teamsFile, "utf8");
    };
    const raceCode = commandPin({
      _: ["new", "Fishing"],
      brief: "reopen fishing",
      team: "efi",
      beforeWrite: inBetweenServerWrite,
    });
    assert.equal(raceCode, 1, "reopen refused when server wrote in between");
    assert.equal(readFileSync(teamsFile, "utf8"), expectedAfterServerReopen);
    const afterRace = JSON.parse(expectedAfterServerReopen);
    assert.equal(afterRace.teams[0].lanes.find((l) => l.id === "fishing")?.state, "done", "fishing remained done");
    assert.equal(afterRace.teams[0].lanes.some((l) => l.id === "lighting"), true, "server write preserved");

    const revBeforeMerge = teamsRevision(teamsFile);
    const snapshotBeforeMerge = readFileSync(teamsFile, "utf8");
    const staleMergeCli = vs("merge", "audio", "crafting-tree", "--note", "stale merge", "--team", "efi", "--revision", rev0);
    assert.equal(staleMergeCli.status, 1, "CLI merge with stale revision refused");
    assert.match(staleMergeCli.stderr, /teams\.json changed.*stale revision/i);
    assert.equal(readFileSync(teamsFile, "utf8"), snapshotBeforeMerge);
    assert.equal(teamsRevision(teamsFile), revBeforeMerge);

    let expectedAfterServerMerge;
    const raceMerge = commandPinMerge({
      _: ["audio", "crafting-tree"],
      note: "race merge",
      team: "efi",
      beforeWrite: () => {
        const cur = JSON.parse(readFileSync(teamsFile, "utf8"));
        cur.teams[0].lanes.push({ id: "combat", name: "Combat", code: "Com", state: "pinned" });
        const r = writeTeamsRegistry({ teams: cur.teams, revision: teamsRevision(teamsFile) }, root);
        assert.equal(r.status, 200);
        expectedAfterServerMerge = readFileSync(teamsFile, "utf8");
      },
    });
    assert.equal(raceMerge, 1, "merge refused when server wrote in between");
    assert.equal(readFileSync(teamsFile, "utf8"), expectedAfterServerMerge);
    const afterRaceMerge = JSON.parse(expectedAfterServerMerge);
    assert.equal(afterRaceMerge.teams[0].lanes.find((l) => l.id === "audio")?.state, "pinned", "audio not marked removed");
    assert.equal(afterRaceMerge.teams[0].lanes.some((l) => l.id === "combat"), true, "server write preserved");

    // 5. CLI merge with current revision succeeds and bumps revision.
    const revBeforeOkMerge = teamsRevision(teamsFile);
    const okMerge = vs("merge", "audio", "crafting-tree", "--note", "unify sfx", "--team", "efi", "--revision", revBeforeOkMerge, "--json");
    assert.equal(okMerge.status, 0, okMerge.stderr);
    const revAfterOkMerge = teamsRevision(teamsFile);
    assert.notEqual(revAfterOkMerge, revBeforeOkMerge);
    assert.equal(JSON.parse(okMerge.stdout).revision, revAfterOkMerge);
    assert.equal(
      JSON.parse(readFileSync(teamsFile, "utf8")).teams[0].lanes.find((l) => l.id === "audio")?.state,
      "removed",
    );
  }),
);

test(
  "two concurrent writers with the same base revision: lock serializes them so exactly one wins (200) and the other gets 409",
  withTempHome(async ({ home, root, teamsFile }) => {
    const seed = {
      teams: [{ id: "efi", name: "EFI", paths: [], lanes: [{ id: "base-lane", name: "Base Lane", code: "Bas", state: "pinned" }] }],
    };
    writeFileSync(teamsFile, JSON.stringify(seed, null, 2) + "\n", "utf8");
    const baseRev = teamsRevision(teamsFile);

    const env = { ...process.env, VIBESQUAD_HOME: home, VIBESQUAD_ROOT: root, PASEO_AGENT_ID: "" };
    const runWriter = (laneId, laneName) =>
      new Promise((resolve, reject) => {
        const script = `
          import { writeTeamsRegistry } from "./server/teams-file.mjs";
          const res = writeTeamsRegistry({
            revision: ${JSON.stringify(baseRev)},
            teams: [{ id: "efi", name: "EFI", paths: [], lanes: [
              { id: "base-lane", name: "Base Lane", code: "Bas", state: "pinned" },
              { id: ${JSON.stringify(laneId)}, name: ${JSON.stringify(laneName)}, state: "pinned" }
            ] }],
          }, ${JSON.stringify(root)});
          process.stdout.write(JSON.stringify({ status: res.status, revision: res.body?.revision, error: res.body?.error }));
        `;
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) return reject(new Error(`writer ${laneId} exited ${code}: ${stderr}`));
          resolve({ laneId, ...JSON.parse(stdout) });
        });
      });

    const [a, b] = await Promise.all([runWriter("writer-a", "Writer A"), runWriter("writer-b", "Writer B")]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    assert.deepEqual(statuses, [200, 409], "exactly one writer wins (200) and the other gets 409");

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 409 ? a : b;
    assert.equal(loser.error, "teams.json changed");
    assert.equal(loser.revision, winner.revision);
    assert.equal(teamsRevision(teamsFile), winner.revision);
    assert.equal(existsSync(`${teamsFile}.lock`), false, "lock file cleaned up after write");

    const onDisk = JSON.parse(readFileSync(teamsFile, "utf8"));
    assert.deepEqual(
      onDisk.teams[0].lanes.map((l) => l.id),
      ["base-lane", winner.laneId],
    );
  }),
);

