-- U3a style frame: airbrushed 90s vaporwave UI (sidebar + one window), hand-painted.
-- One INDEXED 480x270 canvas, P0 slots only, exported with the dark and light palettes
-- (pure swap) at 4x nearest. Same hand as H0: lib.lua helpers, 3x5 font, ASCII stamps.
-- Airbrush grain = hand-authored 8x8 spray threshold matrix (SPRAY below), placed per pixel.
-- No filters, no blur, no generated imagery.
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/ui/u3a/paint.lua
local root = app.params.root
local dir = root.."/art/ui/u3a/"
local L = dofile(root.."/art/cast/hypno/lib.lua")
local BG,PANEL,PHI,LINE,MARBLE,TEXT,MUTED,TEAL,VIOLET,PINK,CORAL,AMBER,MINT,SKY,SKIN,INK =
  0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15

local pal = { dark = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" },
              light = Palette{ fromFile = root.."/art/palette/pc98-light.gpl" } }
-- Light surfaces follow the U2 swatch A that the owner picked (src/styles.css light block):
-- the P0 light BG #fdf4ec was the flash-bang. Slots stay index-matched.
for i, hex in pairs({ [0]=0xe0d1dc, [1]=0xebe0e8, [2]=0xd6c2d0, [3]=0xb092a7, [6]=0x574268 }) do
  pal.light:setColor(i, Color{ r = hex >> 16, g = (hex >> 8) & 255, b = hex & 255 })
end

local W, H = 480, 270
local spr = L.new(W, H, pal.dark)
-- opaque painting: slot 0 is BG paint here; export reads the cel image directly
local C = L.canvas(spr, spr.layers[1], spr.frames[1])

-- ---------------------------------------------------------------- spray grain
-- Hand-laid 8x8 threshold matrix (every value 0..63 once), clumped on purpose so
-- coverage reads as airbrush speckle, not an ordered Bayer cross-hatch.
local SPRAY = {
  {34,12,50, 3,41,22,59, 8},
  {57,27, 6,45,17,63,30,46},
  { 1,39,61,24,53, 9,37,20},
  {48,15,32,11,35,49, 2,56},
  {25,58, 4,43,28,18,42,13},
  {40, 7,52,19,62, 5,31,60},
  {16,44,29,36,10,55,23,38},
  {54,21,47, 0,33,26,51,14},
}
do local seen = {}; for _, r in ipairs(SPRAY) do for _, v in ipairs(r) do
  assert(not seen[v], "SPRAY dup "..v); seen[v] = true end end end
-- tiles are shifted per 8px block so the matrix never lines up into a visible grid
local function grain(x, y)
  local bx, by = x // 8, y // 8
  return SPRAY[(y + bx*5) % 8 + 1][(x + by*3) % 8 + 1]
end
local function hit(x, y, t) return grain(x, y) + 0.5 < t*64 end
local function clamp(v) return v < 0 and 0 or (v > 1 and 1 or v) end

-- multi-stop gradient, vertical or horizontal, grain-blended between stops
local function grad(x, y, w, h, cols, horiz)
  local n = #cols
  for j=0,h-1 do for i=0,w-1 do
    local f = horiz and i/math.max(1, w-1) or j/math.max(1, h-1)
    local s = f*(n-1); local k = math.min(n-1, math.floor(s)); local t = s - k
    if k >= n-1 then C.px(x+i, y+j, cols[n])
    else C.px(x+i, y+j, hit(x+i, y+j, t) and cols[k+2] or cols[k+1]) end
  end end
end

-- soft airbrush puff: coverage falls off smoothly to a fuzzy grain edge; clip = stencil
local function puff(cx, cy, rx, ry, c, amt, clip)
  for y=math.floor(cy-ry), math.ceil(cy+ry) do for x=math.floor(cx-rx), math.ceil(cx+rx) do
    if not clip or (x >= clip[1] and y >= clip[2] and x <= clip[3] and y <= clip[4]) then
      local d = ((x-cx)/rx)^2 + ((y-cy)/ry)^2
      if d < 1 and hit(x, y, amt*(1-d)^2) then C.px(x, y, c) end
    end
  end end
end

-- airbrush stroke along a segment; tapers at both ends like a hand pass
local function stroke(x0, y0, x1, y1, r, c, amt, clip)
  local dx, dy = x1-x0, y1-y0; local len2 = dx*dx + dy*dy
  for y=math.floor(math.min(y0,y1)-r), math.ceil(math.max(y0,y1)+r) do
    for x=math.floor(math.min(x0,x1)-r), math.ceil(math.max(x0,x1)+r) do
      if not clip or (x >= clip[1] and y >= clip[2] and x <= clip[3] and y <= clip[4]) then
        local t = clamp(((x-x0)*dx + (y-y0)*dy) / len2)
        local px, py = x0 + t*dx, y0 + t*dy
        local d = math.sqrt((x-px)^2 + (y-py)^2) / r
        local taper = math.sin(t*math.pi)
        if d < 1 and hit(x, y, amt*taper*(1-d*d)) then C.px(x, y, c) end
      end
    end
  end
