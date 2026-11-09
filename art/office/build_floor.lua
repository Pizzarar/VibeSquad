-- H1d floor plate (docs/art/STYLE_BIBLE.md, owner ruling 3a): art/office/floor.aseprite, 640x332 INDEXED (P0),
-- hand-placed shapes only. Same hand as the H0 cast + the H1a gallery floor crop: chunky FRONT-VIEW furniture,
-- every object its own 1px INK outline (obj() below outlines each piece on its own, so overlaps stay
-- separated), flat fills, MARBLE shine pixels, Bayer dither only in the sunset through the windows.
-- Layout = F4 (docs/PLAN_FLOOR_RELAYOUT_F4.md), unchanged: per team a glass Buddy office in the outer top
-- corner, a row of 5 cubicles along the back wall, a bench of two staggered rows (3 + 3) with the lead's desk
-- at its head, the stats TV (wall CRT) by the lift, a break nook, the lobby mat. Every seat faces the back
-- wall (sprites sit with their backs to the camera); monitors sit right of the head like the H0 sprites.
-- Back wall 0..95 (top rail 0..3, skirting 89..95), floor 96..330, INK floor edge 331 = the plate's bottom edge
-- (HP5: no slab / floor-below strip, the hub floor sits flush on the page bottom). Lift car mid-shaft (HP5).
-- Layers (bottom->top): bg (sky through the windows), building, furniture, signs, light, front.
-- "front" = the overlay that covers sprites (Buddy office glass front, lead desk modesty panel, lift car
-- front + door jambs); also part of the plate, export_floor.lua writes it alone as floor-front-*.png.
-- Anchor slices (contract, unchanged): teamA/teamB.{lead,buddyOffice,desk0..10,lobby,statsTv},
-- elevator.{doorA,doorB,car}. desk0..2 = bench row 1, desk3..5 = bench row 2, desk6..10 = cubicles.
-- At most one googly prop per scene (ruling 2a): the VIBE poster on team A's wall.
-- Index 0 is never painted on the plate (fully opaque).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/build_floor.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local W, H = 640, 332
local K = { k=15, v=8, p=9, c=10, a=11, s=14, m=4, t=7, g=12, y=13, l=3, h=2, n=1 }
local INK, V, P, CO, A_, S_, M, T, G, Y = L.INK, L.VIOLET, L.PINK, L.CORAL, L.AMBER, L.SKIN, L.MARBLE, L.TEAL, L.MINT, L.SKY
local PANEL, PHI, LINE = L.PANEL, L.PHI, L.LINE

local FLOOR0, FLOOR1 = 96, 330
local WIN0, WIN1 = 24, 62       -- window glass rows (bullpen run); sill under it

local spr = L.new(W, H, pal)
local f1 = spr.frames[1]
local C = {}
for _, n in ipairs({ "bg", "building", "furniture", "signs", "light", "front" }) do C[n] = L.canvas(spr, L.layer(spr, n), f1) end

-- scratch canvas: obj() draws one object here, outlines it in INK (outside), then stamps it onto a layer
local tmpSpr = L.new(W, H, pal)
local T0 = L.canvas(tmpSpr, tmpSpr.layers[1], tmpSpr.frames[1])
local bb
do
  local raw = T0.px
  T0.px = function(x, y, c)
    if c and x >= 0 and y >= 0 and x < W and y < H then
      raw(x, y, c)
      bb[1] = math.min(bb[1], x); bb[2] = math.min(bb[2], y); bb[3] = math.max(bb[3], x); bb[4] = math.max(bb[4], y)
    end
  end
