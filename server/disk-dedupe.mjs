// B1 (docs/PLAN_DISK_LIFECYCLE_1121.md, idea-464 part 4): Temp scratch TTL.
// VS code and tests make their scratch dirs with mkdtemp(join(tmpdir(), "vs-<name>-")), which leaves
// "vs-<name>-XXXXXX" (exactly 6 random [A-Za-z0-9] characters). Crashed or killed runs leak them: on the dev machine
// they are ~306k of Temp's ~327k top-level entries. This sweep removes only:
//   - direct children of the temp dir (never deeper, never the temp dir itself),
//   - real directories (a file, symlink or junction at the top level is never touched),
//   - whose name matches VS_SCRATCH_RE,
//   - whose whole tree is older than the TTL (the newest mtime of any entry, links included, is before the cutoff).
// Removal never follows a link: a symlink/junction inside a scratch dir is unlinked, so its target stays intact.
//
// Cargo note (same block): a CARGO_TARGET_DIR shared between worktrees of one repo is NOT safe. Cargo keys a local
// crate by its path relative to the workspace root, so two worktrees map to the same unit: in a test, worktree A's
// `cargo build` reported Finished without compiling and `cargo run` ran worktree B's binary. So spawns get no shared
// CARGO_TARGET_DIR. Per-worktree target dirs stay, and reclaiming them is a retention question (R1), not this module's.
import { lstat, opendir, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const VS_SCRATCH_RE = /^vs-[a-z0-9]+(?:-[a-z0-9]+)*-[A-Za-z0-9]{6}$/;
export const TEMP_TTL_DAYS = 3;
export const TEMP_TTL_TICK_MS = 30 * 60_000;
export const TEMP_TTL_FIRST_MS = 5 * 60_000;
/** Removals per tick: bounds one tick's I/O; a large backlog drains over later ticks. */
export const TEMP_TTL_MAX_REMOVE = 5000;
const DAY_MS = 86_400_000;

export const isVsScratchName = (name) => VS_SCRATCH_RE.test(String(name ?? ""));

const isDirNotLink = (st) => st.isDirectory() && !st.isSymbolicLink();

/**
 * Newest mtime in the tree at `dir` and its total file bytes, never following links. Stops early (young: true) as soon
 * as any entry is at/after `cutoff`, since such a tree is kept anyway.
 */
async function treeAge(dir, cutoff, fs) {
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let names;
    try {
      names = await fs.readdir(cur);
    } catch (e) {
      if (e?.code === "ENOENT") continue;
      throw e;
    }
    for (const name of names) {
      const p = join(cur, name);
      let st;
      try {
        st = await fs.lstat(p);
      } catch (e) {
        if (e?.code === "ENOENT") continue;
        throw e;
      }
      if (st.mtimeMs >= cutoff) return { young: true, bytes };
      if (isDirNotLink(st)) stack.push(p);
      else if (!st.isSymbolicLink()) bytes += st.size;
    }
  }
  return { young: false, bytes };
}

/** Remove `dir` bottom-up without following links: links and files are unlinked, real dirs rmdir'd once empty. */
async function removeTree(dir, fs) {
  let freed = 0;
  const names = await fs.readdir(dir);
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try {
      st = await fs.lstat(p);
    } catch (e) {
      if (e?.code === "ENOENT") continue;
      throw e;
    }
    if (st.isSymbolicLink()) {
      // A junction / dir symlink is removed as a link: unlink first, rmdir (non-recursive) as the Windows fallback.
      try {
        await fs.unlink(p);
      } catch (e) {
        if (e?.code === "ENOENT") continue;
        await fs.rmdir(p);
      }
    } else if (st.isDirectory()) {
      freed += await removeTree(p, fs);
    } else {
      try {
        await fs.unlink(p);
        freed += st.size;
      } catch (e) {
        if (e?.code !== "ENOENT") throw e;
      }
    }
  }
  try {
    await fs.rmdir(dir);
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  return freed;
}

