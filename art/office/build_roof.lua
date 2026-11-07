-- S1v2 penthouse, 3/4 top-down camera (above + behind, ~45deg): art/office/roof.aseprite, 640x200
-- INDEXED (P0), stacks ABOVE the floor plates. [RiffBot lounge | lift top | Overlord office].
-- Bands: sky 0..23, roof deck seen from above 24..47 (tank, AC, dish, VIBE TOWER billboard), cut
-- parapet top 48..51, back wall face 52..103, carpet 104..191, floor slab 192..199.
-- Layers: bg, building, furniture, signs, light, front. "front" = what covers sprites (the balcony
-- railing along the front edge, lift car jambs/sill, door jambs); export_floor.lua writes it on its own.
-- Slices (roof-plate px): penthouse.riffbot.{seat,lounge}, penthouse.overlord.{seat,crtWall},
-- penthouse.elevatorTop. Seats + elevatorTop are 32x32 sprite cells (bottom-centre anchor).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/build_roof.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local KIT = dofile(root.."/art/office/kit34.lua")(L)
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local W, H = 640, 200
local K = KIT.K
local DECK0, CAP0, WALL0, FLOOR0, SLAB = 24, 48, 52, 104, 192

local spr = L.new(W, H, pal)
local C = {}
for _, n in ipairs({ "bg", "building", "furniture", "signs", "light", "front" }) do C[n] = L.canvas(spr, L.layer(spr, n), spr.frames[1]) end