end

-- sparse speckle texture (paper tooth under the spray)
local function speck(x, y, w, h, c, amt)
  for j=0,w > 0 and h-1 or -1 do for i=0,w-1 do
    if hit(x+i+13, y+j+7, amt*0.12) then C.px(x+i, y+j, c) end
  end end
end

-- mall-art sparkle: sprayed halo, long tapering arms, hard white core
local function sparkle(cx, cy, len, halo)
  if halo then puff(cx, cy, len*0.9, len*0.9, halo, 0.45) end
  for k=1,len do
    local t = 1 - (k-1)/len
    for _, d in ipairs({{1,0},{-1,0},{0,1},{0,-1}}) do
      local x, y = cx + d[1]*k, cy + d[2]*k
      if k <= 2 or hit(x, y, t*1.1) then C.px(x, y, MARBLE) end
    end
  end
  if len >= 4 then C.px(cx-1, cy-1, MARBLE); C.px(cx+1, cy+1, MARBLE)
    C.px(cx+1, cy-1, MARBLE); C.px(cx-1, cy+1, MARBLE) end
  C.px(cx, cy, MARBLE)
end
local function star(x, y, c) C.px(x, y, c); C.px(x-1, y, c); C.px(x+1, y, c); C.px(x, y-1, c); C.px(x, y+1, c) end

-- ---------------------------------------------------------------- type
-- 3x5 font from lib + the few marks the UI needs
L.F["@"] = "011101111100011"; L.F[">"] = "100010001010100"; L.F["%"] = "101001010100101"
L.F["<"] = "001010100010001"; L.F[","] = "000000000010100"; L.F["?"] = "110001010000010"
L.F["_"] = "000000000000111"; L.F["'"] = "010010000000000"
local text, textW = L.text, L.textW

