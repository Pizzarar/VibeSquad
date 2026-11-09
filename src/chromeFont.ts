// Glyph table for public/ui/u3/font-chrome-big-{dark,light}.png (U3b chrome font), copied from font-chrome-big.json
// (test/ui-u3c-skin.test.mjs keeps the two in step). glyph = [x, y, w, h, advance] in native px; shown at 2x.
export const CHROME_FONT = {
  sheetW: 208,
  sheetH: 53,
  scale: 2,
  origin: -1,
  fallback: "?",
  glyphs: {"'":[66,36,6,17,5],"-":[57,36,8,17,7]," ":[170,36,7,17,6],"!":[38,36,6,17,5],"#":[144,36,12,17,11],"&":[92,36,11,17,10],"(":[104,36,7,17,6],")":[112,36,7,17,6],",":[31,36,6,17,5],".":[24,36,6,17,5],"/":[80,36,11,17,10],":":[73,36,6,17,5],"?":[45,36,11,17,10],"@":[157,36,12,17,11],"_":[132,36,11,17,10],"+":[120,36,11,17,10],"0":[109,18,11,17,10],"1":[121,18,8,17,7],"2":[130,18,11,17,10],"3":[142,18,11,17,10],"4":[154,18,11,17,10],"5":[166,18,11,17,10],"6":[178,18,11,17,10],"7":[190,18,11,17,10],"8":[0,36,11,17,10],"9":[12,36,11,17,10],"A":[0,0,11,17,10],"B":[12,0,11,17,10],"C":[24,0,11,17,10],"D":[36,0,11,17,10],"E":[48,0,11,17,10],"F":[60,0,11,17,10],"G":[72,0,11,17,10],"H":[84,0,11,17,10],"I":[96,0,8,17,7],"J":[105,0,11,17,10],"K":[117,0,11,17,10],"L":[129,0,11,17,10],"M":[141,0,12,17,11],"N":[154,0,11,17,10],"O":[166,0,11,17,10],"P":[178,0,11,17,10],"Q":[190,0,11,17,10],"R":[0,18,11,17,10],"S":[12,18,11,17,10],"T":[24,18,11,17,10],"U":[36,18,11,17,10],"V":[48,18,11,17,10],"W":[60,18,12,17,11],"X":[73,18,11,17,10],"Y":[85,18,11,17,10],"Z":[97,18,11,17,10]} as Record<string, readonly [number, number, number, number, number]>,
};

/** Lengths are in kit pixels via --u3-px (see applyKitPixelToDom in uiScale.ts), so every glyph lands on whole device px. */
const kit = (n: number) => `calc(var(--u3-px) * ${n})`;

/** Style for one glyph span, or null when the font has neither the char nor the fallback. */
export function chromeGlyphStyle(ch: string): { width: string; height: string; backgroundPosition: string; marginRight: string } | null {
  const f = CHROME_FONT;
  const g = f.glyphs[ch.toUpperCase()] ?? f.glyphs[f.fallback];
  if (!g) return null;
  const [x, y, w, h, adv] = g;
  return { width: kit(w), height: kit(h), backgroundPosition: `${kit(-x)} ${kit(-y)}`, marginRight: kit(adv - w) };
}

// Small chrome font (font-chrome-small-{dark,light}.png, 208x41), mirrored from font-chrome-small.json. glyph = [x, y, w, h, advance] in sheet px.
export const CHROME_FONT_SMALL = {
  sheetW: 208,
  sheetH: 41,
  fallback: "?",
  glyphs: {"'":[185,14,5,13,3],"-":[177,14,7,13,5]," ":[66,28,6,13,4],"!":[161,14,5,13,3],"#":[44,28,10,13,8],"&":[0,28,9,13,7],"(":[10,28,6,13,4],")":[17,28,6,13,4],",":[155,14,5,13,3],".":[149,14,5,13,3],"/":[197,14,9,13,7],":":[191,14,5,13,3],"?":[167,14,9,13,7],"@":[55,28,10,13,8],"_":[34,28,9,13,7],"+":[24,28,9,13,7],"0":[51,14,9,13,7],"1":[61,14,7,13,5],"2":[69,14,9,13,7],"3":[79,14,9,13,7],"4":[89,14,9,13,7],"5":[99,14,9,13,7],"6":[109,14,9,13,7],"7":[119,14,9,13,7],"8":[129,14,9,13,7],"9":[139,14,9,13,7],"A":[0,0,9,13,7],"B":[10,0,9,13,7],"C":[20,0,9,13,7],"D":[30,0,9,13,7],"E":[40,0,9,13,7],"F":[50,0,9,13,7],"G":[60,0,9,13,7],"H":[70,0,9,13,7],"I":[80,0,7,13,5],"J":[88,0,9,13,7],"K":[98,0,9,13,7],"L":[108,0,9,13,7],"M":[118,0,10,13,8],"N":[129,0,9,13,7],"O":[139,0,9,13,7],"P":[149,0,9,13,7],"Q":[159,0,9,13,7],"R":[169,0,9,13,7],"S":[179,0,9,13,7],"T":[189,0,9,13,7],"U":[199,0,9,13,7],"V":[0,14,9,13,7],"W":[10,14,10,13,8],"X":[21,14,9,13,7],"Y":[31,14,9,13,7],"Z":[41,14,9,13,7]} as Record<string, readonly [number, number, number, number, number]>,
};

const smallGlyph = (ch: string) => CHROME_FONT_SMALL.glyphs[ch.toUpperCase()] ?? CHROME_FONT_SMALL.glyphs[CHROME_FONT_SMALL.fallback];

/** Advance of one small-font glyph in sheet px (0 when the font has neither the char nor the fallback). */
export const chromeSmallAdvance = (ch: string): number => smallGlyph(ch)?.[4] ?? 0;

/** Style for one small-font glyph in plain px (the floor band is already scaled by an integer, so 1 sheet px = 1 plate px). `track` tightens the advance. */
export function chromeSmallGlyphStyle(ch: string, track = 0): { width: number; height: number; backgroundPosition: string; marginRight: number } | null {
  const g = smallGlyph(ch);
  if (!g) return null;
  const [x, y, w, h, adv] = g;
  return { width: w, height: h, backgroundPosition: `${-x}px ${-y}px`, marginRight: Math.max(adv + track, 1) - w };
}
