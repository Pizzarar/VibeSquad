import { realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * Compute Vite's `server.fs.allow` for a checkout whose node_modules may be a
 * junction to the main checkout's (vs worktree create links it — see
 * server/team-worktrees.mjs `linkNodeModules`). Files served through that link
 * realpath outside the workspace root and would otherwise 403 with "outside of
 * Vite serving allow list" (fonts and any other `/@fs/` asset under node_modules).
 *
 * Returns the workspace root plus the node_modules realpath. In the main checkout
 * (a real node_modules under the root) the second entry is a redundant no-op, so
 * this is safe to use unconditionally.
 *
 * @param {string} rootDir absolute path of the checkout root (the vite config dir)
 * @returns {string[]} the `server.fs.allow` list
 */
export function viteFsAllow(rootDir) {
  let root = rootDir;
  try {
    root = realpathSync(rootDir);
  } catch {
    // root does not exist or is not readable; fall back to the raw path
  }
  const allow = [root];
  try {
    const nm = realpathSync(join(root, "node_modules"));
    if (!allow.includes(nm)) allow.push(nm);
  } catch {
    // no node_modules (or not readable): root-only allow list
  }
  return allow;
}
