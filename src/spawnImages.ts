// Pure helper for spawn-with-images (dependency-free so it runs under node --test).
type Img = { data: string; mimeType: string };

/** Adds `images` to a spawn request only when there are some, so the plain path stays byte-identical. */
export function withImages<T extends object>(req: T, images: Img[]): T & { images?: Img[] } {
  return images.length ? { ...req, images } : req;
}
