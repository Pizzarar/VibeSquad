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
import { lstat, opendir, readdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const VS_SCRATCH_RE = /^vs-[a-z0-9]+(?:-[a-z0-9]+)*-[A-Za-z0-9]{6}$/;
export const TEMP_TTL_DAYS = 3;
export const TEMP_TTL_TICK_MS = 30 * 60_000;
export const TEMP_TTL_FIRST_MS = 5 * 60_000;
/** Removals per pass: bounds one pass's I/O; a large backlog drains over later passes. */
export const TEMP_TTL_MAX_REMOVE = 5000;
/** Wall-clock budget per pass: a pass stops (truncated) once it has run this long. */
export const TEMP_TTL_MAX_MS = 4 * 60_000;
/**
 * Delay before the next pass while backlogged (the last pass was truncated). At the 30-minute slow tick, 5000 per pass
 * drained at most ~240k dirs/day against a live backlog of ~240k expired VS dirs, and each truncated pass rescans from
 * the top of the dir. The backlog cadence drains that in hours, then drops back to the slow tick once a pass ends
 * untruncated.
 */
export const TEMP_TTL_BACKLOG_MS = 60_000;
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

const freshError = (p) => Object.assign(new Error(`entry inside the TTL, removal stopped: ${p}`), { code: "VS_TTL_FRESH" });

/**
 * Remove `dir` bottom-up without following links: links and files are unlinked, real dirs rmdir'd once empty.
 * Every level is lstat'ed right before its readdir, and anything that is not a real directory there (a dir swapped for
 * a junction/symlink after the scan) is refused instead of read, so a link target is never walked or emptied. With
 * `cutoff`, any entry (or dir) modified at/after it stops the removal (VS_TTL_FRESH): a tree written to after the scan
 * keeps its fresh entries. Residual: the lstat -> readdir gap is not atomic (no handle-relative ops in Node), but it is
 * one syscall wide instead of a whole tree walk.
 */
async function removeTree(dir, fs, cutoff = Infinity) {
  let dirSt;
  try {
    dirSt = await fs.lstat(dir);
  } catch (e) {
    if (e?.code === "ENOENT") return 0;
    throw e;
  }
  if (!isDirNotLink(dirSt)) throw Object.assign(new Error(`not a real directory, refused: ${dir}`), { code: "VS_TTL_NOT_DIR" });
  if (dirSt.mtimeMs >= cutoff) throw freshError(dir);
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
    if (st.mtimeMs >= cutoff) throw freshError(p);
    if (st.isSymbolicLink()) {
      // A junction / dir symlink is removed as a link: unlink first, rmdir (non-recursive) as the Windows fallback.
      try {
        await fs.unlink(p);
      } catch (e) {
        if (e?.code === "ENOENT") continue;
        await fs.rmdir(p);
      }
    } else if (st.isDirectory()) {
      freed += await removeTree(p, fs, cutoff); // re-lstat's p at entry
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
 * The scan -> delete re-check: the tree walk can take seconds, so right before removal `p` must still be a real
 * directory (not swapped for a link) whose own mtime is before the cutoff. removeTree then re-checks every level.
 */
async function stillExpiredDir(p, cutoff, fs) {
  let st;
  try {
    st = await fs.lstat(p);
  } catch (e) {
    if (e?.code === "ENOENT") return false;
    throw e;
  }
  return isDirNotLink(st) && st.mtimeMs < cutoff;
}

/** Shared guards for every pass: TTL >= 1 day, an absolute temp dir that is a real directory (not a link). */
async function checkedRoot(tempDir, ttlDays, fs) {
  const days = Number(ttlDays);
  if (!Number.isFinite(days) || days < 1) throw new Error(`temp TTL must be at least 1 day (got ${ttlDays})`);
  if (typeof tempDir !== "string" || !isAbsolute(tempDir)) throw new Error("tempDir must be an absolute path");
  const root = resolve(tempDir);
  const rootSt = await fs.lstat(root);
  if (!isDirNotLink(rootSt)) throw new Error("tempDir must be a real directory");
  return { root, days };
}

/**
 * One TTL pass over `tempDir`. Returns { scanned, matched, removed, young, errors, bytesFreed, truncated, stop, ms }.
 * A pass stops early (truncated; `stop` is "count" or "time") after `maxRemove` removals or `maxMs` of wall clock, and
 * the caller then runs the next pass on the backlog cadence. `apply: false` is a dry run: bytesFreed then counts what
 * would be freed.
 */
export async function sweepTempScratch({
  tempDir = tmpdir(),
  ttlDays = TEMP_TTL_DAYS,
  now = Date.now(),
  maxRemove = TEMP_TTL_MAX_REMOVE,
  maxMs = TEMP_TTL_MAX_MS,
  clock = Date.now,
  apply = true,
  fs = defaultFs,
} = {}) {
  const out = { scanned: 0, matched: 0, removed: 0, young: 0, errors: 0, bytesFreed: 0, truncated: false, stop: null, ms: 0 };
  const { root, days } = await checkedRoot(tempDir, ttlDays, fs);
  const cutoff = now - days * DAY_MS;
  const started = clock();

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
    if (out.removed >= maxRemove || clock() - started >= maxMs) {
      out.truncated = true;
      out.stop = out.removed >= maxRemove ? "count" : "time";
      break; // leaving a for-await closes the Dir handle
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
      if (apply) {
        if (!(await stillExpiredDir(p, cutoff, fs))) {
          out.young++; // swapped for a link, written to, or gone since the walk: left alone
          continue;
        }
        out.bytesFreed += await removeTree(p, fs, cutoff);
      } else out.bytesFreed += age.bytes;
      out.removed++;
    } catch {
      out.errors++; // locked or permission-denied: left for a later tick
    }
  }
  out.ms = Math.max(0, Math.round(clock() - started));
  return out;
}

export const formatTempTtlMetric = (r, ttlDays) =>
  `temp-scratch-ttl removed=${r.removed} bytesFreed=${r.bytesFreed} young=${r.young} errors=${r.errors} matched=${r.matched} scanned=${r.scanned} ttlDays=${ttlDays}${r.ms != null ? ` ms=${r.ms}` : ""}${r.truncated ? ` truncated=${r.stop ?? 1}` : ""}`;

/**
 * First pass TEMP_TTL_FIRST_MS after start; each later pass starts TEMP_TTL_TICK_MS after the previous one ends, or
 * only `backlogMs` after it when that pass was truncated and removed something (backlog cadence). A metric is logged
 * when a pass freed something, hit errors or was truncated. VS_TEMP_TTL_DAYS overrides the TTL (min 1).
 */
export function startTempScratchTtl({
  env = process.env,
  tempDir = tmpdir(),
  tickMs = TEMP_TTL_TICK_MS,
  firstMs = TEMP_TTL_FIRST_MS,
  backlogMs = TEMP_TTL_BACKLOG_MS,
  logMetric,
  sweep = sweepTempScratch,
} = {}) {
  const ttlDays = env.VS_TEMP_TTL_DAYS ? Number(env.VS_TEMP_TTL_DAYS) : TEMP_TTL_DAYS;
  let running = false;
  let stopped = false;
  let timer = null;
  const tick = async () => {
    if (running) return null;
    running = true;
    try {
      const r = await sweep({ tempDir, ttlDays });
      if ((r.removed > 0 || r.errors > 0 || r.truncated) && logMetric) logMetric(formatTempTtlMetric(r, ttlDays));
      return r;
    } catch (e) {
      console.warn(`[vibesquad] temp-scratch-ttl: ${e?.message ?? e}`);
      return null;
    } finally {
      running = false;
    }
  };
  const schedule = (ms) => {
    if (stopped) return;
    timer = setTimeout(async () => {
      const r = await tick();
      // Backlog cadence only while passes still make progress: a pass cut off by the time budget with nothing removed
      // (a slow scan over young dirs) goes back to the slow tick instead of looping every backlogMs.
      schedule(r?.truncated && r.removed > 0 ? backlogMs : tickMs);
    }, ms);
    timer.unref?.();
  };
  schedule(firstMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    tick,
  };
}

/** "vs-catalog-Ab12Cd" -> "vs-catalog": the creator's mkdtemp prefix (names are pre-checked by VS_SCRATCH_RE). */
export const scratchPrefix = (name) => String(name).slice(0, -7);

export const AGE_BUCKETS = ["<1d", "1-3d", "3-7d", ">=7d"];
const ageBucket = (ageMs) => (ageMs < DAY_MS ? "<1d" : ageMs < 3 * DAY_MS ? "1-3d" : ageMs < 7 * DAY_MS ? "3-7d" : ">=7d");

/** Newest mtime (the dir itself and every entry, links included) and total file bytes of a tree; never follows links. */
async function treeStats(dir, dirMtime, fs) {
  let bytes = 0;
  let newest = dirMtime;
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
      if (st.mtimeMs > newest) newest = st.mtimeMs;
      if (isDirNotLink(st)) stack.push(p);
      else if (!st.isSymbolicLink()) bytes += st.size;
    }
  }
  return { newest, bytes };
}

