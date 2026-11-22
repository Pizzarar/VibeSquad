// Read git refs from the filesystem, without spawning git (idea-518). On Windows each `git` child costs a synchronous
// CreateProcess on the server's event loop (loop-lag.jsonl 11-21: ~1.3 s p50 per spawn under load), so hot paths that only
// need "what is HEAD / where does ref X point" read .git directly with async fs and spawn git only when this answers null.
// Supports a plain repo (.git dir) and a linked worktree (.git file -> gitdir, plus its `commondir`), loose refs, symbolic
// refs (chains capped at 5 hops) and packed-refs. A reftable repo (extensions.refStorage) answers null: callers fall back.
//
// Contract: never guess. null means "can't tell from the files: ask git", never "no refs". Any read error other than
// "not there" (ENOENT/ENOTDIR/EISDIR, e.g. EBUSY/EPERM/EACCES on a locked file), a loose ref that exists but isn't a sha or
// a valid `ref:` line (empty or half-written), a `.lock` beside a ref we read (an update is in flight), a symref chain
// longer than the hop cap, an unsafe ref name or a malformed packed-refs line all answer null. Only a ref that is absent
// both as a loose file and from a readable packed-refs is reported as missing (left out of the Map, like for-each-ref).
//
// providers-catalog.mjs readHeadShaFs (part A) is a sync, HEAD-only sibling with the same "null when unsure" rule; it
// stays sync because its callers (warmPooledMergedUnits, refreshRepoMergedUnits) call it inline. Keep the two in step.
import { promises as fsp } from "node:fs";
import path from "node:path";

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const MISSING = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);
const MAX_HOPS = 5;

/** Thrown inside this module when the files can't answer safely; the exported functions turn it into null. */
class Unsure extends Error {}

/** File text, or undefined when the path doesn't exist. Any other error (locked, denied, I/O) throws Unsure. */
async function readIfPresent(p) {
  try {
    return await fsp.readFile(p, "utf8");
  } catch (e) {
    if (MISSING.has(e?.code)) return undefined;
    throw new Unsure(`${e?.code ?? "read error"}: ${p}`);
  }
}

/** true/false for existence; any error other than "not there" throws Unsure. */
async function present(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch (e) {
    if (MISSING.has(e?.code)) return false;
    throw new Unsure(`${e?.code ?? "stat error"}: ${p}`);
  }
}