const defaultFs = { lstat, opendir, readdir, rmdir, unlink };

/**
 * One TTL pass over `tempDir`. Returns { scanned, matched, removed, young, errors, bytesFreed, truncated }.
 * `apply: false` is a dry run: bytesFreed then counts what would be freed.
 */
export async function sweepTempScratch({
  tempDir = tmpdir(),
  ttlDays = TEMP_TTL_DAYS,
  now = Date.now(),
  maxRemove = TEMP_TTL_MAX_REMOVE,
  apply = true,
  fs = defaultFs,
} = {}) {
  const out = { scanned: 0, matched: 0, removed: 0, young: 0, errors: 0, bytesFreed: 0, truncated: false };
  const days = Number(ttlDays);
  if (!Number.isFinite(days) || days < 1) throw new Error(`temp TTL must be at least 1 day (got ${ttlDays})`);
  if (typeof tempDir !== "string" || !isAbsolute(tempDir)) throw new Error("tempDir must be an absolute path");
  const root = resolve(tempDir);
  const rootSt = await fs.lstat(root);
  if (!isDirNotLink(rootSt)) throw new Error("tempDir must be a real directory");
  const cutoff = now - days * DAY_MS;

  const dh = await fs.opendir(root);
  for await (const ent of dh) {
    out.scanned++;
    if (!isVsScratchName(ent.name)) continue;
    const p = join(root, ent.name);
    let st;
    try {
      st = await fs.lstat(p);
    } catch {
      continue; // gone (another sweeper, or the owner cleaned up)
    }
    if (!isDirNotLink(st)) continue;
    out.matched++;
    if (out.removed >= maxRemove) {
      out.truncated = true;
      break;
    }
    try {
      if (st.mtimeMs >= cutoff) {
        out.young++;
        continue;
      }
      const age = await treeAge(p, cutoff, fs);
      if (age.young) {
        out.young++;
        continue;
      }
      if (apply) out.bytesFreed += await removeTree(p, fs);
      else out.bytesFreed += age.bytes;
      out.removed++;
    } catch {
      out.errors++; // locked or permission-denied: left for a later tick
    }
  }
  return out;
}

export const formatTempTtlMetric = (r, ttlDays) =>
  `temp-scratch-ttl removed=${r.removed} bytesFreed=${r.bytesFreed} young=${r.young} errors=${r.errors} matched=${r.matched} scanned=${r.scanned} ttlDays=${ttlDays}${r.truncated ? " truncated=1" : ""}`;

/**
 * Slow tick: one sweep TEMP_TTL_FIRST_MS after start, then every TEMP_TTL_TICK_MS. A metric is logged only when a pass
 * freed something or hit errors. VS_TEMP_TTL_DAYS overrides the TTL (min 1).
 */
export function startTempScratchTtl({
  env = process.env,
  tempDir = tmpdir(),
  tickMs = TEMP_TTL_TICK_MS,
  firstMs = TEMP_TTL_FIRST_MS,
  logMetric,
  sweep = sweepTempScratch,
} = {}) {
  const ttlDays = env.VS_TEMP_TTL_DAYS ? Number(env.VS_TEMP_TTL_DAYS) : TEMP_TTL_DAYS;
  let running = false;
  const tick = async () => {
    if (running) return null;
    running = true;
    try {
      const r = await sweep({ tempDir, ttlDays });
      if ((r.removed > 0 || r.errors > 0) && logMetric) logMetric(formatTempTtlMetric(r, ttlDays));
      return r;
    } catch (e) {
      console.warn(`[vibesquad] temp-scratch-ttl: ${e?.message ?? e}`);
      return null;
    } finally {
      running = false;
    }
  };
  let interval = null;
  const first = setTimeout(() => {
    void tick();
    interval = setInterval(() => void tick(), tickMs);
    interval.unref?.();
  }, firstMs);
  first.unref?.();
  return {
    stop: () => {
      clearTimeout(first);
      if (interval) clearInterval(interval);
    },
    tick,
  };
}