const emptyRow = () => ({ count: 0, bytes: 0, eligible: 0, eligibleBytes: 0, ages: Object.fromEntries(AGE_BUCKETS.map((b) => [b, { count: 0, bytes: 0 }])) });

async function readCheckpoint(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw new Error(`checkpoint ${file} is unreadable: ${e?.message ?? e}`);
  }
}

async function writeCheckpoint(file, data) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data), "utf8");
  await rename(tmp, file);
}

/**
 * One-time catch-up over the whole temp dir (`vs temp-ttl --catch-up`). Same guards as the sweep: strict name match,
 * real top-level dirs only, links never followed, and a tree with any entry inside the TTL is kept. DRY RUN unless
 * `apply: true`. byPrefix[prefix] = { count, bytes, eligible, eligibleBytes, ages: { [bucket]: { count, bytes } } }.
 *
 * Exact mode walks every candidate tree in full; a tree's age is `now` minus its newest mtime. With `checkpoint` (a file
 * path) progress is saved every 500 trees and when `budgetMs` runs out (complete: false); the next call with the same
 * file resumes where it stopped, so a long scan survives restarts in bounded chunks.
 *
 * Sample mode (`sample: N`, dry run only) is cheap: one top-level pass classifies every dir by its own lstat mtime
 * (exact counts), and only up to N trees per (prefix, age bucket, past-TTL) stratum are walked; bytes are the stratum
 * mean times its count (estimated: true). `guardKept` counts sampled past-TTL trees that the fresh-file guard keeps.
 */