/** A ref name safe to join onto a git dir: HEAD or refs/..., no empty/./.. segments, no backslash, colon or .lock suffix. */
function safeRefName(name) {
  if (name === "HEAD") return true;
  if (typeof name !== "string" || !name.startsWith("refs/") || /[\\:\0]/.test(name) || name.endsWith(".lock")) return false;
  return name.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

async function unsureToNull(run) {
  try {
    return await run();
  } catch (e) {
    if (e instanceof Unsure) return null;
    throw e;
  }
}

/** { gitDir, commonDir } for the repo/worktree whose top level is `cwd` (or an ancestor within 8 levels), or null. */
export async function gitDirsFs(cwd) {
  if (!cwd) return null;
  return unsureToNull(async () => {
    let dir = path.resolve(cwd);
    for (let i = 0; i < 8; i++) {
      const dotGit = path.join(dir, ".git");
      let st = null;
      try {
        st = await fsp.stat(dotGit);
      } catch (e) {
        // A .git we can't stat (locked/denied) must not make us walk up into an enclosing repo.
        if (!MISSING.has(e?.code)) return null;
      }
      if (st?.isDirectory()) return finish(dotGit);
      if (st?.isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec((await readIfPresent(dotGit)) ?? "");
        if (!m) return null;
        return finish(path.resolve(dir, m[1]));
      }
      if (st) return null; // something else named .git
      const up = path.dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
    return null;
  });

  async function finish(gitDir) {
    const raw = await readIfPresent(path.join(gitDir, "commondir"));
    const common = raw?.trim();
    if (raw !== undefined && !common) return null; // commondir exists but is empty/half-written
    const commonDir = common ? path.resolve(gitDir, common) : gitDir;
    if (await present(path.join(commonDir, "reftable"))) return null; // reftable storage: not parsed here
    return { gitDir, commonDir };
  }
}

/** HEAD of a worktree: { branch } (short name) when symbolic, { sha } when detached, or null when unsure. */
export async function readHeadFs(dirs) {
  if (!dirs) return null;
  return unsureToNull(async () => {
    if (await present(path.join(dirs.gitDir, "HEAD.lock"))) return null;
    const raw = (await readIfPresent(path.join(dirs.gitDir, "HEAD")))?.trim();
    if (!raw) return null;
    const m = /^ref:\s*(refs\/heads\/\S+)$/.exec(raw);
    if (m) return safeRefName(m[1]) ? { branch: m[1].slice("refs/heads/".length) } : null;
    return SHA_RE.test(raw) ? { sha: raw.toLowerCase() } : null;
  });
}

/** packed-refs as Map name -> sha (empty when the file is absent); throws Unsure when locked, unreadable or malformed. */
async function packedRefs(commonDir) {
  if (await present(path.join(commonDir, "packed-refs.lock"))) throw new Unsure("packed-refs.lock");
  const text = await readIfPresent(path.join(commonDir, "packed-refs"));
  const map = new Map();
  if (text === undefined) return map;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line[0] === "#") continue;
    if (line[0] === "^") {
      if (!SHA_RE.test(line.slice(1).trim())) throw new Unsure("packed-refs: bad peel line");
      continue;
    }
    const m = /^(\S+) (\S+)$/.exec(line);
    if (!m || !SHA_RE.test(m[1])) throw new Unsure("packed-refs: malformed line");
    map.set(m[2], m[1].toLowerCase());
  }
  return map;
}

/**
 * Resolve full ref names (e.g. "refs/heads/master", "refs/remotes/origin/HEAD") to shas. Returns a Map ref -> sha with
 * missing refs left out (like `git for-each-ref`), or null when `dirs` is null or any ref can't be answered safely (see
 * the contract at the top). packed-refs is read at most once per call.
 */
export async function resolveRefsFs(dirs, refs) {
  if (!dirs) return null;
  return unsureToNull(async () => {
    let packed = null;
    const out = new Map();
    for (const ref of refs) {
      let name = ref;
      let resolved = false;
      for (let hop = 0; hop < MAX_HOPS; hop++) {
        if (!safeRefName(name)) throw new Unsure(`unsafe ref name: ${name}`);
        // Per-worktree refs (HEAD, refs/bisect, refs/worktree) live in gitDir; everything else is shared in commonDir.
        const base = name === "HEAD" || name.startsWith("refs/worktree/") || name.startsWith("refs/bisect/") ? dirs.gitDir : dirs.commonDir;
        const file = path.join(base, ...name.split("/"));
        if (await present(`${file}.lock`)) throw new Unsure(`${name}.lock`);
        const raw = await readIfPresent(file);
        if (raw !== undefined) {
          const loose = raw.trim();
          if (SHA_RE.test(loose)) {
            out.set(ref, loose.toLowerCase());
            resolved = true;
            break;
          }
          const sym = /^ref:\s*(\S+)$/.exec(loose);
          if (!sym) throw new Unsure(`corrupt loose ref: ${name}`); // empty or half-written: git may see something else
          name = sym[1];
          continue;
        }
        packed ??= await packedRefs(dirs.commonDir);
        const sha = packed.get(name);
        if (sha) out.set(ref, sha); // absent from loose and packed: missing, left out
        resolved = true;
        break;
      }
      if (!resolved) throw new Unsure(`symref chain over ${MAX_HOPS} hops: ${ref}`);
    }
    return out;
  });
}
