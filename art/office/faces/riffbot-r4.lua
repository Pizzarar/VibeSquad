-- C2a-R4 RiffBot at 48x48 in the H0 hand (art/cast/hypno/bust.lua): hand-placed shapes and
-- ASCII stamps, flat P0 fills, no gradients. Shown big (~10x, filling a zone), so every face
-- shape is a clean block: no stray single pixels inside the face.
--   Tilted beige CRT on rabbit-ear antennas, violet suit, mint tie. The whole glass is lit (mint,
--   teal scanlines) and the face floats in open space (R4: ticker bar removed): small smug eyes,
--   one cocked brow, a modest smirk, a gold chart-up glint off the right eye.
--   scared (R4, plays when the Overlord expands over Riff's zone): wide eyes with pin pupils,
--   worried brows, wobbly mouth, sweat drop, head shakes 1px, glint flips to a pink chart-down.
-- The head is painted flat in a local 38x32 grid, then tilted with two integer shears
-- (rows shift right 1px per 8 rows, columns rise 1px per 8 columns).
-- Writes public/office/face-riffbot-{dark,light}.png (10 cells) + art/office/faces/riffbot.aseprite
-- and sets riffbot.scared in public/office/faces.json (other entries/offsets untouched).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/faces/riffbot-r4.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local K, V, P, A, S, M, T, G, Y = 15, 8, 9, 11, 14, 4, 7, 12, 13
local KEY = { k=K, m=M, g=G, a=A, p=P, t=T, v=V, s=S }
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local CW, CH = 48, 48
local LAYERS = { "bg", "ant", "body", "head", "face", "fx" }

local BANG = [[
|kkkk|
|kaak|
|kaak|
|kaak|
|kaak|
|kkkk|
|....|
|kkkk|
|kaak|
|kkkk|
]]

-- head grid: case 38x32, glass ink rim u4..33 v3..26, lit area u5..32 v4..25 (ly 0..21)
local LW, LH = 38, 32
local X0, Y0 = 3, 11
local JX = 0                      -- per-frame head shake (scared)
local LU, LV = 5, 4               -- lit-area origin: face stamps use (lx, ly) from here
local LITH = 22
local FY = 3                      -- face block (ly 1..14) centred in the lit area
local function shx(v) return (v + 6) // 8 end          -- row shift (lean)
local function W(u, v)                                  -- local -> world
  local xp = u + shx(v)
  return X0 + JX + xp, Y0 + v - xp // 8
end

-- eye stamps, 7 wide, ink-framed, in lit coords: { top row, art } (m = white, k = ink)
local EYE = {
  -- smug: matched pair, flat ink lid bar over a 3x2 white + 2x2 pupil, both side-eyeing right
  smug = { L = { 5, "|.kkkkk.|\n|kkkkkkk|\n|kmmmkkk|\n|kmmmkkk|\n|.kkkkk.|" },
           R = { 5, "|.kkkkk.|\n|kkkkkkk|\n|kmmmkkk|\n|kmmmkkk|\n|.kkkkk.|" } },
  down = { L = { 7, "|.kkkkk.|\n|kmmmmmk|\n|kmmmmmk|\n|kmkkkmk|\n|.kkkkk.|" },
           R = { 7, "|.kkkkk.|\n|kmmmmmk|\n|kmmmmmk|\n|kmkkkmk|\n|.kkkkk.|" } },
  wide = { L = { 5, "|.kkkkk.|\n|kmmmmmk|\n|kmmkkmk|\n|kmmkkmk|\n|.kkkkk.|" },
           R = { 5, "|.kkkkk.|\n|kmmmmmk|\n|kmmkkmk|\n|kmmkkmk|\n|.kkkkk.|" } },
  shut = { L = { 7, "|kkkkkkk|\n|.k...k.|" },
           R = { 7, "|kkkkkkk|\n|.k...k.|" } },
  -- scared: wide, 1px pin pupils that jitter between the two frames
  scared  = { L = { 5, "|.kkkkk.|\n|kmmmmmk|\n|kmmmmmk|\n|kmmkmmk|\n|kmmmmmk|\n|.kkkkk.|" },
              R = { 5, "|.kkkkk.|\n|kmmmmmk|\n|kmmmmmk|\n|kmmmkmk|\n|kmmmmmk|\n|.kkkkk.|" } },
  scared2 = { L = { 5, "|.kkkkk.|\n|kmmmmmk|\n|kmmkmmk|\n|kmmmmmk|\n|kmmmmmk|\n|.kkkkk.|" },
              R = { 5, "|.kkkkk.|\n|kmmmmmk|\n|kmmmkmk|\n|kmmmmmk|\n|kmmmmmk|\n|.kkkkk.|" } },
}
-- chart-up glint: gold up-right arrow off the right eye's top-outer corner, ink-backed
local GLINT = { "|.aaa|", "|..aa|", "|.a.a|", "|a...|" }
-- chart-down (scared): pink arrow falling away from the eye
local CRASH = { "|a...|", "|.a.a|", "|..aa|", "|.aaa|" }
-- sweat drop on the glass, ink-framed marble
local DROP = "|..k..|\n|.kmk.|\n|kmmmk|\n|kmmmk|\n|.kkk.|"

local function riff(C, s)
  JX = s.jx or 0
  local g = C.bg
  g.rect(0, 0, CW, CH, s.flash and P or Y)
  L.twinkle(g, 4, 5, s.flash and M or P, nil, 1); L.twinkle(g, 44, 42, s.flash and M or V, nil, 1)
  g.px(2, 30, s.flash and M or V)

  -- local grids: head (case + glass) and face (lit screen contents)
  local GH, GF = {}, {}
  local function set(t, u, v, c) if u >= 0 and v >= 0 and u < LW and v < LH then t[v*LW+u] = c end end
  local function rect(t, u, v, w, h, c) for j = v, v+h-1 do for i = u, u+w-1 do set(t, i, j, c) end end end
  -- case: beige, rounded corners, shine tick, speaker slots, power LED
  rect(GH, 0, 0, LW, LH, S)
  for _, p in ipairs({{0,0},{LW-1,0},{0,LH-1},{LW-1,LH-1}}) do GH[p[2]*LW+p[1]] = nil end
  set(GH, 2, 1, M); set(GH, 3, 1, M); set(GH, 1, 2, M)
  rect(GH, 4, 3, 30, 24, K)                                       -- glass rim (ink)
  for _, x in ipairs({6, 8, 10}) do rect(GH, x, 28, 1, 2, K) end
  rect(GH, 32, 28, 2, 2, (s.needs or s.sweat) and P or G)
  -- lit glass: mint, teal scanline every 3rd row, rounded top corners stay ink
  for ly = 0, LITH-1 do for lx = 0, 27 do set(GF, LU + lx, LV + ly, (ly % 3 == 1) and T or G) end end
  for _, p in ipairs({{0,0},{27,0},{0,LITH-1},{27,LITH-1}}) do GF[(LV+p[2])*LW+LU+p[1]] = nil end
  local f = {}
  function f.px(lx, ly, c) set(GF, LU - 1 + lx, LV + FY + ly, c) end   -- face sits 1px left of centre
  function f.get(lx, ly) return GF[(LV + FY + ly)*LW + LU - 1 + lx] end
  function f.stamp(lx, ly, art)
    local r = 0
    for row in art:gmatch("[^\n]+") do
      row = row:gsub("^%s*|", ""):gsub("|%s*$", "")
      for i = 1, #row do local ch = row:sub(i, i); if ch ~= "." then f.px(lx+i-1, ly+r, KEY[ch]) end end
      r = r + 1
    end
  end
  function f.line(x0, y0, x1, y1, c)
    local n = math.max(math.abs(x1-x0), math.abs(y1-y0), 1)
    for t = 0, n do f.px(x0 + math.floor((x1-x0)*t/n + 0.5), y0 + math.floor((y1-y0)*t/n + 0.5), c) end
  end
  local function brow(x0, y0, x1, y1) f.line(x0, y0, x1, y1, K); f.line(x0, y0+1, x1, y1+1, K) end

  -- brows (2px ink): left angled down-in, right cocked arch; dy drops them with the eyes
  local dy = (s.eyes == "down") and 1 or 0
  if s.brow == "cock" then
    brow(5, 1+dy, 11, 2+dy); brow(15, 2+dy, 17, 0+dy); brow(18, 0+dy, 20, 1+dy)
  elseif s.brow == "up" then
    brow(5, 2, 11, 1); brow(15, 1, 20, 2)
  elseif s.brow == "worry" then             -- inner ends up
    brow(5, 2, 11, 0); brow(15, 0, 20, 2)
  end
  -- eyes
  local e = EYE[s.eyes]
  f.stamp(5, e.L[1], e.L[2]); f.stamp(15, e.R[1], e.R[2])
  -- glint: gold arrow from the right eye's top-outer corner, 1px ink backing on the glass
  if s.eyes ~= "shut" then
    local scared = s.eyes:sub(1, 6) == "scared"
    local gx, gy = 22, e.R[1] - 3
    if scared then gx, gy = 23, e.R[1] + 3 end
    local pts = {}
    for r, row in ipairs(scared and CRASH or GLINT) do
      row = row:gsub("|", "")
      for i = 1, #row do if row:sub(i, i) == "a" then pts[#pts+1] = { gx+i-1, gy+r-1 } end end
    end
    for _, p in ipairs(pts) do
      for _, d in ipairs({{-1,0},{1,0},{0,-1},{0,1}}) do
        local c = f.get(p[1]+d[1], p[2]+d[2])
        if c == G or c == T then f.px(p[1]+d[1], p[2]+d[2], K) end
      end
    end
    for _, p in ipairs(pts) do f.px(p[1], p[2], scared and P or A) end
  end
  -- mouth: modest smirk, right corner hooks up (rows 12..14)
  local m = s.mouth or "smirk"
  if m == "smirk" then
    f.line(9, 14, 14, 14, K); f.px(15, 13, K); f.px(16, 12, K)
  elseif m == "talk1" then                  -- small open smirk
    f.line(9, 14, 10, 14, K)
    for x = 11, 14 do f.px(x, 13, K); f.px(x, 14, K) end; f.px(15, 13, K); f.px(16, 12, K)
  elseif m == "talk2" then                  -- open, one row of teeth
    for x = 10, 15 do f.px(x, 12, K); f.px(x, 14, K) end
    for x = 11, 14 do f.px(x, 13, M) end; f.px(10, 13, K); f.px(15, 13, K); f.px(16, 12, K); f.px(17, 11, K)
  elseif m == "heh" then                    -- side "heh": corner open
    f.line(9, 14, 12, 14, K)
    for x = 13, 15 do f.px(x, 13, K); f.px(x, 14, K) end; f.px(16, 12, K)
  elseif m == "o" then
    for x = 11, 13 do f.px(x, 12, K); f.px(x, 14, K) end; f.px(10, 13, K); f.px(14, 13, K)
    f.px(12, 13, P)
  elseif m == "wobble" or m == "wobble2" then   -- wobbly scared mouth, 1px wave
    local ph = (m == "wobble") and 0 or 1
    for x = 8, 16 do
      f.px(x, 13 + ((x // 2 + ph) % 2), K)
    end
  end
  if s.sweat then f.stamp(22, s.sweat, DROP) end          -- top-right, clear of brow and bezel

  -- tilt both grids into the world
  local h, fc = C.head, C.face
  for v = 0, LH-1 do for u = 0, LW-1 do
    local x, y = W(u, v)
    if GH[v*LW+u] then h.px(x, y, GH[v*LW+u]) end
    if GF[v*LW+u] then fc.px(x, y, GF[v*LW+u]) end
  end end
  h.outline(K)

  -- rabbit-ear antennas from the tilted top edge
  local a = C.ant
  local ax, ay = W(13, 0); local bx, by = W(25, 0)
  a.line(ax, ay, ax-6, ay-8, V); a.line(ax+1, ay, ax-5, ay-8, V)
  a.line(bx, by, bx+7, by-6, V); a.line(bx+1, by, bx+8, by-6, V)
  a.ellipse(ax-6.5, ay-8.5, 1.8, 1.8, P); a.ellipse(bx+8.5, by-6.5, 1.8, 1.8, P)
  a.outline(K)

  -- violet suit, marble shirt, mint tie
  local b = C.body
  b.poly({2,49, 4,44, 13,41, 35,40, 44,43, 46,49}, V)
  b.outline(K)
  b.poly({18,41, 24,48, 31,40}, M)
  b.line(18,41, 24,48, K); b.line(31,40, 24,48, K)
  b.poly({23,42, 26,42, 27,47, 22,47}, G); b.hline(23, 42, 4, K); b.px(24, 44, K); b.px(25, 46, K)
  b.line(13,42, 17,47, K); b.line(36,41, 32,47, K)
  if s.needs then C.fx.stamp(43, 0, BANG, KEY) end
end

---------------------------------------------------------------- build + export
local function flat(spr, frame)
  local img = Image(spr.width, spr.height, ColorMode.INDEXED)
  img:clear(0)
  img:drawSprite(spr, frame)
  return img
end

local frames = {
  { eyes = "down", brow = "cock" },                                      -- lookDown x0
  { eyes = "smug", brow = "cock" },                                      -- idle     x48
  { eyes = "shut", brow = "cock" },                                      -- blink    x96
  { eyes = "smug", brow = "cock", mouth = "talk1" },                     -- talk     x144
  { eyes = "smug", brow = "cock", mouth = "talk2" },                     -- talk     x192
  { eyes = "smug", brow = "cock", mouth = "heh" },                       -- talk     x240
  { eyes = "wide", brow = "up", mouth = "o", needs = true },             -- needs    x288
  { eyes = "wide", brow = "up", mouth = "o", needs = true, flash = true },               -- x336
  { eyes = "scared", brow = "worry", mouth = "wobble", sweat = -2, jx = -1 },             -- scared x384
  { eyes = "scared2", brow = "worry", mouth = "wobble2", sweat = -1, jx = 1 } }           -- scared x432

local spr = L.new(CW, CH, pal)
for i = 2, #frames do spr:newFrame() end
local lay = {}
for _, n in ipairs(LAYERS) do lay[n] = L.layer(spr, n) end
local N = #frames
local img = Image(CW*N, CH, ColorMode.INDEXED); img:clear(0)
for i, s in ipairs(frames) do
  local C = {}
  for _, n in ipairs(LAYERS) do C[n] = L.canvas(spr, lay[n], spr.frames[i]) end
  riff(C, s)
  for _, n in ipairs(LAYERS) do C[n].commit() end
  img:drawImage(flat(spr, i), Point((i-1)*CW, 0))
end
spr:saveAs(root.."/art/office/faces/riffbot.aseprite"); spr:close()
for _, mode in ipairs({"dark", "light"}) do
  local out = Sprite(CW*N, CH, ColorMode.INDEXED)
  out:setPalette(Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" })
  out.transparentColor = 0
  out.cels[1].image = img
  out:saveAs(root.."/public/office/face-riffbot-"..mode..".png"); out:close()
end
print("wrote riffbot R4 "..N.." frames")
-- faces.json: set riffbot.scared only; every other entry/offset stays byte-identical
local fj = io.open(root.."/public/office/faces.json", "rb"); local old = fj:read("a"); fj:close()
local scared = '"scared":[{"x":'..(8*CW)..',"y":0},{"x":'..(9*CW)..',"y":0}]'
local new
if old:find('"scared":%[') then
  new = old:gsub('"scared":%b[]', scared, 1)
else
  new = old:gsub('("needs":%[{"x":288,"y":0},{"x":336,"y":0}%])', '%1,'..scared, 1)
end
assert(new ~= old or old:find(scared, 1, true), "faces.json: riffbot needs entry not found")
fj = io.open(root.."/public/office/faces.json", "wb"); fj:write(new); fj:close()
print("faces.json riffbot.scared set")
