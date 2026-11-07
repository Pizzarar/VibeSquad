-- S1 floor plate: art/office/floor.aseprite, 640x360 INDEXED (P0), hand-placed shapes only.
-- v3 layout: [Buddy booth | lead desk | Team A x6] [slim marble lift core] [Team B x6 | lead | Buddy]
-- Layers (bottom->top): bg (sky through the windows), building, furniture, signs, light.
-- No characters. Anchor slices: teamA/teamB.{lead,buddyOffice,desk0..5,lobby}, elevator.{doorA,doorB,car}.
-- Index 0 is never painted (the plate is fully opaque).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/build_floor.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local W, H = 640, 360
local K = { k=15, v=8, p=9, c=10, a=11, s=14, m=4, t=7, g=12, y=13, l=3, h=2, n=1 }

-- vertical bands
local WIN0, WIN1 = 22, 105      -- window frame
local WALL1 = 149               -- last wall row (baseboard bottom)
local FLOOR0, FLOOR1 = 150, 331 -- carpet
local SLAB = 332                -- floor slab cut-away, then the ceiling of the floor below

local spr = L.new(W, H, pal)
local f1 = spr.frames[1]
local C = {}
for _, n in ipairs({ "bg", "building", "furniture", "signs", "light" }) do C[n] = L.canvas(spr, L.layer(spr, n), f1) end

-- mirror the left room (x < 288) onto the right room
local function mirror(c)
  for y=0,H-1 do for x=0,287 do
    local v = c.get(x, y)
    if v ~= 0 then c.px(W-1-x, y, v) end
  end end
end
local function mx(x, w) return W - x - (w or 1) end
local function mirR(r) return { mx(r[1], r[3]), r[2], r[3], r[4] } end

