// R2-4 remote UI & module-load guards: source-level asserts that isRemote() gates stay in place.
// Restored from 6e3a1e8:test/remote-hardening.test.mjs (deleted in 94107ee); asserts on deleted modules dropped.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
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
    assert.match(settings, /NAV\.filter\(\(n\) => !isRemote\(\) \|\| n\.id !== "runner"\)/);
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
});