-- chunky 7px chrome face (hand-drawn, variable width) for headers and the brand
local CHROME = {
  A={".####.","##..##","##..##","######","##..##","##..##","##..##"},
  B={"#####.","##..##","#####.","##..##","##..##","##..##","#####."},
  C={".#####","##....","##....","##....","##....","##....",".#####"},
  D={"#####.","##..##","##..##","##..##","##..##","##..##","#####."},
  E={"######","##....","#####.","##....","##....","##....","######"},
  F={"######","##....","#####.","##....","##....","##....","##...."},
  I={"####",".##.",".##.",".##.",".##.",".##.","####"},
  L={"##....","##....","##....","##....","##....","##....","######"},
  M={"##...##","###.###","#######","##.#.##","##...##","##...##","##...##"},
  O={".####.","##..##","##..##","##..##","##..##","##..##",".####."},
  P={"#####.","##..##","##..##","#####.","##....","##....","##...."},
  Q={".####.","##..##","##..##","##..##","##.###","##..##",".###.#"},
  R={"#####.","##..##","##..##","#####.","##.##.","##..##","##..##"},
  S={".#####","##....","##....",".####.","....##","....##","#####."},
  U={"##..##","##..##","##..##","##..##","##..##","##..##",".####."},
  V={"##..##","##..##","##..##","##..##",".####.",".####.","..##.."},
  [" "]={"...","...","...","...","...","...","..."},
}
-- chrome bands (index per row), horizon split: sky-white / teal reflection / dark horizon / warm ground
local BANDS = {
  -- cool half is MARBLE/VIOLET (light in both palettes); TEAL only as the line above the horizon
  small = { MARBLE, MARBLE, {MARBLE,VIOLET}, VIOLET, TEAL, PINK, PINK, CORAL, {CORAL,AMBER}, AMBER },
  big   = { MARBLE, MARBLE, MARBLE, {MARBLE,VIOLET}, VIOLET, VIOLET, TEAL, INK,
            PINK, PINK, {PINK,CORAL}, CORAL, {CORAL,AMBER}, AMBER },
}
-- source 7-row glyphs grow by row/column maps: small = 10 rows, 2px stems; big = 14 rows, 3px stems
local ROWMAP = { small = {1,1,2,3,4,4,5,6,7,7}, big = {1,1,2,2,3,3,4,4,5,5,6,6,7,7} }
local COLMAP = { [3] = {2,1,1}, [4] = {1,2,1,1}, [6] = {2,1,1,1,1,2}, [7] = {2,1,1,1,1,1,2} }
local function chrome(x0, y0, s, size)
  local rows, bands = ROWMAP[size], BANDS[size]
  local mask, starts = {}, {}
  local x = x0
  for n=1,#s do
    local g = CHROME[s:sub(n,n)]
    local cm = size == "big" and COLMAP[#g[1]] or nil
    local cx = {}; local acc = 0
    for q=1,#g[1] do cx[q] = acc; acc = acc + (cm and cm[q] or 1) end
    starts[n] = x
    for r, src in ipairs(rows) do local row = g[src]
      for q=1,#row do if row:sub(q,q) == "#" then
        for k=0,(cm and cm[q] or 1)-1 do mask[(y0+r-1)*W + x+cx[q]+k] = r end
      end end
    end
    x = x + acc + (size == "big" and 2 or 1)
  end
  local ring = {}
  for key, _ in pairs(mask) do
    local px, py = key % W, key // W
    for dy=-1,1 do for dx=-1,1 do
      local q = (py+dy)*W + px+dx
      if not mask[q] then ring[q] = true end
    end end
  end
  for key, _ in pairs(ring) do                       -- 1px drop under the outline
    local q = key + W + 1
    if not mask[q] and not ring[q] then C.px(q % W, q // W, INK) end
  end
  for key, _ in pairs(ring) do C.px(key % W, key // W, INK) end
  for key, r in pairs(mask) do
    local b = bands[r]; local px, py = key % W, key // W
    if type(b) == "table" then b = L.dith(px, py, b[1], b[2], 0.5) end
    C.px(px, py, b)
  end
  -- hand glints: a short diagonal sheen through the warm half of every third letter
  local h = #rows
  for n=1,#s do if n % 3 == 1 and s:sub(n,n) ~= " " then
    local gx = starts[n] + 2
    for k=0,(size == "big" and 3 or 2) do
      local key = (y0+h-2-k)*W + gx+k
      if mask[key] and mask[key] > h//2 then C.px(gx+k, y0+h-2-k, MARBLE) end
    end
  end end
  return x - x0 - (size == "big" and 2 or 1), starts
end

-- ---------------------------------------------------------------- widgets
-- structured airbrush pool: solid core -> 75% -> 50% -> 25% -> feather (grain at each level)
local LEVELS = { {0.34,1.0}, {0.52,0.75}, {0.68,0.5}, {0.84,0.25}, {1.0,0.09} }
local function pool(cx, cy, rx, ry, c, clip, maxLevel)
  for y=math.floor(cy-ry), math.ceil(cy+ry) do for x=math.floor(cx-rx), math.ceil(cx+rx) do
    if not clip or (x >= clip[1] and y >= clip[2] and x <= clip[3] and y <= clip[4]) then
      local d = math.sqrt(((x-cx)/rx)^2 + ((y-cy)/ry)^2)
      for _, lv in ipairs(LEVELS) do
        if d < lv[1] then
          if hit(x, y, math.min(lv[2], maxLevel or 1)) then C.px(x, y, c) end
          break
        end
      end
    end
  end end
end
-- label on a stencil cushion: 1px of clean face around every glyph run
local function label(x, y, s, c, face)
  C.rect(x-1, y-1, textW(s)+2, 7, face)
  text(C, x, y, s, c)
end
-- light label with an INK keyline (reads on teal/violet in both palettes)
local function keyText(x, y, s, c)
  for _, d in ipairs({{-1,0},{1,0},{0,-1},{0,1},{1,1}}) do text(C, x+d[1], y+d[2], s, INK) end
  text(C, x, y, s, c)
end
-- painted 2-tone bevel: lavender/pink highlight top-left that tapers before the corners,
-- deep recess bottom-right; corners left open
local function paintedFrame(x, y, w, h, hiC)
  hiC = hiC or VIOLET
  for i=0,w-1 do
    local t = math.min(i, w-1-i)
    local cov = t < 2 and 0 or (t < 8 and (t-1)/7 or 1)
    if hit(x+i, y-1, cov) then C.px(x+i, y-1, hiC) end
    if hit(x+i+3, y, cov*0.45) then C.px(x+i, y, hiC) end
    if t >= 1 then C.px(x+i, y+h, INK) end
    if t >= 2 and hit(x+i, y+h-1, 0.5) then C.px(x+i, y+h-1, INK) end
  end
  for j=0,h-1 do
    local t = math.min(j, h-1-j)
    local cov = t < 2 and 0 or (t < 8 and (t-1)/7 or 1)
    if hit(x-1, y+j, cov) then C.px(x-1, y+j, hiC) end
    if hit(x, y+j+3, cov*0.45) then C.px(x, y+j, hiC) end
    if t >= 1 then C.px(x+w, y+j, INK) end
    if t >= 2 and hit(x+w-1, y+j, 0.5) then C.px(x+w-1, y+j, INK) end
  end
end
-- painted bevel button: INK rim, sprayed sheen on top, sprayed shade at the bottom
local function button(x, y, w, h, face, label, lc, opt)
  opt = opt or {}
  C.rect(x, y, w, h, face)
  local hi = opt.hi or MARBLE
  local sh = opt.shade or (face == TEAL and VIOLET or (face == PHI and PANEL or LINE))
  -- gloss lives on the rim rows only, so labels sit on clean paint
  for i=0,w-1 do
    local edge = 1 - math.abs(i/(w-1) - 0.35)*1.3
    if hit(x+i, y+1, 0.75*edge) then C.px(x+i, y+1, hi) end
    if h >= 10 and hit(x+i+5, y+2, 0.3*edge) then C.px(x+i, y+2, hi) end
    if hit(x+i+3, y+h-1, 0.85) then C.px(x+i, y+h-1, sh) end
    if h >= 10 and hit(x+i+1, y+h-2, 0.35) then C.px(x+i, y+h-2, sh) end
  end
  C.hline(x+1, y, w-2, hi) -- crisp stencil highlight
  C.hline(x, y-1, w, INK); C.hline(x, y+h, w, INK)       -- rim, corners nipped
  C.vline(x-1, y, h, INK); C.vline(x+w, y, h, INK)
  C.hline(x+1, y+h+1, w-1, INK); C.vline(x+w+1, y+1, h-1, INK); C.px(x+w, y+h, INK) -- hard 1px drop
  if label then
    local lx, ly = x + (w - textW(label))//2 + (opt.dx or 0), y + (h-5)//2
    if face == TEAL or face == VIOLET then keyText(lx, ly, label, MARBLE)
    else text(C, lx, ly, label, lc or TEXT) end
  end
end

-- filled pastel chip, corners nipped, grainy fringe
local function chip(x, y, w, face, label, lc, fringe)
  local h = 7
  C.rect(x, y, w, h, face)
  C.px(x, y, nil)
  for _, p in ipairs({{x,y},{x+w-1,y},{x,y+h-1},{x+w-1,y+h-1}}) do C.px(p[1], p[2], fringe or PANEL) end
  if fringe then for i=0,w-1 do
    if hit(x+i, y-1, 0.35) then C.px(x+i, y-1, face) end
    if hit(x+i, y+h, 0.35) then C.px(x+i, y+h, face) end
  end end
  text(C, x + (w - textW(label))//2, y+1, label, lc)
end

-- sunken well (inputs, portrait frame)
local function well(x, y, w, h, face)
  if face then C.rect(x, y, w, h, face) end
  C.hline(x-1, y-1, w+1, INK); C.vline(x-1, y-1, h+1, INK)
  C.hline(x-1, y+h, w+2, MARBLE); C.vline(x+w, y-1, h+2, MARBLE)
end

-- tiny status pips (pixel sprites, not glowing dots)
local function pip(x, y, c)
  C.rect(x, y, 3, 3, c); C.px(x, y, MARBLE)
  C.hline(x, y+3, 3, INK); C.vline(x+3, y, 4, INK)
end
local function dots(x, y, c) C.px(x, y, c); C.px(x+2, y, c); C.px(x+4, y, c) end

-- airbrushed sunset disc with vaporwave cut lines
local function sun(cx, cy, r, clip)
  for y=cy-r-2, cy+r+2 do for x=cx-r-2, cx+r+2 do
    if not clip or (x >= clip[1] and y >= clip[2] and x <= clip[3] and y <= clip[4]) then
      local d = math.sqrt((x-cx)^2 + (y-cy)^2) / r
      local f = clamp((y-(cy-r)) / (2*r))
      local c = f < 0.4 and AMBER or (f < 0.72 and (hit(x, y, (f-0.4)*3) and CORAL or AMBER) or CORAL)
      if f > 0.8 and hit(x, y, (f-0.8)*4) then c = PINK end
      local cut = (y > cy) and ((y - cy) % 4 == 2 - math.min(1, (y-cy)//6))
      if not cut and (d < 0.86 or (d < 1.12 and hit(x, y, (1.12-d)*3.6))) then C.px(x, y, c) end
    end
  end end
end

-- ---------------------------------------------------------------- page
local SBW = 100
-- page: night-mall wash, BG at top drifting into PANEL, sprayed clouds low right
grad(SBW, 0, W-SBW, H, { BG, BG, PANEL })
local PAGE = { SBW+2, 0, W-1, H-1 }
pool(W, H+12, 120, 70, VIOLET, PAGE, 0.75)
pool(W, H+8, 60, 34, PINK, PAGE, 0.75)
-- star field, hand-placed
for _, s in ipairs({{214,6},{262,14},{318,8},{356,17},{404,10},{238,40},{302,44},{344,36},
                    {440,40},{470,22},{386,52},{229,52}}) do C.px(s[1], s[2], MUTED) end
for _, s in ipairs({{288,30},{420,28}}) do star(s[1], s[2], LINE) end

-- ---------------------------------------------------------------- sidebar
grad(0, 0, SBW, H, { BG, PANEL, PANEL, PHI })
local SB = { 0, 0, SBW-1, H-1 }
pool(30, 294, 120, 50, VIOLET, SB, 0.75)
pool(10, 290, 70, 34, PINK, SB, 0.75)
C.vline(SBW, 0, H, LINE); C.vline(SBW+1, 0, H, INK)

-- brand: sprayed sun rising behind the chrome lettering
pool(82, 9, 22, 12, PINK, {0, 0, SBW-1, 15}, 0.75)
sun(84, 10, 8, {0, 0, SBW-1, 15})
-- VS mark tile, sprayed
grad(4, 4, 14, 14, { VIOLET, PINK, CORAL })
puff(7, 6, 6, 4, MARBLE, 0.6)
C.hline(3, 3, 16, INK); C.hline(3, 18, 16, INK); C.vline(3, 3, 16, INK); C.vline(18, 3, 16, INK)
C.hline(4, 19, 16, INK); C.vline(19, 4, 16, INK)
C.stamp(6, 8, [[
|k...k.kkkk|
|k...k.k...|
|.k.k..kkkk|
|.k.k.....k|
|..k...kkkk|
]])
chrome(22, 4, "VIBESQUAD", "small")
label(22, 17, "VAPOR OS // 199X", MUTED, PANEL)
sparkle(84, 3, 3, nil)
sparkle(20, 2, 2, nil)

-- inbox: sprayed pill button with an envelope
button(5, 25, 90, 11, PHI, nil)
C.stamp(10, 28, [[
|mmmmmmm|
|mkmmmkm|
|mmkmkmm|
|mmmkmmm|
]])
text(C, 21, 28, "INBOX (2)", TEXT)
chip(80, 27, 10, PINK, "2", BG)

text(C, 5, 43, "SQUADS", MUTED)
button(46, 41, 49, 9, PHI, "COLLAPSE ALL", TEXT)

-- active squad: teal stencil bar + sprayed teal light fading right
local function squadTile(y, letter, l1, l2, count, badge, active)
  C.rect(4, y, 80, 18, PHI)
  if active then
    -- teal light sprayed in from the stencil bar, clean where the label sits
    for j=0,17 do for i=0,79 do
      local f = i/79
      local edgeY = (j < 2 or j > 15) and 0.7 or 0.12
      if hit(4+i, y+j, (1-f)^1.3*(i < 16 and 0.9 or edgeY)) then C.px(4+i, y+j, TEAL) end
    end end
    C.vline(4, y, 18, MARBLE); C.vline(5, y, 18, TEAL); C.vline(6, y, 18, TEAL)
  end
  C.hline(3, y-1, 82, INK); C.hline(3, y+18, 82, INK); C.vline(3, y-1, 20, INK); C.vline(84, y-1, 20, INK)
  C.hline(4, y+19, 81, INK); C.vline(85, y, 20, INK)
  -- emblem tile
  grad(8, y+4, 10, 10, { AMBER, AMBER, CORAL })
  C.px(9, y+5, MARBLE); C.px(10, y+5, MARBLE)
  C.hline(7, y+3, 12, INK); C.hline(7, y+14, 12, INK); C.vline(7, y+3, 12, INK); C.vline(18, y+3, 12, INK)
  text(C, 12, y+7, letter, INK)
  label(22, y+3, l1, TEXT, PHI)
  if l2 then label(22, y+10, l2, TEXT, PHI) end
  if count then chip(66, y+5, 13, PANEL, count, TEXT) end
  if badge then chip(66, y+5, 13, PINK, badge, BG, PHI) end
  button(88, y+5, 8, 8, PHI, nil); dots(90, y+9, TEXT)
end
squadTile(55, "E", "ESCAPE FROM", "IDLE", "8", nil, true)

-- squad hub row
local function hubRow(y, state, sc)
  C.vline(5, y-1, 10, TEAL)
  C.rect(9, y-1, 31, 9, BG)
  C.hline(10, y-1, 29, TEAL); C.hline(10, y+7, 29, TEAL); C.vline(9, y, 7, TEAL); C.vline(39, y, 7, TEAL)
  text(C, 11, y+1, "RIFFBOT", TEAL)
  text(C, 43, y+1, "SQUAD HUB", MUTED)
  pip(88, y+2, sc)
end
hubRow(79, "READY", MINT)

local function teamsHead(y, label)
  text(C, 5, y, label, MUTED)
  button(87, y-2, 9, 9, PHI, "+", TEXT)
end
local function teamRow(y, name, code, st, opt)
  opt = opt or {}
  if opt.sel then
    C.rect(2, y-2, 85, 9, PHI)
    for j=-2,6 do for i=0,84 do
      local edgeY = (j == -2 or j == 6) and 0.8 or 0.1
      if hit(i+2, y+j, (1-i/84)^1.5*(i < 4 and 0.9 or edgeY)) then C.px(i+2, y+j, VIOLET) end
    end end
    C.vline(2, y-2, 9, PINK)
  end
  pip(6, y+1, st)
  if opt.sel then label(13, y, name, TEXT, PHI) else text(C, 13, y, name, opt.dim and MUTED or TEXT) end
  if opt.badge then chip(56, y-1, 9, PINK, opt.badge, BG) end
  chip(68, y-1, textW(code)+3, PHI, code, MUTED)
  button(89, y, 7, 6, PHI, nil); dots(90, y+3, TEXT)
end

teamsHead(91, "TEAMS 8")
local y0 = 102
for i, r in ipairs({ {"SIM CORE","@SIM",MINT}, {"ECONOMY","@ECO",AMBER}, {"UI RAID","@UIR",LINE,{badge="1"}},
                     {"ART PIPE","@ART",LINE,{sel=true}}, {"RELEASE","@REL",LINE,{dim=true}} }) do
  teamRow(y0 + (i-1)*11, r[1], r[2], r[3], r[4])
end
squadTile(163, "V", "VIBESQUAD", nil, nil, "1", false)
hubRow(187, "LIVE", TEAL)
teamsHead(199, "TEAMS 7")
for i, r in ipairs({ {"ART DIR","@ART",MINT}, {"BUG CHASE","@BUG",AMBER}, {"UI BOIS","@UI",LINE} }) do
  teamRow(210 + (i-1)*11, r[1], r[2], r[3])
end

-- provider strip + toolbar
well(5, 245, 90, 7, BG)
text(C, 7, 246, "SIGNALS >", MUTED)
star(78, 248, PINK); star(85, 248, TEAL); C.px(91, 248, MARBLE)
local tx = 5
for _, b in ipairs({ {20, "100%"}, {9, "?"}, {9, "I"}, {9, nil}, {9, nil} }) do
  button(tx, 257, b[1], 10, PHI, b[2], TEXT)
  tx = tx + b[1] + 4
end
-- gear + bolt, stamped
C.stamp(tx-24, 259, [[
|.k.k.|
|kkkkk|
|kk.kk|
|kkkkk|
|.k.k.|
]], { k = TEXT })
C.stamp(tx-11, 259, [[
|..pp|
|.pp.|
|pppp|
|.pp.|
|pp..|
]], { p = AMBER })

-- ---------------------------------------------------------------- top bar + header
local MX = SBW + 7
button(MX, 4, 30, 10, VIOLET, "SQUADS", INK)
text(C, MX+38, 7, "SQUADS > ESCAPE FROM IDLE", MUTED)
button(W-26, 4, 21, 10, PHI, "100%", TEXT)

-- chrome header with a sprayed cloud behind it
pool(MX+90, 29, 110, 15, VIOLET, PAGE, 0.75)
pool(MX+60, 30, 62, 10, PINK, PAGE, 0.75)
grad(MX, 21, 15, 15, { AMBER, AMBER, CORAL, PINK })
puff(MX+4, 23, 6, 4, MARBLE, 0.7)
C.hline(MX-1, 20, 17, INK); C.hline(MX-1, 36, 17, INK); C.vline(MX-1, 20, 17, INK); C.vline(MX+15, 20, 17, INK)
C.hline(MX, 37, 17, INK); C.vline(MX+16, 21, 17, INK)
C.stamp(MX+4, 24, [[
|kkkkkk|
|kk....|
|kkkkk.|
|kk....|
|kk....|
|kk....|
|kkkkkk|
|......|
]])
local hw, st = chrome(MX+23, 22, "ESCAPE FROM IDLE", "big")
sparkle(MX+23+hw+6, 23, 5, nil)
sparkle(st[1]-1, 21, 3, nil); sparkle(st[9]+8, 21, 2, nil); sparkle(st[14]+1, 36, 2, nil)
label(W-6-textW("9 TEAMS - 0 NEED YOU"), 28, "9 TEAMS - 0 NEED YOU", MUTED, BG)

button(MX, 43, 28, 9, TEAL, "+ TEAM", INK)
button(MX+33, 43, 38, 9, PHI, "SETTINGS", TEXT)
button(MX+76, 43, 20, 9, PHI, "FULL", TEXT)

-- ---------------------------------------------------------------- window
local WX, WY, WW, WH = MX, 58, W-MX-7, 205
local BODY = { WX, WY+16, WX+WW-1, WY+WH-1 }
-- sprayed haze behind the window (painted drop, not a CSS glow)
stroke(WX+20, WY+WH+3, WX+WW-10, WY+WH+3, 5, VIOLET, 0.55, PAGE)
stroke(WX+WW+3, WY+20, WX+WW+3, WY+WH-6, 4, VIOLET, 0.55, PAGE)
-- body: panel wash + sprayed corner clouds + paper tooth
grad(WX, WY+16, WW, WH-16, { PANEL, PANEL, PHI })
pool(WX+WW, WY+WH, 150, 66, VIOLET, BODY)
pool(WX+WW, WY+WH, 84, 40, PINK, BODY)
for j=0,4 do for i=0,WW-1 do   -- title-bar shade cast onto the body, banded, tapered at the ends
  local t = math.min(i, WW-1-i)
  local cov = ({0.75, 0.5, 0.25, 0.12, 0.05})[j+1] * math.min(1, t/24)
  if hit(WX+i, WY+16+j, cov) then C.px(WX+i, WY+16+j, PHI) end
end end
-- frame
C.hline(WX-1, WY-1, WW+2, INK); C.hline(WX-1, WY+WH, WW+2, INK)
C.vline(WX-1, WY-1, WH+2, INK); C.vline(WX+WW, WY-1, WH+2, INK)
C.hline(WX, WY+WH+1, WW+2, INK); C.vline(WX+WW+1, WY, WH+2, INK)
C.vline(WX, WY+16, WH-16, MARBLE)
-- chunky title bar: four-stop spray, sheen pass along the top, hard INK floor
grad(WX, WY, WW, 15, { VIOLET, PINK, CORAL, SKIN }, true)
for j=0,14 do for i=0,WW-1 do   -- vertical shading in the lower rows
  if j > 9 and hit(WX+i, WY+j, (j-9)/5*0.5) then C.px(WX+i, WY+j, VIOLET) end
end end
stroke(WX+8, WY+3, WX+WW-60, WY+3, 3.2, MARBLE, 0.95, { WX, WY, WX+WW-1, WY+14 })
C.hline(WX, WY, WW, MARBLE)
C.hline(WX, WY+15, WW, INK)
text(C, WX+6, WY+5, "SIM CORE", INK)
sparkle(WX+44, WY+6, 3, nil)
chip(WX+WW-55, WY+4, 19, MARBLE, "@SIM", INK)
for i, g in ipairs({ "_", "O", "X" }) do
  local bx = WX + WW - 33 + (i-1)*11
  button(bx, WY+3, 9, 9, MARBLE, nil, nil, { shade = LINE })
  if g == "_" then C.hline(bx+2, WY+9, 5, INK)
  elseif g == "O" then C.hline(bx+2, WY+5, 5, INK); C.hline(bx+2, WY+6, 5, INK); C.hline(bx+2, WY+9, 5, INK)
    C.vline(bx+2, WY+5, 5, INK); C.vline(bx+6, WY+5, 5, INK)
  else C.line(bx+2, WY+5, bx+6, WY+9, INK); C.line(bx+6, WY+5, bx+2, WY+9, INK) end
end

-- portrait well: airbrushed sunset behind the H0 bust (same hand)
local PX, PY = WX+8, WY+24
local PCL = { PX, PY, PX+67, PY+67 }
grad(PX, PY, 68, 68, { SKY, VIOLET, PINK, CORAL }, false)
sun(PX+34, PY+40, 17, PCL)
for j=PY+52, PY+67 do for i=PX, PX+67 do   -- sprayed floor haze
  if hit(i, j, (j-PY-52)/15*0.8) then C.px(i, j, VIOLET) end
end end
for _, s in ipairs({{PX+6,PY+6},{PX+60,PY+12},{PX+14,PY+20}}) do C.px(s[1], s[2], MARBLE) end
paintedFrame(PX, PY, 68, 68, PINK)
do
  local b = Sprite{ fromFile = root.."/art/cast/hypno/lead-bust.aseprite" }
  local img = Image(b.width, b.height, ColorMode.INDEXED); img:drawSprite(b, 1)
  b:close()
  for j=0,img.height-1 do for i=0,img.width-1 do
    local v = img:getPixel(i, j)
    if v ~= 0 then C.px(PX+2+i, PY+4+j, v) end
  end end
end
sparkle(PX+62, PY+5, 4, PINK)
button(PX, PY+73, 68, 10, VIOLET, "LEAD", INK)

-- right column
local RX = PX + 80
text(C, RX, PY+1, "BIG CHEESE  -  LEAD", TEXT)
text(C, RX, PY+9, "3 AGENTS LIVE", MUTED)
text(C, RX, PY+17, "BUDDY: WALKMAN KID", TEAL)
C.rect(WX+WW-55, PY-1, 49, 9, PANEL)
chip(WX+WW-54, PY, 47, PINK, "! NEEDS YOU", BG)
sparkle(WX+WW-6, PY-1, 3, nil)

local cx = RX
for _, s in ipairs({ {"RUN", MINT}, {"WAIT", AMBER}, {"IDLE", LINE} }) do
  local w = textW(s[1]) + 13
  button(cx, PY+28, w, 9, PHI, nil)
  pip(cx+3, PY+31, s[2]); label(cx+9, PY+30, s[1], TEXT, PHI)
  cx = cx + w + 6
end

-- context bar: sunken well with a sprayed fill
text(C, RX, PY+44, "CTX  82K / 150K", MUTED)
well(RX+64, PY+44, 112, 5, BG)
for j=0,4 do for i=0,61 do
  local f = i/61
  C.px(RX+64+i, PY+44+j, hit(RX+64+i, PY+44+j, f) and AMBER or TEAL)
  if j == 0 and hit(RX+64+i, PY+44, 0.7) then C.px(RX+64+i, PY+44, MARBLE) end
end end

-- divider: a single airbrush pass, not a rule
stroke(RX, PY+58, WX+WW-8, PY+58, 2.2, PINK, 0.9, BODY)
C.hline(RX+16, PY+58, WX+WW-RX-40, LINE)

-- activity lines
for i, s in ipairs({ "CREATE AGENT  ART PAINTER", "CREATE AGENT  ART DIRECTOR", "VS WHO LEAD  -  LIVE" }) do
  local ly = PY + 64 + (i-1)*9
  C.px(RX, ly+2, TEAL); C.px(RX+1, ly+1, TEAL); C.px(RX+1, ly+3, TEAL)
  text(C, RX+5, ly, s, i == 3 and TEAL or TEXT)
end

-- agent desks: H0 floor sprites (working pose) in sprayed sunken tiles
local AY = PY + 100
text(C, PX, AY, "AGENTS ON THE FLOOR", MUTED)
stroke(PX+80, AY+2, WX+WW-10, AY+2, 1.6, VIOLET, 0.8, BODY)
for i, r in ipairs({ {"lead","LEAD",MINT}, {"buddy","BUDDY",MINT}, {"implement","BUILD",AMBER}, {"review","REVIEW",LINE} }) do
  local tx0 = PX + (i-1)*86
  local TC = { tx0, AY+9, tx0+75, AY+44 }
  grad(tx0, AY+9, 76, 36, { BG, PANEL, PHI })
  pool(tx0+20, AY+43, 28, 9, VIOLET, TC)
  pool(tx0+20, AY+43, 16, 5, i == 3 and AMBER or PINK, TC)
  paintedFrame(tx0, AY+9, 76, 36, i == 3 and AMBER or VIOLET)
  local f = Sprite{ fromFile = root.."/art/cast/hypno/"..r[1].."-floor.aseprite" }
  local img = Image(32, 32, ColorMode.INDEXED); img:drawSprite(f, 1); f:close()
  for j=0,31 do for q=0,31 do local v = img:getPixel(q, j)
    if v ~= 0 then C.px(tx0+4+q, AY+12+j, v) end end end
  pip(tx0+40, AY+15, r[3])
  label(tx0+46, AY+15, r[2], TEXT, PANEL)
  text(C, tx0+46, AY+33, i == 3 and "WAIT" or (i == 4 and "IDLE" or "LIVE"), MUTED)
end

-- composer + buttons
local IY = WY + WH - 22
well(WX+8, IY, WW-118, 15, BG)
text(C, WX+12, IY+5, "MESSAGE SIM CORE...", MUTED)
C.vline(WX+12+textW("MESSAGE SIM CORE...")+2, IY+4, 7, TEAL)
button(WX+WW-102, IY+2, 44, 12, PHI, "CANCEL", TEXT)
button(WX+WW-51, IY+2, 42, 12, TEAL, "SEND", INK)
sparkle(WX+WW-12, IY+3, 3, nil)

C.commit()

-- ---------------------------------------------------------------- export
spr:saveAs(dir.."u3a-frame.aseprite")
local flat = C.img:clone()
local function toRGB(img, p)
  local out = Image(img.width, img.height, ColorMode.RGB)
  for j=0,img.height-1 do for i=0,img.width-1 do
    local c = p:getColor(img:getPixel(i, j))
    out:drawPixel(i, j, app.pixelColor.rgba(c.red, c.green, c.blue, 255))
  end end
  return out
end
local function scale(img, z)
  local out = Image(img.width*z, img.height*z, ColorMode.RGB)
  for j=0,img.height-1 do for i=0,img.width-1 do
    local v = img:getPixel(i, j)
    for q=0,z-1 do for o=0,z-1 do out:drawPixel(i*z+o, j*z+q, v) end end
  end end
  return out
end
-- big label for the comparison sheet (3x5 font at 6x)
local function bigText(img, x, y, s, rgba, z)
  for n=1,#s do
    local g = L.F[s:sub(n,n)] or L.F[" "]
    for r=0,4 do for q=0,2 do if g:sub(r*3+q+1, r*3+q+1) == "1" then
      for b=0,z-1 do for a=0,z-1 do img:drawPixel(x+((n-1)*4+q)*z+a, y+r*z+b, rgba) end end
    end end end
  end
end

for _, mode in ipairs({ "dark", "light" }) do
  local p = pal[mode]
  local one = toRGB(flat, p)
  one:saveAs(dir.."u3a-"..mode.."-1x.png")
  local big = scale(one, 4)
  big:saveAs(root.."/scratch/shots/u3a-"..mode..".png")
  print("wrote u3a-"..mode..".png "..big.width.."x"..big.height)
  -- side-by-side: U3a mock at 4x (1920x1080) | U2 app at 1x in a 1920x1080 viewport
  local ref = Image{ fromFile = dir.."ref/u3a-ref-u2-"..mode.."-1080.png" }
  local two = big
  local GAP, TOP = 24, 60
  local sheet = Image(two.width + GAP + ref.width, TOP + math.max(two.height, ref.height), ColorMode.RGB)
  local bgc = p:getColor(INK)
  sheet:clear(app.pixelColor.rgba(bgc.red, bgc.green, bgc.blue, 255))
  local lab = p:getColor(MARBLE); local lc = app.pixelColor.rgba(lab.red, lab.green, lab.blue, 255)
  bigText(sheet, 0, 14, "U3A AIRBRUSH MOCK (4X)", lc, 6)
  bigText(sheet, two.width + GAP, 14, "U2 APP TODAY (1X)", lc, 6)
  sheet:drawImage(two, Point(0, TOP))
  sheet:drawImage(ref, Point(two.width + GAP, TOP))
  sheet:saveAs(root.."/scratch/shots/u3a-vs-u2-"..mode..".png")
  print("wrote u3a-vs-u2-"..mode..".png "..sheet.width.."x"..sheet.height)
end
