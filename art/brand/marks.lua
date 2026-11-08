-- S4 VS mark: hand-placed pixel sources, one table per master size.
-- A mark is a tiny Win95 window: INK rim, MARBLE top-left bevel, INK bottom-right bevel,
-- VIOLET title bar, SKY_TOP body, a teal V + pink S with an INK drop shadow, and one
-- amber twinkle kept inside the title bar's right end. Every glyph, twinkle and title mark
-- below is placed by hand per size (16 is its own drawing, not a downscale of 64).
-- Only P0 slots, chosen so the light .gpl swap keeps every role readable:
-- VIOLET/TEAL/PINK/AMBER/MARBLE/INK keep their value in both palettes; SKY_TOP flips
-- indigo night <-> baby-blue morning, which is the dark/light difference.
local M = {}

-- ASCII key: k INK, m MARBLE, v VIOLET, y SKY_TOP, t TEAL, p PINK, a AMBER
M.KEY = { k=15, m=4, v=8, y=13, t=7, p=9, a=11 }

-- frame spec: rim = INK ring width, hi = MARBLE top-left bevel width, lo = extra INK
-- bottom-right bevel width (inside the rim), title = title-bar rows.
M.sizes = {}

-- 3-row twinkle (fits a 3-row title bar), 5-row and 7-row versions for the bigger masters
local TW3 = [[
.a.
ama
.a.
]]
local TW5 = [[
..a..
..a..
aamaa
..a..
..a..
]]
local TW7 = [[
...a...
...a...
..ama..
aammmaa
..ama..
...a...
...a...
]]

-- ---------------------------------------------------------------- 16 (ico 16, tab)
-- Full frame at 16 too (INK rim + MARBLE top-left), so it holds on white browser chrome.
-- 5x7 glyphs with 2px stems, 1px body margin all round.
M.sizes[16] = {
  frame = { rim=1, hi=1, lo=0, title=3 },
  glyphs = {
    { 3, 6, [[
tt.tt
tt.tt
tt.tt
tt.tt
.ttt.
.ttt.
..t..
]] },
    { 9, 6, [[
.pppp
pp...
pp...
.ppp.
...pp
...pp
pppp.
]] },
  },
  shadow = 1,
  twinkle = { 11, 2, TW3 },
}

-- ---------------------------------------------------------------- 22 (sidebar slot)
M.sizes[22] = {
  frame = { rim=1, hi=1, lo=0, title=3 },
  titleMark = { {4, 3, 6, 1} },          -- x, y, w, h MARBLE "title text"
  glyphs = {
    { 3, 7, [[
ttt...ttt
ttt...ttt
ttt...ttt
ttt...ttt
.ttt.ttt.
.ttt.ttt.
..ttttt..
..ttttt..
...ttt...
...ttt...
....t....
]] },
    { 13, 7, [[
.pppppp
ppppppp
ppp....
ppp....
pppppp.
.pppppp
....ppp
....ppp
....ppp
ppppppp
pppppp.
]] },
  },
  shadow = 1,
  twinkle = { 16, 2, TW3 },
}

-- ---------------------------------------------------------------- 24 (x2 -> ico 48)
M.sizes[24] = {
  frame = { rim=1, hi=1, lo=1, title=3 },
  titleMark = { {4, 3, 6, 1} },
  glyphs = {
    { 3, 8, [[
ttt...ttt
ttt...ttt
ttt...ttt
ttt...ttt
.ttt.ttt.
.ttt.ttt.
..ttttt..
..ttttt..
...ttt...
...ttt...
....t....
]] },
    { 13, 8, [[
.pppppp.
pppppppp
ppp..ppp
ppp.....
pppppp..
.pppppp.
..pppppp
.....ppp
ppp..ppp
pppppppp
.pppppp.
]] },
  },
  shadow = 1,
  twinkle = { 17, 2, TW3 },
}

