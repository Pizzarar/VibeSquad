-- H1c-v2 RiffBot + Overlord 80x48 widescreen faces (G8: both sky TVs fixed 50/50, portrait fills the
-- whole ~5:3 screen hole, faceContain 7x at 4K@120% / 6x at 1080p), re-anchored on the H0 hand (docs/art/STYLE_BIBLE.md) from the
-- owner-approved H1a sketches (art/h1/gallery.lua riffbot/overlord, 60e5144). One solid outlined
-- object per bot, googly MARBLE eyes, INK line mouths, flat P0 fills, hand-placed shapes, no dither.
--   RiffBot : cream TV on rabbit ears and sneakers. Googly eyes on the teal screen; the stock
--             ticker IS the mouth (owner 4a): an INK band with AMBER prices that opens, ticks,
--             shouts "YO!!" (needs) and crashes to a PINK "-9.99" with a wobbly lip (scared).
--   Overlord: one violet TV with a glass jar on top holding its brain (owner 4a), one big googly
--             eye and a toothy grin on the mint screen. Brain bobs (idle/lookDown), glows (needs).
-- Gutter contract (UI lane): bg = SKY (13) everywhere, columns 0 and 79 stay flat SKY in every
-- frame (asserted below), no pink flash background: needs[1] flashes inside the object instead.
-- Cells/offsets/order = public/office/faces.json (cell 80x48; keys/frame names unchanged; not written here).
-- Writes public/office/face-{riffbot,overlord}-{dark,light}.png + art/office/faces/{riffbot,overlord}.aseprite.
-- After it, re-run takeover.lua (reads overlord needs[0]).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/faces/faces-h1c.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local K, V, P, CO, A, S, M, T, G, Y = 15, 8, 9, 10, 11, 14, 4, 7, 12, 13
local CW, CH = 80, 48

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

-- ---------- RiffBot (80x48: wide cream TV, stubby arms, 43px ticker mouth) ----------
local RIFF = { "back", "body", "screen", "face", "mouth", "prop", "fx" }
local EYE_N = {{26, 20, 5.1, 4.1}, {41, 19, 5.6, 5.1}}
local EYE_W = {{26, 19, 5.6, 4.6}, {41, 18, 6.1, 5.6}}
local TICK = "RIFF +4.20"

