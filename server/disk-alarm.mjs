// M1 (PLAN_DISK_LIFECYCLE_1121, idea-464 part 5): disk-free alarm. Every 10 min read free/total for the drive holding the VS
// sanctuary/runtime (%LOCALAPPDATA%) and the projects drive. Logs a `metric` 'disk-free drive=<X> free=<GB> pct=<n>' (at most hourly unless pct
// moves >2 points), and raises ONE needs-you to the Squad Overlord per episode when free < 20%; re-arms once free recovers above 25%.
// Same shape as idle-lane-kick.mjs: setInterval tick, errors caught, VS_DISK_ALARM=0 opts out. All I/O injectable for tests.
import { statfs } from "node:fs/promises";
import { parse } from "node:path";
import { homedir } from "node:os";
import { appendVsLogEntry } from "./brainstorm.mjs";
import { primaryProjectsDir } from "./brief-path.mjs";

export const DISK_ALARM_TICK_MS = 10 * 60_000;
export const DISK_LOG_EVERY_MS = 60 * 60_000;
export const DISK_LOG_DELTA_PTS = 2;
export const DISK_LOW_PCT = 20;
export const DISK_REARM_PCT = 25;
const GB = 1024 ** 3;

export const OVERLORD_TEAM = "vibesquad";
export const OVERLORD_LANE = "vibesquad";

export const driveOf = (p) => parse(String(p)).root.replace(/[\/]+$/, "") || "/";

async function defaultStat(p) {
  const s = await statfs(p);
  return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
}

export function defaultTargets(rootDir) {
  const local = process.env.LOCALAPPDATA || homedir();
  return [local, primaryProjectsDir(rootDir)];
}

export function createDiskAlarm({
  targets,
  rootDir,
  stat = defaultStat,
  now = () => Date.now(),
  log = (type, text) => appendVsLogEntry({ teamId: OVERLORD_TEAM, laneId: OVERLORD_LANE, agent: "vibesquad-server", type, text }),
} = {}) {
  const state = new Map(); // drive -> { loggedAt, loggedPct, alarmed }
  async function tick() {
    const results = [];
    const seen = new Set();
    for (const p of targets ?? defaultTargets(rootDir)) {
      const drive = driveOf(p);
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
        st.alarmed = true;
        await log("needs-you", `Disk low on ${drive}: ${freeGb} GB free (${pct}%). Free space or move worktrees/artifacts before it hits zero.`);
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
