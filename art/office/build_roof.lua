-- S1 penthouse: art/office/roof.aseprite, 640x200 INDEXED (P0), stacks ABOVE the floor plates.
-- [RiffBot lounge | lift top (shaft rises in) | Overlord office], rooftop sky + VIBE TOWER billboard.
-- Bands: sky 0..47, roof parapet 48..53, ceiling 54..63, back wall 64..129, carpet 130..191,
-- floor slab 192..199 (sits on the top floor's ceiling). Layers: bg, building, furniture, signs, light.
-- Slices (roof-plate px): penthouse.riffbot.{seat,lounge}, penthouse.overlord.{seat,crtWall},
-- penthouse.elevatorTop. Seats + elevatorTop are 32x32 sprite cells (bottom-centre anchor).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/build_roof.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local W, H = 640, 200
local K = { k=15, v=8, p=9, c=10, a=11, s=14, m=4, t=7, g=12, y=13, l=3, h=2, n=1 }
local SKY1, ROOF0, CEIL0, WALL0, FLOOR0, SLAB = 47, 48, 54, 64, 130, 192

local spr = L.new(W, H, pal)
local C = {}
for _, n in ipairs({ "bg", "building", "furniture", "signs", "light" }) do C[n] = L.canvas(spr, L.layer(spr, n), spr.frames[1]) end

local S = {
  riffSeat = {184, 146, 32, 32}, lounge = {4, 64, 283, 128},
  lordSeat = {434, 146, 32, 32}, crtWall = {380, 83, 140, 45},
  top = {304, 146, 32, 32},
}

local function textBig(c, x, y, s, col, sh)
  for pass=1,2 do
    for n=1,#s do
      local g = L.F[s:sub(n,n)] or L.F[" "]
      for r=0,4 do for q=0,2 do
        if g:sub(r*3+q+1, r*3+q+1) == "1" then
          local px0, py0 = x + (n-1)*8 + q*2, y + r*2
          if pass == 1 and sh then c.rect(px0+1, py0+1, 2, 2, sh) elseif pass == 2 then c.rect(px0, py0, 2, 2, col) end
        end
      end end
    end
  end
end
local function bigW(s) return #s*8 - 2 end

-- ======================= bg: rooftop sky + window sky =======================
do
  local c = C.bg
  local ramp = { L.SKY, L.VIOLET, L.PINK, L.CORAL }
  for y=0,SLAB-1 do
    local t
    if y <= SKY1 then t = math.min(0.999, y/50) * 2 else t = 1 + math.min(0.999, (y-WALL0)/60) * 2 end
    local s = math.floor(t)
    for x=0,W-1 do c.px(x, y, L.dith(x, y, ramp[s+1], ramp[math.min(s+2, 4)], t - s)) end
  end
  for _, p in ipairs({{20,6},{48,14},{110,4},{150,20},{200,9},{236,25},{410,7},{450,18},{500,5},
                      {530,24},{590,11},{620,3},{170,74},{230,80},{560,76},{604,88}}) do c.px(p[1], p[2], L.MARBLE) end
  L.twinkle(c, 132, 12, L.MARBLE, L.MARBLE, 2); L.twinkle(c, 470, 14, L.MARBLE, L.MARBLE, 2)
  -- clouds
  for _, cl in ipairs({{176,38},{214,96},{588,100},{520,40}}) do
    c.ellipse(cl[1], cl[2], 9, 3, L.MARBLE); c.ellipse(cl[1]+8, cl[2]-2, 6, 3, L.MARBLE); c.ellipse(cl[1]-7, cl[2]+1, 5, 2, L.MARBLE)
  end
  -- far city, way below the penthouse windows
  for _, b in ipairs({{126,6,114},{133,9,110},{143,5,116},{150,8,112},{160,10,108},{172,6,115},
                      {180,9,111},{191,7,113},{200,10,109},{212,6,114},{220,9,110},{231,8,112},
                      {241,10,108},{253,7,113},{262,9,111},
                      {532,8,110},{541,6,114},{549,10,108},{561,7,113},{570,9,111},{581,6,115},
                      {589,10,109},{601,8,112},{611,9,110}}) do
    c.rect(b[1], b[3], b[2], 122-b[3], L.INK)
    for wy=b[3]+2, 120, 3 do if (b[1]+wy) % 3 == 0 then c.px(b[1]+2, wy, L.AMBER) end end
  end
  c.commit()
end

-- ======================= building =======================
do
  local c = C.building
  -- roof parapet
  c.hline(0, ROOF0, W, L.INK); c.hline(0, ROOF0+1, W, L.MARBLE)
  c.rect(0, ROOF0+2, W, 3, L.LINE); c.hline(0, ROOF0+5, W, L.INK)
  -- ceiling
  c.rect(0, CEIL0, W, 9, L.PANEL)
  for x=0,W-1,20 do c.vline(x, CEIL0, 9, L.LINE) end
  c.hline(0, CEIL0+9, W, L.INK)
  -- back wall with two window holes
  c.rect(0, WALL0, W, FLOOR0-WALL0, L.PHI)
  local TILE = { "........", ".v......", "v.v.....", "...v....", "........", ".....l..", "....lll.", ".....l.." }
  for y=WALL0,FLOOR0-7 do for x=0,W-1 do
    local ty, tx = (y-WALL0) % 8, (x + ((y-WALL0)//8 % 2)*4) % 8
    local ch = TILE[ty+1]:sub(tx+1, tx+1)
    if ch ~= "." then c.px(x, y, K[ch]) end
  end end
  c.hline(0, FLOOR0-6, W, L.INK); c.rect(0, FLOOR0-5, W, 4, L.LINE); c.hline(0, FLOOR0-5, W, L.MARBLE)
  c.hline(0, FLOOR0-1, W, L.INK)
  for _, w in ipairs({{124, 276}, {530, 626}}) do
    local x0, x1, y0, y1 = w[1], w[2], 67, 123
    c.rect(x0, y0, x1-x0+1, y1-y0+1, L.INK)
    c.rect(x0+1, y0+1, x1-x0-1, y1-y0-1, L.MARBLE)
    c.hline(x0+1, y1-1, x1-x0-1, L.LINE); c.vline(x1-1, y0+1, y1-y0-1, L.LINE)
    c.rect(x0+3, y0+3, x1-x0-5, y1-y0-5, L.INK)
    for x=x0+4, x1-4 do for y=y0+4, y1-4 do c.px(x, y, 0) end end
    for mxx=x0+50, x1-20, 50 do c.vline(mxx-1, y0+3, y1-y0-5, L.INK); c.vline(mxx, y0+3, y1-y0-5, L.MARBLE); c.vline(mxx+1, y0+3, y1-y0-5, L.INK) end
  end
  -- carpet + slab
  c.rect(0, FLOOR0, W, SLAB-FLOOR0, L.PANEL)
  for y=FLOOR0,SLAB-1 do for x=0,W-1 do
    if ((x + y) % 16 == 0 or (x - y) % 16 == 0) and (x % 2 == 0) then c.px(x, y, L.LINE) end
  end end
  c.hline(0, SLAB, W, L.INK); c.hline(0, SLAB+1, W, L.MARBLE); c.rect(0, SLAB+2, W, 5, L.LINE); c.hline(0, H-1, W, L.INK)
  for x=6,W-1,24 do c.rect(x, SLAB+3, 12, 3, L.PHI) end
  c.rect(0, ROOF0, 3, H-ROOF0, L.INK); c.rect(W-3, ROOF0, 3, H-ROOF0, L.INK)

  -- lift core: marble column through the penthouse, machine room on the roof
  c.rect(288, 20, 64, H-20, L.MARBLE)
  c.vline(288, 20, H-20, L.INK); c.vline(351, 20, H-20, L.INK)
  c.vline(289, 21, H-21, L.LINE); c.vline(350, 21, H-21, L.LINE)
  c.hline(288, 20, 64, L.INK); c.hline(289, 21, 62, L.MARBLE)
  for _, v in ipairs({{292,30,1},{346,90,-1},{293,160,1}}) do
    for i=0,9 do if i % 3 ~= 2 then c.px(v[1] + (v[3] > 0 and i//3 or -(i//3)), v[2]+i, L.LINE) end end
  end
  -- shaft window from just under the ceiling to the floor; pulley wheel at the top
  c.rect(299, CEIL0+10, 42, SLAB-CEIL0-10, L.INK)
  for y=CEIL0+11,SLAB-1 do for x=300,339 do c.px(x, y, L.dith(x, y, L.SKY, L.VIOLET, math.max(0, (y-120)/80))) end end
  c.ellipse(320, 76, 9, 9, L.INK); c.ellipse(320, 76, 7, 7, L.LINE); c.ellipse(320, 76, 2, 2, L.AMBER)
  for a=0,315,45 do c.line(320, 76, 320 + math.floor(6*math.cos(math.rad(a)) + 0.5), 76 + math.floor(6*math.sin(math.rad(a)) + 0.5), L.INK) end
  c.rect(305, 64, 30, 3, L.INK)
  c.vline(312, 78, 56, L.INK); c.vline(328, 78, 56, L.INK)
  c.commit()
end

-- ======================= furniture =======================
local deskMap
do
  local P = dofile(root.."/art/cast/hypno/floor.lua")
  local rows = {}
  for row in P.desk[1][3]:gmatch("[^\n]+") do rows[#rows+1] = row:gsub("^%s*|", ""):gsub("|%s*$", ""):reverse() end
  deskMap = { y = P.desk[1][2], art = "|"..table.concat(rows, "|\n|").."|" }
end
do
  local c = C.furniture
  -- ---- rooftop: water tank, AC box, satellite dish, billboard legs ----
  c.stamp(56, 12, [[
|....kkkkkkkkkkkkkkkk....|
|..kkmmmmmmmmmmmmmmmmkk..|
|.kmmmmmmmmmmmmmmmmmmmlk.|
|kkkkkkkkkkkkkkkkkkkkkkkk|
|kmmmmmmmmmmmmmmmmmmmmmlk|
|kmmmmmmmmmmmmmmmmmmmmmlk|
|kkkkkkkkkkkkkkkkkkkkkkkk|
|kmmmmmmmmmmmmmmmmmmmmmlk|
|kmmmmmmmmmmmmmmmmmmmmmlk|
|kkkkkkkkkkkkkkkkkkkkkkkk|
|kmmmmmmmmmmmmmmmmmmmmmlk|
|kmmmmmmmmmmmmmmmmmmmmmlk|
|kkkkkkkkkkkkkkkkkkkkkkkk|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|.kkkk..kkkk..kkkk..kkkk.|
|........................|
]], K)
  L.plate(c, 196, 34, 30, 13, L.LINE, L.MARBLE, L.INK)
  for x=199,222,3 do c.vline(x, 36, 9, L.INK) end
  c.stamp(560, 18, [[
|.........kkk...|
|.......kkmmmk..|
|.....kkmmmmmlk.|
|...kkmmmmmmmlk.|
|..kmmmmmmmmmlk.|
|.kmmmmkmmmmlk..|
|.kmmmmmkmmlk...|
|kmmmmmmmkkk....|
|kmmmmmmlk.ka...|
|.kmmmllk.......|
|..kkkkk........|
|....kk.........|
|....kk.........|
|....kk.........|
|....kk.........|
|....kk.........|
|....kk.........|
|....kk.........|
|....kk.........|
|...kkkk........|
|..kkkkkk.......|
]], K)
  -- billboard legs (the board itself is a sign)
  for _, x in ipairs({284, 354}) do c.rect(x, 30, 3, 18, L.INK); c.px(x+1, 31, L.LINE) end
  c.hline(284, 40, 73, L.INK)
  -- antenna on the machine room
  c.vline(338, 2, 18, L.INK); c.px(338, 1, L.PINK); c.hline(335, 8, 7, L.INK)

  -- ---- RiffBot lounge ----
  -- whiteboard (Win95 window "RIFFS.TXT") with music doodles
  L.plate(c, 16, 70, 96, 50, L.MARBLE, L.MARBLE, L.LINE)
  c.rect(18, 72, 92, 7, L.VIOLET)
  c.rect(102, 73, 5, 5, L.MARBLE); c.px(103, 74, L.INK); c.px(105, 76, L.INK); c.px(105, 74, L.INK); c.px(103, 76, L.INK); c.px(104, 75, L.INK)
  c.stamp(22, 84, [[
|.....kk.............ppp.......t.t.t...........aaa.......|
|.....kpk...........p...p.....t.t.t.t.........a...a......|
|.....k.k...kk.......p...........t.....g.g...a.....a.....|
|.....k....kpk.......p...........t....g.g.g...a...a......|
|...kkk....k.k......p...........t......g.g.....aaa.......|
|..kpppk...k.......p.....g.....t.................a.......|
|...kkk..kkk.......ppppp..g...........kk.........a.......|
|.......kpppk..............g.g.......kpk..pp.....a.......|
|........kkk.................g......kk.k.p..p....a.......|
|...................................kpk..p..p....a.......|
|..ttt.....tt......tt......tt........k....pp............|
|.t...t...t..t....t..t....t..t...........................|
|t.....t.t....t..t....t..t....t..........................|
|.......t......tt......tt......t.........................|
|..............................t.........................|
]], K)
  -- shag rug + three bean bags
  c.ellipse(70, 180, 62, 9, L.VIOLET)
  for x=12,128,6 do c.px(x, 178, L.PINK); c.px(x+3, 182, L.PINK) end
  c.edge(L.VIOLET, L.INK)
  local BEAN = [[
|.........kkkkk................|
|.......kkXXXXXkk..............|
|......kXXXXXXXXXk.............|
|.....kXXmXXXXXXXXk............|
|.....kXmXXXXXXXXXXkkkk........|
|....kXXXXXXXXXXXXkXXXXkkk.....|
|....kXXXXXXXXXXXkXXXXXXXXkk...|
|...kXXXXXXXXXXXXkXXXXXXXXXXk..|
|...kXXXXXXXXXXXXXkkXXXXXXXXXk.|
|..kXXXXXXXXXXXXXXXXkkkXXXXXXk.|
|..kXXXXXXXXXXXXXXXXXXXXXXXXXXk|
|.kXXXXXXXXXXXXXXXXXXXXXXXXXXXk|
|.kXXXXXXXXXXXXXXXXXXXXXXXXXXXk|
|.kXXXXXXXXXXXXXXXXXXXXXXXXXXk.|
|..kkXXXXXXXXXXXXXXXXXXXXXXkk..|
|....kkkkkkkkkkkkkkkkkkkkkk....|
]]
  for _, bb in ipairs({{16,163,"p"},{56,165,"g"},{96,163,"a"}}) do
    c.stamp(bb[1], bb[2], (BEAN:gsub("X", bb[3])), K)
  end
  -- disco ball
  c.vline(152, CEIL0+9, 5, L.INK)
  c.ellipse(152, 74, 6, 6, L.MARBLE)
  for y=69,79,3 do c.hline(146, y, 13, L.LINE) end
  for x=148,157,3 do c.vline(x, 69, 11, L.LINE) end
  c.outline(L.INK)
  -- synth desk at the RiffBot seat (same desk geometry as the floor desks), speakers both sides
  do
    local x, y = S.riffSeat[1], S.riffSeat[2]
    c.rect(x-3, y+15, 38, 3, L.AMBER); c.hline(x-3, y+15, 23, L.INK)
    c.vline(x-4, y+15, 7, L.INK); c.vline(x+35, y+15, 7, L.INK)
    c.hline(x-3, y+18, 38, L.INK); c.hline(x-3, y+19, 38, L.AMBER); c.hline(x-3, y+20, 38, L.CORAL)
    c.hline(x-3, y+21, 38, L.INK)
    L.plate(c, x-3, y+22, 38, 8, L.LINE, L.MARBLE, L.INK)
    -- little mixer (no monitor, so the head reads against the window)
    L.plate(c, x+21, y+11, 11, 5, L.LINE, L.MARBLE, L.INK)
    c.px(x+23, y+12, L.MINT); c.px(x+26, y+13, L.PINK); c.px(x+29, y+12, L.AMBER)
    -- synth keys on the desktop
    c.rect(x-2, y+12, 20, 4, L.INK); c.rect(x-1, y+13, 18, 2, L.MARBLE)
    for kx=x, x+16, 2 do c.px(kx, y+13, L.INK) end
    c.px(x+1, y+12, L.PINK); c.px(x+4, y+12, L.MINT)
    for _, sx in ipairs({x-14, x+37}) do
      L.plate(c, sx, y+6, 9, 25, L.VIOLET, L.MARBLE, L.INK)
      c.ellipse(sx+4, y+12, 3, 3, L.INK); c.px(sx+4, y+12, L.MARBLE)
      c.ellipse(sx+4, y+22, 3, 3, L.INK); c.px(sx+4, y+22, L.MARBLE)
    end
  end
  -- record crate
  c.stamp(240, 164, [[
|k.k.k.k.k.k.k.k.k.k.|
|kpkakgktkpkakgktkpk.|
|kkkkkkkkkkkkkkkkkkkk|
|kaaaaaaaaaaaaaaaaaak|
|kakkkkkkkkkkkkkkkkak|
|kaaaaaaaaaaaaaaaaaak|
|kakkkkkkkkkkkkkkkkak|
|kaaaaaaaaaaaaaaaaaak|
|kkkkkkkkkkkkkkkkkkkk|
]], K)

  -- ---- Overlord office ----
  -- CRT wall: 4x3 rack of tiny monitors, one per team
  do
    local x0, y0, w, h = S.crtWall[1], S.crtWall[2], S.crtWall[3], S.crtWall[4]
    c.rect(x0, y0, w, h, L.INK)
    local SC = { L.TEAL, L.MINT, L.PINK, L.AMBER }
    for r=0,2 do for q=0,3 do
      local x, y = x0 + 2 + q*34, y0 + 2 + r*14
      c.rect(x, y, 32, 13, L.MARBLE); c.hline(x, y+12, 32, L.LINE)
      c.rect(x+2, y+2, 24, 9, L.SKY)
      local col = SC[(r*4 + q) % 4 + 1]
      for ly=y+4, y+8, 2 do c.hline(x+4, ly, 6 + ((r+q+ly) % 3)*5, col) end
      c.px(x+29, y+9, (r+q) % 2 == 0 and L.MINT or L.PINK)
    end end
  end
  -- the big desk at the Overlord seat: gold trim, pink front, a big red-ish button
  do
    local x, y = S.lordSeat[1], S.lordSeat[2]
    c.rect(x-16, y+15, 64, 3, L.AMBER); c.hline(x-16, y+15, 36, L.INK)
    c.rect(x-16, y+18, 64, 4, L.AMBER); c.hline(x-16, y+18, 64, L.INK); c.hline(x-16, y+20, 64, L.CORAL)
    c.hline(x-16, y+21, 64, L.INK); c.vline(x-17, y+15, 7, L.INK); c.vline(x+48, y+15, 7, L.INK)
    L.plate(c, x-16, y+22, 64, 9, L.PINK, L.AMBER, L.INK)
    for px0=x-14, x+44, 6 do c.px(px0, y+26, L.AMBER) end
    c.stamp(x, y + deskMap.y, deskMap.art)
    c.stamp(x-13, y+10, "|.kkk.|\n|kpppk|\n|kpmpk|\n|kkkkk|\n|kaaak|", K)
  end
  -- globe on a stand, marble bust in shades, pink carpet runner
  c.stamp(372, 146, [[
|...kkkkk...|
|.kktttgtkk.|
|ktttgggtttk|
|kttgggttttk|
|ktttgtttggk|
|ktttttttggk|
|.kktttttkk.|
|...kkkkk...|
|....kak....|
|....kak....|
|....kak....|
|....kak....|
|....kak....|
|....kak....|
|....kak....|
|....kak....|
|....kak....|
|....kak....|
|....kak....|
|....kak....|
|..kkkkkkk..|
|.kaaaaaaak.|
|.kkkkkkkkk.|
]], K)
  c.stamp(586, 144, [[
|.......kkkkkkk........|
|......kmmmmmmmk.......|
|.....kmmmmmmmmmk......|
|....kmmlmmmmmmmmk.....|
|....kmmmmmmmmmmmk.....|
|....kkkkkkkkkkkkk.....|
|....kpkpkpkkpkpkk.....|
|....kkkkkkkkkkkkk.....|
|.....kmmmmlmmmmk......|
|......kmmllmmmk.......|
|.......kmmmmmk........|
|....kkkmmmmmmmkkk.....|
|..kkmmmmmmmmmmmmmkk...|
|.kkkkkkkkkkkkkkkkkk...|
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
  c.rect(380, 183, 140, 6, L.PINK); c.edge(L.PINK, L.INK)
  for x=384,516,6 do c.px(x, 185, L.AMBER) end

  -- ---- lift top: car + doors + call panels (same kit as the floors) ----
  local cx, cy = 302, S.top[2] - 12
  c.rect(cx, cy, 36, 46, L.INK)
  c.rect(cx+1, cy+1, 34, 44, L.PHI)
  c.rect(cx+1, cy+1, 34, 3, L.LINE); c.hline(cx+10, cy+2, 16, L.AMBER)
  c.hline(cx+1, cy+30, 34, L.MARBLE); c.hline(cx+1, cy+31, 34, L.LINE)
  c.rect(cx+1, cy+42, 34, 3, L.LINE); c.hline(cx+1, cy+42, 34, L.INK)
  for _, sx in ipairs({cx+9, cx+18, cx+27}) do c.vline(sx, cy+4, 26, L.LINE) end
  c.rect(cx+29, cy+10, 5, 14, L.INK)
  for by=cy+12, cy+21, 3 do c.px(cx+31, by, L.AMBER) end
  c.px(cx+31, cy+22, L.PINK)
  for _, x in ipairs({290, 339}) do
    local y, w, h = cy-2, 11, 48
    c.rect(x, y, w, h, L.INK)
    c.rect(x+1, y+1, w-2, h-1, L.TEAL)
    c.vline(x+1, y+1, h-1, L.MARBLE)
    c.vline(x + w//2, y+1, h-1, L.INK)
    c.rect(x+2, y+8, 3, 10, L.SKY); c.rect(x+w-5, y+8, 3, 10, L.SKY)
    c.rect(x+1, y-10, w-2, 8, L.INK)
    c.hline(x + w//2 - 1, y-5, 3, L.PINK); c.px(x + w//2, y-4, L.PINK)
  end
  c.commit()
end

-- ======================= signs =======================
do
  local c = C.signs
  local function board(cx, y, label, face, h)
    local w = bigW(label) + 12
    local x = cx - w//2
    L.plate(c, x, y, w, h or 17, face, L.MARBLE, L.CORAL)
    c.hline(x+2, y+2, w-4, L.PINK); c.hline(x+2, y+(h or 17)-3, w-4, L.PINK)
    textBig(c, x+6, y+4, label, L.INK, L.CORAL)
    return x, w
  end
  -- rooftop billboard
  local bx, bw = board(320, 8, "VIBE TOWER", L.AMBER, 19)
  for x=bx+4, bx+bw-5, 6 do c.px(x, 9, L.MARBLE) end
  L.twinkle(c, bx-5, 12, L.MARBLE, L.MARBLE, 2); L.twinkle(c, bx+bw+4, 22, L.AMBER, L.MARBLE, 1)
  -- lounge sign hanging from the ceiling, office nameplate over the CRT wall
  c.vline(176, CEIL0+9, 3, L.INK); c.vline(236, CEIL0+9, 3, L.INK)
  local rx, rw = board(206, 66, "RIFF ROOM", L.MARBLE, 16)
  for _, yy in ipairs({68, 79}) do c.hline(rx+2, yy, rw-4, L.MINT) end
  c.vline(rx+2, 68, 12, L.MINT); c.vline(rx+rw-3, 68, 12, L.MINT)
  board(450, 65, "OVERLORD", L.AMBER, 16)
  L.text(c, 21, 73, "RIFFS.TXT", L.MARBLE)
  L.text(c, 74, 86, "JAM AT 4", L.PINK)
  L.text(c, 22, 103, "BIG RIFFS ONLY", L.TEAL)
  L.text(c, 22, 110, "1.VIBE 2.RIFF", L.VIOLET)
  L.twinkle(c, 100, 106, L.AMBER, L.MARBLE, 1)
  -- PH indicator over the lift top
  c.rect(305, S.top[2]-30, 30, 13, L.INK)
  L.text(c, 316, S.top[2]-26, "PH", L.AMBER)
  c.stamp(308, S.top[2]-26, "|.g.|\n|ggg|", K)
  -- rooftop machine-room plate
  L.plate(c, 300, 30, 40, 9, L.VIOLET, L.MARBLE, L.LINE)
  L.text(c, 306, 32, "LIFT M", L.MARBLE)
  c.commit()
end

-- ======================= light =======================
do
  local c = C.light
  local fur = C.furniture
  local function pool(cx, cy, rx, ry, col, maxT, x0, x1)
    for y=cy-ry, cy+ry do for x=cx-rx, cx+rx do
      local d = math.sqrt(((x-cx)/rx)^2 + ((y-cy)/ry)^2)
      if d < 1 and y >= FLOOR0+1 and y < SLAB and x >= x0 and x <= x1 and fur.get(x, y) == 0 then
        if (L.BAYER[y%4+1][x%4+1] + 0.5) < maxT*(1-d)*16 then c.px(x, y, col) end
      end
    end end
  end
  pool(450, FLOOR0+6, 90, 14, L.TEAL, 0.5, 356, 634)        -- CRT-wall glow on the office carpet
  pool(200, FLOOR0+4, 80, 10, L.CORAL, 0.45, 4, 284)        -- sunset spill in the lounge
  -- disco sparkles
  for _, s in ipairs({{132,92},{172,100},{144,110},{166,86},{120,140},{190,128}}) do L.twinkle(c, s[1], s[2], L.MARBLE, L.MARBLE, 1) end
  L.twinkle(c, 152, 74, L.MARBLE, L.MARBLE, 2)
  L.twinkle(c, 420, 140, L.PINK, L.MARBLE, 1)
  L.twinkle(c, 296, 100, L.TEAL, L.MARBLE, 2)
  c.commit()
end

local function slice(name, r) local s = spr:newSlice(Rectangle(r[1], r[2], r[3], r[4])); s.name = name end
slice("penthouse.riffbot.seat", S.riffSeat); slice("penthouse.riffbot.lounge", S.lounge)
slice("penthouse.overlord.seat", S.lordSeat); slice("penthouse.overlord.crtWall", S.crtWall)
slice("penthouse.elevatorTop", S.top)
spr:saveAs(root.."/art/office/roof.aseprite")
print("wrote roof.aseprite")