export async function catchUpTempScratch({
  tempDir = tmpdir(),
  ttlDays = TEMP_TTL_DAYS,
  now = Date.now(),
  apply = false,
  sample = 0,
  checkpoint = null,
  budgetMs = Infinity,
  clock = Date.now,
  fs = defaultFs,
  onProgress,
} = {}) {
  const { root, days } = await checkedRoot(tempDir, ttlDays, fs);
  const sampleN = Number(sample) || 0;
  if (sampleN && apply === true) throw new Error("sample mode is a dry run only; --apply always walks every tree");
  if (sampleN && checkpoint) throw new Error("sample mode needs no checkpoint");
  const started = clock();
  const out = { tempDir: root, ttlDays: days, apply: apply === true, estimated: sampleN > 0, complete: true, scanned: 0, vsNamed: 0, nameMismatch: 0, notDir: 0, matched: 0, eligible: 0, removed: 0, errors: 0, recheckKept: 0, bytesFreed: 0, byPrefix: {}, ms: 0 };
  let done = new Set();
  if (checkpoint) {
    const ck = await readCheckpoint(checkpoint);
    if (ck) {
      if (ck.tempDir !== root || ck.ttlDays !== days || ck.apply !== out.apply) throw new Error(`checkpoint ${checkpoint} is for another run (tempDir/ttlDays/apply differ); delete it to start over`);
      // The checkpoint sets the deletion cutoff on --apply, so it is validated: a future or non-numeric `now` would move
      // the cutoff past the real TTL and expose live scratch.
      const num = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
      if (!num(ck.now) || ck.now > now || !num(ck.eligible) || !num(ck.removed) || !num(ck.bytesFreed) || !Array.isArray(ck.done) || !ck.byPrefix || typeof ck.byPrefix !== "object" || Array.isArray(ck.byPrefix)) {
        throw new Error(`checkpoint ${checkpoint} is invalid (now must be a finite time no later than the current one); delete it to start over`);
      }
      now = ck.now; // keep the age buckets of the first chunk
      Object.assign(out, { eligible: ck.eligible, removed: ck.removed, bytesFreed: ck.bytesFreed, byPrefix: ck.byPrefix });
      done = new Set(ck.done);
    }
  }
  const cutoff = now - days * DAY_MS;
  const save = () => writeCheckpoint(checkpoint, { tempDir: root, ttlDays: days, apply: out.apply, now, eligible: out.eligible, removed: out.removed, bytesFreed: out.bytesFreed, byPrefix: out.byPrefix, done: [...done] });
  const strata = new Map(); // sample mode: `${prefix}|${bucket}|${pastTtl}` -> { pre, bucket, past, count, sampled, sampledBytes }
  out.guardKept = 0;
  out.sampledPastTtl = 0;
  out.sampledTrees = 0;
  let sinceSave = 0;

  const dh = await fs.opendir(root);
  for await (const ent of dh) {
    out.scanned++;
    if (onProgress && out.scanned % 10_000 === 0) onProgress(out);
    if (!ent.name.startsWith("vs-")) continue;
    out.vsNamed++;
    if (!isVsScratchName(ent.name)) {
      out.nameMismatch++;
      continue;
    }
    const p = join(root, ent.name);
    let st;
    try {
      st = await fs.lstat(p);
    } catch {
      continue;
    }
    if (!isDirNotLink(st)) {
      out.notDir++;
      continue;
    }
    out.matched++;
    const pre = scratchPrefix(ent.name);

    if (sampleN) {
      const bucket = ageBucket(now - st.mtimeMs);
      const past = st.mtimeMs < cutoff;
      const key = `${pre}|${bucket}|${past}`;
      const s = strata.get(key) ?? { pre, bucket, past, count: 0, sampled: 0, sampledBytes: 0 };
      strata.set(key, s);
      s.count++;
      if (s.sampled >= sampleN) continue;
      try {
        const t = await treeStats(p, st.mtimeMs, fs);
        s.sampled++;
        s.sampledBytes += t.bytes;
        out.sampledTrees++;
        if (past) {
          out.sampledPastTtl++;
          if (t.newest >= cutoff) out.guardKept++;
        }
      } catch {
        out.errors++;
      }
      continue;
    }

    if (done.has(ent.name)) continue;
    if (clock() - started >= budgetMs) {
      out.complete = false;
      break; // leaving a for-await closes the Dir handle
    }
    let t;
    try {
      t = await treeStats(p, st.mtimeMs, fs);
    } catch {
      out.errors++; // not marked done: a resumed chunk retries it
      continue;
    }
    const expired = t.newest < cutoff; // past the TTL with no fresh entry anywhere in the tree
    if (expired && out.apply === true) {
      let freed;
      try {
        if (!(await stillExpiredDir(p, cutoff, fs))) {
          out.recheckKept++; // swapped for a link, written to, or gone since the walk; not done: a resumed chunk re-checks
          continue;
        }
        freed = await removeTree(p, fs, cutoff);
      } catch {
        out.errors++; // locked, or a fresh entry found mid-removal; not done: a resumed chunk retries it
        continue;
      }
      out.bytesFreed += freed;
      out.removed++;
    }
    // Marked done (and counted) only once its outcome is final, so a failed removal is retried on resume.
    done.add(ent.name);
    const row = (out.byPrefix[pre] ??= emptyRow());
    row.count++;
    row.bytes += t.bytes;
    const bucket = row.ages[ageBucket(now - t.newest)];
    bucket.count++;
    bucket.bytes += t.bytes;
    if (expired) {
      out.eligible++;
      row.eligible++;
      row.eligibleBytes += t.bytes;
    }
    if (checkpoint && ++sinceSave >= 500) {
      sinceSave = 0;
      await save();
    }
  }

  for (const s of strata.values()) {
    const est = s.sampled ? Math.round((s.sampledBytes / s.sampled) * s.count) : 0;
    const row = (out.byPrefix[s.pre] ??= emptyRow());
    row.count += s.count;
    row.bytes += est;
    row.ages[s.bucket].count += s.count;
    row.ages[s.bucket].bytes += est;
    if (s.past) {
      out.eligible += s.count;
      row.eligible += s.count;
      row.eligibleBytes += est;
    }
  }
  if (checkpoint) await save();
  out.ms = Math.max(0, Math.round(clock() - started));
  return out;
}

