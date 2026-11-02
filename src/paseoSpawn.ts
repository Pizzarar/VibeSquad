import { spawnTeamAgent, type SpawnRequest } from "./paseo";
import { blobsToPaseoImages, rememberSent } from "./imageDrafts";

/** spawnTeamAgent plus first-prompt images (`paseo run --image`): prompt and images go in one create call. */
export async function spawnTeamAgentWithImages(
  req: SpawnRequest,
  images: Array<{ blob: Blob }>,
): Promise<{ id: string; cwd: string }> {
  if (!images.length) return spawnTeamAgent(req);
  const r = await spawnTeamAgent({ ...req, images: await blobsToPaseoImages(images) });
  rememberSent(r.id, req.prompt, images);
  return r;
}
