// M1 (PLAN_DISK_LIFECYCLE_1121, idea-464 part 5): disk-free alarm. Every 10 min read free/total for the drive holding the VS
// sanctuary/runtime (%LOCALAPPDATA%) and the projects drive. Logs a `metric` 'disk-free drive=<X> free=<GB> pct=<n>' (at most hourly unless pct
// moves >2 points), and raises ONE needs-you to the Squad Overlord per episode when free < 20%; re-arms once free recovers above 25%.
// Same shape as idle-lane-kick.mjs: setInterval tick, errors caught, VS_DISK_ALARM=0 opts out. All I/O injectable for tests.
import { stat as fsStat, statfs } from "node:fs/promises";
import { dirname, parse } from "node:path";
import { homedir } from "node:os";
import { appendVsLogEntry } from "./brainstorm.mjs";
import { primaryProjectsDir } from "./brief-path.mjs";
import { resolveManagedWorktreeRoot } from "./team-worktrees.mjs";

export const DISK_ALARM_TICK_MS = 10 * 60_000;
export const DISK_LOG_EVERY_MS = 60 * 60_000;
export const DISK_LOG_DELTA_PTS = 2;
export const DISK_LOW_PCT = 20;
export const DISK_REARM_PCT = 25;
const GB = 1024 ** 3;

export const OVERLORD_TEAM = "vibesquad";
export const OVERLORD_LANE = "vibesquad";

/** Normalized drive key: `X:` (uppercase) for a drive-letter path with either slash style, else the POSIX/UNC root without trailing separators. */
export function driveOf(p) {
  const str = String(p);
  const m = /^([A-Za-z]):/.exec(str);
  if (m) return `${m[1].toUpperCase()}:`;
  return parse(str).root.replace(/[\\/]+$/, "") || "/";
}

/** Walks up to the nearest existing ancestor (a fresh sanctuary root may not exist yet) and returns fn(thatPath). */
async function viaExisting(p, fn, probe = fsStat) {
  let cur = String(p);
  for (;;) {
    try {
      await probe(cur);
      return await fn(cur);
    } catch (e) {
      const up = dirname(cur);
      if (up === cur) throw e;
      cur = up;
    }
  }
}

async function defaultStat(p) {
  const s = await viaExisting(p, (q) => statfs(q));
  return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
}

/** Off win32 a volume is its device id (`stat.dev`), not a path root: `/` alone would lump every mount into one. */
export async function defaultVolumeKey(p, platform = process.platform, probe = fsStat) {
  if (platform === "win32") return driveOf(p);
  try {
    return `dev:${await viaExisting(p, async (q) => (await probe(q)).dev, probe)}`;
  } catch {
    return driveOf(p);
  }
}

export function defaultTargets(rootDir, { platform = process.platform, env = process.env } = {}) {
  const local = env.LOCALAPPDATA || homedir();
  const base = [local, primaryProjectsDir(rootDir)];
  // Off win32 the sanctuary is not under LOCALAPPDATA, so it can sit on its own volume: watch it explicitly.
  return platform === "win32" ? base : [...base, resolveManagedWorktreeRoot(env)];
}

export function createDiskAlarm({
  targets,
  rootDir,
  stat = defaultStat,
  platform = process.platform,
  volumeKey = (p) => defaultVolumeKey(p, platform),
  now = () => Date.now(),
  log = (type, text) => appendVsLogEntry({ teamId: OVERLORD_TEAM, laneId: OVERLORD_LANE, agent: "vibesquad-server", type, text }),
} = {}) {
  const state = new Map(); // drive -> { loggedAt, loggedPct, alarmed }
  async function tick() {
    const results = [];
    const seen = new Set();
    for (const p of targets ?? defaultTargets(rootDir, { platform })) {
      const drive = platform === "win32" ? driveOf(p) : await volumeKey(p);
      if (seen.has(drive)) continue; // two paths on one drive: one reading
      seen.add(drive);
      let s;
      try {
        s = await stat(p);
      } catch (e) {
        console.warn(`[vibesquad] disk-alarm: stat ${drive} failed: ${e?.message ?? e}`);
        continue;
      }
      if (!(s.total > 0)) continue;
      const pct = Math.round((s.free / s.total) * 100);
      const freeGb = (s.free / GB).toFixed(1);
      const t0 = now();
      const st = state.get(drive) ?? { loggedAt: -Infinity, loggedPct: null, alarmed: false };
      state.set(drive, st);
      let logged = false, raised = false;
      if (t0 - st.loggedAt >= DISK_LOG_EVERY_MS || Math.abs(pct - st.loggedPct) > DISK_LOG_DELTA_PTS) {
        await log("metric", `disk-free drive=${drive} free=${freeGb} pct=${pct}`);
        st.loggedAt = t0;
        st.loggedPct = pct;
        logged = true;
      }
      if (!st.alarmed && pct < DISK_LOW_PCT) {
        await log("needs-you", `Disk low on ${drive}: ${freeGb} GB free (${pct}%). Free space or move worktrees/artifacts before it hits zero.`);
        st.alarmed = true; // only after the write succeeded: a failed log retries next tick
        raised = true;
      } else if (st.alarmed && pct > DISK_REARM_PCT) st.alarmed = false;
      results.push({ drive, pct, logged, raised });
    }
    return results;
  }
  return { tick };
}

/** Server wiring: one tick per 10 min (plus one at start). Returns { stop, tick }. */
export function startDiskAlarm({ tickMs = DISK_ALARM_TICK_MS, env = process.env, ...rest } = {}) {
  if (env.VS_DISK_ALARM === "0") return { stop() {}, tick: async () => [], disabled: true };
  const alarm = createDiskAlarm(rest);
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    alarm.tick().catch((e) => console.warn(`[vibesquad] disk-alarm: ${e?.message ?? e}`)).finally(() => { running = false; });
  };
  const t = setInterval(run, tickMs);
  t.unref?.();
  run();
  return { stop: () => clearInterval(t), tick: alarm.tick };
}
