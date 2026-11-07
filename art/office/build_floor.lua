-- S1v2 floor plate, 3/4 top-down camera (above + behind, ~45deg): art/office/floor.aseprite,
-- 640x360 INDEXED (P0), hand-placed shapes only.
-- v3 layout: [Buddy booth | lead U-desk | Team A x6] [slim marble lift core] [Team B x6 | lead | Buddy]
-- The back wall is foreshortened (cut top cap 0..3, face 4..95); the carpet runs 96..331, so desks,
-- keyboards and CRT tops are seen from above. Floor slab + the floor below's ceiling from 332.
-- Layers (bottom->top): bg (sky through the windows), building, furniture, signs, light, front.
-- "front" = the overlay that must cover sprites (glass booth fronts, lead U-desk lip, lift car front +
-- door jambs); it is also part of the plate, and export_floor.lua writes it on its own as floor-front-*.png.
-- Anchor slices: teamA/teamB.{lead,buddyOffice,desk0..5,lobby}, elevator.{doorA,doorB,car}.
-- Index 0 is never painted on the plate (fully opaque).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/build_floor.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local KIT = dofile(root.."/art/office/kit34.lua")(L)
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local W, H = 640, 360
local K = KIT.K

local WIN0, WIN1 = 20, 68       -- window frame (foreshortened)
local FLOOR0, FLOOR1 = 96, 331  -- carpet
local SLAB = 332

local spr = L.new(W, H, pal)
local f1 = spr.frames[1]
local C = {}
for _, n in ipairs({ "bg", "building", "furniture", "signs", "light", "front" }) do C[n] = L.canvas(spr, L.layer(spr, n), f1) end

local function mirror(c)
  for y=0,H-1 do for x=0,287 do
    local v = c.get(x, y)
    if v ~= 0 then c.px(W-1-x, y, v) end
  end end
end
local function mx(x, w) return W - x - (w or 1) end
local function mirR(r) return { mx(r[1], r[3]), r[2], r[3], r[4] } end

-- ======================= anchors (Team A; Team B mirrored) — unchanged from S1 =======================
local A = {
  buddyOffice = {20, 262, 32, 32},
  lead        = {78, 204, 32, 32},
  desks = { {124,172,32,32}, {172,172,32,32}, {220,172,32,32},
            {124,234,32,32}, {172,234,32,32}, {220,234,32,32} },
  lobby       = {212, 272, 72, 32},
}
local EL = { doorA = {290, 256, 11, 48}, car = {304, 270, 32, 32} }
EL.doorB = mirR(EL.doorA)

