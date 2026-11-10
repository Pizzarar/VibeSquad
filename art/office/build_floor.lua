-- FT (docs/PLAN_FLOOR_TIGHT.md): tighter, chunkier floor for the 64px cast. The plate stays 960 wide but drops
-- to 960x444: every shape below is written in a 480x222 design grid and re-rasterised at x2
-- (art/office/ff/scale.lua, area mode): fills scale, each object's 1px INK outline is traced at 960 (obj), and
-- M.thin collapses every 2px run back to 1px per layer, so outlines, bevels and shine dots stay 1px (no
-- nearest-neighbour upscale). Floor checker, rugs, sky dither, plus-stars, text (5x7 font), twinkles and stamps
-- are drawn natively at 960. Slices = design rects x2 (team B stays a pixel mirror of team A).
-- vs FF (960x498 from a 640x332 grid at 1.5): the back wall is 64 rows (was 96), the dead checker rows are gone,
-- desks/people are x2 of the 32 grid (was x1.5), rows restack to 4 cubicles + bench 4 + bench 3 per team.
-- Surreal touch (flavour a, 11-09; max 2 per floor): team A's wall clock melts down the wall, and one
-- floating eyeball drifts over the lift lobby (= the scene's one googly prop, ruling 2a; the posters are plain).
-- Same hand as H0/H1: chunky FRONT-VIEW furniture, every object its own 1px INK outline (obj() outlines each
-- piece on its own), flat fills, MARBLE shine pixels, Bayer dither only in the sunset through the windows.
-- Per team: a glass Buddy office in the outer top corner with the lead's desk below it, a row of 4 cubicles
-- along the back wall, a bench of two rows (4 + 3), the stats TV (wall CRT) by the lift, the lobby mat.
-- Every seat faces the back wall (sprites sit with their backs to the camera); monitors sit right of the head.
-- Back wall 0..63 (top rail 0..3, skirting 57..63), floor 64..220, INK floor edge 221 = the plate's bottom edge
-- (HP5). Lift (HP6): solid lobby wall, one closed door pair at floor level.
-- Layers (bottom->top): bg (sky through the windows), building, furniture, signs, light, front.
-- "front" = the overlay that covers sprites (Buddy office glass front, lead desk modesty panel, lift door jambs
-- + threshold); also part of the plate, export_floor.lua writes it alone as floor-front-*.png.
-- Anchor slices (contract, keys unchanged): teamA/teamB.{lead,buddyOffice,desk0..10,lobby,statsTv,sign},
-- elevator.{doorA,doorB,car,counter,callPrev,callNext}. desk0..3 = bench row 1, desk4..6 = bench row 2,
-- desk7..10 = cubicles.
-- Index 0 is never painted on the plate (fully opaque).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/build_floor.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local W, H = 480, 222          -- design grid
local SC = dofile(root.."/art/office/ff/scale.lua")(L)
local SX = 2
local W2, H2 = 960, 444        -- plate px
local function E(v) return SC.even(v * SX) end
local MID = W2 // 2
local K = { k=15, v=8, p=9, c=10, a=11, s=14, m=4, t=7, g=12, y=13, l=3, h=2, n=1 }
local INK, V, P, CO, A_, S_, M, T, G, Y = L.INK, L.VIOLET, L.PINK, L.CORAL, L.AMBER, L.SKIN, L.MARBLE, L.TEAL, L.MINT, L.SKY
local PANEL, PHI, LINE = L.PANEL, L.PHI, L.LINE

local FLOOR0, FLOOR1 = 64, 220
local WIN0, WIN1 = 24, 44       -- window glass rows; sill under it
local HALF = 208               -- team A half = design x 0..207; lift core 208..271

local spr = L.new(W2, H2, pal)
local f1 = spr.frames[1]
local C = {}
local function wrap(raw) return SC.wrap(raw, SX, 0, 0, { area = true }) end
for _, n in ipairs({ "bg", "building", "furniture", "signs", "light", "front" }) do C[n] = wrap(L.canvas(spr, L.layer(spr, n), f1)) end
-- deferred native details (text, twinkles, stamps): drawn after the layer's thin pass so it never touches them
local POST = {}
local function post(c, fn) POST[c] = POST[c] or {}; table.insert(POST[c], fn) end
local function finish(c)
  SC.thin(c.raw, MID)
  for _, fn in ipairs(POST[c] or {}) do fn() end
  c.raw.commit()
end

-- scratch canvas: obj() draws one object here, outlines it in INK (outside, traced at 960), then stamps it onto a layer
local tmpSpr = L.new(W2, H2, pal)
local T0r = L.canvas(tmpSpr, tmpSpr.layers[1], tmpSpr.frames[1])
local bb
do
  local raw = T0r.px
  T0r.px = function(x, y, c)
    if c and x >= 0 and y >= 0 and x < W2 and y < H2 then
      raw(x, y, c)
      bb[1] = math.min(bb[1], x); bb[2] = math.min(bb[2], y); bb[3] = math.max(bb[3], x); bb[4] = math.max(bb[4], y)
    end
  end
end
local T0 = wrap(T0r)
local function obj(dst, fill, detail)
  bb = { 1e9, 1e9, -1, -1 }
  T0.dst = dst
  fill(T0)
  if bb[3] < 0 then return end
  local add = {}
  for y=bb[2]-1, bb[4]+1 do for x=bb[1]-1, bb[3]+1 do
    if T0r.get(x, y) == 0 then
      for _, d in ipairs({{-1,0},{1,0},{0,-1},{0,1}}) do
        local n = T0r.get(x+d[1], y+d[2])
        if n ~= 0 and n ~= INK then add[#add+1] = {x, y}; break end
      end
    end
  end end
  for _, p in ipairs(add) do T0r.px(p[1], p[2], INK) end
  if detail then detail(T0) end
  for y=bb[2], bb[4] do for x=bb[1], bb[3] do
    local v = T0r.get(x, y)
    if v ~= 0 then dst.raw.px(x, y, v); T0r.img:drawPixel(x, y, 0) end
  end end
end

-- team A half (design x 0..207 = plate x 0..415) mirrored onto team B, in plate px
local function mirror(c)
  local r = c.raw
  for y=0,H2-1 do for x=0,E(HALF)-1 do
    local v = r.get(x, y)
    if v ~= 0 then r.px(W2-1-x, y, v) end
  end end
end

-- ---- native details at 960 (never scaled pixels) ----
-- 5x7 caps font, 1px strokes; a design-grid L.text (3x5 at x,y, 4px pitch) lands on the same centre
local F7 = {
  A = {".###.","#...#","#...#","#####","#...#","#...#","#...#"}, B = {"####.","#...#","#...#","####.","#...#","#...#","####."},
  D = {"####.","#...#","#...#","#...#","#...#","#...#","####."}, E = {"#####","#....","#....","####.","#....","#....","#####"},
  F = {"#####","#....","#....","####.","#....","#....","#...."}, G = {".###.","#...#","#....","#.###","#...#","#...#",".###."},
  I = {".###.","..#..","..#..","..#..","..#..","..#..",".###."}, L = {"#....","#....","#....","#....","#....","#....","#####"},
  O = {".###.","#...#","#...#","#...#","#...#","#...#",".###."}, T = {"#####","..#..","..#..","..#..","..#..","..#..","..#.."},
  U = {"#...#","#...#","#...#","#...#","#...#","#...#",".###."}, V = {"#...#","#...#","#...#","#...#",".#.#.",".#.#.","..#.."},
  W = {"#...#","#...#","#...#","#.#.#","#.#.#","##.##","#...#"},
}
local function text(c, x, y, s, col)
  local cx = (x + (#s*4 - 1) / 2) * SX
  local x0 = math.floor(cx - (#s*6 - 1) / 2 + 0.5)
  local y0 = math.floor((y + 2.5) * SX - 3.5 + 0.5)
  post(c.dst or c, function()
    local r = (c.dst or c).raw
    for n=1,#s do
      local g = F7[s:sub(n, n)]
      if g then for row=1,7 do for q=1,5 do
        if g[row]:sub(q, q) == "#" then r.px(x0 + (n-1)*6 + q-1, y0 + row-1, col) end
      end end end
    end
  end)
end
local function twinkle(c, x, y, col, core, size)
  local px, py = c.P(x), c.P(y)
  local sz = math.floor((size or 1) * SX + 0.5)
  post(c, function()
    local r = c.raw
    for d=1,sz do r.px(px-d, py, col); r.px(px+d, py, col); r.px(px, py-d, col); r.px(px, py+d, col) end
    r.px(px, py, core or col)
  end)
end
local function stamp(c, x, y, art, key)
  local d = c.dst or c
  if c.dst then   -- inside obj(): draw on the layer after its thin pass
    post(d, function() local w = wrap(d.raw); w.stamp(x, y, art, key) end)
  else post(c, function() c.stamp(x, y, art, key) end) end
end
-- the wall's little LINE plus-stars, 1px arms at 960
local function plus(c, x, y, col)
  local px, py = c.P(x), c.P(y)
  local r = c.raw
  r.px(px, py, col); r.px(px-1, py, col); r.px(px+1, py, col); r.px(px, py-1, col); r.px(px, py+1, col)
end
local function mx(x, w) return W - x - (w or 1) end
local function mirR(r) return { mx(r[1], r[3]), r[2], r[3], r[4] } end

-- ======================= anchors (Team A; Team B mirrored) =======================
local CUBE0, CUBEP = 58, 37       -- cubicle dividers at CUBE0 + i*CUBEP
local A = {
  buddyOffice = {10, 76, 32, 32},
  lead        = {18, 154, 32, 32},
  bench1 = { {62,116,32,32}, {99,116,32,32}, {136,116,32,32}, {173,116,32,32} },
  bench2 = { {80,154,32,32}, {117,154,32,32}, {154,154,32,32} },
  cubes = {},
  lobby       = {136, 188, 72, 32},   -- queue feet on the front strip, 2 rows clear of the bench-2 chair bases
  statsTv     = {160, 18, 40, 28},
}
for i=0,3 do A.cubes[#A.cubes+1] = {CUBE0 + i*CUBEP + 3, 78, 32, 32} end
A.desks = {}
for _, k in ipairs({"bench1", "bench2", "cubes"}) do for _, d in ipairs(A[k]) do A.desks[#A.desks+1] = d end end
-- HP6 addendum (no open shaft): the lift is a solid lobby wall with one closed door pair at floor level;
-- LIFT_Y = top of the door frame. doorA/doorB = the two closed leaves over the car opening, car = the rider cell
-- behind them (the UI shows it when it opens the doors).
local LIFT_Y = 160
local EL = { doorA = {224, LIFT_Y+6, 16, 48}, car = {224, LIFT_Y+22, 32, 32} }
EL.doorB = mirR(EL.doorA)
-- HP6 (docs/PLAN_FLOOR_LABELS.md): UI-written slots. counter = the INK digit face of the lift indicator,
-- callPrev/callNext = the wall call-button plates beside the door frame (clear of doors + car),
-- sign = the blank lettering field of each team's amber sign plate (UI draws the team name in the chrome font).
EL.counter = {226, LIFT_Y-12, 28, 8}
EL.callPrev = {210, LIFT_Y+18, 10, 14}
EL.callNext = mirR(EL.callPrev)
local SIGN_CX = 90
A.sign = {SIGN_CX - 37, 7, 74, 10}

-- ======================= bg: sunset through the windows (the only dither on the plate) =======================
local BGO = wrap(SC.canvas(W2, H2))   -- sun, blimp, skyline, palms, stars (thinned, then laid over the sky)
do
  local c = BGO
  for _, p in ipairs({{70,27},{112,26},{30,28},{20,31},{122,30},{358,27},{372,31},{410,26},{448,29},{460,27}}) do
    c.raw.px(c.P(p[1]), c.P(p[2]), M)
  end
end
-- sun, palms and skyline sit on the bg too, each one an outlined object
do
  local c = BGO
  -- striped sun (team A window), clipped to the glass by the wall drawn over it
  obj(c, function(t)
    for y=28,44 do for x=78,114 do
      if ((x-96)^2 + ((y-45)*1.05)^2) <= 15^2 and not (y == 37 or y == 40 or y == 42 or y == 44) then t.px(x, y, A_) end
    end end
  end)
  -- team B: a goofy GOO blimp instead of a second sun (left pane, clear of the mullion)
  obj(c, function(t)
    t.ellipse(376, 31, 8.6, 4.6, M, {0,1,0,0,0,-1,0}, {0,0,1,0,0,0,0})
    t.poly({383, 28, 387, 26, 387, 36, 383, 34}, P)
    t.rect(373, 36, 6, 2, P)
  end, function(t)
    text(t, 371, 29, "GOO", P)
  end)
  -- skyline: chunky INK blocks with a few AMBER windows {x, w, top}
  local blocks = { {64,10,34},{75,9,38},{122,12,33},{108,11,36},{12,10,34},{24,9,38},{34,8,33},
                   {446,10,34},{437,9,38},{435,8,33},{340,12,33},{354,9,37},{396,11,35},{406,12,32} }
  for i, b in ipairs(blocks) do
    c.rect(b[1], b[3], b[2], 45-b[3], INK)
    for wy=b[3]+3, 42, 4 do for wx=b[1]+2, b[1]+b[2]-3, 4 do
      if (wx*7 + wy*3 + i) % 5 < 2 then c.rect(wx, wy, 2, 2, A_) end
    end end
  end
  -- crooked palm silhouettes (INK only, like the crop)
  local function palm(x, y, s)
    c.line(x, 44, x+1*s, y+8, INK); c.line(x+1*s, y+8, x+3*s, y, INK)
    local hx = x + 3*s
    c.poly({hx,y, hx-11,y+3, hx-13,y+8, hx-6,y+3}, INK); c.poly({hx+1,y, hx+7,y+5, hx+8,y+10, hx+5,y+4}, INK)
    c.poly({hx,y, hx-4,y-6, hx-10,y-6, hx-3,y-3}, INK); c.poly({hx+1,y, hx+5,y-6, hx+8,y-7, hx+4,y-2}, INK)
  end
  palm(84, 32, -1); palm(424, 32, 1); palm(36, 33, -1)
  SC.thin(c.raw, MID)
  for _, fn in ipairs(POST[c] or {}) do fn() end
  -- the sky: Bayer dither natively at 960 (design rows 0..63 = plate rows 0..127)
  local b = C.bg.raw
  local ramp = { Y, V, P, CO, A_ }
  for y=0,E(FLOOR0)-1 do
    local t = math.max(0, math.min(0.999, (y/SX-20)/26)) * 4
    local s = math.floor(t)
    for x=0,W2-1 do b.px(x, y, L.dith(x, y, ramp[s+1], ramp[math.min(s+2, 5)], t - s)) end
  end
  for y=E(FLOOR0),H2-1 do b.hline(0, y, W2, PANEL) end
  for y=0,H2-1 do for x=0,W2-1 do local v = c.raw.img:getPixel(x, y); if v ~= 0 then b.px(x, y, v) end end end
  b.commit()
end

-- ======================= building: wall, windows, floor, cubicle back panel, lift core =======================
do
  local c = C.building
  -- back wall: PANEL_HI with the crop's little LINE plus-stars, a VIOLET top rail
  c.rect(0, 0, HALF, FLOOR0, PHI)
  for y=8,52,11 do for x=((y//11)%2)*8+4, HALF-1, 16 do plus(c, x, y, LINE) end end
  c.hline(0, 0, HALF, INK); c.rect(0, 1, HALF, 2, V); c.hline(0, 3, HALF, INK)
  -- chunky skirting: INK / VIOLET x3 / INK, then the wall-floor seam
  c.hline(0, 57, HALF, INK); c.rect(0, 58, HALF, 4, V); c.hline(0, 58, HALF, M); c.hline(0, 62, HALF, INK)
  c.hline(0, 63, HALF, INK)
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
  window(64, 112, WIN0, WIN1, {88})
  window(12, 40, WIN0, WIN1, {26})
  -- pilaster between the office and the bullpen: chunky MARBLE column, INK outline
  c.rect(49, 4, 9, 54, INK); c.rect(50, 4, 7, 53, M); c.vline(55, 4, 53, LINE)
  c.rect(48, 50, 11, 7, INK); c.rect(49, 51, 9, 5, M); c.hline(49, 54, 9, LINE)
  -- floor: big PANEL / PANEL_HI checker, chunky tiles
  for y=E(FLOOR0), E(FLOOR1+1)-1 do for x=0,E(HALF)-1 do   -- 24x16 tiles at 960
    c.raw.px(x, y, ((x//24 + (y-E(FLOOR0))//16) % 2 == 0) and PANEL or PHI)
  end end
  -- Buddy office floor: a VIOLET rug-tile field so the room reads as its own space
  for y=E(FLOOR0), E(115)-1 do for x=E(4), E(52)-1 do   -- 12x8 rug tiles at 960
    c.raw.px(x, y, ((x//12 + (y-E(FLOOR0))//8) % 2 == 0) and PHI or LINE)
  end end
  -- cubicle back panel along the wall: one long SKIN fabric board, INK outline, MARBLE cap, CORAL pin dots
  local px0, px1 = CUBE0 + 2, HALF - 3
  c.rect(px0-1, FLOOR0, px1-px0+3, 14, INK)
  c.rect(px0, FLOOR0+1, px1-px0+1, 2, M)
  c.rect(px0, FLOOR0+3, px1-px0+1, 10, S_)
  for x=px0+5, px1-3, 9 do c.px(x, FLOOR0+7 + (x//9) % 3, CO) end
  -- floor front edge: one INK row, the plate's bottom (HP5: no slab / floor-below strip)
  c.hline(0, H-1, HALF, INK)
  -- outer building wall
  c.rect(0, 0, 4, H, INK); c.vline(1, 4, H-6, M); c.vline(2, 4, H-6, LINE)
  mirror(c)

  -- lift core x 208..271 (HP6: solid lift-lobby wall, no shaft): MARBLE pilasters, a PANEL_HI wall panel with the
  -- back wall's plus-stars, a lobby floor strip in front of the doors, chunky INK outlines
  local X0 = HALF
  c.rect(X0, 0, 64, H, M)
  c.vline(X0, 0, H, INK); c.vline(X0+63, 0, H, INK)
  c.vline(X0+62, 1, H-1, LINE); c.vline(X0+61, 1, H-1, LINE)
  c.hline(X0, 0, 64, INK); c.rect(X0+1, 1, 62, 2, V); c.hline(X0, 3, 64, INK)
  local LOB = LIFT_Y + 58          -- lobby floor strip top (under the threshold)
  c.rect(X0+6, 19, 52, LOB-19, INK); c.rect(X0+7, 20, 50, LOB-21, PHI)
  for y=28, LOB-12, 11 do for x=((y//11)%2)*8+X0+12, X0+52, 16 do plus(c, x, y, LINE) end end
  -- mid rail (lines up with the room's skirting) and a chunky skirting at the door level
  c.hline(X0+7, 57, 50, INK); c.rect(X0+7, 58, 50, 4, V); c.hline(X0+7, 58, 50, M); c.hline(X0+7, 62, 50, INK)
  c.hline(X0+7, LOB-5, 50, INK); c.rect(X0+7, LOB-4, 50, 3, V); c.hline(X0+7, LOB-4, 50, M)
  for _, v in ipairs({{X0+2,44},{X0+57,120},{X0+2,170}}) do c.px(v[1], v[2], LINE); c.px(v[1]+1, v[2]+1, LINE); c.px(v[1], v[2]+3, LINE) end
  -- lobby floor strip: big LINE / PANEL_HI tiles up to the plate's bottom edge
  c.hline(X0+1, LOB, 62, INK)
  for y=E(LOB+1), E(H-1)-1 do for x=E(X0+1), E(X0+63)-1 do   -- 16x12 lobby tiles at 960
    c.raw.px(x, y, (((x-E(X0+1))//16 + (y-E(LOB+1))//12) % 2 == 0) and LINE or PHI)
  end end
  c.hline(X0, H-1, 64, INK)
  finish(c)
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
    if n % 2 == 0 then stamp(t, x+w-4, y-1, STK[(n-1) % 3 + 1], K) end
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
-- bench row: one long shared plank, a monitor per seat, clutter in the wider gaps, a tower at the far end
local function benchRow(c, row, towerAt)
  local xs, xe = 1e9, -1e9
  for _, r in ipairs(row) do xs = math.min(xs, r[1]); xe = math.max(xe, r[1]) end
  local y = row[1][2]
  local x0, x1 = math.max(xs-3, CUBE0+1), math.min(xe+35, HALF-1)
  if xs > W/2 then x0, x1 = math.max(xs-3, W-HALF+1), math.min(xe+35, W-CUBE0-2) end
  plank(c, x0, y+14, x1-x0, CO)
  for _, r in ipairs(row) do seat(c, r[1], r[2]) end
  if towerAt then tower(c, towerAt, y+16) end
end
-- cubicle seat: short plank inside the dividers, monitor, a memo pinned on the back panel
local function cubeDesk(c, x, y)
  plank(c, x, y+14, 32, CO)
  seat(c, x, y)
  local memo = ({M, A_, P, G})[deskN % 4 + 1]
  obj(c, function(t) t.poly({x+3, y-12, x+9, y-13, x+9, y-7, x+3, y-7}, memo) end, function(t) t.px(x+6, y-12, P) end)
end
-- lead desk: the wide boss desk with two monitors, a gold trophy and the brick phone dock
local function leadDesk(c, x, y)
  plank(c, x-10, y+14, 52, P)
  monitor(c, x-9, y+1, 1, 15)
  monitor(c, x+26, y+1, 4, 15)
  local tx = x < W/2 and x-13 or x+38
  obj(c, function(t)                                           -- trophy (outer end)
    t.rect(tx, y+5, 7, 4, A_); t.rect(tx+2, y+9, 3, 2, A_); t.rect(tx+1, y+11, 5, 2, V)
  end, function(t) t.px(tx+1, y+6, M) end)
end

-- the scene props (team A side, mirrored to B)
do
  local c = C.furniture
  -- Buddy office: a crooked fern in a pot in the back corner
  obj(c, function(t)
    t.rect(43, 69, 8, 7, CO); t.ellipse(47, 64, 4.6, 4.6, G, {0,0,1,0,0}, {0,1,0,0,-1}); t.ellipse(49, 59, 2.1, 3.1, G)
  end, function(t) t.hline(43, 71, 8, INK); t.px(46, 63, INK); t.px(48, 65, INK); t.px(44, 70, M) end)
  -- arcade cabinet between the office and the lead desk (screen faces the camera)
  obj(c, function(t)
    t.poly({32, 118, 48, 117, 48, 150, 32, 150}, V)
    t.rect(32, 118, 17, 5, P)
  end, function(t)
    t.hline(32, 123, 17, INK)
    t.rect(34, 125, 12, 10, INK); t.rect(35, 126, 10, 8, Y)
    t.px(37, 128, G); t.px(41, 130, A_); t.px(39, 132, P)
    t.hline(32, 136, 17, INK); t.rect(35, 138, 2, 2, A_); t.rect(41, 138, 2, 2, P); t.px(36, 137, INK)
    text(t, 35, 119, "GO", M)
  end)
  -- water cooler by the cabinet
  obj(c, function(t)
    t.ellipse(15, 122, 5.1, 6.1, T)
    t.poly({9, 129, 21, 129, 21, 150, 9, 150}, M)
  end, function(t)
    t.hline(9, 129, 13, INK); t.px(13, 119, M); t.px(14, 118, M)
    t.rect(11, 133, 3, 2, T); t.rect(17, 133, 3, 2, P); t.hline(9, 138, 13, LINE)
    t.vline(20, 130, 20, LINE)
  end)
  -- small potted palm at the front, left of the bench
  obj(c, function(t)
    t.poly({62, 206, 74, 206, 72, 218, 64, 218}, CO)
    t.rect(67, 194, 2, 12, V)
  end, function(t) t.hline(62, 208, 13, INK); t.px(64, 207, M) end)
  obj(c, function(t)
    t.poly({68, 194, 55, 193, 52, 199, 61, 195}, G)
    t.poly({69, 194, 80, 189, 85, 195, 76, 194}, G)
    t.poly({68, 194, 64, 185, 58, 185, 65, 190}, G)
    t.poly({69, 194, 73, 184, 79, 183, 75, 190}, G)
  end, function(t) t.px(57, 195, INK); t.px(80, 192, INK); t.px(64, 188, INK) end)
  -- potted plant at the lobby mat's lift end
  obj(c, function(t)
    t.poly({194, 206, 206, 206, 204, 218, 196, 218}, CO)
    t.ellipse(200, 200, 6.1, 5.1, G, {0,1,0,0,0,-1}, {0,0,-1,0,1,0})
  end, function(t) t.hline(194, 208, 13, INK); t.px(198, 198, INK); t.px(202, 201, INK); t.px(197, 207, M) end)
  -- lobby mat in front of the bench, arrow toward the lift
  obj(c, function(t) t.poly({112, 210, 190, 209, 191, 219, 111, 219}, P) end,
    function(t) stamp(t, 172, 212, "|...a...|\n|aaaaa..|\n|...a...|", K); t.hline(114, 210, 6, M) end)
  -- cubicle dividers: chunky TEAL pillars with a MARBLE cap and an INK seam, between the cells
  for i=0,4 do
    local cx = CUBE0 + i*CUBEP
    local x0, x1 = cx-2, cx+2
    if i == 0 then x0 = CUBE0 - 1 end
    if i == 4 then x1 = math.min(x1, HALF-1) end
    obj(c, function(t) t.poly({x0, 106, x0, 69, x0+1, 67, x1-1, 68, x1, 106}, T) end,
      function(t) t.hline(x0+1, 69, x1-x0-1, M) end)
  end
  mirror(c)

  -- desks for both teams (not mirrored, so every monitor sits right of the head like the sprites)
  for _, m in ipairs({ function(r) return r end, mirR }) do
    local r = m(A.buddyOffice); plank(c, r[1]-2, r[2]+14, 36, CO); seat(c, r[1], r[2])
    r = m(A.lead); leadDesk(c, r[1], r[2])
    local row = {}
    for _, d in ipairs(A.bench1) do row[#row+1] = m(d) end
    benchRow(c, row)
    row = {}
    for _, d in ipairs(A.bench2) do row[#row+1] = m(d) end
    local tw = m({191, 0, 7, 1})
    benchRow(c, row, tw[1])
    for _, d in ipairs(A.cubes) do r = m(d); cubeDesk(c, r[1], r[2]) end
  end

  -- lift (HP6): a closed door pair in a MARBLE frame at floor level, the < > call plates beside the frame
  local fx, fy = EL.doorA[1] - 3, LIFT_Y
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
  c.rect(EL.doorA[1] + 14, LIFT_Y+28, 4, 2, INK)   -- the leaves' meeting pulls
  -- HP6 call buttons (< prev, > next): INK-outlined VIOLET wall plate, a raised MARBLE push button with a
  -- LINE shadow and a chunky INK chevron. Idle look only; the UI lights them.
  for _, b in ipairs({{EL.callPrev, -1}, {EL.callNext, 1}}) do
    local x, y, w, h = b[1][1], b[1][2], b[1][3], b[1][4]
    c.rect(x, y, w, h, INK); c.rect(x+1, y+1, w-2, h-2, V); c.px(x+1, y+1, M)
    c.rect(x+2, y+2, w-4, h-4, INK); c.rect(x+3, y+3, w-6, h-6, M)
    c.hline(x+3, y+h-4, w-6, LINE); c.vline(x+w-4, y+3, h-6, LINE)
    -- chevron natively at 960: 9 rows, 2px stroke, centred on the MARBLE button face
    local dir = b[2]
    post(c, function()
      local bx0, bx1, by0, by1 = E(x+3), E(x+w-3), E(y+3), E(y+h-3)
      local cx, cy = (bx0 + bx1 - 1) // 2, (by0 + by1 - 1) // 2
      for i=0,8 do
        local d = (dir < 0) and math.abs(i-4) or (4 - math.abs(i-4))
        c.raw.rect(cx - 3 + d, cy - 4 + i, 3, 1, INK)
      end
    end)
  end
  finish(c)
end

-- ======================= signs (wall) =======================
do
  local c = C.signs
  -- team sign over the window head: a slightly crooked AMBER board (the top rail holds it)
  local function sign(cx, n)
    local w = n*8 - 2 + 12
    local x = cx - w//2
    obj(c, function(t) t.poly({x, 5, x+w-1, 4, x+w, 17, x+1, 18}, A_) end, function(t)
      t.hline(x+2, 5, w-4, M)   -- HP6: no baked lettering; the UI writes the team name into teamX.sign
    end)
    twinkle(c, x - 5, 9, M, M, 2)
  end
  sign(SIGN_CX, 9)
  sign(W-SIGN_CX, 9)
  -- corner office: IDEA LAB plate over its window, OUT light
  for _, x in ipairs({8, W-8-36}) do
    obj(c, function(t) t.rect(x, 9, 36, 9, V) end, function(t) text(t, x+3, 11, "IDEA LAB", M) end)
  end
  -- stats TV: a chunky beige PC-98 CRT bolted to the wall by the lift. The glass rect (contract) stays flat
  -- INK so the UI can draw blips on it; the case, knobs and rabbit ears are the caricature part.
  local function statsTv(g)
    local gx, gy = g[1], g[2]
    obj(c, function(t)
      t.poly({gx-6, gy-5, gx+45, gy-6, gx+46, gy+35, gx-6, gy+36}, S_)
      t.rect(gx+6, gy+37, 28, 2, LINE)
    end, function(t)
      t.rect(gx-1, gy-1, 42, 30, LINE)
      t.rect(gx, gy, 40, 28, INK)
      t.hline(gx-4, gy-3, 10, M); t.px(gx-4, gy-2, M)
      t.vline(gx+45, gy-4, 38, CO)
      for i=0,2 do t.rect(gx+1+i*6, gy+31, 3, 2, CO) end
      t.rect(gx+33, gy+31, 2, 2, G)
    end)
    -- rabbit ears (wonky), short: the top rail is close
    c.line(gx+16, gy-7, gx+11, gy-13, INK); c.line(gx+23, gy-7, gx+29, gy-12, INK)
    c.rect(gx+10, gy-14, 2, 2, P); c.rect(gx+29, gy-13, 2, 2, A_)
    c.rect(gx+15, gy-8, 10, 2, INK)
  end
  statsTv(A.statsTv)
  statsTv(mirR(A.statsTv))
  -- team A: the lopsided VIBE poster, plain now (the floating lobby eye is the scene's one googly prop, 2a)
  obj(c, function(t) t.poly({119, 25, 136, 24, 137, 46, 120, 47}, P) end, function(t)
    t.poly({123, 28, 132, 28, 130, 38, 125, 38}, A_)                 -- a little sun
    t.hline(123, 31, 8, P); t.hline(124, 34, 6, P)
    text(t, 120, 40, "VIBE", M)
    t.px(120, 25, M); t.px(135, 25, M)
  end)
  -- team B: a plain WOW poster with a lightning bolt
  obj(c, function(t) t.poly({W-137, 24, W-120, 25, W-121, 47, W-138, 46}, T) end, function(t)
    t.poly({W-127, 27, W-132, 34, W-128, 34, W-130, 40, W-124, 32, W-128, 32}, A_)
    text(t, W-135, 40, "WOW", INK)
    t.px(W-136, 25, M)
  end)
  -- team B: the plain wonky clock
  do local x = W-1-145
    obj(c, function(t) t.ellipse(x, 30, 6.1, 6.6, M, {0,0,1,0,0,0,0,0,0,0,0,0,0}, {0,1,0,0,0,0,0,0,0,-1,0,0,0}) end,
      function(t) t.line(x, 30, x, 26, INK); t.line(x, 30, x+3, 32, INK); t.px(x, 25, LINE); t.px(x-4, 30, LINE); t.px(x+4, 30, LINE); t.px(x, 35, LINE); t.px(x-3, 26, M) end)
  end
  -- team A: SURREAL (flavour a, 11-09): the same clock, melting. Its lower rim sags into a long drip that
  -- runs down the wall to the skirting, the 6 slides down the drip, the minute hand droops; one drop below.
  do local x = 145
    obj(c, function(t)
      t.ellipse(x, 29, 6.1, 6.1, M, {0,0,1,0,0,0,0,0,0,0,0,0,0}, {0,1,0,0,0,0,0,0,0,0,0,0,0})
      t.poly({x-6, 31, x+6, 31, x+5, 37, x+2, 39, x-3, 38, x-6, 34}, M)   -- sagging lower half
      t.poly({x+1, 37, x+4, 37, x+4, 45, x+3, 50, x+2, 50, x+1, 45}, M)   -- long drip
      t.poly({x-4, 36, x-2, 37, x-2, 41, x-3, 42, x-4, 41}, M)           -- short drip
      t.rect(x+2, 53, 2, 2, M)                                            -- the drop
    end, function(t)
      t.line(x, 30, x, 25, INK)                                           -- hour hand, still upright
      t.line(x, 30, x+3, 33, INK); t.line(x+3, 33, x+3, 36, INK)          -- minute hand, drooping
      t.px(x, 24, LINE); t.px(x-4, 29, LINE); t.px(x+4, 29, LINE)
      t.px(x+3, 43, LINE)                                                 -- the 6, slid down the drip
      t.px(x-3, 25, M); t.px(x+3, 46, M)
    end)
  end
  -- lift: floor indicator + LIFT plate
  local iy = LIFT_Y - 14   -- counter housing sits on the door frame head
  -- HP6: blank digit face (INK in both modes) inside a LINE bevel; the UI writes the floor number here
  c.rect(EL.counter[1]-2, iy, 32, 12, INK); c.rect(EL.counter[1]-1, iy+1, 30, 10, LINE); c.px(EL.counter[1]-1, iy+1, M)
  local f = EL.counter; c.rect(f[1], f[2], f[3], f[4], INK)
  obj(c, function(t) t.rect(MID//2 - 17, 7, 34, 9, V) end, function(t) text(t, MID//2 - 8, 9, "LIFT", M) end)
  -- SURREAL (flavour a, 11-09): one floating eyeball drifting over the lift lobby, the scene's one googly
  -- prop (ruling 2a). Calm: a MARBLE ball with a TEAL iris looking off to the side, two PINK veins, an INK
  -- pupil + shine, three LINE drift dots trailing below it. Off every UI slot (counter, doors, call plates).
  do local ex, ey = MID//2 - 2, 108
    obj(c, function(t) t.ellipse(ex, ey, 8.1, 7.6, M) end, function(t)
      t.ellipse(ex + 3, ey + 1, 4.1, 4.1, T)
      t.rect(ex + 3, ey, 3, 3, INK)
      t.px(ex + 2, ey - 1, M)
      t.line(ex - 7, ey - 2, ex - 4, ey - 1, P); t.px(ex - 3, ey, P)
      t.line(ex - 6, ey + 4, ex - 3, ey + 3, P)
      t.hline(ex - 4, ey - 6, 4, LINE)
    end)
    for i, d in ipairs({{-6, 13}, {-9, 18}, {-11, 23}}) do c.rect(ex + d[1], ey + d[2], 2 - (i > 2 and 1 or 0), 2 - (i > 2 and 1 or 0), LINE) end
  end
  finish(c)
end

-- ======================= front overlay (covers sprites; also part of the plate) =======================
do
  local c = C.front
  -- Buddy corner office glass front: chunky MARBLE rail, TEAL glass band with two glints, INK outlines,
  -- kick plate hiding the chair casters
  local yRim = A.buddyOffice[2] + A.buddyOffice[4] - 11
  local x0, x1 = 4, 51
  c.rect(x0, yRim-1, x1-x0+1, 4, INK); c.rect(x0, yRim, x1-x0+1, 2, M); c.hline(x0+1, yRim, 5, M)
  for _, px in ipairs({5, 28, 50}) do c.rect(px-1, yRim+3, 3, 8, INK); c.vline(px, yRim+3, 8, M) end
  for _, gx in ipairs({9, 34}) do for i=0,4 do c.px(gx+i, yRim+8-i, M); c.px(gx+i+1, yRim+8-i, M) end end
  c.rect(x0, yRim+10, x1-x0+1, 7, INK); c.rect(x0+1, yRim+11, x1-x0-1, 5, T); c.hline(x0+1, yRim+11, x1-x0-1, M)
  c.px(x0+3, yRim+13, M)
  -- side glass of the office (seen face on): a MARBLE post on the bullpen side
  c.rect(52, FLOOR0, 5, yRim+17-FLOOR0, INK); c.rect(53, FLOOR0, 3, yRim+16-FLOOR0, M); c.vline(55, FLOOR0, yRim+16-FLOOR0, LINE)
  -- lead desk modesty panel: VIOLET, crooked top edge, a gold crown plaque (covers the chair casters)
  local x, y = A.lead[1], A.lead[2]
  c.poly({x-10, y+25, x+42, y+24, x+42, y+37, x-10, y+37}, INK)
  c.poly({x-9, y+26, x+41, y+25, x+41, y+36, x-9, y+36}, V)
  c.hline(x-8, y+26, 20, M); c.hline(x-9, y+32, 51, INK)
  c.rect(x+9, y+27, 14, 8, INK); c.rect(x+10, y+28, 12, 6, A_)
  -- crown plaque in 2x2 blocks (both teams), drawn after the layer's thin pass
  post(c, function()
    local CR = { "a.a.a.a", "aaaaaaa", "ppppppp" }
    local bx, by = E(x+12) + 2, E(y+29) + 1
    for r, row in ipairs(CR) do for i=1,7 do
      local ch = row:sub(i, i)
      if ch ~= "." then
        local col = ch == "a" and INK or P
        c.raw.rect(bx + (i-1)*2, by + (r-1)*2, 2, 2, col); c.raw.rect(W2 - bx - 14 + (i-1)*2, by + (r-1)*2, 2, 2, col)
      end
    end end
  end)
  mirror(c)
  -- lift door frame front (HP6): jambs + threshold over the rider cell edges (hides the rider's shoes)
  local fx, fy = EL.doorA[1] - 3, LIFT_Y
  for _, jx in ipairs({fx, fx+35}) do c.rect(jx, fy+4, 3, 54, INK); c.vline(jx+1, fy+5, 52, M) end
  c.rect(fx, fy+52, 38, 6, INK); c.rect(fx+1, fy+53, 36, 2, M); c.rect(fx+1, fy+55, 36, 2, LINE)
  c.hline(fx+4, fy+55, 30, A_)
  finish(c)
end

-- ======================= light: a few sparkles + glass glints (no dither pools) =======================
do
  local c = C.light
  for _, t in ipairs({{100, 204, P}, {204, 116, A_}, {30, 158, T}}) do
    twinkle(c, t[1], t[2], t[3], M, 1); twinkle(c, W-1-t[1], t[2], t[3], M, 1)
  end
  twinkle(c, 214, 84, T, M, 2)
  twinkle(c, 265, 46, P, M, 1)
  finish(c)
end

-- ======================= slices (contract) =======================
-- every edge x2 (= what the area raster painted)
local function slice(name, r)
  local x0, y0 = E(r[1]), E(r[2])
  local s = spr:newSlice(Rectangle(x0, y0, E(r[1] + r[3]) - x0, E(r[2] + r[4]) - y0))
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
