// Block R2-4: remote mode hardening & audit fixes (synthetic HTTP Responses for vs.http errors,
// client-side 256 KiB body cap, remote/unpaired poll & desktop UI guards, R2-5 write payload alignment).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  MAX_REMOTE_REQ_BODY_BYTES,
  errorToRemoteResponse,
  installRemoteTransport,
} from "../src/remoteTransport.ts";
import { buildNewSquadTeamDef } from "../src/newSquadDef.ts";
import {
  checkRemoteBody,
  pinTeamsRegistry,
} from "../plugin/server/remote-proxy-rules.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function makeTarget() {
  return {
    location: { origin: "https://app.paseo.sh" },
    fetch: async () => new Response("passthrough", { status: 200 }),
  };
}

describe("remoteTransport vs.http error mapping & body limit", () => {
  test("maps 403 RemoteDenied rejection to a synthetic HTTP 403 Response", async () => {
    const target = makeTarget();
    installRemoteTransport(async () => {
      throw new Error("vs.http: RemoteDenied: path not on the remote allowlist [403]");
    }, target);

    const res = await target.fetch("https://app.paseo.sh/__vibesquad/paseo/status");
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("content-type"), "application/json");
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /RemoteDenied.*\[403\]/);
  });

  test("maps [400], [405], [413], [429], [503] and remote-access-off errors to matching Response statuses", async () => {
    for (const status of [400, 404, 405, 413, 429, 503]) {
      const target = makeTarget();
      installRemoteTransport(async () => {
        throw new Error(`vs.http: Rejected [${status}]`);
      }, target);
      const res = await target.fetch("https://app.paseo.sh/api/teams");
      assert.equal(res.status, status);
      const json = await res.json();
      assert.equal(json.ok, false);
      assert.match(json.error, new RegExp(`\\[${status}\\]`));
    }

    const offRes = errorToRemoteResponse(new Error("vs.http: remote access is off"));
    assert.ok(offRes);
    assert.equal(offRes.status, 403);
  });

  test("rejects request bodies larger than MAX_REMOTE_REQ_BODY_BYTES (256 KiB) client-side with 413 without calling invoke", async () => {
    assert.equal(MAX_REMOTE_REQ_BODY_BYTES, 256 * 1024);
    let calls = 0;
    const target = makeTarget();
    installRemoteTransport(async () => {
      calls++;
      return { status: 200, headers: {}, body: "{}" };
    }, target);

    const oversized = "x".repeat(MAX_REMOTE_REQ_BODY_BYTES + 1);
    const res = await target.fetch("https://app.paseo.sh/api/teams", {
      method: "PUT",
      body: oversized,
    });
    assert.equal(res.status, 413);
    assert.equal(calls, 0);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /PayloadTooLarge/);
  });

  test("genuine transport/relay disconnect errors without [4xx]/[5xx] still reject fetch", async () => {
    const target = makeTarget();
    installRemoteTransport(async () => {
      throw new Error("Relay disconnected: WebSocket closed");
    }, target);

    await assert.rejects(
      target.fetch("https://app.paseo.sh/api/teams"),
      /Relay disconnected: WebSocket closed/,
    );
    assert.equal(errorToRemoteResponse(new Error("Relay disconnected")), null);
  });
});

