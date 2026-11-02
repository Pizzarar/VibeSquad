// Pure helper for spawn-with-images: with images the first prompt goes out as a send after create.
export type SpawnPlan = { createPrompt: string; firstSend: { text: string; withImages: true } | null };

/** No images: the prompt rides on create as before. Images: create bare, then send prompt + images. */
export function planFirstPrompt(prompt: string, imageCount: number): SpawnPlan {
  if (imageCount <= 0) return { createPrompt: prompt, firstSend: null };
  return { createPrompt: "", firstSend: { text: prompt, withImages: true } };
}
