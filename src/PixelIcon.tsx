// @art S2b-2 pixel icons (public/ui/icon-{squads,teams}-{dark,light}{,@2x}.png, 16px 1x / 32px @2x).
// Theme-picked, crisp (image-rendering: pixelated), sized in kit pixels so they land on integer device px.
// The caller's glyph is the fallback until/unless the image loads.
import type { ReactNode } from "react";
import { useImageOk, useTheme } from "./useBotFace";

export type PixelIconName = "squads" | "teams";

export function pixelIconSrc(name: PixelIconName, theme: string): { src: string; srcSet: string } {
  const base = `/ui/icon-${name}-${theme}`;
  return { src: `${base}.png`, srcSet: `${base}.png 1x, ${base}@2x.png 2x` };
}

export function PixelIcon({ name, alt, fallback }: { name: PixelIconName; alt: string; fallback: ReactNode }) {
  const theme = useTheme();
  const { src, srcSet } = pixelIconSrc(name, theme);
  const ok = useImageOk(src);
  if (!ok) return <>{fallback}</>;
  return <img className="pixel-icon" data-testid={`pixel-icon-${name}`} src={src} srcSet={srcSet} alt={alt} draggable={false} />;
}
