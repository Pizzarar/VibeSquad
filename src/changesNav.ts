// Entry for other panes (N3 chat commit links): open the right dock's Changes tab on one commit's diff.
import { openRightDockTab } from "./RightDock";
import { requestCommit } from "./commitRequest";

/** Opens Changes and shows commit `sha` (7-64 hex) of the repo at `cwd`. Returns false for a malformed hash. */
export function openCommit(cwd: string, sha: string): boolean {
  if (!requestCommit(cwd, sha)) return false;
  openRightDockTab("Changes");
  return true;
}
