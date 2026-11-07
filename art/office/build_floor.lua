-- S1v2 floor plate, 3/4 top-down camera (above + behind, ~45deg): art/office/floor.aseprite,
-- 640x360 INDEXED (P0), hand-placed shapes only.
-- F4 layout (docs/PLAN_FLOOR_RELAYOUT_F4.md): per team, a small glass Buddy office in the outer top
-- corner; a row of 5 PC-98 cubicles (low beige partitions, chunky beige CRTs) along the windows; one
-- open bench of two short staggered rows (3 + 3) with the lead's U-desk at its head; a wall-mounted
-- PC-98 system-monitor CRT (the stats TV) by the lift. Every seat faces the same way (back to the camera).
-- The back wall is foreshortened (cut top cap 0..3, face 4..95); the carpet runs 96..331, so desks,
-- keyboards and CRT tops are seen from above. Floor slab + the floor below's ceiling from 332.
-- Layers (bottom->top): bg (sky through the windows), building, furniture, signs, light, front.
-- "front" = the overlay that must cover sprites (glass office fronts, lead U-desk lip, lift car front +
-- door jambs); it is also part of the plate, and export_floor.lua writes it on its own as floor-front-*.png.
-- Anchor slices: teamA/teamB.{lead,buddyOffice,desk0..10,lobby,statsTv}, elevator.{doorA,doorB,car}.
-- desk0..2 = bench row 1, desk3..5 = bench row 2, desk6..10 = cubicles. statsTv = the CRT glass rect.
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

