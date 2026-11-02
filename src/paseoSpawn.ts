import { sendMessage, spawnTeamAgent, type SpawnRequest } from "./paseo";
import { planFirstPrompt } from "./spawnImages";
import { blobsToPaseoImages, rememberSent } from "./imageDrafts";

/** spawnTeamAgent plus first-prompt images (`paseo run --image`). Profile/labels path is untouched. */
export async function spawnTeamAgentWithImages(
  req: SpawnRequest,
  images: Array<{ blob: Blob }>,
): Promise<{ id: string; cwd: string }> {
  const plan = planFirstPrompt(req.prompt, images.length);
  const r = await spawnTeamAgent({ ...req, prompt: plan.createPrompt });
  if (plan.firstSend) {
    await sendMessage(r.id, plan.firstSend.text, await blobsToPaseoImages(images));
    rememberSent(r.id, plan.firstSend.text, images);
  }
  return r;
}
