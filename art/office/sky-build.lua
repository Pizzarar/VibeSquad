-- C2 phase 2: the sky band behind the two sky-CRT chat zones (C2b .sky-zones, docs/PLAN_NEON_OFFICE.md
-- "C2: Sky gods" Art 1). art/office/sky.aseprite, 480x176, INDEXED (P0), tiles seamlessly on x (every
-- shape wraps at x=480; the Bayer seams are 4-periodic). C2b draws it `background-size: auto 100%`,
-- so 176 rows = the zone height: 3x at 528px (about the zone at 1080p), 2x at the 360px minimum.
-- Rows: flat sunset bands with 4-row Bayer seams (SKY_TOP > VIOLET > CORAL > AMBER; PINK only in thin
-- streaks, it is a dark berry in the light palette), stars up
-- top, vaporwave streak clouds, a few floating cumulus, then the cloud floor along the bottom edge
-- that the tower's roof antennas poke up through (mast, rabbit ears, dish, whip). The bottom ~28
-- rows are what shows under the floating CRTs.
-- Layers: sky, streaks, clouds, antennas, floor.
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/sky-build.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local S = dofile(root.."/art/office/sky-lib.lua")
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local W, H = 480, 176

local spr = L.new(W, H, pal)
local C = {}
for _, n in ipairs({ "sky", "streaks", "clouds", "antennas", "floor" }) do
  local c = L.canvas(spr, L.layer(spr, n), spr.frames[1])
  local px, get = c.px, c.get
  c.px = function(x, y, col) px(x % W, y, col) end          -- tileable: everything wraps on x
  c.get = function(x, y) return get(x % W, y) end
  C[n] = c
end

-- ======================= sky: flat bands, 4-row Bayer seams =======================
do
  local c = C.sky
  local stops = { { 0, L.SKY }, { 46, L.VIOLET }, { 96, L.CORAL }, { 128, L.AMBER } }
  for y = 0, H - 1 do
    local col, nxt, t = stops[1][2], nil, 0
    for i = 1, #stops do if y >= stops[i][1] - 2 then col = stops[i][2] end end
    for i = 2, #stops do
      local s = stops[i][1]
      if y >= s - 2 and y < s + 2 then col, nxt, t = stops[i-1][2], stops[i][2], (y - (s - 2) + 0.5) / 4 end
    end
    for x = 0, W - 1 do c.px(x, y, nxt and L.dith(x, y, col, nxt, t) or col) end
  end
  for _, p in ipairs({ {14,6},{52,17},{97,4},{141,24},{176,9},{233,31},{268,5},{311,19},{352,11},
                       {396,27},{431,7},{466,21},{76,36},{204,40},{377,38} }) do c.px(p[1], p[2], L.MARBLE) end
  L.twinkle(c, 120, 12, L.MARBLE, L.MARBLE, 2); L.twinkle(c, 330, 30, L.MARBLE, L.MARBLE, 1)
  L.twinkle(c, 448, 14, L.MARBLE, L.MARBLE, 1)
  c.commit()
end

-- ======================= streaks: long flat vaporwave lenses, one band brighter than the sky behind =======================
do
  local c = C.streaks
  local function lens(x, y, len, col)
    c.hline(x, y, len, col)
    c.hline(x + 4, y - 1, len - 10, col)
  end
  lens(20, 60, 64, L.PINK);  lens(150, 70, 40, L.PINK);  lens(300, 56, 72, L.PINK);  lens(430, 74, 46, L.PINK)
  lens(250, 78, 30, L.PINK)
  lens(60, 90, 58, L.PINK); lens(196, 86, 82, L.PINK); lens(370, 89, 50, L.PINK); lens(456, 84, 40, L.PINK)
  lens(30, 108, 50, L.AMBER); lens(180, 112, 40, L.AMBER)
  lens(110, 118, 70, L.AMBER); lens(290, 124, 48, L.AMBER); lens(400, 116, 36, L.AMBER)
  lens(20, 142, 40, L.MARBLE); lens(236, 140, 56, L.MARBLE); lens(380, 144, 30, L.MARBLE)
  c.commit()
end

-- ======================= clouds: a few floating cumulus (peek out between and round the CRTs) =======================
do
  local c = C.clouds
  S.cloud(c, L, { {36,38,10,6}, {48,34,9,7}, {58,39,8,5} }, { base = 42, und = 2, wrap = W })
  S.cloud(c, L, { {170,88,14,7}, {188,82,12,9}, {204,87,10,6}, {216,90,6,4} }, { base = 93, und = 3, wrap = W })
  S.cloud(c, L, { {262,46,6,4}, {271,43,6,5}, {279,47,5,3} }, { base = 49, und = 2, wrap = W })
  S.cloud(c, L, { {346,110,12,6}, {362,104,13,9}, {378,110,10,6} }, { base = 114, und = 3, wrap = W })
  S.cloud(c, L, { {468,70,9,5}, {480,66,9,7}, {492,71,7,4} }, { base = 74, und = 2, wrap = W })   -- straddles the seam
  c.commit()
end

