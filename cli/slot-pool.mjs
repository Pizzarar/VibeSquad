// Named machine-wide slot pools (idea-267): at most N commands of one kind at once, e.g. 3 Godot test suites.
//   vs slot run --pool godot [--max 3] [--timeout <s>] -- <cmd> [args...]
// The `npm test` slot (scripts/suite-lock.mjs) stays a single slot with its own files; a pool is its N-slot sibling built
// from the same parts: an O_EXCL lock per slot with dead/stale holder takeover (runner/lock.mjs acquireStartLock) and the
// FIFO waiter line (cli/fifo-queue.mjs). Files, in os.tmpdir() or VIBESQUAD_TEST_LOCK_DIR (tests point it at a temp dir):
//   <dir>/vibesquad-slot-<pool>-<i>.lock   {pid, startedAt, pool, index, agentId, cmd}  slot i of 0..max-1, held for the run
//   <dir>/vibesquad-slot-<pool>.queue      join / beat / done lines (cli/fifo-queue.mjs)
// Liveness: a holder whose pid is dead is reclaimed at once. A holder touches its lock's mtime every HOLD_BEAT_MS, so one
// whose pid was reused by another process (Windows recycles pids fast) goes stale after HOLD_STALE_MS without a beat and
// is reclaimed too. A waiter judges that only after it has itself been awake for HOLD_STALE_MS, so a machine that just woke
// from sleep (every holder's beat looks old) does not steal live slots.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireStartLock, pidAlive, readLock } from "../runner/lock.mjs";
import { appendQueue, QUEUE_BEAT_MS, QUEUE_BEAT_STALE_MS, QUEUE_POLL_MS, readQueue } from "./fifo-queue.mjs";

export const DEFAULT_POOL_MAX = Object.freeze({ godot: 3 });
export const HOLD_BEAT_MS = 30_000;
export const HOLD_STALE_MS = 120_000;
export const WAIT_NOTICE_MS = 30_000;
// A poll gap longer than this means the waiter itself was suspended: restart its awake clock.
const SUSPEND_GAP_MS = 10_000;
const POOL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function validatePool(pool) {
  const p = String(pool ?? "").trim().toLowerCase();
  if (!POOL_RE.test(p)) throw new Error(`bad pool name "${pool}": use 1-32 of a-z 0-9 _ - (e.g. godot)`);
  return p;
}

/** Slot count: --max, else VS_SLOT_MAX_<POOL> (godot -> VS_SLOT_MAX_GODOT), else DEFAULT_POOL_MAX, else 1. */
export function poolMax(pool, { flag, env = process.env } = {}) {
  const envKey = `VS_SLOT_MAX_${pool.toUpperCase().replace(/-/g, "_")}`;
  for (const [src, raw] of [["--max", flag], [envKey, env[envKey]]]) {
    if (raw === undefined || raw === null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 64) throw new Error(`${src} must be a whole number 1-64 (got "${raw}")`);
    return n;
  }
  return DEFAULT_POOL_MAX[pool] ?? 1;
}

export function poolPaths(pool, dir = process.env.VIBESQUAD_TEST_LOCK_DIR || os.tmpdir()) {
  return {
    dir,
    pool,
    queue: path.join(dir, `vibesquad-slot-${pool}.queue`),
    slot: (i) => path.join(dir, `vibesquad-slot-${pool}-${i}.lock`),
  };
}

function agentIdOf(env = process.env) {
  return String(env.VS_AGENT_ID || env.PASEO_AGENT_ID || "").trim() || null;
}

/**
 * Who holds the pool's slots: [{index, file, pid, startedAt, agentId, cmd, fresh}] for every lock file that exists, also
 * slots past `max` (a caller with a bigger --max) since they use the machine all the same. `fresh` is false for a
 * holder that is dead or (with judgeBeat) silent past holdStaleMs: those slots are free for the taking.
 */