local function riff(C, s)
  C.back.rect(0, 0, CW, CH, Y)
  local b = C.body
  b.poly({9,11, 38,9, 70,10, 72,26, 71,41, 40,42, 8,41, 7,25}, M)
  b.poly({8,37, 71,37, 71,41, 40,42, 8,41}, CO)
  b.outline(K)
  b.hline(8, 36, 64, K)
  for x=11,69,4 do b.px(x, 39, A) end
  local sc = C.screen
  sc.rect(12, 13, 46, 22, K); sc.rect(13, 14, 44, 20, T)
  for y=15,33,4 do sc.hline(14, y, 42, G) end
  for i, k in ipairs({{64, 16}, {64, 23}}) do
    sc.ellipse(k[1], k[2], 2.2, 2.2, (s.flash and i == 1) and A or P)
  end
  for y=28,32,2 do sc.hline(61, y, 7, K) end
  sc.px(64, 14, K); sc.px(64, 21, K)

  -- eyes
  local f = C.face
  local E = s.wide and EYE_W or EYE_N
  eyes(f, E)
  if s.eyes == "look" then                       -- idle: lopsided googly stare
    pupil(f, 25, 20); pupil(f, 41 + (s.px or 0), 18)
  elseif s.eyes == "down" then                   -- lookDown: lids half, pupils sunk
    lids(f, E, T, 0.45); pupil(f, 25, 21); pupil(f, 40, 20)
  elseif s.eyes == "shut" then                   -- shut: lids all the way, INK lid curves
    lids(f, E, T, 1.0)
    f.line(21, 20, 26, 22, K); f.line(26, 22, 31, 20, K); f.line(36, 19, 41, 21, K); f.line(41, 21, 46, 19, K)
  elseif s.eyes == "yo" then
    pupil(f, 26 + (s.px or 0), 16, 2, 2); pupil(f, 41 + (s.px or 0), 14, 2, 2)
  elseif s.eyes == "scared" then                 -- pin pupils that jitter
    local j = s.jit or 0
    f.rect(26 + j, 19, 1, 2, K); f.rect(42 - j, 18, 1, 2, K)
  end
  if s.brow == "up" then
    f.line(20, 13, 28, 12, K); f.line(35, 11, 44, 12, K)
  elseif s.brow == "worry" then                  -- inner ends up
    f.line(20, 13, 28, 11, K); f.line(36, 10, 45, 12, K)
  end

  -- ticker mouth (owner 4a): INK band across the screen, text rows y0+1..y0+5, optional tongue
  local m = C.mouth
  local y0, h = s.band[1], s.band[2]
  local x0, x1 = 14, 56
  m.rect(x0, y0, x1 - x0 + 1, h, s.flash and P or K)
  m.px(x0, y0 + h - 1, 0); m.px(x1, y0 + h - 1, 0)                            -- rounded lower lip
  if s.lip == "smirk" then                                                     -- lopsided corner hooks
    m.px(x0 - 1, y0, K); m.px(x1 + 1, y0, K); m.px(x1 + 2, y0 - 1, K)
  elseif s.lip == "wobble" then                                                -- scared: wavy top lip
    for x = x0, x1 do if ((x // 2) + (s.jit or 0)) % 2 == 0 then m.px(x, y0 - 1, K) end end
  end
  if s.tongue then
    local ty = y0 + h - 2
    m.hline(25, ty, 20, s.tongueC or P); m.hline(28, ty - 1, 14, s.tongueC or P)
  end
  clipText(m, x0 + 1 - (s.scroll or 0), y0 + 1, s.text or TICK, s.textC or A, x0 + 1, x1 - 1)

  -- antennas, sneakers, stubby arms
  local p = C.prop
  p.rect(33, 8, 13, 2, K)
  p.rect(17, 43, 8, 3, A); p.rect(54, 43, 8, 3, A)
  if s.scared then                                                             -- both hands up
    p.poly({8,29, 6,22, 8,21, 10,28}, M); p.ellipse(6, 18, 2.2, 2.6, M)
    p.poly({71,29, 73,22, 75,23, 73,30}, M); p.ellipse(74, 18, 2.2, 2.6, M)
  else
    p.poly({8,24, 5,26, 4,33, 7,33, 8,30}, M); p.ellipse(5, 35, 2.2, 2.2, M)  -- left arm hangs
    if s.arm == 1 then
      p.poly({71,29, 74,22, 76,23, 73,30}, M); p.ellipse(75, 18, 2.2, 2.6, M)
    elseif s.arm == 2 then
      p.poly({71,29, 73,21, 75,21, 73,30}, M); p.ellipse(74, 17, 2.2, 2.6, M)
    else
      p.poly({71,24, 74,26, 75,33, 72,33, 71,30}, M); p.ellipse(74, 35, 2.2, 2.2, M)
    end
  end
  p.outline(K)
  if s.droop then                                                              -- scared: ears sag
    p.line(34, 9, 25, 4, K); p.line(44, 9, 53, 6, K); p.line(53, 6, 61, 7, K)
    p.rect(24, 3, 2, 2, P); p.rect(61, 6, 2, 2, P)
  else
    p.line(34, 9, 22, 2, K); p.line(44, 9, 51, 5, K); p.line(51, 5, 60, 3, K)
    p.rect(21, 1, 2, 2, P); p.rect(60, 2, 2, 2, P)
  end
  p.vline(20, 41, 2, K); p.vline(57, 41, 2, K)

  local fx = C.fx
  if s.arm == 1 then fx.line(78, 15, 77, 13, K); fx.line(78, 20, 78, 19, K)    -- wave ticks
  elseif s.arm == 2 then fx.line(71, 14, 70, 12, K); fx.line(78, 13, 77, 11, K) end
  if s.yo then
    if s.flash then L.twinkle(fx, 10, 6, A, M, 2); L.twinkle(fx, 3, 40, P, nil, 1)
    else L.twinkle(fx, 10, 4, A, M, 2); L.twinkle(fx, 68, 6, A, nil, 1) end
  elseif s.scared then                                                         -- shake ticks off the case
    local o = s.jit or 0
    fx.vline(2, 27 + o, 3, K); fx.vline(3, 34 - o, 2, K); fx.vline(77, 28 - o, 3, K); fx.vline(76, 34 + o, 2, K)
  else
    L.twinkle(fx, 70, 4, M, nil, 1); fx.px(12, 5, V); fx.px(3, 42, V)
  end
end

local RIFF_FRAMES = {
  { eyes = "down", band = {27, 7}, lip = "smirk" },                                         -- lookDown x0
  { eyes = "look", band = {27, 7}, lip = "smirk" },                                         -- idle     x80
  { eyes = "shut", band = {27, 7}, lip = "smirk" },                                         -- blink    x160
  { eyes = "look", band = {26, 8}, text = "RIFF +6.90 SQD", tongue = true },                -- talk     x240
  { eyes = "look", band = {25, 9}, text = "RIFF +6.90 SQD", scroll = 6, tongue = true, px = 1 }, -- talk x320
  { eyes = "look", band = {27, 7}, text = "RIFF +6.90 SQD", scroll = 12, lip = "smirk" },  -- talk     x400
  { eyes = "yo", wide = true, brow = "up", band = {25, 9}, text = "YO!! YO!!", textC = P,
    scroll = -3, tongue = true, tongueC = CO, arm = 1, yo = true },                         -- needs    x480
  { eyes = "yo", wide = true, brow = "up", band = {25, 9}, text = "YO!! YO!!", textC = K,
    scroll = -3, tongue = true, tongueC = CO, arm = 2, yo = true, flash = true, px = 1 },   -- needs    x560
  { eyes = "scared", wide = true, brow = "worry", band = {27, 6}, text = "-9.99 OOF", textC = P,
    lip = "wobble", droop = true, scared = true, jit = 0, shake = -1, scroll = -3 },        -- scared   x640
  { eyes = "scared", wide = true, brow = "worry", band = {27, 6}, text = "-9.99 OOF", textC = P,
    lip = "wobble", droop = true, scared = true, jit = 1, shake = 1, scroll = -2 },         -- scared   x720
}

-- ---------- Overlord (80x48: wide violet console, big brain-jar dome, side gauges) ----------
local OVER = { "back", "brain", "jar", "body", "screen", "gauge", "face", "mouth", "prop", "fx" }
local OEYE_N = {{40, 30, 9.1, 4.6}}
local OEYE_W = {{40, 30, 9.6, 5.1}}

local function over(C, s)
  C.back.rect(0, 0, CW, CH, Y)
  local br = C.brain
  br.ellipse(40, 12, 14.6, 6.1, P, {0,1,0,0,-1,0}, {0,0,1,0,0,1})
  br.outline(K)
  local fold = s.glow and A or CO
  br.line(29, 10, 33, 8, fold); br.line(33, 8, 36, 11, fold); br.line(39, 7, 40, 12, fold)
  br.line(44, 9, 49, 8, fold); br.line(45, 13, 50, 12, fold); br.line(30, 14, 36, 14, fold)
  br.line(51, 10, 53, 9, fold); br.line(27, 12, 29, 12, fold)
  br.vline(40, 13, 4, K)
  br.px(31, 7, M); br.px(30, 8, M)                                             -- shine
  local j = C.jar
  j.ellipse(40, 12, 23, 11, M); j.rect(16, 12, 49, 7, M)
  j.outline(K)
  for y=0,20 do for x=0,CW-1 do if j.get(x, y) == M then j.px(x, y, 0) end end end
  j.vline(20, 6, 9, M); j.vline(21, 4, 2, M); j.px(58, 5, M); j.px(59, 6, M)
  local b = C.body
  b.poly({5,22, 40,21, 74,22, 75,34, 74,43, 40,44, 5,43, 4,33}, V)
  b.rect(13, 18, 54, 3, A)
  b.outline(K)
  for _, x in ipairs({16, 40, 63}) do b.px(x, 19, K) end
  b.hline(6, 21, 68, K)
  b.px(72, 24, M); b.px(73, 25, M)                                             -- shine on the cabinet
  local sc = C.screen
  sc.rect(16, 24, 48, 18, K); sc.rect(17, 25, 46, 16, G)
  for y=26,40,3 do sc.hline(18, y, 44, T) end
  for i, k in ipairs({{69, 28}, {69, 35}}) do
    sc.ellipse(k[1], k[2], 2.2, 2.2, (s.flash and i == 2) and P or A)
  end
  sc.px(69, 26, K); sc.px(69, 33, K)
  for y=39,41,2 do sc.hline(66, y, 6, K) end
  -- left side gauges: a dial with a swinging needle and a bar meter
  local g = C.gauge
  g.ellipse(10, 29, 3.6, 3.1, M)
  g.rect(7, 36, 7, 4, K)
  g.outline(K)
  g.px(8, 28, P); g.px(12, 27, P)
  local nd = s.needle or {11, 27}
  g.line(10, 30, nd[1], nd[2], K)
  g.rect(8, 37, s.meter or 2, 2, (s.meter or 0) >= 5 and P or A)

  local f = C.face
  local E = s.wide and OEYE_W or OEYE_N
  eyes(f, E)
  local ix, iy = s.iris[1], s.iris[2]
  if s.lid then lids(f, E, G, s.lid) end
  if s.lid and s.lid >= 0.8 then f.line(32, 30, 40, 32, K); f.line(40, 32, 48, 30, K) end      -- shut lid curve
  if s.lid == nil or s.lid < 0.8 then
    if s.wide then f.ellipse(ix, iy, 3.1, 2.6, P) else f.ellipse(ix, iy, 2.6, 1.6, P) end
    pupil(f, ix - 1, iy - (s.wide and 1 or 0), 2, 2)                          -- iris sits below the lid cut
  end
  if s.brow == "smug" then f.line(29, 24 + (s.browDy or 0), 51, 26 + (s.browDy or 0), K)
  elseif s.brow == "up" then f.line(29, 23, 37, 25, K); f.line(43, 25, 51, 22, K) end

  local m = C.mouth
  if s.mouth == "grin" then                                                    -- closed toothy grin
    f.hline(26, 37, 28, K); f.hline(27, 39, 26, K)
    for x=27,52 do f.px(x, 38, (x % 3) ~= 0 and M or K) end
    f.px(25, 36, K); f.px(54, 36, K)
  else                                                                         -- open: {y, h}
    local my, mh = s.mouth[1], s.mouth[2]
    m.rect(26, my, 28, mh, P); m.outline(K)
    for x=27,52 do if (x % 3) ~= 1 then m.px(x, my, M) end end
    if mh >= 4 then m.hline(33, my + mh - 1, 14, CO) end
  end

  local p = C.prop
  p.rect(15, 45, 8, 2, A); p.rect(57, 45, 8, 2, A)
  p.outline(K)
  local fx = C.fx
  if s.zap then bang(C.fx, 66, s.zap - 1) end                                 -- bang first: zaps stay unoutlined
  if s.zap == 1 then
    fx.line(4, 4, 7, 7, A); fx.line(7, 7, 4, 10, A); fx.line(4, 10, 7, 13, A)
    fx.line(78, 12, 75, 15, A); fx.line(75, 15, 78, 18, A)
  elseif s.zap == 2 then
    fx.line(7, 2, 4, 5, A); fx.line(4, 5, 7, 8, A); fx.line(7, 8, 4, 11, A)
    fx.line(75, 10, 78, 13, A); fx.line(78, 13, 75, 16, A); fx.line(75, 16, 78, 19, A)
  else
    L.twinkle(fx, 70, 6, M, nil, 1); fx.px(6, 9, V); fx.px(75, 16, V)
  end
end

local OVER_FRAMES = {
  { lid = 0.5, iris = {39, 33}, brow = "smug", browDy = 1, mouth = "grin", meter = 2 },      -- lookDown x0
  { lid = 0.5, iris = {37, 33}, brow = "smug", browDy = 1, mouth = "grin", bob = -1, meter = 2 }, -- lookDown x80
  { lid = 0.5, iris = {39, 32}, brow = "smug", mouth = "grin", meter = 3 },                  -- idle     x160
  { lid = 0.5, iris = {43, 32}, brow = "smug", mouth = "grin", bob = -1, meter = 3, needle = {12, 28} }, -- idle x240
  { lid = 1.0, iris = {39, 32}, brow = "smug", mouth = "grin", meter = 3 },                 -- blink    x320
  { lid = 0.35, iris = {40, 31}, brow = "smug", mouth = {36, 3}, meter = 4 },                -- talk     x400
  { lid = 0.35, iris = {40, 31}, brow = "smug", mouth = {36, 5}, bob = -1, meter = 5, needle = {12, 28} }, -- talk x480
  { lid = 0.35, iris = {40, 31}, brow = "smug", mouth = {37, 2}, meter = 4 },                -- talk     x560
  { wide = true, iris = {40, 30}, brow = "up", mouth = {36, 5}, zap = 1, glow = true,
    meter = 5, needle = {13, 29} },                                                          -- needs    x640
  { wide = true, iris = {42, 29}, brow = "up", mouth = {35, 6}, zap = 2, glow = true,
    flash = true, bob = -1, meter = 5, needle = {13, 30} },                                  -- needs    x720
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