-- ======================= antennas: the tower's roof poking up through the cloud floor =======================
-- 2px strokes (they display at 3x), INK silhouettes against the sunset, one lamp each.
do
  local c = C.antennas
  local K = L.INK
  local function rod(x0, y0, x1, y1) c.line(x0, y0, x1, y1, K); c.line(x0 + 1, y0, x1 + 1, y1, K) end
  -- lattice mast at x=70: 2px legs splaying out, a brace every 5 rows with a zigzag between, PINK beacon
  local cx = 70
  local function hw(y) return 1 + (y - 146) // 7 end
  local prev
  for y = 146, H - 1 do
    local l, r = cx - hw(y) - 1, cx + hw(y) + 1
    c.px(l - 1, y, K); c.px(l, y, K); c.px(r, y, K); c.px(r + 1, y, K)
    if (y - 146) % 5 == 0 then
      c.hline(l, y, r - l + 1, K)
      if prev then c.line(prev[1], prev[2], r, y, K) end
      prev = { l, y }
    end
  end
  rod(cx, 139, cx, 145)
  c.stamp(cx - 2, 135, [[
|.kkk.|
|kppmk|
|kpppk|
|.kkk.|
]], { k = K, p = L.PINK, m = L.MARBLE })
  -- rabbit ears (the old roof TVs, waving goodbye) on a little set-top housing + 2px mast
  c.rect(196, 163, 2, H - 163, K)
  c.stamp(191, 158, [[
|..kkkkkk..|
|.kmmmmmmk.|
|kkkkkkkkkk|
|kvvvvvvggk|
|kkkkkkkkkk|
]], { k = K, m = L.MARBLE, v = L.VIOLET, g = L.MINT })
  rod(194, 158, 186, 144); rod(199, 158, 207, 142)
  local knob = [[
|.kk.|
|kamk|
|kaak|
|.kk.|
]]
  c.stamp(184, 141, knob, { k = K, a = L.AMBER, m = L.MARBLE })
  c.stamp(207, 139, knob, { k = K, a = L.AMBER, m = L.MARBLE })
  -- satellite dish: 3/4 side view, concave bowl opening up-left (lit MARBLE face, VIOLET toward the
  -- back), INK convex back, mount on a 2px pole, feed arm from the lower rim to a horn at the focus
  c.rect(337, 148, 2, H - 148, K)
  c.stamp(326, 137, [[
|...........kk.|
|.........kkmk.|
|........kmmvk.|
|.......kmmvvvk|
|......kmmvvvvk|
|.....kmmvvvvvk|
|....kmmvvvvvvk|
|...kmmvvvvvvvk|
|..kmmvvvvvvvk.|
|.kmmvvvvvvvk..|
|kmmvvvvvvkk...|
|kkvvvvvkk.....|
|.kkkkkk.......|
]], { k = K, m = L.MARBLE, v = L.VIOLET })
  rod(325, 148, 323, 139)
  c.stamp(321, 136, [[
|.kkk.|
|kgggk|
|.kkk.|
]], { k = K, g = L.MINT })
  -- Yagi / crossbar comms mast: 2px pole, three stepped crossbars (wide at the bottom), PINK beacon
  c.rect(437, 142, 2, H - 142, K)
  c.hline(431, 160, 14, K); c.hline(431, 161, 14, K)
  c.hline(433, 153, 10, K); c.hline(433, 154, 10, K)
  c.hline(435, 147, 6, K)
  for _, x in ipairs({ 431, 444, 433, 442 }) do c.px(x, x < 437 and (x == 431 and 159 or 152) or (x == 444 and 159 or 152), K) end
  c.stamp(436, 138, [[
|.kk.|
|kppk|
|kpmk|
|.kk.|
]], { k = K, p = L.PINK, m = L.MARBLE })
  c.commit()
end

-- ======================= floor: the cloud floor along the bottom edge (bases of the antennas hide in it) =======================
do
  local c = C.floor
  local base = H - 2                -- row 175 = the VIOLET bottom outline
  -- hand-placed puffs, wrapping. Back bank: low and wide (tops ~164). Front bank: four hero puffs
  -- (tops ~155) with medium/small ones between; the antennas stand in the gaps between heroes.
  S.cloud(c, L, {
    { 14,182,22,18}, { 52,183,20,17}, { 96,181,24,18}, {140,183,20,17}, {180,182,22,18}, {222,183,20,17},
    {262,181,23,18}, {304,183,20,17}, {346,182,22,18}, {386,183,20,17}, {428,181,24,18}, {462,183,18,16},
      }, { base = base, und = 2, wrap = W, body = { 169, 0, W - 1 } })
  local puffs = {
    { 16,178,13,20}, { 30,176,12,17}, {  2,174,9,8}, { 42,173,8,7},
    { 94,175,13,11}, {110,172,7,6},
    {132,180,12,19}, {146,177,13,22}, {164,173,8,7},
    {226,176,14,12}, {244,172,7,6},
    {262,179,13,21}, {276,177,12,18}, {292,173,9,8},
    {364,176,15,12}, {381,172,7,6},
    {396,178,12,18}, {410,179,13,23}, {428,174,8,7}, {468,176,11,10},
  }
  S.cloud(c, L, puffs, { base = base, und = 2, wrap = W })
  c.commit()
end

spr:saveAs(root.."/art/office/sky.aseprite")
local flat = Image(W, H, ColorMode.INDEXED); flat:clear(0); flat:drawSprite(spr, spr.frames[1])
spr:close()
for _, mode in ipairs({ "dark", "light" }) do
  local out = Sprite(W, H, ColorMode.INDEXED)
  out:setPalette(Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" })
  out.transparentColor = 0
  out.cels[1].image = flat
  out:saveAs(root.."/public/office/sky-"..mode..".png"); out:close()
end
print("wrote sky band "..W.."x"..H)