-- ======================= bg: sunset sky through the windows =======================
do
  local c = C.bg
  local ramp = { L.SKY, L.VIOLET, L.PINK, L.CORAL, L.AMBER }
  for y=4,95 do
    local t = math.max(0, math.min(0.999, (y-24)/42)) * 4
    local s = math.floor(t)
    for x=0,W-1 do c.px(x, y, L.dith(x, y, ramp[s+1], ramp[math.min(s+2, 5)], t - s)) end
  end
  for _, p in ipairs({{88,26},{103,33},{140,25},{161,30},{247,26},{266,34},{378,25},{396,32},
                      {470,28},{512,24},{540,31},{556,26},{212,29},{120,36},{85,40},{555,40}}) do
    c.px(p[1], p[2], L.MARBLE)
  end
  L.twinkle(c, 118, 28, L.MARBLE, L.MARBLE, 2)
  L.twinkle(c, 530, 29, L.MARBLE, L.MARBLE, 2)
  -- vaporwave sun, striped (team A side)
  local sx, sy, sr = 196, 68, 22
  for y=sy-sr, sy do
    local gap = y > sy-12 and (sy - y) % 4 == 1
    if not gap then
      local hw = math.floor(math.sqrt(sr*sr - (y-sy)^2))
      for x=sx-hw, sx+hw do c.px(x, y, L.dith(x, y, L.AMBER, L.CORAL, (y-(sy-sr))/sr)) end
    end
  end
  -- skyline: INK blocks with AMBER windows {x, w, top}
  local blocks = { {79,12,52},{92,8,47},{101,14,55},{116,9,45},{126,16,51},{143,10,57},
                   {154,13,49},{168,6,59},{218,8,59},{227,14,50},{242,9,54},{252,15,46},
                   {268,8,52},
                   {363,10,54},{374,14,46},{389,8,51},{398,16,57},{415,9,48},{425,13,52},
                   {439,7,59},{447,15,45},{463,10,55},{474,12,50},{487,8,58},{496,14,47},
                   {511,10,53},{522,15,49},{538,8,57},{547,12,46} }
  for i, b in ipairs(blocks) do
    c.rect(b[1], b[3], b[2], 69-b[3], L.INK)
    for wy=b[3]+3, 66, 3 do for wx=b[1]+2, b[1]+b[2]-3, 3 do
      if (wx*7 + wy*3 + i) % 5 < 2 then c.px(wx, wy, L.AMBER) end
    end end
  end
  c.vline(122, 38, 7, L.INK); c.px(122, 37, L.PINK)
  c.vline(452, 37, 8, L.INK); c.px(452, 36, L.PINK)
  -- team B sky: a goofy blimp
  c.stamp(470, 27, [[
|.......kkkkkkkkkkkkk..........|
|....kkkmmmmmmmmmmmmmkkk.......|
|..kkmmmmmmmmmmmmmmmmmmmkk..k..|
|.kmmmmmmmmmmmmmmmmmmmmmmmk.kpk|
|kmmmmmmmmmmmmmmmmmmmmmmmmmkkpk|
|kmmmmmmmmmmmmmmmmmmmmmmmmmmppk|
|kmmmmmmmmmmmmmmmmmmmmmmmmmkkpk|
|.kmmmmmmmmmmmmmmmmmmmmmmmk.kpk|
|..kkmmmmmmmmmmmmmmmmmmmkk..k..|
|....kkkmmmmmmmmmmmmmkkk.......|
|.......kkkkkkkkkkkkk..........|
|..........kpppppk.............|
|..........kkkkkkk.............|
]], K)
  L.text(c, 476, 30, "GOO", L.PINK)
  L.text(c, 490, 30, "TV", L.VIOLET)
  c.commit()
end

