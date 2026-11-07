-- U3b painted kit: every UI piece of the U3a airbrush style frame, cut into reusable assets.
-- Hand-painted with art/ui/u3b/airbrush.lua (same hand and grain as art/ui/u3a/paint.lua).
-- Outputs (1x native, CSS shows them at 2x with image-rendering: pixelated):
--   public/ui/u3/<piece>-{dark,light}.png, <nine-slice piece>.json, kit.json, sprites.json,
--   font-chrome-{big,small}.json
--   scratch/shots/u3b-kit-{dark,light}.png        kit gallery at 4x
--   scratch/shots/u3b-recompose-{dark,light}.png  the U3a layout rebuilt from kit pieces only, 4x
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/ui/u3b/kit.lua
local root = app.params.root
local A = dofile(root.."/art/ui/u3b/airbrush.lua")
A.useFont(dofile(root.."/art/cast/hypno/lib.lua"))
local BG,PANEL,PHI,LINE,MARBLE,TEXT,MUTED,TEAL,VIOLET,PINK,CORAL,AMBER,MINT,SKY,SKIN,INK =
  0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15
local px, rect, hline, vline, hit = A.px, A.rect, A.hline, A.vline, A.hit
local OUT = root.."/public/ui/u3/"
local SCALE = 2

local pal = { dark = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" },
              light = Palette{ fromFile = root.."/art/palette/pc98-light.gpl" } }
-- light surfaces = the U2 swatch A in src/styles.css (P0 light BG was the flash-bang); index-matched
for i, hex in pairs({ [0]=0xe0d1dc, [1]=0xebe0e8, [2]=0xd6c2d0, [3]=0xb092a7, [6]=0x574268 }) do
  pal.light:setColor(i, Color{ r = hex >> 16, g = (hex >> 8) & 255, b = hex & 255 })
end

