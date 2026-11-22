// Forge audit R16: off win32 volumes are keyed by stat.dev (not drive letter / path root) and the sanctuary is a target.
import test from "node:test";
import assert from "node:assert/strict";
import { createDiskAlarm, defaultTargets, defaultVolumeKey } from "../server/disk-alarm.mjs";

const GB = 1024 ** 3;
const DEV = { "/home/u": 10, "/home/u/projects": 10, "/srv/wt": 20 };
const devProbe = async (p) => {
  p = p.replaceAll(String.fromCharCode(92), "/");
  if (!(p in DEV)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return { dev: DEV[p] };
};

test("posix: two paths on one device share a reading; a separate mount gets its own, keyed dev:<n>", async () => {
  const logs = [];
  const alarm = createDiskAlarm({
    platform: "linux",
    targets: ["/home/u", "/home/u/projects", "/srv/wt"],
    volumeKey: (p) => defaultVolumeKey(p, "linux", devProbe),
    stat: async () => ({ total: 100 * GB, free: 50 * GB }),
    now: () => 1_000_000,
    log: async (type, text) => logs.push({ type, text }),
  });
  const res = await alarm.tick();
  assert.deepEqual(res.map((r) => r.drive), ["dev:10", "dev:20"]);
  assert.deepEqual(logs.map((l) => l.text), ["disk-free drive=dev:10 free=50.0 pct=50", "disk-free drive=dev:20 free=50.0 pct=50"]);
});

test("posix: a not-yet-created sanctuary is keyed through its nearest existing parent", async () => {
  assert.equal(await defaultVolumeKey("/srv/wt/VibeSquad/unit", "linux", devProbe), "dev:20");
});

test("posix: unresolvable path falls back to the path root; win32 keeps the drive letter", async () => {
  const never = async () => { throw new Error("nope"); };
  assert.equal(await defaultVolumeKey("/nowhere/x", "linux", never), "/");
  assert.equal(await defaultVolumeKey("d:\\proj", "win32", never), "D:");
});

test("defaultTargets adds the sanctuary root off win32 only", () => {
  const env = { VIBESQUAD_WORKTREES_DIR: "/srv/wt", LOCALAPPDATA: "" };
  const linux = defaultTargets("/repo", { platform: "linux", env });
  assert.ok(linux.some((t) => t.replaceAll("\\", "/").endsWith("/srv/wt")));
  assert.equal(defaultTargets("/repo", { platform: "win32", env }).length, 2);
});

test("posix: low-disk alarm names the dev key", async () => {
  const logs = [];
  const alarm = createDiskAlarm({
    platform: "linux",
    targets: ["/srv/wt"],
    volumeKey: (p) => defaultVolumeKey(p, "linux", devProbe),
    stat: async () => ({ total: 100 * GB, free: 5 * GB }),
    now: () => 1,
    log: async (type, text) => logs.push({ type, text }),
  });
  await alarm.tick();
  assert.ok(logs.some((l) => l.type === "needs-you" && l.text.startsWith("Disk low on dev:20")));
});
