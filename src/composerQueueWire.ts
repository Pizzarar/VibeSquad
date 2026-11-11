// Wires the composer queue flusher to the live roster. Started once from main.tsx.
import { blobsToPaseoImages, rememberSent } from "./imageDrafts";
import { getPaseoState, sendMessage, subscribePaseo } from "./paseo";
import { rosterForQueue, startQueueFlusher } from "./composerQueue";

export async function flushQueued(agentId: string, text: string, images: Array<{ blob: Blob }>) {
  if (images.length) {
    await sendMessage(agentId, text, await blobsToPaseoImages(images), { activeTurnBehavior: "steer" });
    rememberSent(agentId, text, images);
  } else {
    await sendMessage(agentId, text, undefined, { activeTurnBehavior: "steer" });
  }
}

export function startComposerQueueFlusher() {
  return startQueueFlusher({
    getStatus: (id) => getPaseoState().agents.get(id)?.status,
    subscribe: subscribePaseo,
    send: flushQueued,
    roster: () => rosterForQueue(getPaseoState()),
  });
}
