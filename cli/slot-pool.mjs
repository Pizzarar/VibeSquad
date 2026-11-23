// Named machine-wide slot pools (idea-267): at most N commands of one kind at once, e.g. 3 Godot test suites.
//   vs slot run --pool godot [--max 3] [--timeout <s>] -- <cmd> [args...]
// The `npm test` slot (scripts/suite-lock.mjs) stays a single slot with its own files; a pool is its N-slot sibling built
// from the same parts: an O_EXCL lock per slot with dead/stale holder takeover (runner/lock.mjs acquireStartLock) and the
// FIFO waiter line (cli/fifo-queue.mjs). Files, in testLockDir() (fixed machine-wide, not TMPDIR) or VIBESQUAD_TEST_LOCK_DIR (tests point it at a temp dir):
//   <dir>/vibesquad-slot-<pool>-<i>.lock   {pid, startedAt, pool, index, agentId, squad, cmd}  slot i of 0..max-1, held for the run
//   <dir>/vibesquad-slot-<pool>.queue      join / beat / done lines (cli/fifo-queue.mjs)
//   <dir>/vibesquad-slot-<pool>.claim      only under reservations: held for the instant of one take (see below)
// Liveness: a holder whose pid is dead is reclaimed at once. A holder touches its lock's mtime every HOLD_BEAT_MS, so one
// whose pid was reused by another process (Windows recycles pids fast) goes stale after HOLD_STALE_MS without a beat and
// is reclaimed too. A waiter judges that only after it has itself been awake for HOLD_STALE_MS, so a machine that just woke
// from sleep (every holder's beat looks old) does not steal live slots.
// Reservations (idea-578): VS_SLOT_RESERVE_<POOL>=<squad>:<n>[,<squad>:<n>] (default godot efi:2; "none" turns them off)
// guarantee a Squad n slots. A caller takes a slot only if every OTHER reserved Squad still finds the unused part of its
// reservation free afterwards: free - 1 >= sum over other reserved R of max(0, n_R - held_R). With godot's 3 slots and
// efi:2, efi may use all 3 and every other Squad together at most 1. The caller's Squad is its agent's `team` label
// (cli/vs.mjs slotCallerSquad); an unresolved caller is shared-only. Waiters are served by walking the line in join order:
// each waiter the rule lets take a slot is handed one, a waiter it does not is skipped (no head-of-line blocking), so the
// order is FIFO within each class. Under reservations every take re-checks the rule against the lock files while holding
// the claim mutex, so two racing takers cannot both use the last unreserved slot.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireStartLock, pidAlive, readLock, releaseLock } from "../runner/lock.mjs";
import { appendQueue, ensureTestLockDir, QUEUE_BEAT_MS, QUEUE_BEAT_STALE_MS, QUEUE_POLL_MS, readQueue, testLockDir } from "./fifo-queue.mjs";

export const DEFAULT_POOL_MAX = Object.freeze({ godot: 3 });
// idea-578 (owner 11-22): 2 of the 3 godot slots are reserved for Squad efi; the 3rd is shared by every Squad.
export const DEFAULT_POOL_RESERVE = Object.freeze({ godot: "efi:2" });
// The claim mutex is held for one readdir plus a few lock creates; a live holder silent this long is wedged.
export const CLAIM_STALE_MS = 10_000;
const SHARED = "*shared";
const SQUAD_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
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

/** A Squad id as the pool compares it (lowercase), or null for none. */
export function normSquad(squad) {
  const s = String(squad ?? "").trim().toLowerCase();
  return s || null;
}

/**
 * "<squad>:<n>[,<squad>:<n>]" -> { squad: n }; "none" -> {}. Throws (naming `src`) on a malformed entry, a Squad listed
 * twice, or reservations adding up to more than `max` slots.
 */
export function parseReserveSpec(raw, { max, src = "reservation" } = {}) {
  const text = String(raw ?? "").trim();
  if (!text || text.toLowerCase() === "none") return {};
  const out = {};
  for (const part of text.split(",")) {
    const m = /^\s*([^:\s]+)\s*:\s*(\d+)\s*$/.exec(part);
    const squad = normSquad(m?.[1]);
    const n = Number(m?.[2]);
    if (!m || !SQUAD_RE.test(squad) || n < 1 || n > 64) {
      throw new Error(`${src}: bad reservation "${part.trim()}" in "${text}"; use <squad>:<n>[,<squad>:<n>] with n 1-64 (e.g. efi:2), or none`);
    }
    if (out[squad] !== undefined) throw new Error(`${src}: Squad "${squad}" is reserved twice in "${text}"`);
    out[squad] = n;
  }
  const total = Object.values(out).reduce((a, b) => a + b, 0);
  if (max !== undefined && total > max) throw new Error(`${src}: "${text}" reserves ${total} slots but the pool has only ${max}`);
  return out;
}

