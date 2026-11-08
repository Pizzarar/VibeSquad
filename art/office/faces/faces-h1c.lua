-- H1c RiffBot + Overlord 48px faces, re-anchored on the H0 hand (docs/art/STYLE_BIBLE.md) from the
-- owner-approved H1a sketches (art/h1/gallery.lua riffbot/overlord, 60e5144). One solid outlined
-- object per bot, googly MARBLE eyes, INK line mouths, flat P0 fills, hand-placed shapes, no dither.
--   RiffBot : cream TV on rabbit ears and sneakers. Googly eyes on the teal screen; the stock
--             ticker IS the mouth (owner 4a): an INK band with AMBER prices that opens, ticks,
--             shouts "YO!!" (needs) and crashes to a PINK "-9.99" with a wobbly lip (scared).
--   Overlord: one violet TV with a glass jar on top holding its brain (owner 4a), one big googly
--             eye and a toothy grin on the mint screen. Brain bobs (idle/lookDown), glows (needs).
-- Gutter contract (UI lane): bg = SKY (13) everywhere, columns 0 and 47 stay flat SKY in every
-- frame (asserted below), no pink flash background: needs[1] flashes inside the object instead.
-- Cells/offsets/order = public/office/faces.json (unchanged; this script does not write it).
-- Writes public/office/face-{riffbot,overlord}-{dark,light}.png + art/office/faces/{riffbot,overlord}.aseprite.
-- After it, re-run takeover.lua (reads overlord needs[0]).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/faces/faces-h1c.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local K, V, P, CO, A, S, M, T, G, Y = 15, 8, 9, 10, 11, 14, 4, 7, 12, 13
local CW, CH = 48, 48

-- ---------- shared face language (same helpers as art/h1/gallery.lua) ----------
local function eyes(C, list) for _, e in ipairs(list) do C.ellipse(e[1], e[2], e[3], e[4], M) end; C.outline(K) end
local function lids(C, list, lidc, frac)
  for _, e in ipairs(list) do
    local top = math.ceil(e[2] - e[4]); local cut = math.floor(e[2] - e[4] + 2*e[4]*frac + 0.5)
    for y=top, cut do for x=math.floor(e[1]-e[3])-1, math.ceil(e[1]+e[3])+1 do
      if C.get(x, y) == M then C.px(x, y, y == cut and K or lidc) end
    end end
  end
end
local function pupil(C, x, y, w, h) C.rect(x, y, w or 2, h or 3, K); C.px(x, y, M) end
local function bang(C, x, y)
  C.rect(x+1, y, 5, 9, M); C.rect(x, y+1, 7, 7, M)
  C.outline(K)
  C.vline(x+3, y+2, 3, P); C.px(x+3, y+6, P)
end
-- text clipped to a box (ticker window)
local function clipText(C, x, y, s, c, x0, x1)
  local tmp = { px = function(px, py, cc) if px >= x0 and px <= x1 then C.px(px, py, cc) end end }
  L.text(tmp, x, y, s, c)
end

-- ---------- RiffBot ----------
local RIFF = { "back", "body", "screen", "face", "mouth", "prop", "fx" }
local EYE_N = {{15, 20, 3.1, 3.6}, {25, 19, 3.6, 4.6}}
local EYE_W = {{15, 19, 3.6, 4.1}, {25, 18, 4.1, 5.1}}
local TICK = "+4.20"