-- ======================= building: cut wall top, wall face, windows, carpet =======================
do
  local c = C.building
  -- cut top of the back wall, seen from above
  c.hline(0, 0, 288, L.INK); c.rect(0, 1, 288, 2, L.MARBLE); c.hline(0, 2, 288, L.LINE); c.hline(0, 3, 288, L.INK)
  c.rect(0, 4, 288, 92, L.PHI)
  -- wallpaper y 74..88: squiggle + plus tile, offset rows
  local TILE = { "........", ".v......", "v.v.....", "...v....", "........", ".....l..", "....lll.", ".....l.." }
  for y=74,88 do for x=0,287 do
    local ty, tx = (y-74) % 8, (x + ((y-74)//8 % 2)*4) % 8
    local ch = TILE[ty+1]:sub(tx+1, tx+1)
    if ch ~= "." then c.px(x, y, K[ch]) end
  end end
  -- chair rail + baseboard, then the wall/floor seam
  c.hline(0, 72, 288, L.MARBLE); c.hline(0, 73, 288, L.LINE)
  c.hline(0, 89, 288, L.INK); c.rect(0, 90, 288, 5, L.LINE); c.hline(0, 90, 288, L.MARBLE)
  c.hline(0, 95, 288, L.INK)
  -- window (sky shows through)
  local wx0, wx1 = 76, 276
  c.rect(wx0, WIN0, wx1-wx0+1, WIN1-WIN0+1, L.INK)
  c.rect(wx0+1, WIN0+1, wx1-wx0-1, WIN1-WIN0-1, L.MARBLE)
  c.hline(wx0+1, WIN1-1, wx1-wx0-1, L.LINE); c.vline(wx1-1, WIN0+1, WIN1-WIN0-1, L.LINE)
  c.rect(wx0+3, WIN0+3, wx1-wx0-5, WIN1-WIN0-5, L.INK)
  for x=wx0+4, wx1-4 do for y=WIN0+4, WIN1-3 do c.px(x, y, 0) end end
  for _, mxx in ipairs({126, 175, 224}) do
    c.vline(mxx-1, WIN0+3, WIN1-WIN0-4, L.INK); c.vline(mxx, WIN0+3, WIN1-WIN0-4, L.MARBLE)
    c.vline(mxx+1, WIN0+3, WIN1-WIN0-4, L.INK)
  end
  -- window sill: a ledge seen from above
  c.rect(wx0-2, WIN1+1, wx1-wx0+5, 2, L.MARBLE); c.hline(wx0-2, WIN1+3, wx1-wx0+5, L.INK)
  -- carpet: PANEL with a foreshortened dotted LINE diamond lattice (diamonds 24 wide x 12 deep)
  c.rect(0, FLOOR0, 288, FLOOR1-FLOOR0+1, L.PANEL)
  for y=FLOOR0,FLOOR1 do for x=0,287 do
    if ((x + 2*y) % 24 == 0 or (x - 2*y) % 24 == 0) and (x % 2 == 0) then c.px(x, y, L.LINE) end
  end end
  -- floor slab cut-away, then the ceiling of the floor below (dollhouse tower read)
  c.hline(0, SLAB, 288, L.INK); c.hline(0, SLAB+1, 288, L.MARBLE)
  c.rect(0, SLAB+2, 288, 9, L.LINE)
  for x=6,287,24 do c.rect(x, SLAB+4, 12, 4, L.PHI); c.hline(x, SLAB+4, 12, L.INK) end
  c.hline(0, SLAB+11, 288, L.INK)
  c.rect(0, SLAB+12, 288, H-SLAB-12, L.PANEL)
  for x=0,287,20 do c.vline(x, SLAB+12, H-SLAB-12, L.LINE) end
  for _, lx in ipairs({30, 110, 190, 250}) do
    c.rect(lx, SLAB+17, 26, 6, L.INK); c.rect(lx+1, SLAB+18, 24, 4, L.MARBLE); c.hline(lx+1, SLAB+21, 24, L.LINE)
  end
  -- IDEA LAB booth floor: PHI tiles, foreshortened LINE grid (6 wide x 4 deep)
  c.rect(8, FLOOR0, 55, 202, L.PHI)
  for y=FLOOR0,FLOOR0+201 do for x=8,62 do
    if (x - 8) % 6 == 0 or (y - FLOOR0) % 4 == 0 then c.px(x, y, L.LINE) end
  end end
  -- pilaster between the booth and the window
  c.rect(68, 4, 6, 91, L.MARBLE); c.vline(68, 4, 91, L.INK); c.vline(73, 4, 91, L.LINE); c.vline(74, 4, 91, L.INK)
  for y=10,90,12 do c.hline(69, y, 4, L.LINE) end
  -- outer building wall: cut top seen from above, full height
  c.rect(0, 0, 3, H, L.INK); c.vline(1, 0, SLAB, L.MARBLE); c.vline(3, 4, SLAB-4, L.LINE)
  -- booth partition (glass wall seen from above: a capped rail on the floor)
  c.vline(63, FLOOR0, 199, L.INK); c.vline(64, FLOOR0, 199, L.MARBLE); c.vline(65, FLOOR0, 199, L.TEAL)
  c.vline(66, FLOOR0, 199, L.LINE); c.vline(67, FLOOR0, 199, L.INK)
  mirror(c)

  -- elevator core x 288..351 (marble column, glass shaft); the core's cut top at y 0..3
  c.rect(288, 0, 64, H, L.MARBLE)
  c.vline(288, 0, H, L.INK); c.vline(351, 0, H, L.INK)
  c.vline(289, 0, H, L.LINE); c.vline(350, 0, H, L.LINE)
  c.hline(288, 3, 64, L.INK); c.hline(288, 2, 64, L.LINE)
  for _, v in ipairs({{292,40,1},{347,90,-1},{293,160,1},{346,214,-1},{292,318,1}}) do
    for i=0,9 do if i % 3 ~= 2 then c.px(v[1] + (v[3] > 0 and i//3 or -(i//3)), v[2]+i, L.LINE) end end
  end
  -- shaft window 300..339
  c.rect(299, 14, 42, 236, L.INK)
  for y=15,248 do for x=300,339 do c.px(x, y, L.dith(x, y, L.SKY, L.VIOLET, math.max(0, (y-150)/100))) end end
  c.vline(314, 15, 234, L.INK); c.vline(325, 15, 234, L.INK)
  c.vline(303, 15, 234, L.LINE); c.vline(336, 15, 234, L.LINE)
  c.rect(332, 110, 6, 16, L.INK); c.rect(333, 111, 4, 14, L.LINE)
  -- slab + floor-below under the core
  c.hline(288, SLAB, 64, L.INK); c.hline(288, SLAB+1, 64, L.MARBLE)
  c.rect(288, SLAB+2, 64, 9, L.LINE); c.hline(288, SLAB+11, 64, L.INK)
  c.vline(288, SLAB, H-SLAB, L.INK); c.vline(351, SLAB, H-SLAB, L.INK)
  c.commit()
end

-- ======================= furniture =======================
local CLUTTER = {
  "|.kkk.|\n|kmmmk|\n|kmpmk|\n|kmmmk|\n|.kkk.|",           -- mug, from above
  "|kkkkkk|\n|kttttk|\n|kkkkkk|\n|kvvvvk|\n|kkkkkk|",      -- floppy stack
  "|.kgk.|\n|kgggk|\n|.kgk.|\n|kpppk|\n|kkkkk|",           -- cactus
  "|kkkkkk|\n|kmmmmk|\n|kmlmmk|\n|kmmmlk|\n|kkkkkk|",      -- paper pile
  "|.kkk.|\n|kaaak|\n|kakak|\n|kaaak|\n|.kkk.|",           -- coffee can, from above
}
local STK = { "|.a.|\n|aaa|\n|a.a|", "|p.p|\n|ppp|\n|.p.|", "|ggg|\n|gkg|\n|ggg|" }
local deskN = 0
-- worker desk around slice (x,y): sitter's head lands on the keyboard row, CRT top + rear behind it
local function deskAt(c, x, y)
  deskN = deskN + 1
  KIT.slab(c, x-3, y+2, 38, 11, L.AMBER, L.CORAL, 3)
  KIT.keys(c, x+5, y+7)
  c.stamp(x-1, y+3, CLUTTER[(deskN*3-1) % #CLUTTER + 1], K)
  KIT.crt(c, x+17, y-8, STK[(deskN-1) % 3 + 1])
  if deskN % 2 == 0 then c.rect(x+19, y-6, 3, 3, L.AMBER); c.px(x+19, y-6, L.MARBLE) end -- sticky note
  -- beige tower PC on the floor beside the desk, top face + front
  c.rect(x+36, y+6, 6, 12, L.INK); c.rect(x+37, y+7, 4, 3, L.MARBLE); c.rect(x+37, y+11, 4, 6, L.MARBLE)
  c.hline(x+37, y+10, 4, L.LINE); c.px(x+38, y+13, L.MINT); c.hline(x+37, y+15, 4, L.LINE)
end
-- lead U-desk: back run with two CRTs, side wings, front returns (the returns are the "front lip")
local function leadDesk(c, x, y)
  KIT.slab(c, x-9, y+2, 50, 11, L.AMBER, L.CORAL, 3)
  for _, wx in ipairs({x-9, x+33}) do
    c.rect(wx-1, y+1, 10, 26, L.INK); c.rect(wx, y+2, 8, 24, L.AMBER); c.vline(wx, y+2, 24, L.MARBLE)
  end
  c.hline(x-9, y+2, 50, L.MARBLE)
  KIT.keys(c, x+5, y+7)
  KIT.crt(c, x-7, y-8, STK[1]); KIT.crt(c, x+23, y-8, STK[3])
  -- gold trophy on the left wing, phone on the right wing
  c.stamp(x-7, y+12, "|kkkkk|\n|kaaak|\n|kaaak|\n|.kak.|\n|.kkk.|\n|kaaak|\n|kkkkk|", K)
  c.stamp(x+35, y+13, "|kkkk|\n|kpak|\n|kppk|\n|kppk|\n|kkkk|", K)
end
local function leadFront(c, x, y)
  -- returns: top face + violet front panel with the crown nameplate (covers the chair casters)
  for _, r in ipairs({{x-9, 19}, {x+22, 19}}) do
    c.rect(r[1]-1, y+25, r[2]+2, 14, L.INK)
    c.rect(r[1], y+26, r[2], 4, L.AMBER); c.hline(r[1], y+26, r[2], L.MARBLE)
    c.hline(r[1], y+30, r[2], L.INK)
    L.plate(c, r[1], y+31, r[2], 7, L.VIOLET, L.MARBLE, L.INK)
  end
  L.plate(c, x-4, y+32, 9, 5, L.INK, L.LINE, L.INK)
  c.stamp(x-3, y+32, "|a.a.a|\n|aaaaa|\n|apapa|\n|aaaaa|", K)
end

do
  local c = C.furniture
  -- booth back wall: IDEA LAB whiteboard of doodles
  L.plate(c, 12, 14, 48, 38, L.MARBLE, L.MARBLE, L.LINE)
  c.stamp(16, 22, [[
|.ppp......t.t.......a.......|
|p...p....t.t.t.....aaa......|
|...p......t...t...aaaaa.....|
|..p..............kaaaaak....|
|..p...ggg..........aaa......|
|.....g...g.........kkk......|
|..p..g.k.g..ttt....kkk......|
|.....g...g.t...t.....kk...pp|
|......ggg..t.k.t.........p..|
|...........t...t.ppp....p...|
|............ttt.p...p....p..|
|................p...p.....pp|
|.................ppp........|
]], K)
  c.rect(14, 47, 44, 3, L.LINE); c.rect(20, 47, 4, 2, L.PINK); c.rect(26, 47, 4, 2, L.TEAL) -- marker tray
  -- booth rug under the Buddy seat (seen from above)
  c.rect(10, 252, 52, 26, L.VIOLET)
  for x=10,61,4 do for y=254,276,6 do c.px(x+1, y, L.AMBER); c.px(x+3, y+3, L.AMBER) end end
  c.edge(L.VIOLET, L.INK)
  -- beanbag in the booth corner
  c.ellipse(20, 120, 9, 6, L.INK); c.ellipse(20, 120, 8, 5, L.PINK); c.ellipse(18, 118, 3, 2, L.CORAL)

  -- water cooler against the wall, standing on the carpet
  c.stamp(98, 74, [[
|....kkkkkk....|
|...kyyyyyyk...|
|...kymyyyyk...|
|...kyyyyyyk...|
|....kyyyyk....|
|..kkkkkkkkkk..|
|..kmmmmmmmmk..|
|..kmtmmmmpmk..|
|..kmkmmmmkmk..|
|..kmmmmmmmmk..|
|..kllllllllk..|
|..kmmmmmmmmk..|
|..kmmmmmmmmk..|
|..kmmmmmmmmk..|
|..kmmmmmmmmk..|
|..kllllllllk..|
|..kmmmmmmmmk..|
|..kmmmmmmmmk..|
|..kllllllllk..|
|..kmmmmmmmmk..|
|..kmmmmmmmmk..|
|..kkkkkkkkkk..|
|...kkkkkkkk...|
]], K)
  -- filing cabinet + fax, against the wall by the lift (top face shows)
  c.rect(258, 82, 24, 4, L.INK); c.rect(259, 83, 22, 2, L.MARBLE)
  L.plate(c, 259, 87, 22, 22, L.LINE, L.MARBLE, L.INK)
  for _, dy in ipairs({94, 101}) do c.hline(261, dy, 18, L.INK); c.rect(268, dy-4, 4, 2, L.MARBLE) end
  c.stamp(260, 72, [[
|..kkkkkkkk......|
|..kmmmmmmk......|
|.kkkkkkkkkkkkkk.|
|kaaaaaaaaaaaaaak|
|kaakkkkkaagapak.|
|kaakyyykaaaaaak.|
|kaaaaaaaaaaaaaak|
|.kkkkkkkkkkkkkk.|
|..kmmmmmmk......|
|...kmmmmk.......|
]], K)
  -- potted plants against the wall
  for _, px in ipairs({178}) do
    c.stamp(px, 70, [[
|...kk..kk...|
|..kggkkggk..|
|.kgggggggk..|
|kggkgggkggk.|
|.kgggkgggk..|
|..kkggggkk..|
|...kpppk....|
|..kpppppk...|
|..kpaaapk...|
|..kpppppk...|
|...kkkkk....|
]], K)
  end
  -- big palm (front, between the desk rows and the slab)
  c.stamp(140, 298, [[
|......kk.................kk.......|
|.....kggk...............kggk......|
|....kgggk....kkkkk.....kgggk......|
|...kgggk....kgggggk.....kgggk.....|
|..kggkk...kggkkkkggk.....kkggk....|
|.kggk....kggk....kggk.......kggk..|
|.kgk....kggk..kk..kggk.......kgk..|
|kgk....kggk..kggk..kggk.......kk..|
|kk....kggk..kgggk...kgk...........|
|.....kgk...kggkggk...kk..kkk......|
|.....kk...kggk.kggk....kgggk......|
|.........kggk...kgk...kggkggk.....|
|........kggk.....kk..kggk.kggk....|
|........kgk.........kggk...kgk....|
|........kk...kkk...kggk.....kk....|
|............kccck..kgk............|
|.............kcck..kk.............|
|.............kcck.................|
|..............kcck................|
|..........kkkkkkkkkkk.............|
|..........kpppppppppk.............|
|..........kpaaaaaaapk.............|
|..........kpppppppppk.............|
|...........kpppppppk..............|
|...........kpppppppk..............|
|............kkkkkkk...............|
]], K)
  -- marble bust in pink shutter shades, on a pedestal (front, by the lead)
  c.stamp(88, 299, [[
|.......kkkkkkk........|
|......kmmmmmmmk.......|
|.....kmmmmmmmmmk......|
|....kmmlmmmmmmmmk.....|
|....kmlmmmmmmmmmk.....|
|....kmmmmmmmmmmmk.....|
|....kkkkkkkkkkkkk.....|
|....kpkpkpkkpkpkk.....|
|....kkkkkkkkkkkkk.....|
|.....kmmmmlmmmmk......|
|......kmmllmmmk.......|
|.......kmmmmmk........|
|....kkkmmmmmmmkkk.....|
|..kkmmmmmmmmmmmmmkk...|
|.kmmmmmmmmmmmmmmmmmk..|
|.kkkkkkkkkkkkkkkkkkk..|
|...kkkkkkkkkkkkkkk....|
|...kmmmmmmmmmmmmmk....|
|...kmmmmmmmmmmmmmk....|
|....kmlmmmmmmmmmk.....|
|....kmlmmmmmmmmmk.....|
|....kmlmmmmmmmmmk.....|
|....kmlmmmmmmmmmk.....|
|...kkkkkkkkkkkkkkk....|
|...kmmmmmmmmmmmmmk....|
|..kkkkkkkkkkkkkkkkk...|
]], K)
  -- lobby mat under the queue (feet line = lobby bottom), arrow to the door
  c.rect(212, 296, 72, 10, L.PINK); c.edge(L.PINK, L.INK)
  c.stamp(266, 299, "|...a...|\n|aaaaa..|\n|...a...|", K)
  mirror(c)

  -- desks for both teams (not mirrored, so every CRT sits right of the head like the sprites)
  for _, m in ipairs({ function(r) return r end, mirR }) do
    local r = m(A.buddyOffice); deskAt(c, r[1], r[2])
    r = m(A.lead); leadDesk(c, r[1], r[2])
    for _, d in ipairs(A.desks) do r = m(d); deskAt(c, r[1], r[2]) end
  end

  -- lift car (seen from above: back wall face, then the car floor) + doors + call panels
  local cx, cy = 302, 250
  c.rect(cx, cy, 36, 56, L.INK)
  c.rect(cx+1, cy+1, 34, 16, L.PHI)                                    -- car back wall
  c.rect(cx+1, cy+1, 34, 3, L.LINE); c.hline(cx+10, cy+2, 16, L.AMBER) -- ceiling light
  c.hline(cx+1, cy+13, 34, L.MARBLE); c.hline(cx+1, cy+14, 34, L.LINE)  -- handrail
  for _, sx in ipairs({cx+9, cx+18, cx+27}) do c.vline(sx, cy+4, 9, L.LINE) end
  c.rect(cx+29, cy+4, 5, 9, L.INK); for by=cy+5, cy+11, 2 do c.px(cx+31, by, L.AMBER) end
  c.hline(cx+1, cy+17, 34, L.INK)
  for y=cy+18, cy+54 do for x=cx+1, cx+34 do                           -- car floor, checker
    c.px(x, y, ((x//4 + y//3) % 2 == 0) and L.LINE or L.PHI)
  end end
  for _, d in ipairs({EL.doorA, EL.doorB}) do
    local x, y, w, h = d[1], d[2], d[3], d[4]
    c.rect(x, y, w, h, L.INK)
    c.rect(x+1, y+1, w-2, h-1, L.TEAL)
    c.vline(x+1, y+1, h-1, L.MARBLE)
    c.vline(x + w//2, y+1, h-1, L.INK)
    c.rect(x+2, y+8, 3, 10, L.SKY); c.rect(x+w-5, y+8, 3, 10, L.SKY)
    c.rect(x+1, y-10, w-2, 8, L.INK)
    c.px(x + w//2, y-8, L.AMBER); c.hline(x + w//2 - 1, y-7, 3, L.AMBER)
    c.hline(x + w//2 - 1, y-5, 3, L.PINK); c.px(x + w//2, y-4, L.PINK)
  end
  c.commit()
end

-- ======================= signs =======================
do
  local c = C.signs
  local function textBig(x, y, s, col, sh)
    for n=1,#s do
      local g = L.F[s:sub(n,n)] or L.F[" "]
      for r=0,4 do for q=0,2 do
        if g:sub(r*3+q+1, r*3+q+1) == "1" then
          local px0, py0 = x + (n-1)*8 + q*2, y + r*2
          if sh then c.rect(px0+1, py0+1, 2, 2, sh) end
        end
      end end
    end
    for n=1,#s do
      local g = L.F[s:sub(n,n)] or L.F[" "]
      for r=0,4 do for q=0,2 do
        if g:sub(r*3+q+1, r*3+q+1) == "1" then c.rect(x + (n-1)*8 + q*2, y + r*2, 2, 2, col) end
      end end
    end
  end
  -- team sign bolted to the wall over the window head
  local function sign(cx, label, face)
    local w = #label*8 - 2 + 12
    local x = cx - w//2
    L.plate(c, x, 6, w, 17, face, L.MARBLE, L.CORAL)
    c.hline(x+2, 8, w-4, L.PINK); c.hline(x+2, 20, w-4, L.PINK)
    textBig(x+6, 10, label, L.INK, L.CORAL)
    L.twinkle(c, x - 4, 9, L.MARBLE, L.MARBLE, 2)
    L.twinkle(c, x + w + 3, 18, L.AMBER, L.MARBLE, 1)
  end
  sign(176, "VIBESQUAD", L.AMBER)
  sign(W-176, "HYPERDESK", L.AMBER)
  -- booth labels + OUT signs
  L.text(c, 20, 6, "IDEA LAB", L.INK)
  L.text(c, W-20-L.textW("IDEA LAB"), 6, "IDEA LAB", L.INK)
  for _, x in ipairs({22, W-22-26}) do
    L.plate(c, x, 58, 26, 9, L.MINT, L.MARBLE, L.LINE)
    L.text(c, x+3, 60, "OUT", L.INK)
  end
  local function poster(x, y, label, face)
    L.plate(c, x, y, 22, 22, face, L.MARBLE, L.LINE)
    c.stamp(x+6, y+2, [[
|....k....|
|...kak...|
|kkkkaakkk|
|kaaaaaaak|
|.kaaaaak.|
|.kaakaak.|
|kaak.kaak|
|kk.....kk|
]], K)
    L.text(c, x + (22 - L.textW(label))//2, y+14, label, L.INK)
  end
  poster(232, 70, "GO!", L.PINK)
  poster(W-232-22, 70, "WOW", L.TEAL)
  for _, x in ipairs({148, W-148-13}) do
    c.ellipse(x+6, 81, 6, 6, L.INK); c.ellipse(x+6, 81, 5, 5, L.MARBLE)
    c.vline(x+6, 77, 4, L.INK); c.hline(x+6, 81, 3, L.INK); c.px(x+6, 81, L.PINK)
  end
  -- lift floor indicator + LIFT plate
  c.rect(305, 236, 30, 11, L.INK)
  L.text(c, 316, 239, "07", L.AMBER)
  c.stamp(308, 239, "|.g.|\n|ggg|", K)
  L.plate(c, 303, 6, 34, 9, L.VIOLET, L.MARBLE, L.LINE)
  L.text(c, 312, 8, "LIFT", L.MARBLE)
  c.commit()
end

-- ======================= front overlay (covers sprites; also part of the plate) =======================
do
  local c = C.front
  -- Buddy glass booth front wall (door gap on the lift side), kick plate hides the chair casters
  KIT.glassFront(c, 4, 52, 283, {5, 28, 51})
  -- lead U-desk front lip
  leadFront(c, A.lead[1], A.lead[2])
  mirror(c)
  -- lift car front: header, jambs, threshold kick (hides the rider's shoes + shadow)
  local cx, cy = 302, 250
  c.rect(cx-2, cy-3, 40, 4, L.INK); c.rect(cx-1, cy-2, 38, 2, L.MARBLE)
  for _, jx in ipairs({cx-2, cx+34}) do
    c.rect(jx, cy, 4, 57, L.INK); c.rect(jx+1, cy, 2, 56, L.MARBLE); c.vline(jx+2, cy, 56, L.LINE)
  end
  c.rect(cx-2, cy+49, 40, 8, L.INK); c.rect(cx+2, cy+50, 32, 2, L.MARBLE); c.rect(cx+2, cy+52, 32, 3, L.LINE)
  c.hline(cx+4, cy+53, 28, L.AMBER)
  -- lobby door jambs
  for _, d in ipairs({EL.doorA, EL.doorB}) do
    local x, y, w, h = d[1], d[2], d[3], d[4]
    c.vline(x-1, y-1, h+1, L.INK); c.vline(x+w, y-1, h+1, L.INK)
    c.hline(x-1, y-1, w+2, L.INK); c.hline(x, y+h-1, w, L.MARBLE)
  end
  c.commit()
end

-- ======================= light: dither pools, glass glints, sparkles =======================
do
  local c = C.light
  local fur, sig, fr = C.furniture, C.signs, C.front
  local function free(x, y) return fur.get(x, y) == 0 and sig.get(x, y) == 0 and fr.get(x, y) == 0 end
  local function pool(cx, cy, rx, ry, col, maxT)
    for y=cy-ry, cy+ry do for x=cx-rx, cx+rx do
      local d = math.sqrt(((x-cx)/rx)^2 + ((y-cy)/ry)^2)
      if d < 1 and y >= FLOOR0+1 and y <= FLOOR1 and x > 67 and x < 288 and free(x, y) then
        if (L.BAYER[y%4+1][x%4+1] + 0.5) < maxT*(1-d)*16 then c.px(x, y, col) end
      end
    end end
  end
  -- warm sunset spill on the carpet under the window, soft pools around the desk rows
  for _, cx in ipairs({126, 226}) do pool(cx, FLOOR0+6, 60, 14, L.CORAL, 0.5) end
  for _, lx in ipairs({140, 205}) do pool(lx, 215, 36, 40, L.PHI, 0.45) end
  L.twinkle(c, 58, 104, L.MARBLE, L.MARBLE, 2)
  L.twinkle(c, 118, 300, L.PINK, L.MARBLE, 1)
  L.twinkle(c, 190, 286, L.AMBER, L.MARBLE, 1)
  mirror(c)
  for _, g in ipairs({{302,90,14},{304,180,10}}) do
    for i=0,g[3]-1 do c.px(g[1]+i, g[2]-i, L.MARBLE) end
  end
  L.twinkle(c, 295, 120, L.TEAL, L.MARBLE, 2)
  L.twinkle(c, 345, 66, L.PINK, L.MARBLE, 1)
  c.commit()
end

-- ======================= slices =======================
local function slice(name, r)
  local s = spr:newSlice(Rectangle(r[1], r[2], r[3], r[4]))
  s.name = name
end
for _, side in ipairs({"A", "B"}) do
  local m = side == "A" and function(r) return r end or mirR
  local p = "team"..side.."."
  slice(p.."lead", m(A.lead)); slice(p.."buddyOffice", m(A.buddyOffice))
  for i, d in ipairs(A.desks) do slice(p.."desk"..(i-1), m(d)) end
  slice(p.."lobby", m(A.lobby))
end
slice("elevator.doorA", EL.doorA); slice("elevator.doorB", EL.doorB); slice("elevator.car", EL.car)

spr:saveAs(root.."/art/office/floor.aseprite")
print("wrote floor.aseprite")