-- ---------------------------------------------------------------- 32 (ico 32)
-- 17-row glyphs, 3-row S bars, centred in the body.
M.sizes[32] = {
  frame = { rim=1, hi=1, lo=1, title=5 },
  titleMark = { {5, 4, 9, 1} },
  glyphs = {
    { 3, 10, [[
tttt.....tttt
tttt.....tttt
tttt.....tttt
tttt.....tttt
tttt.....tttt
tttt.....tttt
.tttt...tttt.
.tttt...tttt.
..tttt.tttt..
..tttt.tttt..
...ttttttt...
...ttttttt...
....ttttt....
....ttttt....
.....ttt.....
.....ttt.....
......t......
]] },
    { 17, 10, [[
..ppppppppp
.pppppppppp
ppppppppppp
pppp.......
pppp.......
pppp.......
pppppppp...
.pppppppp..
..pppppppp.
...pppppppp
.......pppp
.......pppp
.......pppp
.......pppp
ppppppppppp
pppppppppp.
ppppppppp..
]] },
  },
  shadow = 1,
  twinkle = { 24, 2, TW5 },
}

-- ---------------------------------------------------------------- 64 (x2 / x4 -> 192 / 512)
-- V: 26x28, stroke 8; straight for 8 rows, then each outer edge steps in 1px per 2 rows.
local function vSpans(w, h, stroke, straight)
  local t = {}
  for r=0,h-1 do
    local xl = r < straight and 0 or (r-straight)//2 + 1
    local xr = w-1 - xl
    if xl + stroke >= xr - stroke + 1 then t[#t+1] = { r, xl, xr }
    else t[#t+1] = { r, xl, xl+stroke-1 }; t[#t+1] = { r, xr-stroke+1, xr } end
  end
  return t
end
-- S: 22x28 hand spans {row, x0, x1}
local S64 = {
  {0,4,21},{1,3,21},{2,2,21},{3,1,21},
  {4,0,7},{5,0,7},{6,0,7},{7,0,7},{8,0,7},{9,0,7},
  {10,1,14},{11,2,15},{12,3,16},{13,4,17},{14,5,18},{15,6,19},{16,7,20},{17,8,21},
  {18,14,21},{19,14,21},{20,14,21},{21,14,21},{22,14,21},{23,14,21},
  {24,0,20},{25,0,19},{26,0,18},{27,0,17},
}
-- title caption "VIBE OS": 3x5 letters, a 5-wide V so it can't read as U
local CAP = {
  V = { "m...m", "m...m", ".m.m.", ".m.m.", "..m.." },
  I = { "mmm", ".m.", ".m.", ".m.", "mmm" },
  B = { "mm.", "m.m", "mm.", "m.m", "mm." },
  E = { "mmm", "m..", "mm.", "m..", "mmm" },
  A = { ".m.", "m.m", "mmm", "m.m", "m.m" },
  P = { "mm.", "m.m", "mm.", "m..", "m.." },
  O = { ".m.", "m.m", "m.m", "m.m", ".m." },
  R = { "mm.", "m.m", "mm.", "m.m", "m.m" },
  S = { ".mm", "m..", ".m.", "..m", "mm." },
  [" "] = { "...", "...", "...", "...", "..." },
}
local function caption(s)
  local rows = { "", "", "", "", "" }
  for i=1,#s do
    local g = CAP[s:sub(i, i)]
    for r=1,5 do rows[r] = rows[r]..(i > 1 and "." or "")..g[r] end
  end
  return table.concat(rows, "\n")
end
M.sizes[64] = {
  frame = { rim=1, hi=2, lo=2, title=8 },
  caption = { 6, 5, caption("VIBE OS") },
  spans = {
    { 5, 22, vSpans(26, 28, 8, 8), 7 },
    { 34, 22, S64, 9 },
  },
  shadow = 2,
  glow = { 44, 60 },                    -- body rows dithered SKY_TOP -> VIOLET (sunset floor)
  twinkle = { 51, 4, TW7 },             -- rows 4..10, inside the 3..10 title bar
}

return M