local function riff(C, s)
  C.back.rect(0, 0, CW, CH, Y)
  local b = C.body
  b.poly({6,11, 22,9, 41,10, 43,26, 42,41, 24,42, 5,41, 4,25}, M)
  b.poly({5,37, 42,37, 42,41, 24,42, 5,41}, CO)
  b.outline(K)
  b.hline(5, 36, 38, K)
  for x=8,40,4 do b.px(x, 39, A) end
  local sc = C.screen
  sc.rect(8, 13, 26, 22, K); sc.rect(9, 14, 24, 20, T)
  for y=15,33,4 do sc.hline(10, y, 22, G) end
  for i, k in ipairs({{38, 16}, {38, 23}}) do
    sc.ellipse(k[1], k[2], 2.2, 2.2, (s.flash and i == 1) and A or P)
  end
  for y=28,32,2 do sc.hline(36, y, 5, K) end
  sc.px(38, 14, K); sc.px(38, 21, K)

  -- eyes
  local f = C.face
  local E = s.wide and EYE_W or EYE_N
  eyes(f, E)
  if s.eyes == "look" then                       -- idle: lopsided googly stare
    pupil(f, 14, 20); pupil(f, 25 + (s.px or 0), 18)
  elseif s.eyes == "down" then                   -- lookDown: lids half, pupils sunk
    lids(f, E, T, 0.45); pupil(f, 14, 21); pupil(f, 24, 20)
  elseif s.eyes == "shut" then                   -- shut: lids all the way, INK lid curves
    lids(f, E, T, 1.0)
    f.line(12, 20, 15, 22, K); f.line(15, 22, 18, 20, K); f.line(22, 19, 25, 21, K); f.line(25, 21, 28, 19, K)
  elseif s.eyes == "yo" then
    pupil(f, 15 + (s.px or 0), 16, 2, 2); pupil(f, 25 + (s.px or 0), 15, 2, 2)
  elseif s.eyes == "scared" then                 -- pin pupils that jitter
    local j = s.jit or 0
    f.rect(15 + j, 19, 1, 2, K); f.rect(26 - j, 18, 1, 2, K)
  end
  if s.brow == "up" then
    f.line(11, 13, 16, 12, K); f.line(22, 11, 28, 12, K)
  elseif s.brow == "worry" then                  -- inner ends up
    f.line(11, 13, 16, 11, K); f.line(23, 10, 29, 12, K)
  end

  -- ticker mouth: INK band, text on rows y0+1..y0+5, optional tongue below the text
  local m = C.mouth
  local y0, h = s.band[1], s.band[2]
  local x0, x1 = 10, 31
  m.rect(x0, y0, x1 - x0 + 1, h, s.flash and P or K)
  m.px(x0, y0 + h - 1, 0); m.px(x1, y0 + h - 1, 0)                            -- rounded lower lip
  if s.lip == "smirk" then                                                     -- lopsided corner hooks
    m.px(x0 - 1, y0, K); m.px(x1 + 1, y0, K); m.px(x1 + 2, y0 - 1, K)
  elseif s.lip == "wobble" then                                                -- scared: wavy top lip
    for x = x0, x1 do if ((x // 2) + (s.jit or 0)) % 2 == 0 then m.px(x, y0 - 1, K) end end
  end
  if s.tongue then
    local ty = y0 + h - 2
    m.hline(15, ty, 12, s.tongueC or P); m.hline(17, ty - 1, 8, s.tongueC or P)
  end
  clipText(m, x0 + 1 - (s.scroll or 0), y0 + 1, s.text or TICK, s.textC or A, x0 + 1, x1 - 1)

  -- antennas, sneakers, waving arm
  local p = C.prop
  p.rect(19, 8, 9, 2, K)
  p.rect(11, 43, 6, 3, A); p.rect(30, 43, 6, 3, A)
  if s.arm == 1 then
    p.poly({41,29, 43,22, 45,23, 43,30}, M); p.ellipse(43, 18, 2.2, 2.6, M)
  elseif s.arm == 2 then
    p.poly({41,29, 42,21, 44,21, 43,30}, M); p.ellipse(42, 17, 2.2, 2.6, M)
  end
  p.outline(K)
  if s.droop then                                                              -- scared: ears sag
    p.line(19, 9, 13, 4, K); p.line(27, 9, 33, 6, K); p.line(33, 6, 38, 7, K)
    p.rect(12, 3, 2, 2, P); p.rect(38, 6, 2, 2, P)
  else
    p.line(19, 9, 12, 2, K); p.line(27, 9, 31, 5, K); p.line(31, 5, 37, 3, K)
    p.rect(11, 1, 2, 2, P); p.rect(37, 2, 2, 2, P)
  end
  p.vline(14, 41, 2, K); p.vline(33, 41, 2, K)

  local fx = C.fx
  if s.arm == 1 then fx.line(46, 15, 45, 13, K); fx.line(46, 20, 46, 19, K)    -- wave ticks
  elseif s.arm == 2 then fx.line(39, 14, 38, 12, K); fx.line(46, 13, 45, 11, K) end
  if s.yo then
    if s.flash then L.twinkle(fx, 6, 6, A, M, 2); L.twinkle(fx, 3, 30, P, nil, 1)
    else L.twinkle(fx, 6, 4, A, M, 2); L.twinkle(fx, 42, 7, A, nil, 1) end
  elseif s.scared then                                                         -- shake ticks off the case
    local o = s.jit or 0
    fx.vline(2, 17 + o, 3, K); fx.vline(2, 26 - o, 2, K); fx.vline(45, 18 - o, 3, K); fx.vline(45, 30 + o, 2, K)
  else
    L.twinkle(fx, 43, 4, M, nil, 1); fx.px(3, 34, V)
  end
end

local RIFF_FRAMES = {
  { eyes = "down", band = {27, 7}, lip = "smirk" },                                         -- lookDown x0
  { eyes = "look", band = {27, 7}, lip = "smirk" },                                         -- idle     x48
  { eyes = "shut", band = {27, 7}, lip = "smirk" },                                         -- blink    x96
  { eyes = "look", band = {26, 8}, text = "+6.90", tongue = true },                         -- talk     x144
  { eyes = "look", band = {25, 9}, text = "+9.00", tongue = true, px = 1 },                 -- talk     x192
  { eyes = "look", band = {27, 7}, text = "+6.90", lip = "smirk" },                         -- talk     x240
  { eyes = "yo", wide = true, brow = "up", band = {25, 9}, text = "YO!!", textC = P,
    scroll = -2, tongue = true, tongueC = CO, arm = 1, yo = true },                         -- needs    x288
  { eyes = "yo", wide = true, brow = "up", band = {25, 9}, text = "YO!!", textC = K,
    scroll = -2, tongue = true, tongueC = CO, arm = 2, yo = true, flash = true, px = 1 },   -- needs    x336
  { eyes = "scared", wide = true, brow = "worry", band = {27, 6}, text = "-9.99", textC = P,
    lip = "wobble", droop = true, scared = true, jit = 0, shake = -1 },                     -- scared   x384
  { eyes = "scared", wide = true, brow = "worry", band = {27, 6}, text = "-9.99", textC = P,
    lip = "wobble", droop = true, scared = true, jit = 1, shake = 1, scroll = 1 },          -- scared   x432
}

-- ---------- Overlord ----------
local OVER = { "back", "brain", "jar", "body", "screen", "face", "mouth", "prop", "fx" }
local OEYE_N = {{20, 30, 6.1, 4.6}}
local OEYE_W = {{20, 30, 6.6, 5.1}}

local function over(C, s)
  C.back.rect(0, 0, CW, CH, Y)
  local br = C.brain
  br.ellipse(24, 12, 9.6, 6.1, P, {0,1,0,0,-1,0}, {0,0,1,0,0,1})
  br.outline(K)
  local fold = s.glow and A or CO
  br.line(17, 10, 20, 8, fold); br.line(20, 8, 22, 11, fold); br.line(24, 7, 25, 12, fold)
  br.line(27, 9, 30, 8, fold); br.line(28, 13, 31, 12, fold); br.line(18, 14, 22, 14, fold)
  br.vline(24, 13, 4, K)
  br.px(19, 7, M); br.px(18, 8, M)                                             -- shine
  local j = C.jar
  j.ellipse(24, 12, 15, 11, M); j.rect(9, 12, 31, 7, M)
  j.outline(K)
  for y=0,20 do for x=0,47 do if j.get(x, y) == M then j.px(x, y, 0) end end end
  j.vline(12, 6, 9, M); j.vline(13, 4, 2, M); j.px(35, 5, M); j.px(36, 6, M)
  local b = C.body
  b.poly({4,22, 24,21, 44,22, 45,34, 44,43, 24,44, 4,43, 3,33}, V)
  b.rect(8, 18, 32, 3, A)
  b.outline(K)
  for _, x in ipairs({10, 24, 37}) do b.px(x, 19, K) end
  b.hline(5, 21, 39, K)
  b.px(42, 24, M); b.px(43, 25, M)                                             -- shine on the cabinet
  local sc = C.screen
  sc.rect(7, 24, 26, 18, K); sc.rect(8, 25, 24, 16, G)
  for y=26,40,3 do sc.hline(9, y, 22, T) end
  for i, k in ipairs({{38, 28}, {38, 35}}) do
    sc.ellipse(k[1], k[2], 2.2, 2.2, (s.flash and i == 2) and P or A)
  end
  sc.px(38, 26, K); sc.px(38, 33, K)
  for y=39,41,2 do sc.hline(36, y, 5, K) end

  local f = C.face
  local E = s.wide and OEYE_W or OEYE_N
  eyes(f, E)
  local ix, iy = s.iris[1], s.iris[2]
  if s.lid then lids(f, E, G, s.lid) end
  if s.lid and s.lid >= 0.8 then f.line(15, 30, 20, 32, K); f.line(20, 32, 25, 30, K) end      -- shut lid curve
  if s.lid == nil or s.lid < 0.8 then
    if s.wide then f.ellipse(ix, iy, 2.6, 2.6, P) else f.ellipse(ix, iy, 2.1, 1.6, P) end
    pupil(f, ix - 1, iy - (s.wide and 1 or 0), 2, 2)                          -- iris sits below the lid cut
  end
  if s.brow == "smug" then f.line(13, 24 + (s.browDy or 0), 27, 26 + (s.browDy or 0), K)
  elseif s.brow == "up" then f.line(12, 23, 18, 25, K); f.line(22, 25, 28, 22, K) end

  local m = C.mouth
  if s.mouth == "grin" then                                                    -- closed toothy grin
    f.hline(11, 37, 18, K); f.hline(12, 39, 16, K)
    for x=12,27 do f.px(x, 38, (x % 3) ~= 0 and M or K) end
    f.px(10, 36, K); f.px(29, 36, K)
  else                                                                         -- open: {y, h}
    local my, mh = s.mouth[1], s.mouth[2]
    m.rect(11, my, 18, mh, P); m.outline(K)
    for x=12,27 do if (x % 3) ~= 1 then m.px(x, my, M) end end
    if mh >= 4 then m.hline(15, my + mh - 1, 10, CO) end
  end

  local p = C.prop
  p.rect(9, 45, 6, 2, A); p.rect(32, 45, 6, 2, A)
  p.outline(K)
  local fx = C.fx
  if s.zap then bang(C.fx, 39, s.zap - 1) end                                 -- bang first: zaps stay unoutlined
  if s.zap == 1 then
    fx.line(2, 4, 5, 7, A); fx.line(5, 7, 2, 10, A); fx.line(2, 10, 5, 13, A)
    fx.line(46, 12, 43, 15, A); fx.line(43, 15, 46, 18, A)
  elseif s.zap == 2 then
    fx.line(5, 2, 2, 5, A); fx.line(2, 5, 5, 8, A); fx.line(5, 8, 2, 11, A)
    fx.line(43, 10, 46, 13, A); fx.line(46, 13, 43, 16, A); fx.line(43, 16, 46, 19, A)
  else
    L.twinkle(fx, 43, 6, M, nil, 1); fx.px(3, 9, V)
  end
end

local OVER_FRAMES = {
  { lid = 0.5, iris = {19, 33}, brow = "smug", browDy = 1, mouth = "grin" },                 -- lookDown x0
  { lid = 0.5, iris = {18, 33}, brow = "smug", browDy = 1, mouth = "grin", bob = -1 },       -- lookDown x48
  { lid = 0.5, iris = {19, 32}, brow = "smug", mouth = "grin" },                             -- idle     x96
  { lid = 0.5, iris = {21, 32}, brow = "smug", mouth = "grin", bob = -1 },                   -- idle     x144
  { lid = 1.0, iris = {19, 32}, brow = "smug", mouth = "grin" },                            -- blink    x192
  { lid = 0.35, iris = {20, 31}, brow = "smug", mouth = {36, 3} },                           -- talk     x240
  { lid = 0.35, iris = {20, 31}, brow = "smug", mouth = {36, 5}, bob = -1 },                 -- talk     x288
  { lid = 0.35, iris = {20, 31}, brow = "smug", mouth = {37, 2} },                           -- talk     x336
  { wide = true, iris = {20, 30}, brow = "up", mouth = {36, 5}, zap = 1, glow = true },      -- needs    x384
  { wide = true, iris = {21, 29}, brow = "up", mouth = {35, 6}, zap = 2, glow = true,
    flash = true, bob = -1 },                                                                -- needs    x432
}

-- ---------- build + export ----------
local function flat(spr, frame)
  local img = Image(spr.width, spr.height, ColorMode.INDEXED); img:clear(0)
  img:drawSprite(spr, frame)
  return img
end

local function build(name, layers, draw, frames, shift)
  local spr = L.new(CW, CH, pal)
  for i = 2, #frames do spr:newFrame() end
  local lay = {}
  for _, n in ipairs(layers) do lay[n] = L.layer(spr, n) end
  local N = #frames
  local strip = Image(CW*N, CH, ColorMode.INDEXED); strip:clear(0)
  for i, s in ipairs(frames) do
    local C = {}
    for _, n in ipairs(layers) do C[n] = L.canvas(spr, lay[n], spr.frames[i]) end
    draw(C, s)
    for _, n in ipairs(layers) do C[n].commit() end
    shift(spr, lay, i, s)
    local img = flat(spr, i)
    for y = 0, CH-1 do                                                         -- gutter contract
      for _, x in ipairs({0, CW-1}) do
        assert(img:getPixel(x, y) == Y, name.." frame "..i.." edge x"..x.." y"..y.." is not SKY")
      end
    end
    strip:drawImage(img, Point((i-1)*CW, 0))
  end
  spr:saveAs(root.."/art/office/faces/"..name..".aseprite"); spr:close()
  for _, mode in ipairs({"dark", "light"}) do
    local out = Sprite(CW*N, CH, ColorMode.INDEXED)
    out:setPalette(Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" })
    out.transparentColor = 0
    out.cels[1].image = strip
    out:saveAs(root.."/public/office/face-"..name.."-"..mode..".png"); out:close()
  end
  print("wrote "..name.." "..N.." frames")
end

build("riffbot", RIFF, riff, RIFF_FRAMES, function(spr, lay, i, s)
  if s.shake then                                                              -- whole bot shakes 1px
    for n, l in pairs(lay) do if n ~= "back" then
      local cel = l:cel(spr.frames[i]); cel.position = Point(s.shake, 0)
    end end
  end
end)
build("overlord", OVER, over, OVER_FRAMES, function(spr, lay, i, s)
  if s.bob then local cel = lay.brain:cel(spr.frames[i]); cel.position = Point(0, s.bob) end
end)