export function poolHolders(paths, { alive = pidAlive, now = Date.now(), holdStaleMs = HOLD_STALE_MS, judgeBeat = true } = {}) {
  const prefix = `vibesquad-slot-${paths.pool}-`;
  let names = [];
  try {
    names = readdirSync(paths.dir).filter((n) => n.startsWith(prefix) && /^\d+\.lock$/.test(n.slice(prefix.length)));
  } catch {}
  const out = [];
  for (const name of names) {
    const index = Number(name.slice(prefix.length, -".lock".length));
    const file = path.join(paths.dir, name);
    let mtime;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue; // released meanwhile
    }
    const info = readLock(file);
    const fresh = info ? alive(info.pid) && (!judgeBeat || now - mtime < holdStaleMs) : now - mtime < 1000; // unreadable: mid-create
    out.push({ index, file, pid: info?.pid ?? null, startedAt: info?.startedAt ?? null, agentId: info?.agentId ?? null, cmd: info?.cmd ?? null, fresh });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** One try at any of slots 0..max-1. Returns {index, file, pid, startedAt} or null when all are held by live holders. */
export function tryAcquirePoolSlot(paths, { max, pid = process.pid, alive = pidAlive, staleMs = HOLD_STALE_MS, agentId = agentIdOf(), cmd = null, onSteal } = {}) {
  for (let index = 0; index < max; index++) {
    const file = paths.slot(index);
    const startedAt = Date.now();
    const ok = acquireStartLock(file, {
      staleMs,
      alive,
      pid,
      body: { startedAt, pool: paths.pool, index, agentId, cmd },
      onSteal: (old, reason) => onSteal?.({ ...old, index, reason }),
    });
    if (ok) return { index, file, pid, startedAt };
  }
  return null;
}

const ours = (slot) => {
  const cur = readLock(slot.file);
  return cur?.pid === slot.pid && cur?.startedAt === slot.startedAt;
};

/** Refresh the slot's beat (lock mtime). False when the slot is no longer ours (it was reclaimed). */
export function beatPoolSlot(slot) {
  if (!ours(slot)) return false;
  try {
    const t = new Date();
    utimesSync(slot.file, t, t);
    return true;
  } catch {
    return false;
  }
}

export function releasePoolSlot(slot) {
  if (slot && ours(slot)) rmSync(slot.file, { force: true });
}

/**
 * Wait FIFO for a slot. Joins the queue; the waiter at live position idx (0-based) tries the locks only while idx is
 * below the number of free slots (the head always tries), so arrivals are served in order while the locks alone keep
 * the count at max. `onWait({ahead, waiting, busy, max, holders})` fires on the first wait, on a change, and every
 * noticeMs. `onJoin({id, leave})` hands a signal handler the way out of the line. Resolves with the slot, or null after
 * timeoutMs (the waiter has left the line).
 */
export async function waitForPoolSlot(
  paths,
  {
    max,
    pid = process.pid,
    agentId = agentIdOf(),
    cmd = null,
    alive = pidAlive,
    pollMs = QUEUE_POLL_MS,
    beatMs = QUEUE_BEAT_MS,
    beatStaleMs = QUEUE_BEAT_STALE_MS,
    holdStaleMs = HOLD_STALE_MS,
    noticeMs = WAIT_NOTICE_MS,
    timeoutMs = 0,
    onWait,
    onJoin,
    onSteal,
  } = {},
) {
  const id = `${pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const join = () => appendQueue(paths, { op: "join", id, pid, agentId, at: Date.now() });
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    try {
      appendQueue(paths, { op: "done", id });
    } catch {}
  };
  join();
  onJoin?.({ id, leave });
  const started = Date.now();
  let lastBeat = started;
  let lastTick = started;
  let awakeSince = started;
  const beat = () => {
    appendQueue(paths, { op: "beat", id, at: Date.now() });
    lastBeat = Date.now();
  };
  let shownKey = "";
  let shownAt = 0;
  try {
    for (;;) {
      const now = Date.now();
      if (now - lastTick > SUSPEND_GAP_MS) awakeSince = now;
      lastTick = now;
      if (timeoutMs > 0 && now - started >= timeoutMs) {
        leave();
        return null;
      }
      const { known, live } = readQueue(paths, { alive, beatStaleMs });
      const idx = live.findIndex((e) => e.id === id);
      if (!known.has(id)) {
        join(); // our line was compacted away (a claimer emptied the file just as we joined): join again at the tail
        lastBeat = Date.now();
      } else if (idx < 0) {
        beat(); // we went silent past beatStaleMs (a suspended machine) and were skipped: a fresh beat restores our place
      }
      if (idx < 0) {
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      const judgeBeat = now - awakeSince >= holdStaleMs;
      const holders = poolHolders(paths, { alive, now, holdStaleMs, judgeBeat });
      const busy = holders.filter((h) => h.fresh && h.index < max).length;
      const free = Math.max(0, max - busy);
      if (idx === 0 || idx < free) {
        const slot = tryAcquirePoolSlot(paths, { max, pid, alive, agentId, cmd, staleMs: judgeBeat ? holdStaleMs : Infinity, onSteal });
        if (slot) {
          leave();
          if (live.length === 1) rmSync(paths.queue, { force: true }); // nobody behind us: compact (a racing joiner re-joins)
          return slot;
        }
      }
      const key = `${idx}|${busy}`;
      if (key !== shownKey || Date.now() - shownAt >= noticeMs) {
        shownKey = key;
        shownAt = Date.now();
        onWait?.({ ahead: idx, waiting: live.length, busy, max, holders: holders.filter((h) => h.fresh && h.pid) });
      }
      if (Date.now() - lastBeat >= beatMs) beat();
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } catch (e) {
    leave();
    throw e;
  }
}

// Windows batch files (.cmd/.bat: npm, npx, most shims) run only under cmd.exe, which parses the command line twice: once
// for `cmd /c <line>`, and again where the batch forwards %* to the real program. Plain "..." quoting is not enough there:
// %VAR% still expands, a trailing backslash eats the closing quote, and = and , split %1 (review M1). This is cross-spawn's
// escaping (lib/util/escape.js; Node's CVE-2024-27980 fix closes the same hole), and it never goes through shell:true:
//   1. MSVCRT argv rules: double each backslash run before a " or the end, escape the ", wrap the arg in "...";
//   2. caret-escape every cmd metacharacter, the quotes included, so cmd's quote mode never switches on;
//   3. escape once more for the second parse (the batch's %*); this keeps %VAR% literal.
// Spawned as cmd.exe /d /s /c "<line>" with windowsVerbatimArguments, so Node adds no quoting of its own.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

export function escapeCmdArg(arg) {
  let a = String(arg);
  a = a.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\*)$/, "$1$1");
  a = `"${a}"`;
  return a.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/** [file, args, spawn options] that run the batch file `bat` with `args` arriving intact. */
export function batchSpawnArgs(bat, args, env = process.env) {
  const line = [String(bat).replace(CMD_META, "^$1"), ...args.map(escapeCmdArg)].join(" ");
  return [env.ComSpec || env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { windowsVerbatimArguments: true }];
}

/** Windows PATH lookup for a bare name (godot -> C:\...\godot.exe, npm -> ...\npm.cmd); null when nothing matches. */
export function resolveWinCommand(cmd, env = process.env) {
  const exts = String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  if (/[\\/]/.test(cmd)) return cmd;
  // Only a PATHEXT extension counts as one: godot-4.3 still gets .exe/.cmd appended (review L1).
  const ext = path.extname(cmd).toLowerCase();
  if (ext && exts.some((e) => e.toLowerCase() === ext)) return cmd;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  for (const d of String((pathKey && env[pathKey]) || "").split(";").filter(Boolean)) {
    for (const ext of exts) {
      const f = path.join(d, cmd + ext.toLowerCase());
      try {
        if (statSync(f).isFile()) return f;
      } catch {}
    }
  }
  return null;
}

function spawnChild(cmd, args, opts, { platform = process.platform } = {}) {
  return new Promise((resolve) => {
    const tryShell = (c) => {
      const [file, argv, extra] = batchSpawnArgs(c, args, opts.env);
      const child = spawn(file, argv, { ...opts, ...extra });
      child.once("spawn", () => resolve({ child }));
      child.on("error", (err) => resolve({ err })); // after spawn: a failed kill; resolve() is a no-op by then
    };
    if (platform === "win32") {
      const found = resolveWinCommand(cmd, opts.env);
      if (!found) return resolve({ err: Object.assign(new Error(`not found on PATH`), { code: "ENOENT" }) });
      if (/\.(cmd|bat)$/i.test(found)) return tryShell(found);
      cmd = found;
    }
    const child = spawn(cmd, args, opts);
    let started = false;
    child.once("spawn", () => {
      started = true;
      resolve({ child });
    });
    child.on("error", (err) => {
      if (started) return; // a failed kill after the start
      if (platform === "win32" && err.code === "EINVAL") tryShell(cmd); // a batch file under another extension
      else resolve({ err });
    });
  });
}

const who = (h) => `pid ${h.pid}${h.agentId ? ` (agent ${h.agentId})` : ""}`;

/**
 * `vs slot run`: wait for a slot of `pool`, run cmd with inherited stdio, release the slot, resolve with the child's exit
 * code (128+signal number when it died by a signal). 124: no slot within timeoutSec. 127: the command could not start.
 * 130/143: interrupted while waiting (the waiter leaves the line first).
 */
export async function runInSlot({ pool, max, timeoutSec = 0, cmd, args = [], env = process.env, dir, stderr = process.stderr, pollMs, noticeMs } = {}) {
  pool = validatePool(pool);
  const paths = poolPaths(pool, dir ?? (env.VIBESQUAD_TEST_LOCK_DIR || os.tmpdir()));
  const label = [cmd, ...args].join(" ").slice(0, 200);
  const say = (s) => stderr.write(`vs slot: ${s}\n`);

  let slot = null;
  let leave = () => {};
  let waiting = true;
  const onSig = (sig) => () => {
    if (!waiting) return;
    leave();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  const sigs = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  const waitHandlers = sigs.map((s) => [s, onSig(s)]);
  for (const [s, h] of waitHandlers) process.on(s, h);
  const onExit = () => {
    if (!slot) leave();
    else releasePoolSlot(slot);
  };
  process.on("exit", onExit);

  try {
    slot = await waitForPoolSlot(paths, {
      max,
      cmd: label,
      timeoutMs: Math.max(0, Number(timeoutSec) || 0) * 1000,
      ...(pollMs ? { pollMs } : {}),
      ...(noticeMs ? { noticeMs } : {}),
      onJoin: (t) => (leave = t.leave),
      onWait: ({ ahead, busy, max: m, holders }) =>
        say(`waiting for ${pool} slot (${ahead} ahead; ${busy}/${m} busy${holders.length ? `: ${holders.map(who).join(", ")}` : ""})`),
      onSteal: (old) => say(`reclaimed ${pool} slot ${old.index} from ${old.reason} holder pid ${old.pid}`),
    });
  } finally {
    waiting = false;
    for (const [s, h] of waitHandlers) process.off(s, h);
  }
  if (!slot) {
    process.off("exit", onExit);
    say(`no ${pool} slot within ${timeoutSec}s; gave up (exit 124)`);
    return 124;
  }

  const beat = setInterval(() => {
    if (beatPoolSlot(slot)) return;
    clearInterval(beat);
    say(`warning: ${pool} slot ${slot.index} was reclaimed by another process while this run held it`);
  }, HOLD_BEAT_MS);
  beat.unref();
  const childEnv = { ...env, VS_SLOT_POOL: pool, VS_SLOT_INDEX: String(slot.index) };
  const { child, err } = await spawnChild(cmd, args, { stdio: "inherit", env: childEnv });
  if (err) {
    clearInterval(beat);
    releasePoolSlot(slot);
    process.off("exit", onExit);
    say(`cannot start "${cmd}": ${err.message}`);
    return 127;
  }
  // A kill aimed at us is passed on, and we wait for the child's exit either way. On Windows, Ctrl+C already reached the
  // child through the console, and child.kill() there is TerminateProcess: SIGINT is not forwarded, so the child (Godot)
  // handles its own Ctrl+C.
  const fwd = sigs.map((s) => [s, () => {
    if (s === "SIGINT" && process.platform === "win32") return;
    try { child.kill(s === "SIGBREAK" || s === "SIGHUP" ? "SIGTERM" : s); } catch {}
  }]);
  for (const [s, h] of fwd) process.on(s, h);
  const code = await new Promise((resolve) => {
    child.once("exit", (c, sig) => resolve(c ?? (sig ? 128 + (os.constants.signals[sig] ?? 0) : 1)));
  });
  for (const [s, h] of fwd) process.off(s, h);
  clearInterval(beat);
  releasePoolSlot(slot);
  process.off("exit", onExit);
  return code;
}

/** `vs slot status`: the pool's holders and waiters. */
export function poolStatus(pool, { dir, max, alive = pidAlive } = {}) {
  pool = validatePool(pool);
  const paths = poolPaths(pool, dir);
  const holders = poolHolders(paths, { alive });
  const { live } = readQueue(paths, { alive });
  return { pool, max, dir: paths.dir, holders, waiting: live.map((e) => ({ pid: e.pid, agentId: e.agentId, since: e.at })) };
}