/**
 * The pool's reservations: VS_SLOT_RESERVE_<POOL> (godot -> VS_SLOT_RESERVE_GODOT), else DEFAULT_POOL_RESERVE, else none.
 * An env spec must fit in `max`; the default is trimmed to fit (VS_SLOT_MAX_GODOT=1 leaves efi:1).
 */
export function poolReserve(pool, { max, env = process.env } = {}) {
  const envKey = `VS_SLOT_RESERVE_${pool.toUpperCase().replace(/-/g, "_")}`;
  const raw = env[envKey];
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") return parseReserveSpec(raw, { max, src: envKey });
  const def = parseReserveSpec(DEFAULT_POOL_RESERVE[pool], { src: "default reservation" });
  let room = max ?? Infinity;
  for (const k of Object.keys(def)) {
    def[k] = Math.min(def[k], room);
    room -= def[k];
    if (!def[k]) delete def[k];
  }
  return def;
}

/** "efi:2,foo:1", or "none". */
export function formatReserve(reserve) {
  const parts = Object.entries(reserve ?? {}).map(([k, n]) => `${k}:${n}`);
  return parts.length ? parts.join(",") : "none";
}

/** The class a caller competes in: its Squad when that Squad holds a reservation, else the shared class. */
const classOf = (squad, reserve) => {
  const s = normSquad(squad);
  return s && reserve[s] ? s : SHARED;
};

/**
 * The reservation rule: may a caller of `squad` take one more slot while `free` slots are free and classes hold `held`
 * ({squad | "*shared": n})? Only if every other reserved Squad keeps the unused part of its reservation free.
 */
export function mayTake(squad, { free, held, reserve }) {
  if (free < 1) return false;
  const mine = classOf(squad, reserve);
  let owed = 0;
  for (const [r, n] of Object.entries(reserve)) if (r !== mine) owed += Math.max(0, n - (held[r] ?? 0));
  return free - 1 >= owed;
}

/** {busy, free, held} over the fresh holders of slots 0..max-1. */
function occupancy(holders, max, reserve) {
  const held = {};
  let busy = 0;
  for (const h of holders) {
    if (!h.fresh || h.index >= max) continue;
    busy++;
    const c = classOf(h.squad, reserve);
    held[c] = (held[c] ?? 0) + 1;
  }
  return { busy, free: Math.max(0, max - busy), held };
}

/**
 * Walk the live line in join order against the current occupancy: a waiter the rule lets take a slot is handed one (it
 * comes off `free` and onto its class's count), a waiter it does not is skipped and blocks nobody. Returns, for the
 * waiter at `idx`, whether it is handed a slot now, and `ahead`: the waiters before it that can block it (those of its
 * own class, plus any other handed a slot first). With no reservations this is idea-267's rule: handed iff idx < free.
 */
export function lineTurn(live, idx, { max, holders, reserve }) {
  const occ = occupancy(holders, max, reserve);
  let { free } = occ;
  const held = { ...occ.held };
  const mine = classOf(live[idx]?.squad, reserve);
  let ahead = 0;
  for (let i = 0; i < idx; i++) {
    const c = classOf(live[i].squad, reserve);
    const handed = mayTake(live[i].squad, { free, held, reserve });
    if (handed) {
      free--;
      held[c] = (held[c] ?? 0) + 1;
    }
    if (handed || c === mine) ahead++;
  }
  return { handed: mayTake(live[idx]?.squad, { free, held, reserve }), ahead };
}