const gib = (n) => (n / 1024 ** 3).toFixed(2);

/** Plain-text report for `vs temp-ttl --catch-up`: totals, then one row per prefix (largest first) with age buckets. */
export function formatCatchUpReport(r, { limit = 30 } = {}) {
  const rows = Object.entries(r.byPrefix).sort((a, b) => b[1].bytes - a[1].bytes || b[1].count - a[1].count);
  const tot = { count: 0, bytes: 0, eligibleBytes: 0, ages: Object.fromEntries(AGE_BUCKETS.map((b) => [b, { count: 0, bytes: 0 }])) };
  for (const [, row] of rows) {
    tot.count += row.count;
    tot.bytes += row.bytes;
    tot.eligibleBytes += row.eligibleBytes;
    for (const b of AGE_BUCKETS) {
      tot.ages[b].count += row.ages[b].count;
      tot.ages[b].bytes += row.ages[b].bytes;
    }
  }
  const cell = (a) => `${a.count}/${gib(a.bytes)}`;
  const lines = [
    `temp-ttl catch-up ${r.apply ? "APPLY" : "DRY RUN (nothing removed; add --apply to delete)"} tempDir=${r.tempDir} ttlDays=${r.ttlDays} ms=${r.ms}`,
    `scanned=${r.scanned} vs-named=${r.vsNamed} nameMismatch=${r.nameMismatch} notDir=${r.notDir} matched=${r.matched} errors=${r.errors}${r.recheckKept ? ` recheckKept=${r.recheckKept}` : ""}`,
    ...(r.estimated
      ? [`SAMPLED: counts and ages from each top dir's own mtime (exact); GiB estimated from ${r.sampledTrees} walked trees. Fresh-file guard kept ${r.guardKept} of ${r.sampledPastTtl} sampled past-TTL trees, so past-TTL is an upper bound.`]
      : []),
    ...(r.complete === false ? ["PARTIAL: time budget reached; rerun with the same --checkpoint to continue."] : []),
    `total ${tot.count} dirs ${gib(tot.bytes)} GiB; past TTL: ${r.eligible} dirs ${gib(tot.eligibleBytes)} GiB${r.apply ? `; removed=${r.removed} freed=${gib(r.bytesFreed)} GiB` : ""}`,
    `age (${r.estimated ? "top dir mtime" : "newest mtime in tree"}) count/GiB: ${AGE_BUCKETS.map((b) => `${b}=${cell(tot.ages[b])}`).join(" ")}`,
    `prefix | count | GiB | pastTTL count/GiB | ${AGE_BUCKETS.join(" | ")}`,
  ];
  for (const [pre, row] of rows.slice(0, limit)) {
    lines.push(`${pre} | ${row.count} | ${gib(row.bytes)} | ${row.eligible}/${gib(row.eligibleBytes)} | ${AGE_BUCKETS.map((b) => cell(row.ages[b])).join(" | ")}`);
  }
  if (rows.length > limit) lines.push(`(+${rows.length - limit} more prefixes; --limit N shows more)`);
  return lines.join("\n");
}