-- ======================= anchors (Team A; Team B mirrored) =======================
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
  for y=14,WALL1 do
    local t = math.max(0, math.min(0.999, (y-26)/78)) * 4
    local s = math.floor(t)
    for x=0,W-1 do c.px(x, y, L.dith(x, y, ramp[s+1], ramp[math.min(s+2, 5)], t - s)) end
  end
  for _, p in ipairs({{88,30},{103,43},{140,29},{161,38},{247,31},{266,46},{378,29},{396,42},
                      {470,33},{512,27},{540,40},{556,30},{212,35},{120,50},{500,62},{85,58},{555,56}}) do
    c.px(p[1], p[2], L.MARBLE)
  end
  L.twinkle(c, 118, 33, L.MARBLE, L.MARBLE, 2)
  L.twinkle(c, 530, 35, L.MARBLE, L.MARBLE, 2)
  -- vaporwave sun, striped (team A side)
  local sx, sy, sr = 196, 104, 30
  for y=sy-sr, sy do
    local gap = y > sy-16 and (sy - y) % 5 == 1
    if not gap then
      local hw = math.floor(math.sqrt(sr*sr - (y-sy)^2))
      for x=sx-hw, sx+hw do c.px(x, y, L.dith(x, y, L.AMBER, L.CORAL, (y-(sy-sr))/sr)) end
    end
  end
  -- skyline: INK blocks with AMBER windows {x, w, top}
  local blocks = { {79,12,82},{92,8,74},{101,14,86},{116,9,70},{126,16,80},{143,10,88},
                   {154,13,76},{168,6,92},{218,8,92},{227,14,78},{242,9,84},{252,15,72},
                   {268,8,82},
                   {363,10,84},{374,14,72},{389,8,80},{398,16,88},{415,9,75},{425,13,82},
                   {439,7,92},{447,15,70},{463,10,86},{474,12,78},{487,8,90},{496,14,74},
                   {511,10,83},{522,15,76},{538,8,88},{547,12,72} }
  for i, b in ipairs(blocks) do
    c.rect(b[1], b[3], b[2], 106-b[3], L.INK)
    for wy=b[3]+3, 102, 4 do for wx=b[1]+2, b[1]+b[2]-3, 3 do
      if (wx*7 + wy*3 + i) % 5 < 2 then c.px(wx, wy, L.AMBER) end
    end end
  end
  c.vline(122, 60, 10, L.INK); c.px(122, 59, L.PINK)
  c.vline(452, 58, 12, L.INK); c.px(452, 57, L.PINK)
  -- team B sky: a goofy blimp
  c.stamp(470, 42, [[
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
  L.text(c, 476, 45, "GOO", L.PINK)
  L.text(c, 490, 45, "TV", L.VIOLET)
  c.commit()
end

-- ======================= building: ceiling, wall, windows, floor =======================
do
  local c = C.building
  -- ceiling y 0..13: tiles
  c.rect(0, 0, W, 13, L.PANEL)
  for x=0,W-1,20 do c.vline(x, 0, 13, L.LINE) end
  c.hline(0, 6, W, L.LINE)
  c.hline(0, 13, W, L.INK)
  -- back wall
  c.rect(0, 14, 288, WALL1-13, L.PHI)
  -- wallpaper y 108..143: squiggle + plus tile, offset rows
  local TILE = { "........", ".v......", "v.v.....", "...v....", "........", ".....l..", "....lll.", ".....l.." }
  for y=108,143 do for x=0,287 do
    local ty, tx = (y-108) % 8, (x + ((y-108)//8 % 2)*4) % 8
    local ch = TILE[ty+1]:sub(tx+1, tx+1)
    if ch ~= "." then c.px(x, y, K[ch]) end
  end end
  -- chair rail + baseboard
  c.hline(0, 106, 288, L.MARBLE); c.hline(0, 107, 288, L.LINE)
  c.hline(0, 144, 288, L.INK); c.rect(0, 145, 288, 4, L.LINE); c.hline(0, 145, 288, L.MARBLE)
  c.hline(0, WALL1, 288, L.INK)
  -- window (sky shows through): frame 76..276
  local wx0, wx1 = 76, 276
  c.rect(wx0, WIN0, wx1-wx0+1, WIN1-WIN0+1, L.INK)
  c.rect(wx0+1, WIN0+1, wx1-wx0-1, WIN1-WIN0-1, L.MARBLE)
  c.hline(wx0+1, WIN1-1, wx1-wx0-1, L.LINE); c.vline(wx1-1, WIN0+1, WIN1-WIN0-1, L.LINE)
  c.rect(wx0+3, WIN0+3, wx1-wx0-5, WIN1-WIN0-6, L.INK)
  for x=wx0+4, wx1-4 do for y=WIN0+4, WIN1-4 do c.px(x, y, 0) end end
  for _, mxx in ipairs({126, 175, 224}) do
    c.vline(mxx-1, WIN0+3, WIN1-WIN0-5, L.INK); c.vline(mxx, WIN0+3, WIN1-WIN0-5, L.MARBLE)
    c.vline(mxx+1, WIN0+3, WIN1-WIN0-5, L.INK)
  end
  -- carpet: PANEL with a dotted LINE diamond lattice
  c.rect(0, FLOOR0, 288, FLOOR1-FLOOR0+1, L.PANEL)
  for y=FLOOR0,FLOOR1 do for x=0,287 do
    if ((x + y) % 16 == 0 or (x - y) % 16 == 0) and (x % 2 == 0) then c.px(x, y, L.LINE) end
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
  -- IDEA LAB booth floor: PHI tiles with a LINE grid (distinct from the carpet)
  c.rect(9, FLOOR0, 54, 154, L.PHI)
  for y=FLOOR0,FLOOR0+153 do for x=9,62 do
    if (x - 9) % 6 == 0 or (y - FLOOR0) % 6 == 0 then c.px(x, y, L.LINE) end
  end end
  -- pilaster between the upper-wall flank and the window
  c.rect(68, 14, 6, 92, L.MARBLE); c.vline(68, 14, 92, L.INK); c.vline(73, 14, 92, L.LINE); c.vline(74, 14, 92, L.INK)
  for y=20,100,12 do c.hline(69, y, 4, L.LINE) end
  -- outer building edge
  c.rect(0, 0, 3, H, L.INK); c.vline(3, 14, SLAB-14, L.LINE)
  mirror(c)

  -- elevator core x 288..351 (marble column, glass shaft)
  c.rect(288, 0, 64, H, L.MARBLE)
  c.vline(288, 0, H, L.INK); c.vline(351, 0, H, L.INK)
  c.vline(289, 0, H, L.LINE); c.vline(350, 0, H, L.LINE)
  for _, v in ipairs({{292,40,1},{347,90,-1},{293,160,1},{346,214,-1},{292,318,1}}) do
    for i=0,9 do if i % 3 ~= 2 then c.px(v[1] + (v[3] > 0 and i//3 or -(i//3)), v[2]+i, L.LINE) end end
  end
  -- shaft window 300..339
  c.rect(299, 14, 42, 292, L.INK)
  for y=15,304 do for x=300,339 do c.px(x, y, L.dith(x, y, L.SKY, L.VIOLET, math.max(0, (y-210)/120))) end end
  c.vline(314, 15, 243, L.INK); c.vline(325, 15, 243, L.INK)
  c.vline(303, 15, 241, L.LINE); c.vline(336, 15, 241, L.LINE)
  c.rect(332, 130, 6, 16, L.INK); c.rect(333, 131, 4, 14, L.LINE)
  -- slab + floor-below under the core
  c.hline(288, SLAB, 64, L.INK); c.hline(288, SLAB+1, 64, L.MARBLE)
  c.rect(288, SLAB+2, 64, 9, L.LINE); c.hline(288, SLAB+11, 64, L.INK)
  c.vline(288, SLAB, H-SLAB, L.INK); c.vline(351, SLAB, H-SLAB, L.INK)
  c.commit()
end

-- ======================= furniture =======================
local deskMap -- the H0 desk, mirrored (CRT right of the head), cell-relative
do
  local P = dofile(root.."/art/cast/hypno/floor.lua")
  local rows = {}
  for row in P.desk[1][3]:gmatch("[^\n]+") do rows[#rows+1] = row:gsub("^%s*|", ""):gsub("|%s*$", ""):reverse() end
  deskMap = { y = P.desk[1][2], art = "|"..table.concat(rows, "|\n|").."|" }
end

-- desk clutter (sits on the desktop, left of the head) and CRT screen variants
local CLUTTER = {
  "|kkkk.|\n|kmmkk|\n|kppkk|\n|kmmk.|\n|kkkk.|",          -- mug
  "|kkkkkk|\n|kttttk|\n|kkkkkk|\n|kvvvvk|\n|kkkkkk|",     -- floppy stack
  "|.kgk.|\n|kgggk|\n|.kgk.|\n|kpppk|\n|kkkkk|",          -- cactus
  "|kkkkk.|\n|kmmmkk|\n|kmlmmk|\n|kmmmmk|\n|kkkkkk|",      -- paper pile
  "|.kk..|\n|kaak.|\n|kaakk|\n|kaak.|\n|kkkk.|",          -- coffee can
}
local SCREEN = {
  "|vvvvvv|\n|tttttt|\n|tmmmtt|\n|tttttt|\n|tmmtmt|\n|tttttt|", -- win title bar + text
  "|tttttt|\n|tgttgt|\n|tttttt|\n|gttttg|\n|tggggt|\n|tttttt|", -- smiley
  "|tttttt|\n|ttttgt|\n|ttgtgt|\n|tggtgt|\n|tggggt|\n|kkkkkk|", -- bar graph
  "|tmtttt|\n|tttttm|\n|ttmttt|\n|tttttt|\n|mtttmt|\n|tttttt|", -- starfield
}
local deskN = 0
local function deskAt(c, x, y, lead)
  deskN = deskN + 1
  if lead then
    -- exec desk: long top, violet pedestals with bevels
    c.rect(x-9, y+15, 50, 3, L.AMBER); c.hline(x-9, y+15, 29, L.INK)
    c.rect(x-9, y+18, 50, 4, L.AMBER); c.hline(x-9, y+18, 50, L.INK); c.hline(x-9, y+20, 50, L.CORAL)
    c.hline(x-9, y+21, 50, L.INK); c.vline(x-10, y+15, 7, L.INK); c.vline(x+41, y+15, 7, L.INK)
    L.plate(c, x-9, y+22, 50, 9, L.VIOLET, L.MARBLE, L.INK)
    for _, px0 in ipairs({x-7, x+33}) do
      c.hline(px0, y+25, 6, L.INK); c.hline(px0, y+28, 6, L.INK); c.px(px0+2, y+24, L.AMBER); c.px(px0+2, y+27, L.AMBER)
    end
    -- gold trophy on the desktop
    c.stamp(x-6, y+8, "|kkkkk|\n|kaaak|\n|kaaak|\n|.kak.|\n|..k..|\n|.kkk.|\n|kaaak|", K)
  else
    -- desktop (depth band) + front edge + bevelled modesty panel with drawers
    c.rect(x-3, y+15, 38, 3, L.AMBER); c.hline(x-3, y+15, 23, L.INK)
    c.vline(x-4, y+15, 7, L.INK); c.vline(x+35, y+15, 7, L.INK)
    c.hline(x-3, y+18, 38, L.INK); c.hline(x-3, y+19, 38, L.AMBER); c.hline(x-3, y+20, 38, L.CORAL)
    c.hline(x-3, y+21, 38, L.INK)
    L.plate(c, x-3, y+22, 38, 8, L.LINE, L.MARBLE, L.INK)
    c.hline(x-2, y+25, 7, L.INK); c.px(x+1, y+24, L.MARBLE); c.px(x+1, y+27, L.MARBLE)
    c.vline(x+5, y+22, 8, L.INK)
    -- beige tower PC beside the desk
    c.stamp(x+36, y+13, [[
|kkkkkk.|
|kmmmmlk|
|kmkkmlk|
|kmmmmlk|
|kmllmlk|
|kmmmmlk|
|kmmmmlk|
|kmmmmlk|
|kmmmmlk|
|kmmmmlk|
|kgmmmlk|
|kmmmmlk|
|kmmmmlk|
|kmmmmlk|
|kmmmmlk|
|kmmmmlk|
|kmmmmlk|
|kkkkkkk|
]], K)
  end
  c.stamp(x, y + deskMap.y, deskMap.art)
  c.stamp(x+23, y+10, SCREEN[(deskN-1) % #SCREEN + 1], K)
  c.stamp(x+1, y+11, CLUTTER[(deskN*3-1) % #CLUTTER + 1], K)
  -- sticky note on the CRT bezel (every other desk)
  if deskN % 2 == 0 then c.rect(x+19, y+8, 3, 3, L.AMBER); c.px(x+19, y+8, L.MARBLE) end
end

do
  local c = C.furniture
  -- Buddy glass booth x 4..67 (open front: beam, posts, base); whiteboard of doodles inside
  L.plate(c, 5, 110, 62, 8, L.TEAL, L.MARBLE, L.LINE)
  for _, px0 in ipairs({5, 63}) do
    c.rect(px0, 119, 4, 185, L.MARBLE); c.vline(px0+3, 119, 185, L.LINE)
    c.vline(px0-1, 119, 185, L.INK); c.vline(px0+4, 119, 185, L.INK)
  end
  L.plate(c, 5, 304, 62, 6, L.TEAL, L.MARBLE, L.LINE)
  c.hline(9, 118, 54, L.INK)
  L.plate(c, 14, 124, 44, 22, L.MARBLE, L.MARBLE, L.LINE)
  c.stamp(16, 126, [[
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
  -- booth rug under the Buddy seat
  c.rect(12, 292, 48, 10, L.VIOLET)
  for x=12,59,4 do c.px(x+1, 293, L.AMBER); c.px(x+3, 294, L.AMBER); c.px(x+1, 299, L.AMBER); c.px(x+3, 300, L.AMBER) end
  c.edge(L.VIOLET, L.INK)

  -- water cooler against the wall (solid cabinet, no legs, so it never reads as a person)
  c.stamp(96, 132, [[
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
|..kkkkkkkkkk..|
]], K)
  -- filing cabinet + fax, against the wall by the lift
  L.plate(c, 259, 122, 22, 30, L.LINE, L.MARBLE, L.INK)
  for _, dy in ipairs({129, 138, 147}) do c.hline(261, dy, 18, L.INK); c.rect(268, dy-4, 4, 2, L.MARBLE) end
  c.stamp(258, 110, [[
|...kkkkkkkk.......|
|...kmmmmmmk.......|
|..kkkkkkkkkkkkkk..|
|.kaaaaaaaaaaaaaak.|
|.kaakkkkkaagapak..|
|.kaakyyykaaaaaak..|
|.kaakkkkkakakakk..|
|.kaaaaaaaaaaaaaak.|
|..kkkkkkkkkkkkkk..|
|...kmmmmmmk.......|
|...kmmmmmmk.......|
|....kmmmmk........|
]], K)
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
|..............kcck................|
|..............kcck................|
|.............kcck.................|
|.............kcck.................|
|.............kcck.................|
|..........kkkkkkkkkkk.............|
|..........kpppppppppk.............|
|..........kpaaaaaaapk.............|
|..........kpppppppppk.............|
|...........kpppppppk..............|
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
|.......kmmmmmk........|
|....kkkmmmmmmmkkk.....|
|..kkmmmmmmmmmmmmmkk...|
|.kmmmmmmmmmmmmmmmmmk..|
|.kmmmmmlmmmmmmlmmmmk..|
|.kkkkkkkkkkkkkkkkkkk..|
|....kkkkkkkkkkkkk.....|
|....kmmmmmmmmmmmk.....|
|.....kmlmmmmmmmk......|
|.....kmlmmmmmmmk......|
|.....kmlmmmmmmmk......|
|.....kmlmmmmmmmk......|
|.....kmlmmmmmmmk......|
|.....kmlmmmmmmmk......|
|.....kmlmmmmmmmk......|
|.....kmlmmmmmmmk......|
|.....kmlmmmmmmmk......|
|....kkkkkkkkkkkkk.....|
|....kmmmmmmmmmmmk.....|
|...kkkkkkkkkkkkkkk....|
]], K)
  -- lobby mat under the queue (feet line = lobby bottom), arrow to the door
  c.rect(212, 300, 72, 7, L.PINK); c.edge(L.PINK, L.INK)
  c.stamp(266, 301, [[
|...a...|
|aaaaa..|
|...a...|
]], K)
  -- ceiling strip lights
  for _, lx in ipairs({30, 110, 190, 250}) do
    c.rect(lx, 3, 26, 6, L.INK); c.rect(lx+1, 4, 24, 4, L.MARBLE); c.hline(lx+1, 7, 24, L.LINE)
  end
  mirror(c)

  -- desks for both teams (not mirrored, so every CRT sits right of the head like the sprites)
  for _, m in ipairs({ function(r) return r end, mirR }) do
    local r = m(A.buddyOffice); deskAt(c, r[1], r[2])
    r = m(A.lead); deskAt(c, r[1], r[2], true)
    for _, d in ipairs(A.desks) do r = m(d); deskAt(c, r[1], r[2]) end
  end

  -- lift car + doors + call panels
  local cx, cy = 302, EL.car[2] - 12
  c.rect(cx, cy, 36, 46, L.INK)
  c.rect(cx+1, cy+1, 34, 44, L.PHI)
  c.rect(cx+1, cy+1, 34, 3, L.LINE); c.hline(cx+10, cy+2, 16, L.AMBER)
  c.hline(cx+1, cy+30, 34, L.MARBLE); c.hline(cx+1, cy+31, 34, L.LINE) -- handrail
  c.rect(cx+1, cy+42, 34, 3, L.LINE); c.hline(cx+1, cy+42, 34, L.INK)
  for _, sx in ipairs({cx+9, cx+18, cx+27}) do c.vline(sx, cy+4, 26, L.LINE) end
  c.rect(cx+29, cy+10, 5, 14, L.INK)
  for by=cy+12, cy+21, 3 do c.px(cx+31, by, L.AMBER) end
  c.px(cx+31, cy+22, L.PINK)
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
  -- 2x bold sign lettering (3x5 font doubled, 1px CORAL drop shadow)
  local function textBig(x, y, s, col, sh)
    for n=1,#s do
      local g = L.F[s:sub(n,n)] or L.F[" "]
      for r=0,4 do for q=0,2 do
        if g:sub(r*3+q+1, r*3+q+1) == "1" then
          local px0, py0 = x + (n-1)*8 + q*2, y + r*2
          if sh then c.rect(px0+1, py0+1, 2, 2, sh) end
        end
      end end
      for r=0,4 do for q=0,2 do
        if g:sub(r*3+q+1, r*3+q+1) == "1" then c.rect(x + (n-1)*8 + q*2, y + r*2, 2, 2, col) end
      end end
    end
  end
  local function hanging(cx, label, face)
    local w = #label*8 - 2 + 12
    local x = cx - w//2
    c.vline(x+5, 13, 4, L.INK); c.vline(x+w-6, 13, 4, L.INK)
    L.plate(c, x, 17, w, 17, face, L.MARBLE, L.CORAL)
    c.hline(x+2, 19, w-4, L.PINK); c.hline(x+2, 31, w-4, L.PINK)
    textBig(x+6, 21, label, L.INK, L.CORAL)
    L.twinkle(c, x - 4, 20, L.MARBLE, L.MARBLE, 2)
    L.twinkle(c, x + w + 3, 29, L.AMBER, L.MARBLE, 1)
  end
  hanging(176, "VIBESQUAD", L.AMBER)
  hanging(W-176, "HYPERDESK", L.AMBER)
  -- upper-wall flanks: a Win95 "window" pinned to the wall with a clip-art rainbow
  local function wallWin(x, y, label)
    L.plate(c, x, y, 52, 40, L.MARBLE, L.MARBLE, L.LINE)
    c.rect(x+2, y+2, 48, 7, L.VIOLET)
    L.text(c, x+4, y+3, label, L.MARBLE)
    c.rect(x+43, y+3, 5, 5, L.MARBLE); c.px(x+44, y+4, L.INK); c.px(x+46, y+6, L.INK); c.px(x+46, y+4, L.INK); c.px(x+44, y+6, L.INK); c.px(x+45, y+5, L.INK)
    c.rect(x+3, y+11, 46, 26, L.SKY)
    for i, col in ipairs({L.PINK, L.CORAL, L.AMBER, L.MINT, L.TEAL, L.VIOLET}) do
      local r = 20 - i*2
      for a=0,180,2 do
        local px0 = x + 26 + math.floor(r*math.cos(math.rad(a)) + 0.5)
        local py0 = y + 34 - math.floor(r*math.sin(math.rad(a))*0.9 + 0.5)
        c.px(px0, py0, col); c.px(px0, py0+1, col)
      end
    end
    c.ellipse(x+9, y+33, 5, 3, L.MARBLE); c.ellipse(x+43, y+33, 5, 3, L.MARBLE)
  end
  wallWin(10, 42, "NICE.BMP")
  wallWin(W-10-52, 42, "COOL.BMP")
  -- exit-ish sign over the booth: "OUT" with an arrow (invented)
  for _, x in ipairs({22, W-22-26}) do
    L.plate(c, x, 22, 26, 9, L.MINT, L.MARBLE, L.LINE)
    L.text(c, x+3, 24, "OUT", L.INK)
  end
  L.text(c, 21, 112, "IDEA LAB", L.INK)
  L.text(c, W-21-L.textW("IDEA LAB"), 112, "IDEA LAB", L.INK)
  -- lead crown badge on the exec desk's left pedestal, clear of the seated shoulder
  local function nameplate(x, y)
    L.plate(c, x-8, y+23, 9, 7, L.INK, L.LINE, L.INK)
    c.stamp(x-6, y+24, "|a.a.a|\n|aaaaa|\n|apapa|\n|aaaaa|", K)
  end
  nameplate(A.lead[1], A.lead[2]); local rb = mirR(A.lead); nameplate(rb[1], rb[2])
  local function poster(x, y, label, face)
    L.plate(c, x, y, 22, 26, face, L.MARBLE, L.LINE)
    c.stamp(x+6, y+3, [[
|....k....|
|...kak...|
|kkkkaakkk|
|kaaaaaaak|
|.kaaaaak.|
|.kaakaak.|
|kaak.kaak|
|kk.....kk|
]], K)
    L.text(c, x + (22 - L.textW(label))//2, y+15, label, L.INK)
  end
  poster(230, 113, "GO!", L.PINK)
  poster(W-230-22, 113, "WOW", L.TEAL)
  for _, x in ipairs({150, W-150-13}) do
    c.ellipse(x+6, 120, 6, 6, L.INK); c.ellipse(x+6, 120, 5, 5, L.MARBLE)
    c.vline(x+6, 116, 4, L.INK); c.hline(x+6, 120, 3, L.INK); c.px(x+6, 120, L.PINK)
  end
  -- lift floor indicator + LIFT plate
  c.rect(305, EL.car[2]-30, 30, 13, L.INK)
  L.text(c, 316, EL.car[2]-26, "07", L.AMBER)
  c.stamp(308, EL.car[2]-26, "|.g.|\n|ggg|", K)
  L.plate(c, 303, 18, 34, 9, L.VIOLET, L.MARBLE, L.LINE)
  L.text(c, 312, 20, "LIFT", L.MARBLE)
  -- CRT stickers (star / heart / smiley rotate per desk)
  local STK = { "|.a.|\n|aaa|\n|a.a|", "|p.p|\n|ppp|\n|.p.|", "|ggg|\n|gkg|\n|ggg|" }
  local all = { A.buddyOffice, A.lead }
  for _, d in ipairs(A.desks) do all[#all+1] = d end
  for i, d in ipairs(all) do
    c.stamp(d[1]+28, d[2]+8, STK[(i-1) % 3 + 1], K)
    local r = mirR(d); c.stamp(r[1]+28, r[2]+8, STK[i % 3 + 1], K)
  end
  c.commit()
end

-- ======================= light: dither pools, glass glints, sparkles =======================
do
  local c = C.light
  local fur, sig = C.furniture, C.signs
  local function free(x, y) return fur.get(x, y) == 0 and sig.get(x, y) == 0 end
  local function pool(cx, cy, rx, ry, col, maxT)
    for y=cy-ry, cy+ry do for x=cx-rx, cx+rx do
      local d = math.sqrt(((x-cx)/rx)^2 + ((y-cy)/ry)^2)
      if d < 1 and y >= FLOOR0+2 and y <= FLOOR1 and x < 288 and free(x, y) then
        if (L.BAYER[y%4+1][x%4+1] + 0.5) < maxT*(1-d)*16 then c.px(x, y, col) end
      end
    end end
  end
  -- warm sunset spill under the window, soft pools under the strip lights
  for _, cx in ipairs({126, 226}) do pool(cx, FLOOR0+4, 64, 10, L.CORAL, 0.5) end
  for _, lx in ipairs({123, 203, 263}) do pool(lx, 228, 28, 64, L.PHI, 0.5) end
  -- booth glass glints
  for _, g in ipairs({{12,200,22},{22,170,12},{50,240,10}}) do
    for i=0,g[3]-1 do c.px(g[1]+i, g[2]-i, L.MARBLE); if i % 4 ~= 3 then c.px(g[1]+i+2, g[2]-i, L.MARBLE) end end
  end
  L.twinkle(c, 58, 152, L.MARBLE, L.MARBLE, 2)
  L.twinkle(c, 110, 300, L.PINK, L.MARBLE, 1)
  L.twinkle(c, 180, 288, L.AMBER, L.MARBLE, 1)
  mirror(c)
  -- glass shaft glints + core sparkles
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