describe("R2-4 remote UI & module-load guards", () => {
  test("teams.ts, profiles.ts, notifications.tsx, userName.ts guard module-load and desktop fetches", () => {
    const teams = read("src/teams.ts");
    assert.match(teams, /!\(isRemote\(\) && needsPairing\(true, location\.hash\)\)/);
    assert.match(teams, /if \(teamsRevision === "unknown"\) \{\s*await refreshTeams\(\);/);

    const profiles = read("src/profiles.ts");
    assert.match(profiles, /!\(isRemote\(\) && needsPairing\(true, location\.hash\)\)/);

    const notifications = read("src/notifications.tsx");
    assert.match(notifications, /function syncPushEvents\(\): void \{\s*if \(isRemote\(\)\) return;/);
    assert.match(notifications, /data-testid="push-remote-disabled"/);

    const userName = read("src/userName.ts");
    assert.match(userName, /export async function loadDesktopStatus\(\)[\s\S]*?if \(isRemote\(\)\) return desktopStatus;/);
    assert.match(userName, /export async function loadUpdaterStatus\(\)[\s\S]*?if \(isRemote\(\)\) return updaterStatus;/);
  });

  test("App.tsx and SettingsHome.tsx gate desktop-only UI on !isRemote() and expose unpair buttons", () => {
    const app = read("src/App.tsx");
    assert.match(app, /if \(DEMO \|\| isRemote\(\)\) return;\s*void fetchFirstRunStatus\(\)/);
    assert.match(app, /exposedIps\.length > 0 && !isRemote\(\)/);
    assert.match(app, /updaterStatus\.updateAvailable && \(!isRemote\(\) \|\| isAndroidUserAgent\(\)\)/);
    assert.match(app, /data-testid="sidebar-unpair-btn"/);

    const settings = read("src/SettingsHome.tsx");
    assert.match(settings, /NAV\.filter\(\(n\) => !isRemote\(\) \|\| n\.id !== "paseo"\)/);
    assert.match(settings, /data-testid="settings-unpair-btn"/);
  });

  test("IdeaInbox.tsx and NewSquadModal.tsx align payloads with R2-5 remote body policies", () => {
    const inbox = read("src/IdeaInbox.tsx");
    assert.match(inbox, /const \{ source, \.\.\.rest \} = opts;/);
    assert.match(inbox, /laneId: opts\.laneId \|\| opts\.defaultLaneId/);
    assert.match(inbox, /action: "bounce", cardId, teamId: team\.id, laneId: newLane/);
    assert.match(inbox, /action: "merge",\s*targetId,\s*sourceIds,\s*teamId: team\.id,\s*laneId:/);
    assert.match(inbox, /action: "archive",\s*cardId,\s*teamId: team\.id,\s*laneId:/);
    assert.match(inbox, /!isRemote\(\) && \(\s*<button[^>]*inbox-open-topic-btn/);

    const newSquad = read("src/NewSquadModal.tsx");
    assert.match(newSquad, /data-testid="new-squad-remote-note"/);
    assert.match(newSquad, /lastProfile: !remote && startBuddy \? selectedProfile : undefined/);
    assert.match(newSquad, /const \{ paths: _paths, path: _path, \.\.\.restTeam \} = builtTeam/);
    assert.match(newSquad, /paths: _lp, path: _lpath, lastProfile: _lastProfile, \.\.\.restLane/);
    assert.match(newSquad, /onCreated\(newTeam\.id, remote \? null : pin\)/);
    assert.match(newSquad, /\{!remote && \(\s*<>\s*<label[^>]*>\s*<input\s+type="checkbox"\s+data-testid="new-squad-start-buddy"/);
  });

  test("remote parkIdeasInInbox payload omits source and passes checkRemoteBody", () => {
    for (const source of ["ui", "brainstorm-dump"]) {
      const opts = {
        text: "Add dark mode toggle",
        teamId: "vibesquad",
        defaultLaneId: "main-game",
        source,
        splitDump: source === "brainstorm-dump",
      };
      const { source: _source, ...rest } = opts;
      const remoteReqBody = { ...rest, laneId: opts.laneId || opts.defaultLaneId };
      assert.equal("source" in remoteReqBody, false);

      const check = checkRemoteBody("POST", "/__vibesquad/inbox", JSON.stringify(remoteReqBody));
      assert.equal(check.ok, true, `expected POST /__vibesquad/inbox to pass for source=${source}, got: ${JSON.stringify(check)}`);
    }
  });

  test("remote NewSquadModal team payload strips paths/path/lastProfile and passes checkRemoteBody + pinTeamsRegistry", () => {
    const onDiskTeams = [
      {
        id: "existing-squad",
        name: "Existing Squad",
        color: "#ff00aa",
        paths: ["C:\\Users\\Owner\\projects\\existing"],
        lanes: [{ id: "existing-lane", name: "Existing Lane", hub: true, state: "pinned", lastProfile: "Brainstorm - Claude" }],
      },
    ];
    const remote = true;
    const startBuddy = true;
    const selectedProfile = "Brainstorm - Claude";

    const builtTeam = buildNewSquadTeamDef({
      id: "team-mobile-squad",
      name: "Mobile Squad",
      folderPath: "",
      existingTeams: onDiskTeams,
      lastProfile: !remote && startBuddy ? selectedProfile : undefined,
    });
    const { paths: _paths, path: _path, ...restTeam } = builtTeam;
    const newTeam = {
      ...restTeam,
      lanes: builtTeam.lanes.map(({ paths: _lp, path: _lpath, lastProfile: _lastProfile, ...restLane }) => restLane),
    };

    // Strip pinned fields from existing teams as echoed or keep valid representation
    const savePayload = {
      teams: [...onDiskTeams, newTeam],
      revision: "rev-123",
    };

    const bodyCheck = checkRemoteBody("PUT", "/api/teams", JSON.stringify(savePayload));
    assert.equal(bodyCheck.ok, true, `checkRemoteBody failed: ${JSON.stringify(bodyCheck)}`);

    const regCheck = pinTeamsRegistry(bodyCheck.value, { teams: onDiskTeams });
    assert.equal(regCheck.ok, true, `pinTeamsRegistry failed: ${JSON.stringify(regCheck)}`);
  });
});