-- ======================= anchors (Team A; Team B mirrored) =======================
local CUBE0, CUBEP = 76, 41     -- cubicle cells: x = CUBE0 + i*CUBEP, partition rails 4 wide at each cell edge
local A = {
  buddyOffice = {22, 120, 32, 32},
  lead        = {34, 196, 32, 32},
  bench1 = { {96,184,32,32}, {144,184,32,32}, {192,184,32,32} },
  bench2 = { {120,232,32,32}, {168,232,32,32}, {216,232,32,32} },   -- staggered half a seat
  cubes = {},
  lobby       = {212, 272, 72, 32},
  statsTv     = {240, 26, 40, 28},                                  -- CRT glass (the UI draws the blips)
}
for i=0,4 do A.cubes[#A.cubes+1] = {CUBE0 + i*CUBEP + 5, 112, 32, 32} end
A.desks = {}
for _, k in ipairs({"bench1", "bench2", "cubes"}) do for _, d in ipairs(A[k]) do A.desks[#A.desks+1] = d end end
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
                   {268,8,52},{14,9,50},{24,12,44},{37,8,56},{46,13,48},
                   {617,9,50},{604,12,44},{595,8,56},{581,13,48},
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
  -- windows (sky shows through): the bullpen run (stops short of the stats TV) + the corner office's own
  local function window(wx0, wx1, w0, mull)
    c.rect(wx0, w0, wx1-wx0+1, WIN1-w0+1, L.INK)
    c.rect(wx0+1, w0+1, wx1-wx0-1, WIN1-w0-1, L.MARBLE)
    c.hline(wx0+1, WIN1-1, wx1-wx0-1, L.LINE); c.vline(wx1-1, w0+1, WIN1-w0-1, L.LINE)
    c.rect(wx0+3, w0+3, wx1-wx0-5, WIN1-w0-5, L.INK)
    for x=wx0+4, wx1-4 do for y=w0+4, WIN1-3 do c.px(x, y, 0) end end
    for _, mxx in ipairs(mull) do
      c.vline(mxx-1, w0+3, WIN1-w0-4, L.INK); c.vline(mxx, w0+3, WIN1-w0-4, L.MARBLE)
      c.vline(mxx+1, w0+3, WIN1-w0-4, L.INK)
    end
    -- window sill: a ledge seen from above
    c.rect(wx0-2, WIN1+1, wx1-wx0+5, 2, L.MARBLE); c.hline(wx0-2, WIN1+3, wx1-wx0+5, L.INK)
  end
  window(76, 230, WIN0, {115, 153, 192})
  window(9, 63, 18, {36})
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
  -- IDEA LAB corner office floor: PHI tiles, foreshortened LINE grid (6 wide x 4 deep)
  c.rect(4, FLOOR0, 66, 61, L.PHI)
  for y=FLOOR0,FLOOR0+60 do for x=4,69 do
    if (x - 4) % 6 == 0 or (y - FLOOR0) % 4 == 0 then c.px(x, y, L.LINE) end
  end end
  -- pilaster between the booth and the window
  c.rect(68, 4, 6, 91, L.MARBLE); c.vline(68, 4, 91, L.INK); c.vline(73, 4, 91, L.LINE); c.vline(74, 4, 91, L.INK)
  for y=10,90,12 do c.hline(69, y, 4, L.LINE) end
  -- outer building wall: cut top seen from above, full height
  c.rect(0, 0, 3, H, L.INK); c.vline(1, 0, SLAB, L.MARBLE); c.vline(3, 4, SLAB-4, L.LINE)
  -- office side wall (glass seen from above: a capped rail on the floor, ends at the front kick plate)
  c.vline(70, FLOOR0, 61, L.INK); c.vline(71, FLOOR0, 61, L.MARBLE); c.vline(72, FLOOR0, 61, L.TEAL)
  c.vline(73, FLOOR0, 61, L.LINE); c.vline(74, FLOOR0, 61, L.INK)
  -- PC-98 cubicles: low beige partitions. Back panel along the windows (its fabric face toward the
  -- camera), then a capped rail at every cell edge with its end face showing at the aisle.
  local x0, x1 = CUBE0, CUBE0 + 5*CUBEP + 3
  c.hline(x0, 96, x1-x0+1, L.INK); c.hline(x0, 97, x1-x0+1, L.MARBLE)
  c.rect(x0, 98, x1-x0+1, 7, L.SKIN)
  for y=99,103,2 do for x=x0 + (y//2 % 2)*2, x1, 4 do c.px(x, y, L.CORAL) end end
  c.hline(x0, 105, x1-x0+1, L.INK)
  for i=0,5 do
    local px = CUBE0 + i*CUBEP
    c.rect(px, 96, 4, 48, L.INK)
    c.vline(px+1, 97, 37, L.MARBLE); c.vline(px+2, 97, 37, L.MARBLE)
    c.hline(px+1, 134, 2, L.INK)
    c.vline(px+1, 135, 8, L.SKIN); c.vline(px+2, 135, 8, L.CORAL)
  end
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
-- chunky beige PC-98 CRT on its flat system box, from above + behind (screen faces the sitter):
-- screen-glow lip on the far edge, box top with floppy slots, boxy rear with vents. x,y = top-left of the case top; 18 wide.
local function beigeCrt(c, x, y, sticker)
  c.rect(x-1, y+2, 20, 7, L.INK); c.rect(x, y+3, 18, 5, L.SKIN)                -- system box under the monitor
  c.hline(x, y+3, 18, L.MARBLE); c.hline(x, y+7, 18, L.CORAL)
  c.hline(x+1, y-2, 16, L.TEAL); c.hline(x, y-1, 18, L.INK)                    -- screen light spilling over
  c.rect(x, y, 18, 8, L.INK); c.rect(x+1, y, 16, 7, L.SKIN)
  c.hline(x+1, y, 16, L.MARBLE); c.vline(x+16, y+1, 6, L.CORAL)
  c.rect(x+2, y+7, 14, 9, L.INK); c.rect(x+3, y+7, 12, 8, L.SKIN)              -- boxy rear
  c.vline(x+14, y+7, 8, L.CORAL); c.hline(x+3, y+7, 12, L.MARBLE)
  for vy=y+9, y+13, 2 do c.hline(x+5, vy, 6, L.CORAL) end                      -- vents
  c.px(x-1, y+5, L.MINT)                                                        -- power LED
  if sticker then c.stamp(x+12, y+1, sticker, K) end
end
-- cubicle desk inside its partitions: narrower slab, beige CRT right of the head, a memo pinned on the back panel
local function cubeDesk(c, x, y)
  deskN = deskN + 1
  KIT.slab(c, x, y+2, 32, 11, L.AMBER, L.CORAL, 3)
  KIT.keys(c, x+5, y+7)
  c.stamp(x+1, y+3, CLUTTER[(deskN*3-1) % #CLUTTER + 1], K)
  beigeCrt(c, x+13, y-8, STK[(deskN-1) % 3 + 1])
  local memo = ({L.MARBLE, L.AMBER, L.PINK, L.MINT})[deskN % 4 + 1]
  c.rect(x+1, y-12, 5, 4, L.INK); c.rect(x+2, y-11, 3, 2, memo); c.px(x+3, y-12, L.PINK)
  if deskN % 2 == 1 then c.rect(x+8, y-11, 3, 3, L.AMBER); c.px(x+8, y-11, L.MARBLE) end
end
-- open bench row: one long shared slab, a CRT per seat, shared clutter between seats, a tower at the far end
local function benchRow(c, row)
  local xs, xe = 1e9, -1e9
  for _, r in ipairs(row) do xs = math.min(xs, r[1]); xe = math.max(xe, r[1]) end
  local y = row[1][2]
  KIT.slab(c, xs-3, y+2, xe-xs+38, 11, L.AMBER, L.VIOLET, 3)
  for _, r in ipairs(row) do
    deskN = deskN + 1
    KIT.keys(c, r[1]+5, r[2]+7)
    KIT.crt(c, r[1]+17, r[2]-8, STK[(deskN-1) % 3 + 1])
    if deskN % 2 == 0 then c.rect(r[1]+19, r[2]-6, 3, 3, L.AMBER); c.px(r[1]+19, r[2]-6, L.MARBLE) end
    if r[1] ~= xe then c.stamp(r[1]+36, r[2]+3, CLUTTER[(deskN*3-1) % #CLUTTER + 1], K) end
  end
  c.stamp(xs-2, y+3, CLUTTER[deskN % #CLUTTER + 1], K)
  local x = xe
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
  -- office rug under the Buddy seat (seen from above; the glass front covers its near edge)
  c.rect(14, 130, 48, 14, L.VIOLET)
  for x=14,61,4 do for y=132,142,6 do c.px(x+1, y, L.AMBER); c.px(x+3, y+3, L.AMBER) end end
  c.edge(L.VIOLET, L.INK)
  -- beanbag in the office corner
  c.ellipse(12, 124, 6, 4, L.INK); c.ellipse(12, 124, 5, 3, L.PINK); c.ellipse(11, 123, 2, 1, L.CORAL)

  -- water cooler in the break nook
  c.stamp(56, 290, [[
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
  -- potted plant by the lobby mat
  for _, px in ipairs({196}) do
    c.stamp(px, 290, [[
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
  -- break nook below the lead's desk: pink couch (back + arms + cushions from above), coffee table
  c.stamp(10, 250, [[
|.kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk.|
|kppppppppppppppppppppppppppppppppppppppppk|
|kpccccccccccccccccccccccccccccccccccccccpk|
|kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk|
|kppkmmccccccccccccckcccccccccccccccccckppk|
|kppkmccccccccccccccckccccccccccccccccckppk|
|kppkccccccccccccccccckcccccccccccccccckppk|
|kppkccccccccccccccccckcccccccccccccccckppk|
|kppkccccccccccccccccckcccccccccccccccckppk|
|kppkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkppk|
|kppkppppppppppppppppppppppppppppppppppkppk|
|kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk|
|.kk..................................kk...|
]], K)
  c.ellipse(31, 258, 5, 3, L.INK); c.ellipse(31, 258, 4, 2, L.AMBER) -- throw cushion
  c.ellipse(35, 285, 15, 6, L.INK); c.ellipse(35, 285, 14, 5, L.TEAL); c.hline(24, 282, 18, L.MARBLE)
  c.rect(28, 283, 7, 4, L.MARBLE); c.hline(29, 284, 5, L.LINE); c.hline(29, 285, 4, L.LINE) -- magazine
  c.stamp(39, 282, "|.kkk.|\n|kmpmk|\n|.kkk.|", K)                                                 -- mug
  c.vline(35, 291, 3, L.INK); c.hline(32, 293, 7, L.INK)
  -- arcade cabinet against the outer wall: screen faces the camera, marquee + top face
  c.stamp(4, 160, [[
|.kkkkkkkkkkkk.|
|kmmmmmmmmmmmmk|
|kkkkkkkkkkkkkk|
|kppppppppppppk|
|kpkkkkkkkkkkpk|
|kpkyyyyyyyykpk|
|kpkytyygyyykpk|
|kpkyyyyyyyykpk|
|kpkyyyayyyykpk|
|kpkyyyyyypykpk|
|kpkkkkkkkkkkpk|
|kkkkkkkkkkkkkk|
|kvvvvkvvkvvvvk|
|kvvvkakvvkpkvk|
|kvvvvkvvvvvvvk|
|kkkkkkkkkkkkkk|
|kpppppppppppkk|
|kpppvvvvpppppk|
|kpppvavvpppppk|
|kpppvvvvpppppk|
|kpppppppppppkk|
|kppppppppppppk|
|kkkkkkkkkkkkkk|
]], K)
  -- floor lamp by the couch
  c.ellipse(60, 252, 5, 3, L.INK); c.ellipse(60, 252, 4, 2, L.AMBER); c.hline(57, 251, 6, L.MARBLE)
  c.vline(60, 255, 12, L.INK); c.hline(57, 267, 7, L.INK)
  -- office: a little potted fern in the back corner
  c.stamp(5, 99, [[
|..kk.kk...|
|.kggkggk..|
|kgggggggk.|
|.kgkggkgk.|
|..kpppk...|
|.kpaaapk..|
|.kpppppk..|
|..kkkkk...|
]], K)
  -- lobby mat under the queue (feet line = lobby bottom), arrow to the door
  c.rect(212, 296, 72, 10, L.PINK); c.edge(L.PINK, L.INK)
  c.stamp(266, 299, "|...a...|\n|aaaaa..|\n|...a...|", K)
  mirror(c)

  -- desks for both teams (not mirrored, so every CRT sits right of the head like the sprites)
  for _, m in ipairs({ function(r) return r end, mirR }) do
    local r = m(A.buddyOffice); deskAt(c, r[1], r[2])
    r = m(A.lead); leadDesk(c, r[1], r[2])
    for _, k in ipairs({"bench1", "bench2"}) do
      local row = {}
      for _, d in ipairs(A[k]) do row[#row+1] = m(d) end
      benchRow(c, row)
    end
    for _, d in ipairs(A.cubes) do r = m(d); cubeDesk(c, r[1], r[2]) end
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
  -- corner office: IDEA LAB plate over its window, OUT light hung on the glass
  for _, x in ipairs({9, W-9-36}) do
    L.plate(c, x, 6, 36, 9, L.VIOLET, L.MARBLE, L.LINE)
    L.text(c, x+3, 8, "IDEA LAB", L.MARBLE)
  end
  for _, x in ipairs({48, W-48-17}) do
    L.plate(c, x, 7, 17, 7, L.MINT, L.MARBLE, L.LINE)
    L.text(c, x+3, 8, "OUT", L.INK)
  end
  -- stats TV: a PC-98 system-monitor CRT bolted to the back wall by the lift. Beige case with its top face
  -- showing (3/4 camera), bevelled bezel, flat dark glass (the UI draws the blips + idle scanline on it),
  -- a chin with knobs + power LED, and the cable dropping to the baseboard.
  local function statsTv(g)
    local gx, gy = g[1], g[2]
    c.rect(gx+1, gy-8, 38, 5, L.INK); c.rect(gx+2, gy-7, 36, 3, L.SKIN); c.hline(gx+2, gy-7, 36, L.MARBLE)
    for vx=gx+8, gx+30, 4 do c.hline(vx, gy-6, 2, L.CORAL) end
    L.plate(c, gx-4, gy-4, 48, 40, L.SKIN, L.MARBLE, L.CORAL)
    c.rect(gx-1, gy-1, 42, 30, L.LINE)                                -- recess lip
    c.rect(gx, gy, 40, 28, L.INK)                                     -- glass: INK stays dark in both palettes
    c.px(gx-1, gy-1, L.INK); c.px(gx+40, gy-1, L.INK); c.px(gx-1, gy+28, L.INK); c.px(gx+40, gy+28, L.INK)
    c.hline(gx-3, gy+30, 46, L.CORAL)
    for i=0,2 do c.rect(gx+1+i*5, gy+32, 3, 2, L.LINE); c.px(gx+2+i*5, gy+32, L.MARBLE) end
    c.hline(gx+22, gy+32, 8, L.INK); c.hline(gx+22, gy+33, 8, L.CORAL)
    c.px(gx+36, gy+32, L.MINT); c.px(gx+37, gy+32, L.MINT)
    c.vline(gx+34, gy+36, 4, L.INK)
    for y=gy+40, 88 do c.px(gx+34 + ((y//3) % 2), y, L.INK) end
  end
  statsTv(A.statsTv)
  statsTv(mirR(A.statsTv))
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
  poster(84, 72, "GO!", L.PINK)
  poster(W-84-22, 72, "WOW", L.TEAL)
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
  -- Buddy corner office glass front (door gap on the bullpen side), kick plate hides the chair casters
  KIT.glassFront(c, 4, 58, A.buddyOffice[2] + A.buddyOffice[4] - 11, {5, 31, 57})
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
      if d < 1 and y >= FLOOR0+1 and y <= FLOOR1 and (x > 74 and x < 288 or x > 351 and x < W-75) and free(x, y) then
        if (L.BAYER[y%4+1][x%4+1] + 0.5) < maxT*(1-d)*16 then c.px(x, y, col) end
      end
    end end
  end
  -- warm sunset spill on the carpet under the window, soft pools around the desk rows
  L.twinkle(c, 118, 300, L.PINK, L.MARBLE, 1)
  L.twinkle(c, 186, 282, L.AMBER, L.MARBLE, 1)
  mirror(c)
  -- pools per side (not mirrored: the desks are not mirrored, so free() must test each side's own furniture)
  for _, m in ipairs({ function(x) return x end, function(x) return W-1-x end }) do
    for _, cx in ipairs({126, 196}) do pool(m(cx), 150, 56, 10, L.CORAL, 0.3) end
    for _, lx in ipairs({140, 205}) do pool(m(lx), 224, 40, 44, L.PHI, 0.45) end
  end
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
  slice(p.."lobby", m(A.lobby)); slice(p.."statsTv", m(A.statsTv))
end
slice("elevator.doorA", EL.doorA); slice("elevator.doorB", EL.doorB); slice("elevator.car", EL.car)

spr:saveAs(root.."/art/office/floor.aseprite")
print("wrote floor.aseprite")
