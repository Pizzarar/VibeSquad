import { spawnTeamAgent, type SpawnRequest } from "./paseo";
import { blobsToPaseoImages } from "./imageDrafts";
import { withImages } from "./spawnImages";

/** spawnTeamAgent plus first-prompt images (`paseo run --image`): prompt and images go in one create call.
 *  The caller remembers the sent thumbnails (TeamActions does it in finish(), which can run before create resolves). */
export async function spawnTeamAgentWithImages(
  req: SpawnRequest,
  images: Array<{ blob: Blob }>,
): Promise<{ id: string; cwd: string }> {
  return spawnTeamAgent(withImages(req, await blobsToPaseoImages(images)));
}
