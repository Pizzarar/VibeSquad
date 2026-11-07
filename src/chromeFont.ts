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

/** Style for one glyph span, or null when the font has neither the char nor the fallback. */
export function chromeGlyphStyle(ch: string): { width: number; height: number; backgroundPosition: string; marginRight: number } | null {
  const f = CHROME_FONT;
  const g = f.glyphs[ch.toUpperCase()] ?? f.glyphs[f.fallback];
  if (!g) return null;
  const [x, y, w, h, adv] = g;
  return { width: w * f.scale, height: h * f.scale, backgroundPosition: `${-x * f.scale}px ${-y * f.scale}px`, marginRight: (adv - w) * f.scale };
}