local pieces, order = {}, {}
local function piece(name, img, meta)
  meta = meta or {}; meta.img = img; meta.name = name
  pieces[name] = meta; order[#order+1] = name
  return img
end
-- taper for painted edges: 0 at the corner, full 8px in (so 9-slice middles are uniform)
local function taper(t) return t < 2 and 0 or (t < 8 and (t-1)/7 or 1) end

-- ================================================================ 1. frames (9-slice)
local NS = { top = 8, right = 8, bottom = 8, left = 8 }
A.tiled("bayer")
do -- window: INK rim (corners nipped), MARBLE highlight tapering top-left, INK recess, 1px hard drop
  local W, H = 32, 32
  A.use(A.new(W, H))
  hline(1, 0, W-3, INK); hline(1, H-2, W-3, INK); vline(0, 1, H-3, INK); vline(W-2, 1, H-3, INK)
  hline(2, H-1, W-2, INK); vline(W-1, 2, H-2, INK); px(W-2, H-2, INK)
  for i=1,W-3 do local c = taper(math.min(i-1, W-3-i))
    if hit(i, 1, c) then px(i, 1, MARBLE) end
    if hit(i, 2, c*0.45) then px(i, 2, MARBLE) end
    if math.min(i-1, W-3-i) >= 1 and hit(i, H-3, 0.5) then px(i, H-3, INK) end
  end
  for j=1,H-3 do local c = taper(math.min(j-1, H-3-j))
    if hit(1, j, c) then px(1, j, MARBLE) end
    if hit(2, j, c*0.45) then px(2, j, MARBLE) end
    if math.min(j-1, H-3-j) >= 1 and hit(W-3, j, 0.5) then px(W-3, j, INK) end
  end
  piece("window-frame", A.target(), { slice = NS, repeat_ = "repeat", kind = "frame" })
end
local function paintedFrame(hiC)
  local W, H = 32, 32
  A.use(A.new(W, H))
  for i=0,W-1 do local t = math.min(i, W-1-i); local c = taper(t)
    if hit(i, 0, c) then px(i, 0, hiC) end
    if hit(i+3, 1, c*0.45) then px(i, 1, hiC) end
    if t >= 1 then px(i, H-1, INK) end
    if t >= 2 and hit(i, H-2, 0.5) then px(i, H-2, INK) end
  end
  for j=0,H-1 do local t = math.min(j, H-1-j); local c = taper(t)
    if hit(0, j, c) then px(0, j, hiC) end
    if hit(1, j+3, c*0.45) then px(1, j, hiC) end
    if t >= 1 then px(W-1, j, INK) end
    if t >= 2 and hit(W-2, j, 0.5) then px(W-2, j, INK) end
  end
  return A.target()
end
piece("panel-frame", paintedFrame(VIOLET), { slice = NS, repeat_ = "repeat", kind = "frame" })
piece("panel-frame-pink", paintedFrame(PINK), { slice = NS, repeat_ = "repeat", kind = "frame" })
piece("panel-frame-amber", paintedFrame(AMBER), { slice = NS, repeat_ = "repeat", kind = "frame" })
do -- sunken well: INK top-left recess, MARBLE catch-light bottom-right tapering into the corners
  local W, H = 32, 32
  A.use(A.new(W, H))
  for i=0,W-1 do local t = math.min(i, W-1-i)
    if t >= 1 then px(i, 0, INK) end
    if hit(i, H-1, taper(t)) then px(i, H-1, MARBLE) end
  end
  for j=0,H-1 do local t = math.min(j, H-1-j)
    if t >= 1 then px(0, j, INK) end
    if hit(W-1, j, taper(t)) then px(W-1, j, MARBLE) end
  end
  piece("well-frame", A.target(), { slice = NS, repeat_ = "repeat", kind = "frame" })
end

-- ================================================================ 2. backgrounds
-- vertical spray ramps, 16px wide, repeat-x; background-color = the last stop below them
local function ramp(name, h, cols, below)
  A.tiled(true); A.use(A.new(16, h)); A.grad(0, 0, 16, h, cols); A.tiled("bayer")
  piece(name, A.target(), { repeat_ = "repeat-x", kind = "bg", below = below })
end
ramp("bg-page", 256, { BG, BG, PANEL }, "PANEL")
ramp("bg-sidebar", 512, { BG, PANEL, PANEL, PHI }, "PHI")
ramp("bg-panel", 128, { PANEL, PANEL, PHI }, "PHI")
ramp("bg-well", 48, { BG, PANEL, PHI }, "PHI")
do -- shade the title bar casts onto a window body: banded 75/50/25/12, repeat-x
  A.use(A.new(16, 4))
  for j, c in ipairs({ 0.75, 0.5, 0.25, 0.12 }) do for i=0,15 do
    if hit(i, j-1, c) then px(i, j-1, PHI) end end end
  piece("tb-shade", A.target(), { repeat_ = "repeat-x", kind = "bg" })
end
do -- sidebar right edge, repeat-y
  A.use(A.new(2, 8)); vline(0, 0, 8, LINE); vline(1, 0, 8, INK)
  piece("edge-sidebar", A.target(), { repeat_ = "repeat-y", kind = "bg" })
end
do -- star wallpaper: hand-placed, sparse on purpose (no pepper), seamless 128px
  A.use(A.new(128, 128))
  for _, s in ipairs({{6,10},{41,4},{77,15},{112,7},{23,47},{60,38},{98,52},{12,83},{47,70},
                      {85,91},{119,76},{33,110},{70,121},{104,113}}) do px(s[1], s[2], MUTED) end
  for _, s in ipairs({{58,22},{17,64},{92,70},{51,100}}) do A.star(s[1], s[2], LINE) end
  piece("stars", A.target(), { repeat_ = "repeat", kind = "bg" })
end
A.tiled(false)
do -- airbrush corner cloud: anchor bottom-right of window bodies and the page
  A.use(A.new(160, 72))
  A.pool(160, 72, 150, 66, VIOLET); A.pool(160, 72, 84, 40, PINK)
  piece("cloud-corner", A.target(), { repeat_ = "no-repeat", kind = "bg", anchor = "right bottom" })
end
do -- sidebar foot cloud: anchor bottom-left
  A.use(A.new(112, 48))
  A.pool(30, 72, 120, 50, VIOLET, 0.75); A.pool(10, 68, 70, 34, PINK, 0.75)
  piece("cloud-foot", A.target(), { repeat_ = "no-repeat", kind = "bg", anchor = "left bottom" })
end
do -- halo behind the chrome h1: anchor left center, h1 text starts ~22px in
  A.use(A.new(232, 32))
  A.pool(112, 16, 110, 15, VIOLET, 0.75); A.pool(82, 17, 62, 10, PINK, 0.75)
  piece("header-halo", A.target(), { repeat_ = "no-repeat", kind = "bg", anchor = "left center" })
end
do -- active squad tile: teal light sprayed in from a stencil bar, clean where the label sits
  A.use(A.new(80, 18))
  for j=0,17 do for i=0,79 do
    local f = i/79; local edgeY = (j < 2 or j > 15) and 0.7 or 0.12
    if hit(i, j, (1-f)^1.3*(i < 16 and 0.9 or edgeY)) then px(i, j, TEAL) end
  end end
  vline(0, 0, 18, MARBLE); vline(1, 0, 18, TEAL); vline(2, 0, 18, TEAL)
  piece("sel-teal", A.target(), { repeat_ = "no-repeat", kind = "bg", anchor = "left center" })
end
do -- selected / hovered sidebar row: violet spray from a pink stencil bar
  A.use(A.new(85, 9))
  for j=0,8 do for i=0,84 do
    local edgeY = (j == 0 or j == 8) and 0.8 or 0.1
    if hit(i, j, (1-i/84)^1.5*(i < 4 and 0.9 or edgeY)) then px(i, j, VIOLET) end
  end end
  vline(0, 0, 9, PINK)
  piece("sel-violet", A.target(), { repeat_ = "no-repeat", kind = "bg", anchor = "left center" })
end
do -- portrait backdrop: airbrushed sunset plate behind cast busts
  A.use(A.new(68, 68))
  A.grad(0, 0, 68, 68, { SKY, VIOLET, PINK, CORAL })
  local cx, cy, r = 34, 40, 17
  for y=cy-r-2, cy+r+2 do for x=cx-r-2, cx+r+2 do
    local d = math.sqrt((x-cx)^2 + (y-cy)^2) / r
    local f = A.clamp((y-(cy-r)) / (2*r))
    local c = f < 0.4 and AMBER or (f < 0.72 and (hit(x, y, (f-0.4)*3) and CORAL or AMBER) or CORAL)
    if f > 0.8 and hit(x, y, (f-0.8)*4) then c = PINK end
    local cut = (y > cy) and ((y - cy) % 4 == 2 - math.min(1, (y-cy)//6))
    if not cut and (d < 0.86 or (d < 1.12 and hit(x, y, (1.12-d)*3.6))) then px(x, y, c) end
  end end
  for j=52,67 do for i=0,67 do if hit(i, j, (j-52)/15*0.8) then px(i, j, VIOLET) end end end
  for _, s in ipairs({{6,6},{60,12},{14,20}}) do px(s[1], s[2], MARBLE) end
  piece("sunset-plate", A.target(), { repeat_ = "no-repeat", kind = "bg" })
end
A.tiled("bayer")
-- airbrushed divider, 3-slice on x: feathered 16px caps, even ordered-dither 16px centre
local function rule(name, c)
  A.use(A.new(48, 5))
  for i=0,47 do
    local e = math.min(1, math.min(i, 47-i)/15)
    if hit(i, 0, 0.25*e) then px(i, 0, c) end
    if hit(i, 1, 0.75*e) then px(i, 1, c) end
    if e >= 0.35 then px(i, 2, LINE) elseif hit(i, 2, e*2.5) then px(i, 2, c) end
    if hit(i, 3, 0.5*e) then px(i, 3, c) end
    if hit(i, 4, 0.12*e) then px(i, 4, c) end
  end
  piece(name, A.target(), { slice = { top = 0, right = 16, bottom = 0, left = 16 }, repeat_ = "repeat", kind = "bg" })
end
rule("rule-pink", PINK); rule("rule-violet", VIOLET)
-- meter fills, repeat-x: gloss row, face, shade row
local function meter(name, c)
  A.use(A.new(16, 5)); rect(0, 0, 16, 5, c)
  for i=0,15 do if hit(i, 0, 0.7) then px(i, 0, MARBLE) end
    if hit(i, 4, 0.45) then px(i, 4, INK) end end
  piece(name, A.target(), { repeat_ = "repeat-x", kind = "bg" })
end
meter("meter-teal", TEAL); meter("meter-amber", AMBER); meter("meter-pink", PINK); meter("meter-mint", MINT)

-- ================================================================ 3. title bars (repeat-x, 14px = 28 CSS px)
local function barRows(x0, w, shadeC)
  for i=x0,x0+w-1 do
    -- 14px bar: gloss rows 0-1, shade row 12, INK floor 13; rows 2-11 stay clean for caption + controls
    px(i, 0, MARBLE)
    if hit(i, 1, 0.5) then px(i, 1, MARBLE) end
    if hit(i, 12, 0.5) then px(i, 12, shadeC) end
    px(i, 13, INK)
  end
end
local function bar(name, c)
  A.use(A.new(16, 14)); rect(0, 0, 16, 14, c)
  barRows(0, 16, c == VIOLET and INK or VIOLET)
  piece(name, A.target(), { repeat_ = "repeat-x", kind = "bar" })
end
bar("tb-violet", VIOLET); bar("tb-pink", PINK); bar("tb-peach", SKIN); bar("tb-teal", TEAL)
do -- 192px ramp violet > pink > coral > peach; its last 16px equal tb-peach so the two butt seamlessly
  A.use(A.new(192, 14))
  A.tiled(true); A.grad(0, 0, 176, 14, { VIOLET, PINK, CORAL, SKIN }, true); A.tiled("bayer")
  rect(176, 0, 16, 14, SKIN)
  barRows(0, 192, VIOLET)
  piece("tb-ramp", A.target(), { repeat_ = "no-repeat", kind = "bar", next = "tb-peach" })
end

-- ================================================================ 4. button + chip faces (9-slice)
local BTN_SL = { top = 4, right = 4, bottom = 4, left = 4 }
-- 24x14: rim row 0, face rows 1-11, rim 12, drop 13. Gloss rows 1-2, shade rows 10-11;
-- rows 3-9 are flat face so a 5px label (rows 4-8) has 1px of clean fill above and below
local function button(face, state)
  local W, H = 24, 14
  A.use(A.new(W, H))
  rect(1, 1, W-3, H-3, face)
  local rim = state == "hover" and VIOLET or INK
  hline(1, 0, W-3, rim); hline(1, H-2, W-3, rim); vline(0, 1, H-3, rim); vline(W-2, 1, H-3, rim)
  if state ~= "active" then hline(2, H-1, W-2, INK); vline(W-1, 2, H-2, INK); px(W-2, H-2, INK) end
  for i=1,W-3 do
    if state == "active" then
      if hit(i, 1, 0.5) then px(i, 1, INK) end
      if hit(i, 2, 0.25) then px(i, 2, INK) end
      if hit(i, H-3, 0.5) then px(i, H-3, MARBLE) end
    else
      if i >= 2 and i <= W-4 then px(i, 1, MARBLE) end
      if hit(i, 2, state == "hover" and 0.75 or 0.5) then px(i, 2, MARBLE) end
      if hit(i, H-4, 0.25) then px(i, H-4, INK) end
      if hit(i, H-3, 0.5) then px(i, H-3, INK) end
    end
  end
  return A.target()
end
local BTN = { ghost = PHI, primary = TEAL, hot = PINK, on = VIOLET, warn = AMBER, marble = MARBLE }
local BTN_ORDER = { "ghost", "primary", "hot", "on", "warn", "marble" }
for _, v in ipairs(BTN_ORDER) do for _, st in ipairs({ "normal", "hover", "active" }) do
  piece("btn-"..v.."-"..st, button(BTN[v], st), { slice = BTN_SL, repeat_ = "repeat", kind = "button" })
end end
local CHIP_SL = { top = 3, right = 4, bottom = 3, left = 4 }
-- 16x10: gloss row 0, flat rows 1-8 (label rows 2-6), shade row 9
local function chip(face, ring)
  local W, H = 16, 10
  A.use(A.new(W, H)); rect(0, 0, W, H, face)
  for _, p in ipairs({{0,0},{W-1,0},{0,H-1},{W-1,H-1}}) do A.target().d[p[2]*W + p[1] + 1] = nil end
  if ring then
    hline(1, 0, W-2, ring); hline(1, H-1, W-2, ring); vline(0, 1, H-2, ring); vline(W-1, 1, H-2, ring)
  else
    for i=1,W-2 do
      if hit(i, 0, 0.5) then px(i, 0, MARBLE) end
      if hit(i, H-1, 0.5) then px(i, H-1, INK) end
    end
  end
  return A.target()
end
local CHIP = { teal = TEAL, pink = PINK, mint = MINT, amber = AMBER, violet = VIOLET, neutral = PHI, marble = MARBLE }
local CHIP_ORDER = { "teal", "pink", "mint", "amber", "violet", "neutral", "marble" }
for _, v in ipairs(CHIP_ORDER) do piece("chip-"..v, chip(CHIP[v]), { slice = CHIP_SL, repeat_ = "repeat", kind = "chip" }) end
piece("chip-ring-teal", chip(BG, TEAL), { slice = CHIP_SL, repeat_ = "repeat", kind = "chip" })
A.tiled(false)

-- ================================================================ 5. chrome lettering
-- (a) font sheets for dynamic text (team names in the h1), (b) pre-rendered brand strip
local fonts = {}
local function fontSheet(size)
  local h = #A.ROWMAP[size]
  local cellH = h + 3
  local cells, x, y, rowW = {}, 0, 0, 208
  for n=1,#A.CHROME_ORDER do
    local ch = A.CHROME_ORDER:sub(n,n)
    local mw = A.chromeGlyphW(ch, size)
    local cw = mw + 3
    if x + cw > rowW then x = 0; y = y + cellH + 1 end
    cells[#cells+1] = { ch = ch, x = x, y = y, w = cw, h = cellH, advance = mw + A.GAP[size] }
    x = x + cw + 1
  end
  A.use(A.new(rowW, y + cellH))
  for _, c in ipairs(cells) do
    if c.ch ~= " " then
      A.chrome(c.x + 1, c.y + 1, c.ch, size, function() return c.ch:byte() % 3 == 0 end)
    end
  end
  fonts[size] = { cells = cells, cellH = cellH, glyphH = h }
  piece("font-chrome-"..size, A.target(), { kind = "font" })
end
fontSheet("big"); fontSheet("small")
-- lay text out from a font sheet, left to right (exactly what the implementer will do)
local function fontText(x, y, s, size)
  local f = fonts[size]; local img = pieces["font-chrome-"..size].img
  local byCh = {}; for _, c in ipairs(f.cells) do byCh[c.ch] = c end
  local cx = x
  for n=1,#s do
    local c = byCh[s:sub(n,n)] or byCh["?"]
    for j=0,c.h-1 do for i=0,c.w-1 do
      local v = A.get(img, c.x+i, c.y+j); if v then px(cx-1+i, y-1+j, v) end
    end end
    cx = cx + c.advance
  end
  return cx - x
end
do -- brand lockup: sprayed sun rising behind VIBESQUAD (small chrome), for .brand-text
  A.use(A.new(80, 16))
  A.pool(62, 9, 22, 12, PINK, 0.75, { 0, 0, 79, 15 })
  local cx, cy, r = 64, 10, 8
  for y=cy-r-2, math.min(15, cy+r+2) do for x=cx-r-2, cx+r+2 do
    local d = math.sqrt((x-cx)^2 + (y-cy)^2) / r
    local f = A.clamp((y-(cy-r)) / (2*r))
    local c = f < 0.4 and AMBER or (f < 0.72 and (hit(x, y, (f-0.4)*3) and CORAL or AMBER) or CORAL)
    local cut = (y > cy) and ((y - cy) % 4 == 2)
    if not cut and (d < 0.86 or (d < 1.12 and hit(x, y, (1.12-d)*3.6))) then px(x, y, c) end
  end end
  A.chrome(2, 3, "VIBESQUAD", "small")
  A.sparkle(64, 2, 3)
  piece("brand-vibesquad", A.target(), { kind = "strip" })
end

-- ================================================================ 6. sprites
local sprites, sprOrder = {}, {}
local function sprite(name, w, h, draw)
  A.use(A.new(w, h)); draw(w, h)
  sprites[name] = A.target(); sprOrder[#sprOrder+1] = name
end
for i, s in ipairs({ {"xs",2}, {"s",3}, {"m",4}, {"l",5}, {"xl",6} }) do
  local n = s[2]*2 + 1
  sprite("sparkle-"..s[1], n, n, function() A.sparkle(s[2], s[2], s[2]) end)
end
sprite("sparkle-l-pink", 15, 15, function() A.sparkle(7, 7, 5, PINK) end)
sprite("sparkle-l-violet", 15, 15, function() A.sparkle(7, 7, 5, VIOLET) end)
sprite("star-dot", 1, 1, function() px(0, 0, MUTED) end)
for _, s in ipairs({ {"line", LINE}, {"pink", PINK}, {"teal", TEAL}, {"amber", AMBER} }) do
  sprite("star-plus-"..s[1], 3, 3, function() A.star(1, 1, s[2]) end)
end
for _, s in ipairs({ {"mint", MINT}, {"amber", AMBER}, {"line", LINE}, {"pink", PINK}, {"teal", TEAL} }) do
  sprite("pip-"..s[1], 4, 4, function()
    rect(0, 0, 3, 3, s[2]); px(0, 0, MARBLE); hline(0, 3, 3, INK); vline(3, 0, 4, INK) end)
end
local function wbtn(glyph)
  return function()
    rect(1, 1, 6, 6, MARBLE); hline(1, 0, 6, INK); hline(1, 7, 6, INK); vline(0, 1, 6, INK); vline(7, 1, 6, INK)
    hline(2, 8, 6, INK); vline(8, 2, 6, INK); px(7, 7, INK)
    for i=1,6 do if hit(i, 6, 0.6) then px(i, 6, LINE) end end
    if glyph == "min" then hline(2, 5, 4, INK)
    elseif glyph == "max" then hline(2, 2, 4, INK); hline(2, 5, 4, INK); vline(2, 2, 4, INK); vline(5, 2, 4, INK)
    else A.line(2, 2, 5, 5, INK); A.line(5, 2, 2, 5, INK) end
  end
end
sprite("wbtn-min", 9, 9, wbtn("min")); sprite("wbtn-max", 9, 9, wbtn("max")); sprite("wbtn-close", 9, 9, wbtn("close"))
sprite("bullet-teal", 2, 3, function() px(0, 1, TEAL); px(1, 0, TEAL); px(1, 2, TEAL) end)
sprite("pool-floor-pink", 40, 12, function() A.pool(20, 8, 28, 9, VIOLET); A.pool(20, 8, 16, 5, PINK) end)
sprite("pool-floor-amber", 40, 12, function() A.pool(20, 8, 28, 9, VIOLET); A.pool(20, 8, 16, 5, AMBER) end)
sprite("vs-tile", 17, 17, function()
  A.grad(1, 1, 14, 14, { VIOLET, PINK, CORAL }); A.puff(4, 3, 6, 4, MARBLE, 0.6)
  hline(0, 0, 16, INK); hline(0, 15, 16, INK); vline(0, 0, 16, INK); vline(15, 0, 16, INK)
  hline(1, 16, 16, INK); vline(16, 1, 16, INK)
  A.stamp(3, 5, [[
|k...k.kkkk|
|k...k.k...|
|.k.k..kkkk|
|.k.k.....k|
|..k...kkkk|
]], { k = INK })
end)
-- pack sprites into a sheet (shelf packing, 1px gutters)
local sheetW, sx, sy, shelf = 128, 0, 0, 0
local sprRects = {}
for _, n in ipairs(sprOrder) do
  local s = sprites[n]
  if sx + s.w > sheetW then sx = 0; sy = sy + shelf + 1; shelf = 0 end
  sprRects[n] = { x = sx, y = sy, w = s.w, h = s.h }
  sx = sx + s.w + 1; shelf = math.max(shelf, s.h)
end
A.use(A.new(sheetW, sy + shelf))
for _, n in ipairs(sprOrder) do A.blit(sprites[n], sprRects[n].x, sprRects[n].y) end
piece("sprites", A.target(), { kind = "sheet" })

-- ================================================================ export pieces + json
local function json(v, ind)
  ind = ind or ""
  local t = type(v)
  if t == "table" then
    if #v > 0 or next(v) == nil then
      local parts = {}; for _, x in ipairs(v) do parts[#parts+1] = json(x, ind) end
      return "["..table.concat(parts, ",").."]"
    end
    local keys = {}; for k in pairs(v) do keys[#keys+1] = k end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    local parts = {}
    for _, k in ipairs(keys) do parts[#parts+1] = ind.."  "..string.format("%q", tostring(k))..": "..json(v[k], ind.."  ") end
    return "{\n"..table.concat(parts, ",\n").."\n"..ind.."}"
  elseif t == "string" then return string.format("%q", v)
  else return tostring(v) end
end
local function write(path, s) local f = io.open(path, "w"); f:write(s); f:close() end

for _, n in ipairs(order) do
  local p = pieces[n]
  for _, mode in ipairs({ "dark", "light" }) do
    A.toImage(p.img, pal[mode]):saveAs(OUT..n.."-"..mode..".png")
  end
  if p.slice then
    write(OUT..n..".json", json({ slice = p.slice, scale = SCALE, ["repeat"] = p.repeat_ }).."\n")
  end
end
local manifest = { scale = SCALE, files = "<piece>-{dark,light}.png", pieces = {} }
for _, n in ipairs(order) do local p = pieces[n]
  manifest.pieces[n] = { w = p.img.w, h = p.img.h, kind = p.kind, slice = p.slice, ["repeat"] = p.repeat_,
                         anchor = p.anchor, below = p.below, next = p.next }
end
write(OUT.."kit.json", json(manifest).."\n")
write(OUT.."sprites.json", json({ scale = SCALE, image = "sprites-{dark,light}.png", sprites = sprRects,
  anims = { twinkle = { "sparkle-xs", "sparkle-m", "sparkle-s", "sparkle-m" } } }).."\n")
for _, size in ipairs({ "big", "small" }) do
  local f = fonts[size]; local g = {}
  for _, c in ipairs(f.cells) do g[c.ch] = { x = c.x, y = c.y, w = c.w, h = c.h, advance = c.advance } end
  write(OUT.."font-chrome-"..size..".json", json({
    image = "font-chrome-"..size.."-{dark,light}.png", scale = SCALE, glyphHeight = f.glyphH,
    cellHeight = f.cellH, originX = -1, originY = -1, case = "upper", fallback = "?",
    drawOrder = "left-to-right (cells overlap by their INK outline; later glyphs paint over earlier drops)",
    glyphs = g }).."\n")
end

-- ================================================================ gallery (4x)
local function label(x, y, s) A.text(x, y, s, MUTED) end
local function nineDemo(n, x, y, w, h) local p = pieces[n]; A.nine(p.img, p.slice, x, y, w, h) end
local fbH, fsH = pieces["font-chrome-big"].img.h, pieces["font-chrome-small"].img.h
local SY = 418 + fbH + 4 + fsH + 10
local G = A.use(A.new(480, SY + 44))
rect(0, 0, 480, SY + 44, BG)
A.text(4, 3, "U3B PAINTED KIT - 1X PIECES; 9-SLICE DEMOS TILE AT 1X, NEVER STRETCH (CSS SHOWS 2X)", TEXT)
-- frames
label(4, 14, "1 FRAMES 9-SLICE (8/8/8/8)")
local fx = 4
for _, n in ipairs({ "window-frame", "panel-frame", "panel-frame-pink", "panel-frame-amber", "well-frame" }) do
  rect(fx+3, 24, 26, 26, PANEL); A.blit(pieces[n].img, fx, 21)
  A.text(fx, 56, n:gsub("panel%-frame%-", "P-"):gsub("%-frame", ""):upper(), MUTED); fx = fx + 40
end
A.tile(pieces["bg-panel"].img, 211, 22, 118, 46); A.tile(pieces["tb-shade"].img, 211, 36, 118, 4)
A.blit(pieces["tb-ramp"].img, 211, 22)
nineDemo("window-frame", 210, 21, 121, 49)
rect(340, 22, 60, 40, PANEL); nineDemo("panel-frame", 339, 21, 62, 42)
rect(410, 22, 64, 12, BG); nineDemo("well-frame", 409, 21, 66, 14)
A.tile(pieces["meter-teal"].img, 410, 26, 40, 5)
-- title bars
label(4, 76, "3 TITLE BARS REPEAT-X (14PX = 28 CSS)")
local bx = 4
for _, n in ipairs({ "tb-violet", "tb-pink", "tb-peach", "tb-teal" }) do
  A.tile(pieces[n].img, bx, 85, 48, 14); A.text(bx, 102, n:upper(), MUTED); bx = bx + 54
end
A.blit(pieces["tb-ramp"].img, 222, 85); A.tile(pieces["tb-peach"].img, 414, 85, 62, 14)
A.text(222, 102, "TB-RAMP 192PX THEN TB-PEACH REPEAT-X", MUTED)
-- buttons
label(4, 110, "4 BUTTON FACES 9-SLICE (4/4/4/4): NORMAL / HOVER / ACTIVE, RAW + STRETCHED")
for r, v in ipairs(BTN_ORDER) do
  local y = 120 + (r-1)*16
  A.text(4, y+4, v:upper(), MUTED)
  for s, st in ipairs({ "normal", "hover", "active" }) do
    local x = 36 + (s-1)*28
    A.blit(pieces["btn-"..v.."-"..st].img, x, y)
    local dx = 130 + (s-1)*58
    nineDemo("btn-"..v.."-"..st, dx, y, 52, 14)
    local lbl = ({ ghost = "CANCEL", primary = "SEND", hot = "NEEDS", on = "SQUADS", warn = "WAIT", marble = "@SIM" })[v]
    local lx = dx + (51 - A.textW(lbl))//2 + (st == "active" and 1 or 0)
    local ly = y + 4 + (st == "active" and 1 or 0)
    if v == "ghost" or v == "warn" or v == "marble" then A.text(lx, ly, lbl, v == "ghost" and TEXT or INK)
    else A.keyText(lx, ly, lbl, MARBLE) end
  end
end
-- chips
label(310, 110, "4 CHIPS 9-SLICE (3/4/3/4)")
for i, v in ipairs(CHIP_ORDER) do
  local y = 120 + (i-1)*12
  A.blit(pieces["chip-"..v].img, 310, y)
  nineDemo("chip-"..v, 332, y, 40, 10)
  A.text(335, y+2, v:upper(), (v == "neutral") and TEXT or (v == "pink" and BG or INK))
end
A.blit(pieces["chip-ring-teal"].img, 310, 205); nineDemo("chip-ring-teal", 332, 205, 32, 10)
A.text(334, 207, "RIFFBOT", TEAL)
-- backgrounds
label(4, 220, "2 BACKGROUNDS: RAMPS REPEAT-X, STAR TILE, CLOUDS, SELECTION GLOWS, PLATE, RULES, METERS")
local gx = 4
for _, n in ipairs({ "bg-page", "bg-sidebar", "bg-panel", "bg-well" }) do
  local p = pieces[n].img
  A.tile(p, gx, 230, 24, math.min(96, p.h)); A.text(gx, 330, n:sub(4):upper(), MUTED); gx = gx + 30
end
rect(126, 230, 96, 96, BG); A.tile(pieces["stars"].img, 126, 230, 96, 96); A.text(126, 330, "STARS 128", MUTED)
A.blit(pieces["cloud-corner"].img, 228, 230); A.text(228, 304, "CLOUD-CORNER", MUTED)
A.blit(pieces["cloud-foot"].img, 228, 312)
A.blit(pieces["header-halo"].img, 244, 360); A.text(244, 394, "HEADER-HALO", MUTED)
A.blit(pieces["sunset-plate"].img, 400, 230); A.text(400, 300, "SUNSET-PLATE", MUTED)
rect(4, 340, 80, 18, PHI); A.blit(pieces["sel-teal"].img, 4, 340); A.text(90, 346, "SEL-TEAL", MUTED)
rect(4, 362, 85, 9, PHI); A.blit(pieces["sel-violet"].img, 4, 362); A.text(92, 364, "SEL-VIOLET", MUTED)
A.nine(pieces["rule-pink"].img, pieces["rule-pink"].slice, 4, 376, 100, 5)
A.nine(pieces["rule-violet"].img, pieces["rule-violet"].slice, 110, 376, 100, 5)
for i, n in ipairs({ "meter-teal", "meter-amber", "meter-pink", "meter-mint" }) do
  A.tile(pieces[n].img, 4 + (i-1)*30, 386, 26, 5) end
A.tile(pieces["edge-sidebar"].img, 130, 384, 2, 12)
A.text(140, 386, "EDGE-SIDEBAR, METERS, RULES", MUTED)
A.text(344, 340, "CLOUD-FOOT", MUTED)
-- chrome
label(4, 404, "5 CHROME: FONT SHEETS (A-Z 0-9 PUNCT) + JSON, AND THE PRE-RENDERED BRAND STRIP")
A.blit(pieces["font-chrome-big"].img, 4, 414)
local fb = pieces["font-chrome-big"].img
A.blit(pieces["font-chrome-small"].img, 4, 418 + fb.h)
A.blit(pieces["header-halo"].img, 212, 410)
fontText(236, 418, "ESCAPE FROM IDLE", "big")
fontText(236, 440, "TEAM 42: UI RAID!", "big")
fontText(236, 462, "SIM CORE & CO.", "small")
A.blit(pieces["brand-vibesquad"].img, 236, 478)
A.text(320, 484, "BRAND-VIBESQUAD", MUTED)
-- sprites
label(4, SY, "6 SPRITES SHEET + JSON")
A.blit(pieces["sprites"].img, 4, SY+10)
local cx2 = 140
for _, n in ipairs({ "sparkle-xl", "sparkle-l-pink", "sparkle-l-violet", "sparkle-m", "sparkle-s" }) do
  A.blit(sprites[n], cx2, SY+10); cx2 = cx2 + sprites[n].w + 6
end
A.text(140, SY+30, "ANIM TWINKLE: XS > M > S > M", MUTED)

-- ================================================================ recompose: the U3a layout from kit pieces only
-- (text = the 3x5 font standing in for app text; bust/floor = existing cast assets)
local W, H = 480, 270
local R = A.use(A.new(W, H))
local function N(n, x, y, w, h) local p = pieces[n]; A.nine(p.img, p.slice, x, y, w, h) end
local function B(n, x, y) A.blit(pieces[n] and pieces[n].img or sprites[n], x, y) end
local function SP(n, cx, cy) local s = sprites[n]; A.blit(s, cx - s.w//2, cy - s.h//2) end
local function rampFill(n, x, y, w, h)
  local p = pieces[n]; A.tile(p.img, x, y, w, math.min(h, p.img.h))
  if h > p.img.h then rect(x, y + p.img.h, w, h - p.img.h, ({ PANEL = PANEL, PHI = PHI })[p.below]) end
end
local function cush(x, y, s, c, face) rect(x-1, y-1, A.textW(s)+2, 7, face); A.text(x, y, s, c) end
-- btn: x,y,w = face box; full buttons are 11 tall (image 14), label on face rows 3-7
local function btn(v, x, y, w, lbl, st)
  N("btn-"..v.."-"..(st or "normal"), x-1, y-1, w+3, 14)
  if lbl then local lx = x + (w - A.textW(lbl))//2
    if v == "ghost" then A.text(lx, y+3, lbl, TEXT)
    elseif v == "warn" or v == "marble" then A.text(lx, y+3, lbl, INK)
    else A.keyText(lx, y+3, lbl, MARBLE) end
  end
end
-- compact 9px-tall control (row menus): same 9-slice, the 4px caps meet in the middle
local function mini(x, y, w) N("btn-ghost-normal", x-1, y-1, w+3, 11) end
-- chip: 10 tall, label rows 2-6
local function chipN(v, x, y, w, lbl, lc) N("chip-"..v, x, y, w, 10); A.text(x + (w - A.textW(lbl))//2, y+2, lbl, lc) end
local function dots3(x, y) px(x, y, TEXT); px(x+2, y, TEXT); px(x+4, y, TEXT) end
local SBW = 100
-- page
rampFill("bg-page", SBW+2, 0, W-SBW-2, H)
A.tile(pieces["stars"].img, SBW+2, 0, W-SBW-2, H)
B("cloud-corner", W-160, H-72)
-- sidebar
rampFill("bg-sidebar", 0, 0, SBW, H)
B("cloud-foot", 0, H-48)
A.tile(pieces["edge-sidebar"].img, SBW, 0, 2, H)
SP("vs-tile", 11, 11)
B("brand-vibesquad", 20, 1)
cush(22, 17, "VAPOR OS // 199X", MUTED, PANEL)
btn("ghost", 5, 25, 90, nil); A.text(10, 28, "INBOX (2)", TEXT); chipN("pink", 80, 25, 11, "2", BG)
A.text(5, 44, "SQUADS", MUTED); btn("ghost", 46, 41, 49, "COLLAPSE ALL")
local function squadTile(y, letter, l1, l2, count, badge, active)
  rect(4, y, 80, 18, PHI)
  if active then B("sel-teal", 4, y) end
  N("panel-frame", 3, y-1, 82, 20)
  N("btn-warn-normal", 7, y+2, 13, 14); A.text(11, y+6, letter, INK)
  cush(22, y+3, l1, TEXT, PHI); if l2 then cush(22, y+10, l2, TEXT, PHI) end
  if count then chipN("neutral", 66, y+4, 13, count, TEXT) end
  if badge then chipN("pink", 66, y+4, 13, badge, BG) end
  mini(88, y+5, 8); dots3(89, y+9)
end
local function hubRow(y, pip)
  vline(5, y-2, 11, TEAL)
  N("chip-ring-teal", 9, y-2, 31, 10); A.text(11, y, "RIFFBOT", TEAL)
  A.text(43, y, "SQUAD HUB", MUTED); SP(pip, 89, y+2)
end
local function teamsHead(y, l) A.text(5, y, l, MUTED); mini(87, y-2, 9); A.text(90, y, "+", TEXT) end
local function teamRow(y, name, code, pip, opt)
  opt = opt or {}
  if opt.sel then rect(2, y-2, 85, 9, PHI); B("sel-violet", 2, y-2) end
  SP(pip, 7, y+2)
  if opt.sel then cush(13, y, name, TEXT, PHI) else A.text(13, y, name, opt.dim and MUTED or TEXT) end
  if opt.badge then chipN("pink", 55, y-2, 9, opt.badge, BG) end
  chipN("neutral", 67, y-2, A.textW(code)+4, code, MUTED)
  mini(89, y-1, 7); dots3(90, y+3)
end
squadTile(55, "E", "ESCAPE FROM", "IDLE", "8", nil, true)
hubRow(80, "pip-mint")
teamsHead(92, "TEAMS 8")
for i, r in ipairs({ {"SIM CORE","@SIM","pip-mint"}, {"ECONOMY","@ECO","pip-amber"}, {"UI RAID","@UIR","pip-line",{badge="1"}},
                     {"ART PIPE","@ART","pip-line",{sel=true}}, {"RELEASE","@REL","pip-line",{dim=true}} }) do
  teamRow(103 + (i-1)*11, r[1], r[2], r[3], r[4])
end
squadTile(163, "V", "VIBESQUAD", nil, nil, "1", false)
hubRow(188, "pip-teal")
teamsHead(200, "TEAMS 7")
for i, r in ipairs({ {"ART DIR","@ART","pip-mint"}, {"BUG CHASE","@BUG","pip-amber"}, {"UI BOIS","@UI","pip-line"} }) do
  teamRow(211 + (i-1)*11, r[1], r[2], r[3])
end
rect(5, 242, 90, 9, BG); N("well-frame", 4, 241, 92, 11)
A.text(7, 244, "SIGNALS >", MUTED); SP("star-plus-pink", 78, 246); SP("star-plus-teal", 85, 246); px(91, 246, MARBLE)
local tx = 5
for _, b in ipairs({ {20, "100%"}, {9, "?"}, {9, "I"}, {9, "#"}, {9, ">"} }) do btn("ghost", tx, 255, b[1], b[2]); tx = tx + b[1] + 4 end
-- top bar + header
local MX = SBW + 7
btn("on", MX, 3, 30, "SQUADS")
A.text(MX+38, 6, "SQUADS > ESCAPE FROM IDLE", MUTED)
btn("ghost", W-26, 3, 21, "100%")
B("header-halo", MX-2, 13)
N("btn-warn-normal", MX-1, 20, 18, 18); A.text(MX+6, 26, "E", INK)
local hw = fontText(MX+23, 22, "ESCAPE FROM IDLE", "big")
SP("sparkle-l", MX+23+hw+6, 23); SP("sparkle-s", MX+22, 21)
cush(W-6-A.textW("9 TEAMS - 0 NEED YOU"), 28, "9 TEAMS - 0 NEED YOU", MUTED, BG)
btn("primary", MX, 42, 28, "+ TEAM"); btn("ghost", MX+33, 42, 38, "SETTINGS"); btn("ghost", MX+76, 42, 20, "FULL")
-- window: 14px title bar, controls on bar rows 2-11
local WX, WY, WW, WH = MX, 59, W-MX-7, 204
rampFill("bg-panel", WX, WY+14, WW, WH-14)
B("cloud-corner", WX+WW-160, WY+WH-72)
A.tile(pieces["tb-shade"].img, WX, WY+14, WW, 4)
B("tb-ramp", WX, WY); A.tile(pieces["tb-peach"].img, WX+192, WY, WW-192, 14)
A.text(WX+6, WY+5, "SIM CORE", INK); SP("sparkle-s", WX+44, WY+6)
chipN("marble", WX+WW-57, WY+2, 20, "@SIM", INK)
for i, n in ipairs({ "wbtn-min", "wbtn-max", "wbtn-close" }) do B(n, WX+WW-34+(i-1)*11, WY+2) end
N("window-frame", WX-1, WY-1, WW+3, WH+3)
local PX, PY = WX+8, WY+21
B("sunset-plate", PX, PY)
do local b = A.load(root.."/art/cast/hypno/lead-bust.aseprite"); A.blit(b, PX+2, PY+4) end
N("panel-frame-pink", PX-1, PY-1, 70, 70)
SP("sparkle-l-pink", PX+62, PY+5)
btn("on", PX, PY+72, 68, "LEAD")
local RX = PX + 80
A.text(RX, PY+1, "BIG CHEESE  -  LEAD", TEXT)
A.text(RX, PY+9, "3 AGENTS LIVE", MUTED)
A.text(RX, PY+17, "BUDDY: WALKMAN KID", TEAL)
rect(WX+WW-55, PY-2, 49, 12, PANEL); chipN("pink", WX+WW-54, PY-1, 47, "! NEEDS YOU", BG)
SP("sparkle-s", WX+WW-6, PY-2)
local cx = RX
for _, s in ipairs({ {"RUN", "pip-mint"}, {"WAIT", "pip-amber"}, {"IDLE", "pip-line"} }) do
  local w = A.textW(s[1]) + 13
  btn("ghost", cx, PY+27, w, nil); SP(s[2], cx+5, PY+32); A.text(cx+9, PY+30, s[1], TEXT)
  cx = cx + w + 6
end
A.text(RX, PY+46, "CTX  82K / 150K", MUTED)
rect(RX+64, PY+46, 112, 5, BG); A.tile(pieces["meter-teal"].img, RX+64, PY+46, 40, 5)
A.tile(pieces["meter-amber"].img, RX+104, PY+46, 22, 5)
N("well-frame", RX+63, PY+45, 114, 7)
A.nine(pieces["rule-pink"].img, pieces["rule-pink"].slice, RX, PY+57, WX+WW-8-RX, 5)
for i, s in ipairs({ "CREATE AGENT  ART PAINTER", "CREATE AGENT  ART DIRECTOR", "VS WHO LEAD  -  LIVE" }) do
  local ly = PY + 65 + (i-1)*8
  B("bullet-teal", RX, ly+1); A.text(RX+5, ly, s, i == 3 and TEAL or TEXT)
end
local AY = PY + 98
A.text(PX, AY, "AGENTS ON THE FLOOR", MUTED)
A.nine(pieces["rule-violet"].img, pieces["rule-violet"].slice, PX+80, AY, WX+WW-10-PX-80, 5)
for i, r in ipairs({ {"lead","LEAD","pip-mint"}, {"buddy","BUDDY","pip-mint"}, {"implement","BUILD","pip-amber"}, {"review","REVIEW","pip-line"} }) do
  local tx0 = PX + (i-1)*86
  rampFill("bg-well", tx0, AY+9, 76, 36)
  B(i == 3 and "pool-floor-amber" or "pool-floor-pink", tx0, AY+33)
  A.blit(A.load(root.."/art/cast/hypno/"..r[1].."-floor.aseprite"), tx0+4, AY+12)
  N(i == 3 and "panel-frame-amber" or "panel-frame", tx0-1, AY+8, 78, 38)
  SP(r[3], tx0+42, AY+17); cush(tx0+46, AY+15, r[2], TEXT, PANEL)
  A.text(tx0+46, AY+33, i == 3 and "WAIT" or (i == 4 and "IDLE" or "LIVE"), MUTED)
end
local IY = WY + WH - 21
rect(WX+8, IY, WW-118, 15, BG); N("well-frame", WX+7, IY-1, WW-116, 17)
A.text(WX+12, IY+5, "MESSAGE SIM CORE...", MUTED); vline(WX+12+A.textW("MESSAGE SIM CORE...")+2, IY+4, 7, TEAL)
btn("ghost", WX+WW-102, IY+2, 44, "CANCEL"); btn("primary", WX+WW-51, IY+2, 42, "SEND")
SP("sparkle-s", WX+WW-12, IY+2)

-- ================================================================ write shots + source sprites
for _, mode in ipairs({ "dark", "light" }) do
  local g = A.toImage(G, pal[mode], 4, BG)
  g:saveAs(root.."/scratch/shots/u3b-kit-"..mode..".png")
  local r1 = A.toImage(R, pal[mode], 1, BG)
  local r4 = A.toImage(R, pal[mode], 4, BG)
  r4:saveAs(root.."/scratch/shots/u3b-recompose-"..mode..".png")
  -- source copies for hand-editing in Aseprite (RGB, 1x)
  for nm, im in pairs({ ["kit-gallery"] = A.toImage(G, pal[mode], 1, BG), ["recompose"] = r1 }) do
    local spr = Sprite(im.width, im.height, ColorMode.RGB)
    spr.cels[1].image = im
    spr:saveAs(root.."/art/ui/u3b/"..nm.."-"..mode..".aseprite"); spr:close()
  end
  print("wrote u3b-kit-"..mode.." "..g.width.."x"..g.height.." / u3b-recompose-"..mode.." "..r4.width.."x"..r4.height)
end
print("pieces: "..#order.." x2 modes, sprites: "..#sprOrder)
