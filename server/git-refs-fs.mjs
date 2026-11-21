// Read git refs from the filesystem, without spawning git (idea-518). On Windows each `git` child costs a synchronous
// CreateProcess on the server's event loop (loop-lag.jsonl 11-21: ~1.3 s p50 per spawn under load), so hot paths that only
// need "what is HEAD / where does ref X point" read .git directly with async fs and spawn git only when this answers null.
// Supports a plain repo (.git dir) and a linked worktree (.git file -> gitdir, plus its `commondir`), loose refs, symbolic
// refs (one level chains, capped) and packed-refs. A reftable repo (extensions.refStorage) answers null: callers fall back.
import { promises as fsp } from "node:fs";
import path from "node:path";

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

async function readText(p) {
  try {
    return await fsp.readFile(p, "utf8");
  } catch {
    return null;
  }
}

/** { gitDir, commonDir } for the repo/worktree whose top level is `cwd` (or an ancestor within 8 levels), or null. */
export async function gitDirsFs(cwd) {
  if (!cwd) return null;
  let dir = path.resolve(cwd);
  for (let i = 0; i < 8; i++) {
    const dotGit = path.join(dir, ".git");
    let st = null;
    try {
      st = await fsp.stat(dotGit);
    } catch {}
    if (st?.isDirectory()) return finish(dotGit);
    if (st?.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec((await readText(dotGit)) ?? "");
      if (!m) return null;
      return finish(path.resolve(dir, m[1]));
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;

  async function finish(gitDir) {
    const common = (await readText(path.join(gitDir, "commondir")))?.trim();
    const commonDir = common ? path.resolve(gitDir, common) : gitDir;
    try {
      await fsp.stat(path.join(commonDir, "reftable"));
      return null; // reftable storage: not parsed here
    } catch {}
    return { gitDir, commonDir };
  }
}

/** HEAD of a worktree: { branch } (short name) when symbolic, { sha } when detached, or null. */
export async function readHeadFs(dirs) {
  if (!dirs) return null;
  const raw = (await readText(path.join(dirs.gitDir, "HEAD")))?.trim();
  if (!raw) return null;
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(raw);
  if (m) return { branch: m[1] };
  return SHA_RE.test(raw) ? { sha: raw } : null;
}

async function packedRefs(commonDir) {
  const text = await readText(path.join(commonDir, "packed-refs"));
  const map = new Map();
  if (!text) return map;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line[0] === "#" || line[0] === "^") continue;
    const sp = line.indexOf(" ");
    if (sp > 0) map.set(line.slice(sp + 1).trim(), line.slice(0, sp));
  }
  return map;
}

/**
 * Resolve full ref names (e.g. "refs/heads/master", "refs/remotes/origin/HEAD") to shas. Returns a Map ref -> sha with
 * missing refs left out (like `git for-each-ref`), or null when `dirs` is null. packed-refs is read at most once per call.
 */
export async function resolveRefsFs(dirs, refs) {
  if (!dirs) return null;
  let packed = null;
  const out = new Map();
  for (const ref of refs) {
    let name = ref;
    for (let hop = 0; hop < 5 && name; hop++) {
      // Per-worktree refs (HEAD, refs/bisect, refs/worktree) live in gitDir; everything else is shared in commonDir.
      const base = name === "HEAD" || name.startsWith("refs/worktree/") || name.startsWith("refs/bisect/") ? dirs.gitDir : dirs.commonDir;
      const loose = (await readText(path.join(base, ...name.split("/"))))?.trim();
      if (loose && SHA_RE.test(loose)) {
        out.set(ref, loose);
        break;
      }
      const sym = loose ? /^ref:\s*(\S+)$/.exec(loose) : null;
      if (sym) {
        name = sym[1];
        continue;
      }
      packed ??= await packedRefs(dirs.commonDir);
      const sha = packed.get(name);
      if (sha && SHA_RE.test(sha)) out.set(ref, sha);
      break;
    }
  }
  return out;
}
