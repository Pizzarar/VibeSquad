// Pure placement for the portaled pin ⋯ menu list (docs/PLAN_RAIL_MENU_CLIP.md M1).
export const PIN_MENU_MARGIN = 8;
export type Box = { left: number; right: number; top: number; bottom: number };

/** Fixed top/left for a list of `w`×`h` anchored under `anchor`: right-aligned to the button, clamped ≥8px from the viewport edges, flipped above when it doesn't fit below. */
export function placePinMenu(anchor: Box, size: { w: number; h: number }, view: { w: number; h: number }): { top: number; left: number } {
  const m = PIN_MENU_MARGIN;
  const left = Math.max(m, Math.min(anchor.right - size.w, view.w - size.w - m));
  const below = anchor.bottom + 4;
  const fitsBelow = below + size.h <= view.h - m;
  const above = anchor.top - 4 - size.h;
  const top = fitsBelow ? below : above >= m ? above : Math.max(m, view.h - size.h - m);
  return { top, left };
}