local S = {
  riffSeat = {184, 146, 32, 32}, lounge = {4, 104, 283, 88},
  lordSeat = {434, 146, 32, 32}, crtWall = {380, 72, 140, 29},
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

-- ======================= bg: sky over the roof + sky through the windows =======================
do
  local c = C.bg
  local ramp = { L.SKY, L.VIOLET, L.PINK, L.CORAL }
  for y=0,FLOOR0-1 do
    local t
    if y < DECK0 then t = math.min(0.999, y/26) else t = 1 + math.min(0.999, math.max(0, (y-58)/40)) * 2 end
    local s = math.floor(t)
    for x=0,W-1 do c.px(x, y, L.dith(x, y, ramp[s+1], ramp[math.min(s+2, 4)], t - s)) end
  end
  for _, p in ipairs({{20,6},{48,14},{110,4},{150,18},{200,9},{410,7},{450,16},{500,5},
                      {590,11},{620,3},{170,64},{230,70},{560,66},{604,72}}) do c.px(p[1], p[2], L.MARBLE) end
  L.twinkle(c, 132, 10, L.MARBLE, L.MARBLE, 2); L.twinkle(c, 470, 12, L.MARBLE, L.MARBLE, 2)
  for _, cl in ipairs({{176,70},{588,74},{520,14},{24,16}}) do
    c.ellipse(cl[1], cl[2], 9, 3, L.MARBLE); c.ellipse(cl[1]+8, cl[2]-2, 6, 3, L.MARBLE); c.ellipse(cl[1]-7, cl[2]+1, 5, 2, L.MARBLE)
  end
  -- far city, way below the penthouse windows
  for _, b in ipairs({{126,6,88},{133,9,84},{143,5,90},{150,8,86},{160,10,83},{172,6,89},
                      {180,9,85},{191,7,87},{200,10,84},{212,6,88},{220,9,85},{231,8,86},
                      {241,10,83},{253,7,87},{262,9,85},
                      {532,8,85},{541,6,88},{549,10,83},{561,7,87},{570,9,85},{581,6,89},
                      {589,10,84},{601,8,86},{611,9,85}}) do
    c.rect(b[1], b[3], b[2], 98-b[3], L.INK)
    for wy=b[3]+2, 96, 3 do if (b[1]+wy) % 3 == 0 then c.px(b[1]+2, wy, L.AMBER) end end
  end
  c.commit()
end

-- ======================= building =======================
do
  local c = C.building
  -- roof deck seen from above: gravel PHI with LINE flecks, a drain grid
  c.rect(0, DECK0, W, CAP0-DECK0, L.PHI)
  for y=DECK0, CAP0-1 do for x=0, W-1 do
    if (x*5 + y*11) % 17 == 0 then c.px(x, y, L.LINE) end
  end end
  c.hline(0, DECK0, W, L.INK); c.hline(0, DECK0+1, W, L.LINE)
  -- cut parapet top, then the penthouse back wall face
  c.hline(0, CAP0, W, L.INK); c.rect(0, CAP0+1, W, 2, L.MARBLE); c.hline(0, CAP0+3, W, L.INK)
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
    local x0, x1, y0, y1 = w[1], w[2], 56, 96
    c.rect(x0, y0, x1-x0+1, y1-y0+1, L.INK)
    c.rect(x0+1, y0+1, x1-x0-1, y1-y0-1, L.MARBLE)
    c.hline(x0+1, y1-1, x1-x0-1, L.LINE); c.vline(x1-1, y0+1, y1-y0-1, L.LINE)
    c.rect(x0+3, y0+3, x1-x0-5, y1-y0-5, L.INK)
    for x=x0+4, x1-4 do for y=y0+4, y1-3 do c.px(x, y, 0) end end
    for mxx=x0+50, x1-20, 50 do c.vline(mxx-1, y0+3, y1-y0-4, L.INK); c.vline(mxx, y0+3, y1-y0-4, L.MARBLE); c.vline(mxx+1, y0+3, y1-y0-4, L.INK) end
    c.rect(x0-2, y1+1, x1-x0+5, 2, L.MARBLE); c.hline(x0-2, y1+3, x1-x0+5, L.INK)
  end
  -- carpet (foreshortened lattice) + slab
  c.rect(0, FLOOR0, W, SLAB-FLOOR0, L.PANEL)
  for y=FLOOR0,SLAB-1 do for x=0,W-1 do
    if ((x + 2*y) % 24 == 0 or (x - 2*y) % 24 == 0) and (x % 2 == 0) then c.px(x, y, L.LINE) end
  end end
  c.hline(0, SLAB, W, L.INK); c.hline(0, SLAB+1, W, L.MARBLE); c.rect(0, SLAB+2, W, 5, L.LINE); c.hline(0, H-1, W, L.INK)
  for x=6,W-1,24 do c.rect(x, SLAB+3, 12, 3, L.PHI) end
  c.rect(0, CAP0, 3, H-CAP0, L.INK); c.vline(1, CAP0, SLAB-CAP0, L.MARBLE)
  c.rect(W-3, CAP0, 3, H-CAP0, L.INK); c.vline(W-2, CAP0, SLAB-CAP0, L.MARBLE)

  -- lift core: marble column through the penthouse; machine room box on the roof deck
  c.rect(288, 18, 64, H-18, L.MARBLE)
  c.vline(288, 18, H-18, L.INK); c.vline(351, 18, H-18, L.INK)
  c.vline(289, 19, H-19, L.LINE); c.vline(350, 19, H-19, L.LINE)
  c.hline(288, 18, 64, L.INK); c.rect(289, 19, 62, 4, L.MARBLE); c.hline(289, 22, 62, L.LINE); c.hline(288, 23, 64, L.INK)
  for _, v in ipairs({{292,40,1},{346,90,-1},{293,160,1}}) do
    for i=0,9 do if i % 3 ~= 2 then c.px(v[1] + (v[3] > 0 and i//3 or -(i//3)), v[2]+i, L.LINE) end end
  end
  -- shaft window from the wall top down to the car; pulley wheel at the top
  c.rect(299, 54, 42, 74, L.INK)
  for y=55,126 do for x=300,339 do c.px(x, y, L.dith(x, y, L.SKY, L.VIOLET, math.max(0, (y-80)/50))) end end
  c.ellipse(320, 66, 8, 8, L.INK); c.ellipse(320, 66, 6, 6, L.LINE); c.ellipse(320, 66, 2, 2, L.AMBER)
  for a=0,315,45 do c.line(320, 66, 320 + math.floor(5*math.cos(math.rad(a)) + 0.5), 66 + math.floor(5*math.sin(math.rad(a)) + 0.5), L.INK) end
  c.vline(312, 74, 52, L.INK); c.vline(328, 74, 52, L.INK)
  c.commit()
end

-- ======================= furniture =======================
do
  local c = C.furniture
  -- ---- roof deck: water tank, AC box, satellite dish, billboard legs, antenna ----
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
  c.rect(195, 28, 32, 5, L.INK); c.rect(196, 29, 30, 3, L.MARBLE)  -- AC box top face
  L.plate(c, 196, 34, 30, 12, L.LINE, L.MARBLE, L.INK)
  for x=199,222,3 do c.vline(x, 36, 8, L.INK) end
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
  for _, x in ipairs({284, 354}) do c.rect(x, 26, 3, 22, L.INK); c.px(x+1, 27, L.LINE) end
  c.hline(284, 38, 73, L.INK)
  c.vline(338, 0, 18, L.INK); c.px(338, 0, L.PINK); c.hline(335, 6, 7, L.INK)

  -- ---- RiffBot lounge ----
  -- whiteboard (Win95 window "RIFFS.TXT") with music doodles, on the back wall
  L.plate(c, 16, 56, 96, 42, L.MARBLE, L.MARBLE, L.LINE)
  c.rect(18, 58, 92, 7, L.VIOLET)
  c.rect(102, 59, 5, 5, L.MARBLE); c.px(103, 60, L.INK); c.px(105, 62, L.INK); c.px(105, 60, L.INK); c.px(103, 62, L.INK); c.px(104, 61, L.INK)
  c.stamp(22, 70, [[
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
  -- shag rug (seen from above) + three bean bags
  c.ellipse(72, 160, 66, 18, L.VIOLET)
  for x=12,130,6 do for y=146,174,7 do c.px(x + (y % 2)*3, y, L.PINK) end end
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
  for _, bb in ipairs({{16,140,"p"},{56,150,"g"},{96,140,"a"}}) do
    c.stamp(bb[1], bb[2], (BEAN:gsub("X", bb[3])), K)
  end
  -- synth desk at the RiffBot seat (3/4: desktop from above), floor speakers both sides
  do
    local x, y = S.riffSeat[1], S.riffSeat[2]
    KIT.slab(c, x-3, y+2, 38, 11, L.AMBER, L.CORAL, 3)
    c.rect(x+1, y+5, 20, 6, L.INK); c.rect(x+2, y+6, 18, 4, L.MARBLE)       -- synth keys
    for kx=x+3, x+19, 2 do c.vline(kx, y+6, 2, L.INK) end
    c.px(x+3, y+5, L.PINK); c.px(x+6, y+5, L.MINT); c.px(x+9, y+5, L.AMBER)
    L.plate(c, x+23, y+4, 9, 7, L.LINE, L.MARBLE, L.INK)                     -- mixer
    c.px(x+25, y+6, L.MINT); c.px(x+28, y+7, L.PINK); c.px(x+30, y+6, L.AMBER)
    for _, sx in ipairs({x-15, x+38}) do
      c.rect(sx-1, y-6, 11, 4, L.INK); c.rect(sx, y-5, 9, 2, L.LINE)          -- top face
      L.plate(c, sx, y-1, 9, 22, L.VIOLET, L.MARBLE, L.INK)
      c.ellipse(sx+4, y+5, 3, 3, L.INK); c.px(sx+4, y+5, L.MARBLE)
      c.ellipse(sx+4, y+14, 3, 3, L.INK); c.px(sx+4, y+14, L.MARBLE)
    end
  end
  c.stamp(236, 146, [[
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
      local x, y = x0 + 2 + q*34, y0 + 2 + r*9
      c.rect(x, y, 32, 8, L.MARBLE); c.hline(x, y+7, 32, L.LINE)
      c.rect(x+2, y+1, 24, 5, L.SKY)
      local col = SC[(r*4 + q) % 4 + 1]
      for ly=y+2, y+4, 2 do c.hline(x+4, ly, 6 + ((r+q+ly) % 3)*5, col) end
      c.px(x+29, y+3, (r+q) % 2 == 0 and L.MINT or L.PINK)
    end end
  end
  -- pink rug with gold dots under the big desk
  c.rect(398, 124, 104, 44, L.PINK)
  for x=402,498,6 do for y=128,164,8 do c.px(x + (y//8 % 2)*3, y, L.AMBER) end end
  c.edge(L.PINK, L.INK)
  -- the big desk at the Overlord seat (3/4): gold-trim top, pink front, a big button
  do
    local x, y = S.lordSeat[1], S.lordSeat[2]
    KIT.slab(c, x-16, y+2, 64, 12, L.AMBER, L.PINK, 5)
    c.hline(x-16, y+15, 64, L.AMBER)
    for px0=x-14, x+44, 6 do c.px(px0, y+17, L.AMBER) end
    KIT.keys(c, x+5, y+7)
    c.stamp(x-12, y+3, "|.kkk.|\n|kpppk|\n|kpmpk|\n|kpppk|\n|.kkk.|", K)   -- the button, from above
    c.stamp(x+36, y+4, "|kkkkkkk|\n|kmmmmmk|\n|kmllmmk|\n|kmmmmlk|\n|kkkkkkk|", K) -- memo
  end
  c.stamp(370, 138, [[
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
  c.stamp(586, 136, [[
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

  -- ---- lift top: car + doors + call panels (same kit as the floors) ----
  local cx, cy = 302, S.top[2] - 20
  c.rect(cx, cy, 36, 56, L.INK)
  c.rect(cx+1, cy+1, 34, 16, L.PHI)
  c.rect(cx+1, cy+1, 34, 3, L.LINE); c.hline(cx+10, cy+2, 16, L.AMBER)
  c.hline(cx+1, cy+13, 34, L.MARBLE); c.hline(cx+1, cy+14, 34, L.LINE)
  for _, sx in ipairs({cx+9, cx+18, cx+27}) do c.vline(sx, cy+4, 9, L.LINE) end
  c.rect(cx+29, cy+4, 5, 9, L.INK); for by=cy+5, cy+11, 2 do c.px(cx+31, by, L.AMBER) end
  c.hline(cx+1, cy+17, 34, L.INK)
  for y=cy+18, cy+54 do for x=cx+1, cx+34 do c.px(x, y, ((x//4 + y//3) % 2 == 0) and L.LINE or L.PHI) end end
  for _, x in ipairs({290, 339}) do
    local y, w, h = cy+6, 11, 48
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
  local bx, bw = board(320, 6, "VIBE TOWER", L.AMBER, 19)
  for x=bx+4, bx+bw-5, 6 do c.px(x, 7, L.MARBLE) end
  L.twinkle(c, bx-5, 10, L.MARBLE, L.MARBLE, 2); L.twinkle(c, bx+bw+4, 20, L.AMBER, L.MARBLE, 1)
  local rx, rw = board(206, 50, "RIFF ROOM", L.MARBLE, 16)
  for _, yy in ipairs({52, 63}) do c.hline(rx+2, yy, rw-4, L.MINT) end
  c.vline(rx+2, 52, 12, L.MINT); c.vline(rx+rw-3, 52, 12, L.MINT)
  board(450, 53, "OVERLORD", L.AMBER, 16)
  L.text(c, 21, 59, "RIFFS.TXT", L.MARBLE)
  L.text(c, 74, 72, "JAM AT 4", L.PINK)
  L.text(c, 22, 86, "BIG RIFFS ONLY", L.TEAL)
  L.text(c, 22, 92, "1.VIBE 2.RIFF", L.VIOLET)
  L.twinkle(c, 100, 90, L.AMBER, L.MARBLE, 1)
  c.rect(305, 110, 30, 11, L.INK)
  L.text(c, 316, 113, "PH", L.AMBER)
  c.stamp(308, 113, "|.g.|\n|ggg|", K)
  L.plate(c, 300, 28, 40, 9, L.VIOLET, L.MARBLE, L.LINE)
  L.text(c, 306, 30, "LIFT M", L.MARBLE)
  c.commit()
end

-- ======================= front overlay: balcony railing + lift car front =======================
do
  local c = C.front
  for _, run in ipairs({{3, 287}, {352, 636}}) do
    local x0, x1 = run[1], run[2]
    c.hline(x0, 170, x1-x0+1, L.INK); c.hline(x0, 171, x1-x0+1, L.MARBLE); c.hline(x0, 172, x1-x0+1, L.TEAL)
    c.hline(x0, 173, x1-x0+1, L.INK)
    for x=x0+4, x1-2, 10 do c.vline(x, 174, 13, L.INK); c.vline(x+1, 174, 13, L.MARBLE); c.vline(x+2, 174, 13, L.INK) end
    for gx=x0+8, x1-8, 23 do for i=0,3 do c.px(gx+i, 182-i, L.MARBLE) end end
    c.hline(x0, 187, x1-x0+1, L.INK); c.hline(x0, 188, x1-x0+1, L.TEAL); c.hline(x0, 189, x1-x0+1, L.INK)
  end
  local cx, cy = 302, S.top[2] - 20
  c.rect(cx-2, cy-3, 40, 4, L.INK); c.rect(cx-1, cy-2, 38, 2, L.MARBLE)
  for _, jx in ipairs({cx-2, cx+34}) do
    c.rect(jx, cy, 4, 57, L.INK); c.rect(jx+1, cy, 2, 56, L.MARBLE); c.vline(jx+2, cy, 56, L.LINE)
  end
  c.rect(cx-2, cy+49, 40, 8, L.INK); c.rect(cx+2, cy+50, 32, 2, L.MARBLE); c.rect(cx+2, cy+52, 32, 3, L.LINE)
  c.hline(cx+4, cy+53, 28, L.AMBER)
  for _, x in ipairs({290, 339}) do
    local y, w, h = cy+6, 11, 48
    c.vline(x-1, y-1, h+1, L.INK); c.vline(x+w, y-1, h+1, L.INK)
    c.hline(x-1, y-1, w+2, L.INK); c.hline(x, y+h-1, w, L.MARBLE)
  end
  c.commit()
end

-- ======================= light =======================
do
  local c = C.light
  local fur, fr = C.furniture, C.front
  local function pool(cx, cy, rx, ry, col, maxT, x0, x1)
    for y=cy-ry, cy+ry do for x=cx-rx, cx+rx do
      local d = math.sqrt(((x-cx)/rx)^2 + ((y-cy)/ry)^2)
      if d < 1 and y >= FLOOR0+1 and y < SLAB and x >= x0 and x <= x1 and fur.get(x, y) == 0 and fr.get(x, y) == 0 then
        if (L.BAYER[y%4+1][x%4+1] + 0.5) < maxT*(1-d)*16 then c.px(x, y, col) end
      end
    end end
  end
  pool(450, FLOOR0+6, 90, 16, L.TEAL, 0.5, 356, 634)
  pool(200, FLOOR0+6, 80, 14, L.CORAL, 0.45, 4, 284)
  for _, s in ipairs({{132,112},{172,120},{144,128},{246,116},{120,134},{230,134}}) do L.twinkle(c, s[1], s[2], L.MARBLE, L.MARBLE, 1) end
  L.twinkle(c, 420, 118, L.PINK, L.MARBLE, 1)
  L.twinkle(c, 296, 100, L.TEAL, L.MARBLE, 2)
  c.commit()
end

local function slice(name, r) local s = spr:newSlice(Rectangle(r[1], r[2], r[3], r[4])); s.name = name end
slice("penthouse.riffbot.seat", S.riffSeat); slice("penthouse.riffbot.lounge", S.lounge)
slice("penthouse.overlord.seat", S.lordSeat); slice("penthouse.overlord.crtWall", S.crtWall)
slice("penthouse.elevatorTop", S.top)
spr:saveAs(root.."/art/office/roof.aseprite")
print("wrote roof.aseprite")