export function poolPaths(pool, dir = testLockDir()) {
  return {
    dir,
    pool,
    queue: path.join(dir, `vibesquad-slot-${pool}.queue`),
    claim: path.join(dir, `vibesquad-slot-${pool}.claim`),
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
    out.push({ index, file, pid: info?.pid ?? null, startedAt: info?.startedAt ?? null, agentId: info?.agentId ?? null, squad: normSquad(info?.squad), cmd: info?.cmd ?? null, fresh });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** One try at any of slots 0..max-1. Returns {index, file, pid, startedAt} or null when all are held by live holders. */
export function tryAcquirePoolSlot(paths, { max, pid = process.pid, alive = pidAlive, staleMs = HOLD_STALE_MS, agentId = agentIdOf(), squad = null, cmd = null, onSteal } = {}) {
  for (let index = 0; index < max; index++) {
    const file = paths.slot(index);
    const startedAt = Date.now();
    const ok = acquireStartLock(file, {
      staleMs,
      alive,
      pid,
      body: { startedAt, pool: paths.pool, index, agentId, squad: normSquad(squad), cmd },
      onSteal: (old, reason) => onSteal?.({ ...old, index, reason }),
    });
    if (ok) return { index, file, pid, startedAt };
  }
  return null;
}

/**
 * One take under reservations: holding the pool's claim mutex, re-read the lock files, apply the reservation rule for
 * `squad`, and only then try the slots. Null when the claim is busy (the caller retries next poll) or the rule says no.
 */
export function tryClaimPoolSlot(paths, { max, reserve, squad = null, holdStaleMs = HOLD_STALE_MS, judgeBeat = true, pid = process.pid, alive = pidAlive, ...take } = {}) {
  if (!acquireStartLock(paths.claim, { staleMs: CLAIM_STALE_MS, alive, pid })) return null;
  try {
    const holders = poolHolders(paths, { alive, holdStaleMs, judgeBeat });
    const { free, held } = occupancy(holders, max, reserve);
    if (!mayTake(squad, { free, held, reserve })) return null;
    return tryAcquirePoolSlot(paths, { ...take, max, squad, pid, alive });
  } finally {
    releaseLock(paths.claim, pid);
  }
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
 * the count at max. With `reserve` ({squad: n}) the turn comes from lineTurn (FIFO per class, the reservation rule) and
 * the take from tryClaimPoolSlot. `onWait({ahead, waiting, busy, max, reserve, squad, holders})` fires on the first wait, on a change, and every
 * noticeMs. `onJoin({id, leave})` hands a signal handler the way out of the line. Resolves with the slot, or null after
 * timeoutMs (the waiter has left the line).
 */
export async function waitForPoolSlot(
  paths,
  {
    max,
    reserve = {},
    squad = null,
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
  squad = normSquad(squad);
  const reserved = Object.keys(reserve).length > 0;
  // squad goes on the line only under reservations: a reservation-free pool writes idea-267's lines unchanged.
  const join = () => appendQueue(paths, { op: "join", id, pid, agentId, ...(reserved ? { squad } : {}), at: Date.now() });
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
      const { handed, ahead } = lineTurn(live, idx, { max, holders, reserve });
      // Without reservations the head always tries (idea-267). With them only a handed waiter does: a head the rule
      // refuses would just churn the claim mutex, and a reclaimable holder already counts as free in lineTurn.
      if (handed || (idx === 0 && !reserved)) {
        const take = { max, pid, alive, agentId, squad, cmd, staleMs: judgeBeat ? holdStaleMs : Infinity, onSteal };
        const slot = reserved ? tryClaimPoolSlot(paths, { ...take, reserve, holdStaleMs, judgeBeat }) : tryAcquirePoolSlot(paths, take);
        if (slot) {
          leave();
          if (live.length === 1) rmSync(paths.queue, { force: true }); // nobody behind us: compact (a racing joiner re-joins)
          return slot;
        }
      }
      const key = `${ahead}|${busy}`;
      if (key !== shownKey || Date.now() - shownAt >= noticeMs) {
        shownKey = key;
        shownAt = Date.now();
        onWait?.({ ahead, waiting: live.length, busy, max, reserve, squad, holders: holders.filter((h) => h.fresh && h.pid) });
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

const who = (h) => {
  const tags = [h.agentId && `agent ${h.agentId}`, h.squad].filter(Boolean);
  return `pid ${h.pid}${tags.length ? ` (${tags.join(", ")})` : ""}`;
};

/**
 * `vs slot run`: wait for a slot of `pool`, run cmd with inherited stdio, release the slot, resolve with the child's exit
 * code (128+signal number when it died by a signal). 124: no slot within timeoutSec. 127: the command could not start.
 * 130/143: interrupted while waiting (the waiter leaves the line first).
 */
export async function runInSlot({ pool, max, reserve, squad = null, timeoutSec = 0, cmd, args = [], env = process.env, dir, stderr = process.stderr, pollMs, noticeMs } = {}) {
  pool = validatePool(pool);
  reserve ??= poolReserve(pool, { max, env });
  squad = normSquad(squad);
  const mine = Object.keys(reserve).length ? `; reserved ${formatReserve(reserve)}, you: ${squad && reserve[squad] ? squad : `${squad ?? "no squad"}, shared`}` : "";
  const paths = poolPaths(pool, ensureTestLockDir(dir ?? testLockDir(env)));
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
      reserve,
      squad,
      cmd: label,
      timeoutMs: Math.max(0, Number(timeoutSec) || 0) * 1000,
      ...(pollMs ? { pollMs } : {}),
      ...(noticeMs ? { noticeMs } : {}),
      onJoin: (t) => (leave = t.leave),
      onWait: ({ ahead, busy, max: m, holders }) =>
        say(`waiting for ${pool} slot (${ahead} ahead; ${busy}/${m} busy${holders.length ? `: ${holders.map(who).join(", ")}` : ""}${mine})`),
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
export function poolStatus(pool, { dir, max, reserve = {}, alive = pidAlive } = {}) {
  pool = validatePool(pool);
  const paths = poolPaths(pool, dir);
  const holders = poolHolders(paths, { alive });
  const { live } = readQueue(paths, { alive });
  return { pool, max, reserve, dir: paths.dir, holders, waiting: live.map((e) => ({ pid: e.pid, agentId: e.agentId, squad: normSquad(e.squad), since: e.at })) };
}