end
local function obj(dst, fill, detail)
  bb = { 1e9, 1e9, -1, -1 }
  fill(T0)
  if bb[3] < 0 then return end
  local add = {}
  for y=bb[2]-1, bb[4]+1 do for x=bb[1]-1, bb[3]+1 do
    if T0.get(x, y) == 0 then
      for _, d in ipairs({{-1,0},{1,0},{0,-1},{0,1}}) do
        local n = T0.get(x+d[1], y+d[2])
        if n ~= 0 and n ~= INK then add[#add+1] = {x, y}; break end
      end
    end
  end end
  for _, p in ipairs(add) do T0.px(p[1], p[2], INK) end
  if detail then detail(T0) end
  for y=bb[2], bb[4] do for x=bb[1], bb[3] do
    local v = T0.get(x, y)
    if v ~= 0 then dst.px(x, y, v); T0.img:drawPixel(x, y, 0) end
  end end
end

local function mirror(c)
  for y=0,H-1 do for x=0,287 do
    local v = c.get(x, y)
    if v ~= 0 then c.px(W-1-x, y, v) end
  end end
end
local function mx(x, w) return W - x - (w or 1) end
local function mirR(r) return { mx(r[1], r[3]), r[2], r[3], r[4] } end

-- ======================= anchors (Team A; Team B mirrored) — contract, do not move =======================
local CUBE0, CUBEP = 76, 41
local A = {
  buddyOffice = {22, 120, 32, 32},
  lead        = {34, 196, 32, 32},
  bench1 = { {96,184,32,32}, {144,184,32,32}, {192,184,32,32} },
  bench2 = { {120,232,32,32}, {168,232,32,32}, {216,232,32,32} },
  cubes = {},
  lobby       = {212, 272, 72, 32},
  statsTv     = {240, 26, 40, 28},
}
for i=0,4 do A.cubes[#A.cubes+1] = {CUBE0 + i*CUBEP + 5, 112, 32, 32} end
A.desks = {}
for _, k in ipairs({"bench1", "bench2", "cubes"}) do for _, d in ipairs(A[k]) do A.desks[#A.desks+1] = d end end
-- HP6 addendum (no open shaft): the lift is a solid lobby wall with one closed door pair at floor level;
-- LIFT_Y = top of the door frame. doorA/doorB = the two closed leaves over the car opening, car = the rider cell
-- behind them (the UI shows it when it opens the doors).
local LIFT_Y = 250
local EL = { doorA = {304, LIFT_Y+6, 16, 48}, car = {304, LIFT_Y+22, 32, 32} }
EL.doorB = mirR(EL.doorA)
-- HP6 (docs/PLAN_FLOOR_LABELS.md): UI-written slots. counter = the INK digit face of the lift indicator,
-- callPrev/callNext = the wall call-button plates beside the door frame (clear of doors + car),
-- sign = the blank lettering field of each team's amber sign plate (UI draws the team name in the chrome font).
EL.counter = {306, LIFT_Y-12, 28, 8}
EL.callPrev = {290, LIFT_Y+18, 10, 14}
EL.callNext = mirR(EL.callPrev)
A.sign = {116, 8, 74, 11}

-- ======================= bg: sunset through the windows (the only dither on the plate) =======================
do
  local c = C.bg
  local ramp = { Y, V, P, CO, A_ }
  for y=0,95 do
    local t = math.max(0, math.min(0.999, (y-22)/38)) * 4
    local s = math.floor(t)
    for x=0,W-1 do c.px(x, y, L.dith(x, y, ramp[s+1], ramp[math.min(s+2, 5)], t - s)) end
  end
  for y=96,H-1 do c.hline(0, y, W, PANEL) end
  for _, p in ipairs({{88,28},{140,27},{161,31},{266,30},{378,27},{396,33},{470,30},{540,31},{212,29},{18,30},{620,29}}) do
    c.px(p[1], p[2], M)
  end
  c.commit()
end
-- sun, palms and skyline sit on the bg too, each one an outlined object
do
  local c = C.bg
  -- striped sun (team A window), clipped to the glass by the wall drawn over it
  obj(c, function(t)
    for y=40,62 do for x=150,188 do
      if ((x-169)^2 + ((y-62)*1.05)^2) <= 19^2 and not (y == 52 or y == 56 or y == 59 or y == 61) then t.px(x, y, A_) end
    end end
  end)
  -- team B: a goofy blimp instead of a second sun
  obj(c, function(t)
    t.ellipse(482, 36, 15.1, 5.6, M, {0,1,0,0,0,0,-1,0,0,0,0}, {0,0,0,1,0,0,0,0,1,0,0})
    t.poly({496,32, 502,29, 502,43, 496,40}, P)
    t.rect(477, 42, 8, 3, P)
  end, function(t)
    L.text(t, 471, 34, "GOO", P); L.text(t, 485, 34, "TV", V)
  end)
  -- skyline: chunky INK blocks with a few AMBER windows {x, w, top}
  local blocks = { {80,12,48},{94,9,54},{106,14,44},{122,10,52},{134,15,47},{190,10,50},{203,14,45},
                   {219,9,53},{12,10,46},{24,13,52},{40,9,44},{50,11,50},
                   {350+20,12,49},{385,9,54},{397,15,45},{414,10,51},{428,14,47},{446,9,53},{458,12,46},
                   {512,13,48},{528,9,53},{540,14,45},{558,9,51},{588,12,47},{603,9,53},{614,13,44} }
  for i, b in ipairs(blocks) do
    c.rect(b[1], b[3], b[2], 63-b[3], INK)
    for wy=b[3]+3, 60, 4 do for wx=b[1]+2, b[1]+b[2]-3, 4 do
      if (wx*7 + wy*3 + i) % 5 < 2 then c.rect(wx, wy, 2, 2, A_) end
    end end
  end
  -- crooked palm silhouettes (INK only, like the crop)
  local function palm(x, y, s)
    c.line(x, 62, x+1*s, y+10, INK); c.line(x+1, 62, x+1+1*s, y+10, INK)
    c.line(x+1*s, y+10, x+3*s, y, INK); c.line(x+1+1*s, y+10, x+1+3*s, y, INK)
    local hx = x + 3*s
    c.poly({hx,y, hx-11,y+3, hx-13,y+8, hx-6,y+3}, INK); c.poly({hx+1,y, hx+7,y+5, hx+8,y+10, hx+5,y+4}, INK)
    c.poly({hx,y, hx-4,y-6, hx-10,y-6, hx-3,y-3}, INK); c.poly({hx+1,y, hx+5,y-6, hx+8,y-7, hx+4,y-2}, INK)
  end
  palm(214, 36, 1); palm(566, 38, -1); palm(58, 40, -1)
  c.commit()
end

-- ======================= building: wall, windows, floor, cubicle back panel, lift core =======================
do
  local c = C.building
  -- back wall: PANEL_HI with the crop's little LINE plus-stars, a VIOLET top rail
  c.rect(0, 0, 288, 96, PHI)
  for y=8,86,12 do for x=((y//12)%2)*8+4, 287, 16 do
    c.px(x, y, LINE); c.px(x-1, y, LINE); c.px(x+1, y, LINE); c.px(x, y-1, LINE); c.px(x, y+1, LINE)
  end end
  c.hline(0, 0, 288, INK); c.rect(0, 1, 288, 2, V); c.hline(0, 3, 288, INK)
  -- chunky skirting: INK / VIOLET x3 / INK, then the wall-floor seam
  c.hline(0, 89, 288, INK); c.rect(0, 90, 288, 4, V); c.hline(0, 90, 288, M); c.hline(0, 94, 288, INK)
  c.hline(0, 95, 288, INK)
  -- windows: punch the wall (sky shows through), thick MARBLE frame + INK outline, MARBLE mullions
  local function window(x0, x1, y0, y1, mull)
    c.rect(x0-3, y0-3, x1-x0+7, y1-y0+7, INK)
    c.rect(x0-2, y0-2, x1-x0+5, y1-y0+5, M)
    c.vline(x1+2, y0-1, y1-y0+3, LINE); c.hline(x0-1, y1+2, x1-x0+4, LINE)
    c.rect(x0-1, y0-1, x1-x0+3, y1-y0+3, INK)
    for y=y0, y1 do for x=x0, x1 do c.px(x, y, 0) end end
    for _, m in ipairs(mull) do
      c.vline(m-2, y0, y1-y0+1, INK); c.vline(m-1, y0, y1-y0+1, M); c.vline(m, y0, y1-y0+1, M); c.vline(m+1, y0, y1-y0+1, INK)
    end
    -- sill: a fat MARBLE ledge with an INK outline and one shine pixel
    c.rect(x0-5, y1+4, x1-x0+11, 4, INK); c.rect(x0-4, y1+5, x1-x0+9, 2, M); c.hline(x0-4, y1+6, x1-x0+9, LINE)
  end
  window(80, 226, WIN0, WIN1, {129, 178})
  window(12, 60, WIN0, WIN1, {36})
  -- pilaster between the office and the bullpen: chunky MARBLE column, INK outline
  c.rect(67, 4, 9, 86, INK); c.rect(68, 4, 7, 85, M); c.vline(73, 4, 85, LINE)
  c.rect(66, 80, 11, 9, INK); c.rect(67, 81, 9, 7, M); c.hline(67, 86, 9, LINE)
  -- floor: big PANEL / PANEL_HI checker (crop), chunky tiles
  for y=FLOOR0, FLOOR1 do for x=0,287 do
    c.px(x, y, ((x//12 + (y-FLOOR0)//8) % 2 == 0) and PANEL or PHI)
  end end
  -- Buddy office floor: a VIOLET rug-tile field so the room reads as its own space
  for y=FLOOR0, 156 do for x=4, 66 do
    c.px(x, y, ((x//6 + (y-FLOOR0)//4) % 2 == 0) and PHI or LINE)
  end end
  -- cubicle back panel along the wall: one long SKIN fabric board, INK outline, MARBLE cap, CORAL pin dots
  local px0, px1 = CUBE0 + 2, 284
  c.rect(px0-1, 96, px1-px0+3, 14, INK)
  c.rect(px0, 97, px1-px0+1, 2, M)
  c.rect(px0, 99, px1-px0+1, 10, S_)
  for x=px0+5, px1-3, 9 do c.px(x, 103 + (x//9) % 3, CO) end
  -- floor front edge: one INK row, the plate's bottom (HP5: no slab / floor-below strip)
  c.hline(0, H-1, 288, INK)
  -- outer building wall
  c.rect(0, 0, 4, H, INK); c.vline(1, 4, H-6, M); c.vline(2, 4, H-6, LINE)
  mirror(c)

  -- lift core x 288..351 (HP6: solid lift-lobby wall, no shaft): MARBLE pilasters, a PANEL_HI wall panel with the
  -- back wall's plus-stars, a lobby floor strip in front of the doors, chunky INK outlines
  c.rect(288, 0, 64, H, M)
  c.vline(288, 0, H, INK); c.vline(351, 0, H, INK)
  c.vline(350, 1, H-1, LINE); c.vline(349, 1, H-1, LINE)
  c.hline(288, 0, 64, INK); c.rect(289, 1, 62, 2, V); c.hline(288, 3, 64, INK)
  local LOB = LIFT_Y + 58          -- lobby floor strip top (under the threshold)
  c.rect(294, 19, 52, LOB-19, INK); c.rect(295, 20, 50, LOB-21, PHI)
  for y=28, LOB-12, 12 do for x=((y//12)%2)*8+300, 340, 16 do
    c.px(x, y, LINE); c.px(x-1, y, LINE); c.px(x+1, y, LINE); c.px(x, y-1, LINE); c.px(x, y+1, LINE)
  end end
  -- mid rail (lines up with the room's skirting) and a chunky skirting at the door level
  c.hline(295, 89, 50, INK); c.rect(295, 90, 50, 4, V); c.hline(295, 90, 50, M); c.hline(295, 94, 50, INK)
  c.hline(295, LOB-5, 50, INK); c.rect(295, LOB-4, 50, 3, V); c.hline(295, LOB-4, 50, M)
  for _, v in ipairs({{290,44},{345,140},{290,196}}) do c.px(v[1], v[2], LINE); c.px(v[1]+1, v[2]+1, LINE); c.px(v[1], v[2]+3, LINE) end
  -- lobby floor strip: big LINE / PANEL_HI tiles up to the plate's bottom edge
  c.hline(289, LOB, 62, INK)
  for y=LOB+1, H-2 do for x=289, 350 do c.px(x, y, ((x//8 + (y-LOB-1)//6) % 2 == 0) and LINE or PHI) end end
  c.hline(288, H-1, 64, INK)
  c.commit()
end

-- ======================= furniture =======================
local STK = { "|.a.|\n|aaa|\n|a.a|", "|p.p|\n|ppp|\n|.p.|", "|ggg|\n|g.g|\n|ggg|" }
local deskN = 0

-- chunky monitor (front view, right of the head like the H0 sprites): crooked MARBLE case, TEAL screen
-- with INK scribble lines, a stubby neck. x,y = top-left of the case.
local function monitor(c, x, y, n, wide)
  local w = wide or 14
  obj(c, function(t)
    t.poly({x, y+1, x+w-1, y, x+w, y+11, x, y+12}, M)
    t.rect(x+w//2-2, y+12, 4, 3, LINE)
  end, function(t)
    t.rect(x+2, y+2, w-4, 8, INK); t.rect(x+3, y+3, w-6, 6, T)
    t.hline(x+4, y+4, w-9, INK); t.hline(x+4, y+6, w-8 - (n % 3), INK)
    t.px(x+w-4, y+3, M)
    t.vline(x+w-1, y+2, 9, LINE)
    t.px(x+1, y+2, M)
    if n % 2 == 0 then t.stamp(x+w-4, y-1, STK[(n-1) % 3 + 1], K) end
  end)
end
-- a desk plank: AMBER top with a MARBLE shine line, CORAL front face, two stubby VIOLET legs
local function plank(c, x, y, w, front)
  obj(c, function(t)
    t.rect(x, y, w, 3, A_); t.rect(x, y+3, w, 4, front or CO)
    t.rect(x+2, y+7, 3, 5, V); t.rect(x+w-5, y+7, 3, 5, V)
  end, function(t)
    t.hline(x, y+3, w, INK); t.hline(x+1, y, 6, M); t.px(x+w-3, y, M)
    t.hline(x+2, y+7, 3, INK); t.hline(x+w-5, y+7, 3, INK)
  end)
end
-- small desk clutter, each its own outlined blob
local CLUTTER = {
  function(t, x, y) t.rect(x, y+1, 4, 4, M); t.px(x+4, y+2, M); t.px(x+4, y+3, M); t.px(x+1, y+2, P) end,     -- mug
  function(t, x, y) t.rect(x, y+2, 6, 3, T); t.rect(x+1, y, 5, 2, V) end,                                    -- floppy stack
  function(t, x, y) t.rect(x+1, y-1, 3, 4, G); t.px(x, y, G); t.px(x+4, y+1, G); t.rect(x, y+3, 5, 2, CO) end, -- cactus
  function(t, x, y) t.poly({x, y+1, x+6, y, x+6, y+4, x, y+4}, M) end,                                        -- memo pile
}
local function clutter(c, x, y, i) obj(c, function(t) CLUTTER[(i-1) % #CLUTTER + 1](t, x, y) end) end
-- beige tower PC on the floor
local function tower(c, x, y)
  obj(c, function(t) t.poly({x, y, x+6, y-1, x+7, y+13, x, y+13}, S_) end,
    function(t) t.hline(x+1, y+3, 5, INK); t.rect(x+2, y+5, 3, 1, CO); t.px(x+2, y+9, G); t.px(x+1, y+1, M) end)
end

-- one worker seat: monitor right of the head, plank behind the sitter
local function seat(c, x, y)
  deskN = deskN + 1
  monitor(c, x+18, y+1, deskN)
end
-- bench row: one long shared plank, a monitor per seat, clutter between seats, a tower at the far end
local function benchRow(c, row)
  local xs, xe = 1e9, -1e9
  for _, r in ipairs(row) do xs = math.min(xs, r[1]); xe = math.max(xe, r[1]) end
  local y = row[1][2]
  plank(c, xs-4, y+14, xe-xs+40, CO)
  for _, r in ipairs(row) do
    seat(c, r[1], r[2])
    if r[1] ~= xe then clutter(c, r[1]+35, r[2]+9, deskN) end
  end
  clutter(c, xs-3, y+9, deskN+2)
  tower(c, xe+38, y+16)
end
-- cubicle seat: short plank inside the dividers, monitor, a memo pinned on the back panel
local function cubeDesk(c, x, y)
  plank(c, x-1, y+14, 34, CO)
  seat(c, x, y)
  clutter(c, x+1, y+9, deskN + 1)
  local memo = ({M, A_, P, G})[deskN % 4 + 1]
  obj(c, function(t) t.poly({x+2, y-13, x+8, y-14, x+8, y-8, x+2, y-8}, memo) end, function(t) t.px(x+5, y-13, P) end)
end
-- lead desk: the wide boss desk with two monitors, a gold trophy and the brick phone dock
local function leadDesk(c, x, y)
  plank(c, x-10, y+14, 52, P)
  monitor(c, x-9, y+1, 1, 15)
  monitor(c, x+26, y+1, 4, 15)
  obj(c, function(t)                                           -- trophy (left end)
    t.rect(x-13, y+5, 7, 4, A_); t.rect(x-11, y+9, 3, 2, A_); t.rect(x-12, y+11, 5, 2, V)
  end, function(t) t.px(x-12, y+6, M) end)
end

-- the scene props (team A side, mirrored to B)
do
  local c = C.furniture
  -- Buddy office: rug, beanbag, fern
  obj(c, function(t) t.poly({8, 136, 62, 135, 63, 150, 7, 151}, V) end, function(t)
    for x=12,58,8 do t.px(x, 140, A_); t.px(x+4, 146, A_) end
  end)
  obj(c, function(t) t.ellipse(60, 128, 7.1, 5.6, P, {0,-1,0,0,0,1,0}, {0,0,1,0,0,0,0}) end,
    function(t) t.hline(56, 125, 4, M); t.px(55, 126, M); t.hline(57, 131, 6, INK) end)
  obj(c, function(t)                                           -- crooked fern in a pot, office back corner
    t.rect(6, 108, 9, 7, CO); t.ellipse(10, 103, 5.1, 4.6, G, {0,0,1,0,0}, {0,1,0,0,-1}); t.ellipse(14, 98, 2.1, 3.1, G)
  end, function(t) t.hline(6, 110, 9, INK); t.px(9, 102, INK); t.px(12, 104, INK); t.px(7, 109, M) end)

  -- arcade cabinet against the outer wall (screen faces the camera)
  obj(c, function(t)
    t.poly({6, 160, 22, 159, 22, 192, 6, 192}, V)
    t.rect(6, 160, 17, 5, P)
  end, function(t)
    t.hline(6, 165, 17, INK)
    t.rect(8, 167, 12, 10, INK); t.rect(9, 168, 10, 8, Y)
    t.px(11, 170, G); t.px(15, 172, A_); t.px(13, 174, P)
    t.hline(6, 178, 17, INK); t.rect(9, 180, 2, 2, A_); t.rect(15, 180, 2, 2, P); t.px(10, 179, INK)
    L.text(t, 9, 161, "GO", M)
  end)
  -- break nook: a lopsided pink couch (front view), cushions, a teal coffee table, mug
  obj(c, function(t)
    t.poly({10, 252, 52, 251, 53, 266, 10, 266}, P)
    t.rect(7, 258, 7, 17, P); t.rect(49, 258, 7, 17, P)
    t.rect(13, 266, 37, 8, CO)
    t.rect(10, 275, 3, 3, V); t.rect(51, 275, 3, 3, V)
  end, function(t)
    t.vline(14, 258, 17, INK); t.vline(49, 258, 17, INK)
    t.vline(31, 266, 8, INK); t.hline(13, 266, 37, INK)
    t.hline(12, 253, 8, M); t.px(9, 259, M)
  end)
  obj(c, function(t) t.ellipse(30, 259, 4.6, 3.1, A_) end, function(t) t.px(28, 258, M) end)    -- throw cushion
  obj(c, function(t)
    t.poly({20, 283, 50, 282, 51, 287, 20, 288}, T); t.rect(23, 288, 3, 6, V); t.rect(46, 288, 3, 6, V)
  end, function(t) t.hline(21, 283, 8, M) end)
  clutter(c, 38, 278, 1)
  obj(c, function(t) t.poly({26, 281, 33, 280, 33, 283, 26, 283}, M) end, function(t) t.hline(27, 281, 5, LINE) end) -- magazine
  -- floor lamp by the couch: wonky shade on a pole
  obj(c, function(t) t.poly({57, 240, 66, 239, 69, 248, 55, 249}, A_); t.rect(61, 249, 2, 22, V); t.rect(57, 271, 10, 2, V) end,
    function(t) t.hline(58, 241, 4, M) end)
  -- water cooler
  obj(c, function(t)
    t.ellipse(68, 293, 5.1, 6.1, T)
    t.poly({62, 300, 74, 300, 74, 322, 62, 322}, M)
  end, function(t)
    t.hline(62, 300, 13, INK); t.px(66, 290, M); t.px(67, 289, M)
    t.rect(64, 304, 3, 2, T); t.rect(70, 304, 3, 2, P); t.hline(62, 309, 13, LINE)
    t.vline(73, 301, 21, LINE)
  end)
  -- marble bust in pink shutter shades on a pedestal
  obj(c, function(t)
    t.ellipse(98, 302, 6.6, 7.1, M, {0,-1,0,0,0,0,0,1,0,0,0,0,0,0,0}, {0,0,0,1,0,0,0,0,0,0,-1,0,0,0,0})
    t.poly({90, 309, 106, 309, 109, 315, 87, 315}, M)
    t.rect(91, 316, 14, 14, M)
  end, function(t)
    t.rect(92, 300, 13, 3, P); t.hline(92, 301, 13, INK); t.vline(98, 300, 3, INK)
    t.hline(95, 305, 4, INK)
    t.hline(87, 315, 23, INK); t.vline(103, 317, 12, LINE); t.px(93, 296, M); t.px(94, 295, M)
  end)
  -- big crooked palm in a pot (front, by the bench)
  obj(c, function(t)
    t.poly({136, 312, 154, 312, 151, 329, 139, 329}, CO)
    t.rect(144, 290, 2, 22, V); t.rect(145, 292, 2, 6, V)
  end, function(t) t.hline(136, 315, 19, INK); t.px(139, 313, M) end)
  obj(c, function(t)
    t.poly({145, 290, 128, 288, 124, 296, 134, 291}, G)
    t.poly({146, 290, 160, 284, 167, 291, 155, 290}, G)
    t.poly({145, 290, 139, 279, 132, 279, 141, 284}, G)
    t.poly({146, 290, 152, 278, 159, 276, 154, 285}, G)
  end, function(t) t.px(133, 290, INK); t.px(158, 287, INK); t.px(140, 282, INK) end)
  -- potted plant by the lobby mat
  obj(c, function(t)
    t.poly({195, 300, 207, 300, 205, 312, 197, 312}, CO)
    t.ellipse(201, 294, 6.1, 5.1, G, {0,1,0,0,0,-1}, {0,0,-1,0,1,0})
  end, function(t) t.hline(195, 302, 13, INK); t.px(199, 292, INK); t.px(203, 295, INK); t.px(198, 301, M) end)
  -- lobby mat under the queue, arrow toward the lift
  obj(c, function(t) t.poly({212, 297, 283, 296, 284, 306, 211, 306}, P) end,
    function(t) t.stamp(266, 299, "|...a...|\n|aaaaa..|\n|...a...|", K); t.hline(214, 297, 6, M) end)
  -- cubicle dividers: chunky TEAL pillars with a MARBLE cap and an INK seam (crop), between the cells
  for i=0,5 do
    local cx = CUBE0 + i*CUBEP
    local x0, x1 = math.max(cx-4, 77), cx+4
    if i == 5 then x1 = math.min(x1, 285) end
    obj(c, function(t) t.poly({x0, 140, x0, 101, x0+2, 99, x1-1, 100, x1, 140}, T) end,
      function(t) t.hline(x0+1, 101, x1-x0-1, M); t.vline((x0+x1)//2, 104, 34, INK) end)
  end
  mirror(c)

  -- desks for both teams (not mirrored, so every monitor sits right of the head like the sprites)
  for _, m in ipairs({ function(r) return r end, mirR }) do
    local r = m(A.buddyOffice); plank(c, r[1]-2, r[2]+14, 36, CO); seat(c, r[1], r[2])
    r = m(A.lead); leadDesk(c, r[1], r[2])
    for _, k in ipairs({"bench1", "bench2"}) do
      local row = {}
      for _, d in ipairs(A[k]) do row[#row+1] = m(d) end
      benchRow(c, row)
    end
    for _, d in ipairs(A.cubes) do r = m(d); cubeDesk(c, r[1], r[2]) end
  end

  -- lift (HP6): a closed door pair in a MARBLE frame at floor level, the < > call plates beside the frame
  local fx, fy = 301, LIFT_Y
  c.rect(fx, fy, 38, 58, INK); c.rect(fx+1, fy+1, 36, 56, M); c.hline(fx+1, fy+1, 36, PHI)
  c.vline(fx+36, fy+2, 54, LINE)
  for _, d in ipairs({EL.doorA, EL.doorB}) do
    local x, y, w, h = d[1], d[2], d[3], d[4]
    c.rect(x, y, w, h, INK)
    c.rect(x+1, y+1, w-2, h-2, T)
    c.vline(x+1, y+1, h-2, M)
    c.rect(x+4, y+6, 2, 16, Y); c.rect(x+w-6, y+6, 2, 16, Y)
    c.hline(x+1, y+h-6, w-2, INK); c.rect(x+1, y+h-5, w-2, 3, LINE)
  end
  c.rect(318, LIFT_Y+28, 4, 2, INK)   -- the leaves' meeting pulls
  -- HP6 call buttons (< prev, > next): INK-outlined VIOLET wall plate, a raised MARBLE push button with a
  -- LINE shadow and a chunky INK chevron. Idle look only; the UI lights them.
  for _, b in ipairs({{EL.callPrev, -1}, {EL.callNext, 1}}) do
    local x, y, w, h = b[1][1], b[1][2], b[1][3], b[1][4]
    c.rect(x, y, w, h, INK); c.rect(x+1, y+1, w-2, h-2, V); c.px(x+1, y+1, M)
    c.rect(x+2, y+2, w-4, h-4, INK); c.rect(x+3, y+3, w-6, h-6, M)
    c.hline(x+3, y+h-4, w-6, LINE); c.vline(x+w-4, y+3, h-6, LINE)
    for i=0,4 do
      local dx = (b[2] < 0) and math.abs(i-2) or (2 - math.abs(i-2))
      c.rect(x + 3 + dx, y+4+i, 2, 1, INK)
    end
  end
  c.commit()
end

-- ======================= signs (wall) =======================
do
  local c = C.signs
  local function textBig(t, x, y, s, col, sh)
    for pass=1,2 do
      for n=1,#s do
        local g = L.F[s:sub(n,n)] or L.F[" "]
        for r=0,4 do for q=0,2 do
          if g:sub(r*3+q+1, r*3+q+1) == "1" then
            local px0, py0 = x + (n-1)*8 + q*2, y + r*2
            if pass == 1 and sh then t.rect(px0+1, py0+1, 2, 2, sh) elseif pass == 2 then t.rect(px0, py0, 2, 2, col) end
          end
        end end
      end
    end
  end
  -- team sign over the window head: a slightly crooked AMBER board (the top rail holds it)
  local function sign(cx, label)
    local w = #label*8 - 2 + 12
    local x = cx - w//2
    obj(c, function(t) t.poly({x, 6, x+w-1, 5, x+w, 19, x+1, 20}, A_) end, function(t)
      t.hline(x+2, 7, w-4, M)   -- HP6: no baked lettering; the UI writes the team name into teamX.sign
    end)
    L.twinkle(c, x - 5, 9, M, M, 2)
  end
  sign(153, "VIBESQUAD")
  sign(W-153, "HYPERDESK")
  -- corner office: IDEA LAB plate over its window, OUT light
  for _, x in ipairs({10, W-10-36}) do
    obj(c, function(t) t.rect(x, 8, 36, 9, V) end, function(t) L.text(t, x+3, 10, "IDEA LAB", M) end)
  end
  for _, x in ipairs({48, W-48-17}) do
    obj(c, function(t) t.rect(x, 71, 17, 8, G) end, function(t) L.text(t, x+3, 73, "OUT", INK) end)
  end
  -- stats TV: a chunky beige PC-98 CRT bolted to the wall by the lift. The glass rect (contract) stays flat
  -- INK so the UI can draw blips on it; the case, knobs and rabbit ears are the caricature part.
  local function statsTv(g, side)
    local gx, gy = g[1], g[2]
    obj(c, function(t)
      t.poly({gx-6, gy-6, gx+45, gy-7, gx+46, gy+35, gx-6, gy+36}, S_)
      t.rect(gx+6, gy+37, 28, 3, LINE)
    end, function(t)
      t.rect(gx-1, gy-1, 42, 30, LINE)
      t.rect(gx, gy, 40, 28, INK)
      t.hline(gx-4, gy-4, 10, M); t.px(gx-4, gy-3, M)
      t.vline(gx+45, gy-5, 39, CO)
      for i=0,2 do t.rect(gx+1+i*6, gy+31, 3, 2, CO) end
      t.rect(gx+33, gy+31, 2, 2, G)
    end)
    -- rabbit ears (wonky)
    c.line(gx+16, gy-8, gx+9, gy-17, INK); c.line(gx+23, gy-8, gx+31, gy-15, INK)
    c.rect(gx+8, gy-18, 2, 2, P); c.rect(gx+31, gy-16, 2, 2, A_)
    c.rect(gx+15, gy-9, 10, 2, INK)
    -- cable down to the skirting
    for y=gy+41, 88 do c.px(gx+38 + ((y//4) % 2), y, INK) end
  end
  statsTv(A.statsTv)
  statsTv(mirR(A.statsTv))
  -- team A: the one googly prop of the scene, the lopsided VIBE poster (crop)
  obj(c, function(t) t.poly({84, 68, 108, 66, 109, 87, 85, 88}, P) end, function(t)
    t.ellipse(92, 74, 4.1, 4.6, INK); t.ellipse(101, 73, 5.1, 5.6, INK)
    t.ellipse(92, 74, 3.1, 3.6, M); t.ellipse(101, 73, 4.1, 4.6, M)
    t.px(92, 75, INK); t.px(92, 76, INK); t.rect(101, 73, 2, 2, INK); t.px(102, 73, M)
    t.line(89, 78, 91, 80, INK); t.hline(91, 80, 9, INK); t.line(100, 80, 103, 77, INK); t.rect(94, 81, 3, 1, P)
    L.text(t, 89, 82, "VIBE", M)
    t.px(85, 68, M); t.px(108, 67, M)
  end)
  -- team B: a plain WOW poster (no eyes) with a lightning bolt
  obj(c, function(t) t.poly({W-108, 67, W-84, 68, W-85, 88, W-109, 87}, T) end, function(t)
    t.poly({W-95, 70, W-101, 78, W-96, 78, W-99, 85, W-92, 75, W-97, 75}, A_)
    L.text(t, W-106, 80, "WOW", INK)
    t.px(W-107, 68, M)
  end)
  -- wonky clocks
  for _, x in ipairs({138, W-138}) do
    obj(c, function(t) t.ellipse(x, 77, 7.1, 7.6, M, {0,0,1,0,0,0,0,0,0,0,0,0,0,0,0}, {0,1,0,0,0,0,0,0,0,0,0,-1,0,0,0}) end,
      function(t) t.line(x, 77, x, 72, INK); t.line(x, 77, x+3, 79, INK); t.px(x+1, 71, LINE); t.px(x-5, 76, LINE); t.px(x+5, 77, LINE); t.px(x, 83, LINE); t.px(x-3, 72, M) end)
  end
  -- Memphis squiggle + triangle on the wall
  for _, s in ipairs({ {158, 1}, {W-158, -1} }) do
    local x0, d = s[1], s[2]
    for i=0,6 do
      local x = x0 + d*i*4
      c.line(x, 72 + (i%2)*4, x + d*4, 72 + ((i+1)%2)*4, G); c.line(x, 73 + (i%2)*4, x + d*4, 73 + ((i+1)%2)*4, G)
    end
    obj(c, function(t) t.poly({x0 + d*34, 87, x0 + d*44, 78, x0 + d*47, 87}, T) end)
    c.rect(x0 + d*10, 83, 2, 2, A_); c.rect(x0 + d*22, 86, 2, 2, A_)
  end
  -- lift: floor indicator + LIFT plate
  local iy = LIFT_Y - 14   -- counter housing sits on the door frame head
  -- HP6: blank digit face (INK in both modes) inside a LINE bevel; the UI writes the floor number here
  c.rect(304, iy, 32, 12, INK); c.rect(305, iy+1, 30, 10, LINE); c.px(305, iy+1, M)
  local f = EL.counter; c.rect(f[1], f[2], f[3], f[4], INK)
  obj(c, function(t) t.rect(303, 7, 34, 9, V) end, function(t) L.text(t, 312, 9, "LIFT", M) end)
  c.commit()
end

-- ======================= front overlay (covers sprites; also part of the plate) =======================
do
  local c = C.front
  -- Buddy corner office glass front: chunky MARBLE rail, TEAL glass band with two glints, door gap on the
  -- bullpen side, INK outlines, kick plate hiding the chair casters
  local yRim = A.buddyOffice[2] + A.buddyOffice[4] - 11
  local x0, x1 = 4, 58
  c.rect(x0, yRim-1, x1-x0+1, 4, INK); c.rect(x0, yRim, x1-x0+1, 2, M); c.hline(x0+1, yRim, 5, M)
  for _, px in ipairs({5, 31, 57}) do c.rect(px-1, yRim+3, 3, 8, INK); c.vline(px, yRim+3, 8, M) end
  for _, gx in ipairs({10, 38}) do for i=0,4 do c.px(gx+i, yRim+8-i, M); c.px(gx+i+1, yRim+8-i, M) end end
  c.rect(x0, yRim+10, x1-x0+1, 7, INK); c.rect(x0+1, yRim+11, x1-x0-1, 5, T); c.hline(x0+1, yRim+11, x1-x0-1, M)
  c.px(x0+3, yRim+13, M)
  -- side glass of the office (seen face on): a MARBLE post on the bullpen side
  c.rect(67, 96, 5, yRim+17-96, INK); c.rect(68, 96, 3, yRim+16-96, M); c.vline(70, 96, yRim+16-96, LINE)
  -- lead desk modesty panel: VIOLET, crooked top edge, a gold crown plaque (covers the chair casters)
  local x, y = A.lead[1], A.lead[2]
  c.poly({x-10, y+25, x+42, y+24, x+42, y+37, x-10, y+37}, INK)
  c.poly({x-9, y+26, x+41, y+25, x+41, y+36, x-9, y+36}, V)
  c.hline(x-8, y+26, 20, M); c.hline(x-9, y+32, 51, INK)
  c.rect(x+9, y+27, 14, 8, INK); c.rect(x+10, y+28, 12, 6, A_)
  c.stamp(x+12, y+29, "|a.a.a.a|\n|aaaaaaa|\n|ppppppp|", { a=INK, p=P })
  mirror(c)
  -- lift door frame front (HP6): jambs + threshold over the rider cell edges (hides the rider's shoes)
  local fx, fy = 301, LIFT_Y
  for _, jx in ipairs({fx, fx+35}) do c.rect(jx, fy+4, 3, 54, INK); c.vline(jx+1, fy+5, 52, M) end
  c.rect(fx, fy+52, 38, 6, INK); c.rect(fx+1, fy+53, 36, 2, M); c.rect(fx+1, fy+55, 36, 2, LINE)
  c.hline(fx+4, fy+55, 30, A_)
  c.commit()
end

-- ======================= light: a few sparkles + glass glints (no dither pools) =======================
do
  local c = C.light
  L.twinkle(c, 118, 300, P, M, 1)
  L.twinkle(c, 186, 268, A_, M, 1)
  L.twinkle(c, 250, 160, M, M, 1)
  L.twinkle(c, 30, 220, T, M, 1)
  mirror(c)
  L.twinkle(c, 295, 120, T, M, 2)
  L.twinkle(c, 345, 66, P, M, 1)
  c.commit()
end

-- ======================= slices (contract) =======================
local function slice(name, r)
  local s = spr:newSlice(Rectangle(r[1], r[2], r[3], r[4]))
  s.name = name
end
for _, side in ipairs({"A", "B"}) do
  local m = side == "A" and function(r) return r end or mirR
  local p = "team"..side.."."
  slice(p.."lead", m(A.lead)); slice(p.."buddyOffice", m(A.buddyOffice))
  for i, d in ipairs(A.desks) do slice(p.."desk"..(i-1), m(d)) end
  slice(p.."lobby", m(A.lobby)); slice(p.."statsTv", m(A.statsTv)); slice(p.."sign", m(A.sign))
end
slice("elevator.doorA", EL.doorA); slice("elevator.doorB", EL.doorB); slice("elevator.car", EL.car)
slice("elevator.counter", EL.counter); slice("elevator.callPrev", EL.callPrev); slice("elevator.callNext", EL.callNext)

tmpSpr:close()
spr:saveAs(root.."/art/office/floor.aseprite")
print("wrote floor.aseprite")
