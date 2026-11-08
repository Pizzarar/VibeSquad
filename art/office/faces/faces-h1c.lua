-- H1c-v3b RiffBot + Overlord 80x48 widescreen faces (G8: both sky TVs fixed 50/50; faceContain scales
-- the cell at an integer and bottom-anchors it), in the H0 hand (docs/art/STYLE_BIBLE.md) from the
-- owner-approved H1a sketches (art/h1/gallery.lua, 60e5144). Owner H1c-v3: no stretch to fill the
-- cell. Both bots keep natural H0 proportions, centred, with clean SKY left and right. Googly MARBLE
-- eyes, INK line mouths, 1px INK outlines, flat P0 fills, hand-placed shapes, no dither.
--   RiffBot : headshot. Boxy ~4:3 cream CRT head with rabbit ears, sitting on violet suit shoulders,
--             MARBLE collar and PINK tie flush to row 47. Googly eyes on the teal screen; the
--             mouth is a STOCK ARROW (owner 4a, H1c-v3b): a MARBLE zig-zag up-arrow grin that wiggles
--             when talking, spikes sharply up in AMBER on needs and crashes to a PINK down-arrow
--             (scared). No text or digits in the mouth. No feet, no side arms: only on needs a
--             hand pops up from the bottom edge to wave.
--   Overlord: the sky-CRT screen IS the jar (no inner TV): murky SKY water, bubbles, glass glare,
--             a floating brain, 2 lopsided googly eyeballs on dangling optic nerves and a
--             floating set of teeth, each organ outlined and bobbing out of sync.
-- Gutter contract (UI lane): bg = SKY (13) everywhere, columns 0 and 79 stay flat SKY in every
-- frame (asserted below), no pink flash background: needs[1] flashes inside the object instead.
-- Cells/offsets/order = public/office/faces.json (cell 80x48; keys/frame names unchanged; not written here).
-- Writes public/office/face-{riffbot,overlord}-{dark,light}.png + art/office/faces/{riffbot,overlord}.aseprite.
-- After it, re-run takeover.lua (reads overlord needs[0]).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/faces/faces-h1c.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local K, V, P, CO, A, S, M, T, G, Y, LN = 15, 8, 9, 10, 11, 14, 4, 7, 12, 13, 3
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
-- ---------- RiffBot (headshot: boxy ~4:3 CRT head x20..60 on suit shoulders flush to row 47) ----------
local RIFF = { "back", "suit", "tie", "body", "screen", "face", "mouth", "prop", "arm", "fx" }
local EYE_N = {{31, 15, 3.1, 3.6}, {41, 14, 3.6, 4.6}}
local EYE_W = {{31, 15, 3.6, 4.1}, {41, 15, 4.1, 4.6}}

local function riff(C, s)
  C.back.rect(0, 0, CW, CH, Y)
  -- suit: wide violet shoulders, MARBLE shirt V + collar points, lapels, pocket square
  local su = C.suit
  su.poly({8,48, 9,43, 15,39, 30,37, 50,37, 65,39, 71,43, 72,48}, V)
  su.outline(K)
  su.poly({32,37, 48,37, 44,48, 36,48}, M)
  su.line(32, 37, 37, 43, K); su.line(48, 37, 43, 43, K)                       -- collar points
  su.line(31, 37, 35, 47, K); su.line(49, 37, 45, 47, K)                       -- lapels
  su.line(18, 41, 19, 47, K); su.line(62, 41, 61, 47, K)                       -- sleeve seams
  su.hline(55, 42, 4, M); su.px(56, 41, P); su.px(57, 41, P)                   -- pocket square
  local ti = C.tie
  ti.rect(38, 37, 4, 3, P); ti.poly({38,41, 42,41, 43,48, 37,48}, P)
  ti.outline(K)
  -- cabinet
  local b = C.body
  b.poly({22,8, 39,6, 58,7, 60,21, 59,34, 41,35, 21,34, 20,20}, M)
  b.poly({21,31, 59,31, 59,34, 41,35, 21,34}, CO)
  b.outline(K)
  b.hline(21, 30, 39, K)
  for x=24,57,4 do b.px(x, 33, A) end
  local sc = C.screen
  sc.rect(24, 9, 26, 20, K); sc.rect(25, 10, 24, 18, T)
  for y=11,27,4 do sc.hline(26, y, 22, G) end
  for i, k in ipairs({{54, 12}, {54, 18}}) do
    sc.ellipse(k[1], k[2], 2.2, 2.2, (s.flash and i == 1) and A or P)
  end
  for y=22,26,2 do sc.hline(52, y, 5, K) end
  sc.px(54, 10, K); sc.px(54, 16, K)

  -- eyes
  local f = C.face
  local E = s.wide and EYE_W or EYE_N
  eyes(f, E)
  if s.eyes == "look" then                       -- idle: lopsided googly stare
    pupil(f, 30, 15); pupil(f, 42 + (s.px or 0), 13)
  elseif s.eyes == "down" then                   -- lookDown: lids half, pupils sunk
    lids(f, E, T, 0.45); pupil(f, 30, 16); pupil(f, 40, 16)
  elseif s.eyes == "shut" then                   -- shut: lids all the way, INK lid curves
    lids(f, E, T, 1.0)
    f.line(28, 15, 31, 17, K); f.line(31, 17, 34, 15, K); f.line(37, 14, 41, 16, K); f.line(41, 16, 45, 14, K)
  elseif s.eyes == "yo" then
    pupil(f, 31 + (s.px or 0), 12, 2, 2); pupil(f, 41 + (s.px or 0), 12, 2, 2)
  elseif s.eyes == "scared" then                 -- pin pupils that jitter
    local j = s.jit or 0
    f.rect(31 + j, 15, 1, 2, K); f.rect(42 - j, 15, 1, 2, K)
  end

  -- stock-arrow mouth (owner 4a, H1c-v3b): a chunky 2px zig-zag stock-chart line ending in an
  -- arrowhead, curling up at the corners like a cocky grin; flat fill + 1px INK outline, no text.
  local m = C.mouth
  local ar = s.arrow
  local dy = ar.dy or 0
  for i = 1, #ar.pts - 2, 2 do
    local x0, y0, x1, y1 = ar.pts[i], ar.pts[i+1] + dy, ar.pts[i+2], ar.pts[i+3] + dy
    m.line(x0, y0, x1, y1, ar.c); m.line(x0, y0 + 1, x1, y1 + 1, ar.c)
  end
  local hd = {}
  for i, v in ipairs(ar.head) do hd[i] = (i % 2 == 0) and v + dy or v end
  m.poly(hd, ar.c)
  m.outline(K)
  if s.lip == "wobble" then                                                    -- scared: shaky ticks under the crash
    for x = 28, 44, 4 do m.px(x + (s.jit or 0), 27, K) end
  end

  -- rabbit ears (sag when scared)
  local p = C.prop
  p.rect(36, 5, 9, 2, K)
  if s.droop then
    p.line(36, 5, 28, 3, K); p.line(44, 5, 50, 4, K); p.line(50, 4, 56, 5, K)
    p.rect(27, 3, 2, 2, P); p.rect(56, 4, 2, 2, P)
  else
    p.line(36, 5, 30, 1, K); p.line(44, 5, 47, 3, K); p.line(47, 3, 53, 1, K)
    p.rect(29, 0, 2, 2, P); p.rect(53, 0, 2, 2, P)
  end

  -- needs only: a hand pops UP from the bottom edge (row 47) beside the head and waves
  if s.arm then
    local a = C.arm
    if s.arm == 1 then
      a.poly({62,48, 63,27, 69,26, 69,48}, V); a.rect(63, 24, 6, 2, M)
      a.ellipse(66, 19, 3.2, 3.6, M); a.ellipse(62, 21, 1.3, 1.6, M)
    else
      a.poly({63,48, 61,28, 67,26, 70,48}, V); a.rect(61, 24, 6, 2, M)
      a.ellipse(65, 18, 3.2, 3.6, M); a.ellipse(61, 20, 1.3, 1.6, M)
    end
    a.outline(K)
    local hx = s.arm == 1 and 66 or 65
    a.vline(hx - 1, 15 + (s.arm == 1 and 1 or 0), 2, K); a.vline(hx + 1, 15 + (s.arm == 1 and 1 or 0), 2, K)
    a.hline(63, 46, 6, K)                                                      -- sleeve meets the frame edge
  end

  local fx = C.fx
  if s.arm == 1 then fx.line(72, 15, 71, 13, K); fx.line(72, 20, 72, 19, K)    -- wave ticks
  elseif s.arm == 2 then fx.line(70, 12, 69, 10, K); fx.line(73, 15, 72, 13, K) end
  if s.yo then
    if s.flash then L.twinkle(fx, 15, 8, A, M, 2); L.twinkle(fx, 11, 28, P, nil, 1)
    else L.twinkle(fx, 15, 6, A, M, 2); L.twinkle(fx, 63, 5, A, nil, 1) end
  elseif s.scared then                                                         -- shake ticks off the case
    local o = s.jit or 0
    fx.vline(16, 18 + o, 3, K); fx.vline(17, 25 - o, 2, K); fx.vline(63, 19 - o, 3, K); fx.vline(64, 26 + o, 2, K)
  else
    L.twinkle(fx, 64, 5, M, nil, 1); fx.px(15, 7, V); fx.px(11, 29, V)
  end
end

-- arrow mouths: pts = zig-zag polyline (top pixel row, line is 2px tall), head = arrowhead polygon
local GRIN   = { pts = {27,23, 30,26, 34,23, 37,25, 41,23}, head = {39,21, 47,19, 44,26}, c = M }
local GRIN_B = { pts = {27,22, 30,24, 34,26, 37,23, 41,23}, head = {39,21, 47,19, 44,26}, c = M }  -- wiggle
local GRIN_C = { pts = {27,24, 30,26, 34,23, 37,25, 41,22}, head = {39,20, 47,18, 44,25}, c = M }  -- bounce tip
local SPIKE  = { pts = {26,24, 30,26, 33,22, 37,26, 46,15}, head = {43,14, 51,5, 50,16}, c = A }   -- needs
local CRASH  = { pts = {27,21, 31,23, 34,21, 39,23}, head = {42,19, 46,27, 36,26}, c = P }         -- scared
local function sh(a, d) return { pts = a.pts, head = a.head, c = a.c, dy = d } end

local RIFF_FRAMES = {
  { eyes = "down", arrow = GRIN },                                                          -- lookDown x0
  { eyes = "look", arrow = GRIN },                                                          -- idle     x80
  { eyes = "shut", arrow = GRIN },                                                          -- blink    x160
  { eyes = "look", arrow = GRIN_B },                                                        -- talk     x240
  { eyes = "look", arrow = sh(GRIN_C, -1), px = 1 },                                        -- talk     x320
  { eyes = "look", arrow = GRIN },                                                          -- talk     x400
  { eyes = "yo", wide = true, arrow = SPIKE, arm = 1, yo = true },                          -- needs    x480
  { eyes = "yo", wide = true, arrow = sh(SPIKE, -1), arm = 2, yo = true, flash = true, px = 1 }, -- needs x560
  { eyes = "scared", wide = true, arrow = CRASH, lip = "wobble",
    droop = true, scared = true, jit = 0, shake = -1 },                                     -- scared   x640
  { eyes = "scared", wide = true, arrow = sh(CRASH, 0), lip = "wobble",
    droop = true, scared = true, jit = 1, shake = 1 },                                      -- scared   x720
}

-- ---------- Overlord (80x48: the sky-CRT screen IS the jar, owner H1c-v3) ----------
-- No cabinet, no dome, no drawn glass: the sky-CRT bezel is the jar rim. Murky SKY jar water with
-- rising bubbles, holding a round floating brain, 2 lopsided googly eyeballs dangling on optic-nerve tails
-- and a separate floating set of chunky teeth (one gold tooth). Natural H0 proportions, centred,
-- clean water left and right (no stretch to fill). Every organ is its own layer with its own 1px
-- INK outline and bobs on its own cel offset, so the parts drift out of sync.
local OVER = { "back", "bubbles", "eyeL", "eyeR", "brain", "teeth", "fx" }
local OEYES = {
  eyeL = { x = 17, y = 13, r = 6.6, hook = 1, pup = 3,
           veins = {{-6,-2,-4,-1}, {-5,3,-3,2}, {5,-3,3,-2}} },
  eyeR = { x = 63, y = 11, r = 5.1, hook = -1, pup = 2,
           veins = {{-5,-1,-3,0}, {4,-2,2,-1}, {3,3,2,2}} },
}
-- rising bubbles {x, y, size}; y climbs 2px per frame step (s.t)
local BUBS = { {26,44,3}, {56,41,2}, {7,30,1}, {72,25,1}, {54,46,1}, {34,47,2}, {70,44,3}, {9,45,2}, {50,28,1} }

local function nerve(C, pts)                       -- 2px-thick CORAL optic nerve along a polyline
  for i = 1, #pts - 3, 2 do
    C.line(pts[i], pts[i+1], pts[i+2], pts[i+3], CO); C.line(pts[i]+1, pts[i+1], pts[i+2]+1, pts[i+3], CO)
  end
end

local function eyeball(C, e, s, look)
  local cx, cy = e.x, e.y
  local r = e.r + (s.wide and 1 or 0)
  local h, sw = e.hook, (s.swing or 0) * e.hook
  local by = math.floor(cy + r)
  nerve(C, {cx, by - 1, cx - h + sw, by + 5, cx + sw, by + 10, cx - h, by + 15, cx, by + 18,
            cx + 2*h, by + 18, cx + 3*h, by + 16})
  C.ellipse(cx, cy, r, r, M)
  for _, v in ipairs(e.veins) do C.line(cx + v[1], cy + v[2], cx + v[3], cy + v[4], P) end
  if s.shut then                                   -- blink: PINK lid shut, INK slit + 3 lashes
    for y = math.ceil(cy - r), by do for x = math.floor(cx - r), math.ceil(cx + r) do
      if C.get(x, y) == M or C.get(x, y) == P then C.px(x, y, P) end
    end end
    local w = math.floor(r) - 2
    C.line(cx - w, cy, cx, cy + 2, K); C.line(cx, cy + 2, cx + w, cy, K)
    C.px(cx - w + 1, cy + 2, K); C.px(cx, cy + 4, K); C.px(cx + w - 1, cy + 2, K)
  else
    local ix, iy = cx + look[1], cy + look[2]
    local ir = s.wide and r * 0.32 or r * 0.46
    C.ellipse(ix, iy, ir, ir, T)
    local p = s.wide and 2 or e.pup
    C.rect(ix - p // 2, iy - p // 2, p, p, K); C.px(ix - p // 2, iy - p // 2, M)
    if s.lid then                                  -- lookDown: heavy PINK upper lid
      local cut = math.floor(cy - r + 2 * r * s.lid + 0.5)
      for y = math.ceil(cy - r), cut do for x = math.floor(cx - r), math.ceil(cx + r) do
        local c = C.get(x, y)
        if c ~= 0 and c ~= CO then C.px(x, y, y == cut and K or P) end
      end end
    end
  end
  C.outline(K)
end

local function brain(C, s)
  local g = s.pulse and 1 or 0
  C.ellipse(40, 14, 12.6 + g, 10.1 + g, P, {0,0,0,-1,-1,0,0,0,1,1,0,0}, {0,0,1,1,0,0,0,-1,-1,0,0,0})
  C.hline(39, 4 - g, 3, 0)                         -- dip between the two halves
  C.rect(41, 24 + g, 3, 2 - g, CO)                   -- stub of a brain stem (2-3px water gap to the teeth)
  C.outline(K)
  local f = s.glow and A or CO                     -- wobbly gyri, left half then right half
  C.line(30, 11, 32, 8, f); C.line(32, 8, 35, 10, f); C.line(35, 10, 37, 8, f)
  C.line(30, 16, 33, 14, f); C.line(33, 14, 35, 17, f); C.line(35, 17, 38, 15, f)
  C.line(31, 21, 36, 21, f)
  C.line(43, 8, 45, 7, f); C.line(45, 7, 48, 9, f); C.line(48, 9, 50, 8, f)
  C.line(43, 13, 46, 12, f); C.line(46, 12, 48, 15, f); C.line(48, 15, 51, 13, f)
  C.line(44, 20, 49, 19, f)
  C.vline(40, 5 - g, 5 + g, K); C.vline(39, 10, 5, K); C.vline(40, 15, 6, K)       -- crooked fissure
  C.px(31, 6, M); C.px(32, 5, M); C.px(33, 5, M); C.px(30, 7, M)                  -- shine
end

local function teeth(C, s)
  local gap = s.gap or 0                           -- 0 = closed on one 1px INK bite line (row 35)
  C.rect(32, 30, 17, 1, P); C.rect(30, 31, 21, 1, P)                              -- upper gum, rounded
  C.rect(31, 32, 19, 3, M); C.rect(43, 32, 3, 3, A)                               -- upper teeth + gold tooth
  if gap > 0 then C.rect(35, 35, 3, 1, M) end                                     -- fang shows when open
  local lt = 36 + gap
  C.rect(32, lt, 19, 3, M)                                                        -- lower teeth
  C.rect(31, lt + 3, 21, 1, P); C.rect(33, lt + 4, 17, 1, P)                      -- lower gum, rounded
  C.outline(K)
  for i = 0, 3 do C.vline(34 + i*4, 32, 2, K); C.vline(35 + i*4, lt + 1, 2, K) end  -- short tooth gaps
end

local function over(C, s)
  C.back.rect(0, 0, CW, CH, Y)
  local bu = C.bubbles
  local bubs = {}
  for _, b in ipairs(BUBS) do bubs[#bubs + 1] = b end
  if s.chomp then bubs[#bubs + 1] = {54, 35, 2}; bubs[#bubs + 1] = {27, 34, 1}; bubs[#bubs + 1] = {56, 31, 1} end
  for _, b in ipairs(bubs) do
    local x, y = b[1], (b[2] - 2 * (s.t or 0) - 3) % 46 + 2
    if b[3] == 1 then bu.px(x, y, LN)
    elseif b[3] == 2 then bu.px(x, y-1, LN); bu.px(x-1, y, LN); bu.px(x+1, y, LN); bu.px(x, y+1, LN)
    else
      bu.hline(x, y-1, 2, LN); bu.hline(x, y+2, 2, LN); bu.vline(x-1, y, 2, LN); bu.vline(x+2, y, 2, LN)
      bu.px(x+1, y, M)
    end
  end
  eyeball(C.eyeL, OEYES.eyeL, s, s.lookL)
  eyeball(C.eyeR, OEYES.eyeR, s, s.lookR)
  brain(C.brain, s)
  teeth(C.teeth, s)
  local fx = C.fx
  if s.zap then bang(fx, 70, 28 + (s.zap == 2 and -1 or 0)) end
  if s.zap == 1 then
    fx.line(27, 0, 29, 2, A); fx.line(29, 2, 27, 4, A); fx.line(27, 4, 29, 6, A)
    fx.line(54, 1, 52, 3, A); fx.line(52, 3, 54, 5, A)
  elseif s.zap == 2 then
    fx.line(29, 0, 27, 2, A); fx.line(27, 2, 29, 4, A); fx.line(29, 4, 27, 6, A)
    fx.line(52, 0, 54, 2, A); fx.line(54, 2, 52, 4, A); fx.line(52, 4, 54, 6, A)
  end
end

-- off = cel y offsets per organ (out-of-sync bob); t = bubble rise step
local OVER_FRAMES = {
  { lid = 0.42, lookL = {1, 3}, lookR = {-1, 2}, t = 0, off = {brain = 1, eyeL = 2, eyeR = 2, teeth = 1} },            -- lookDown x0
  { lid = 0.42, lookL = {0, 3}, lookR = {0, 2}, t = 1, swing = 1, off = {brain = 1, eyeL = 3, eyeR = 2, teeth = 1} },  -- lookDown x80
  { lookL = {2, 0}, lookR = {-2, -1}, t = 0, off = {brain = 0, eyeL = 0, eyeR = 1, teeth = 0} },                         -- idle x160
  { lookL = {2, 1}, lookR = {-1, -1}, t = 1, swing = 1, off = {brain = -1, eyeL = 1, eyeR = 0, teeth = -1} },            -- idle x240
  { shut = true, t = 0, off = {brain = 0, eyeL = 0, eyeR = 1, teeth = 0} },                                              -- blink x320
  { lookL = {2, 0}, lookR = {-2, 0}, gap = 4, chomp = true, t = 0, off = {brain = 0, eyeL = 0, eyeR = 1, teeth = 0} },  -- talk x400
  { lookL = {2, 0}, lookR = {-2, 0}, gap = 0, chomp = true, t = 1, swing = 1, off = {brain = -1, eyeL = 1, eyeR = 0, teeth = 0} }, -- talk x480
  { lookL = {2, 1}, lookR = {-1, 0}, gap = 2, chomp = true, t = 2, off = {brain = 0, eyeL = 0, eyeR = 1, teeth = 0} },   -- talk x560
  { wide = true, lookL = {0, 0}, lookR = {0, 0}, gap = 3, zap = 1, glow = true, t = 0,
    off = {brain = 0, eyeL = -1, eyeR = 0, teeth = 0} },                                                                 -- needs x640
  { wide = true, lookL = {1, 0}, lookR = {-1, 0}, gap = 4, zap = 2, glow = true, pulse = true, swing = 1, t = 1,
    off = {brain = 0, eyeL = 0, eyeR = -1, teeth = 0} },                                                                -- needs x720
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
  for n, dy in pairs(s.off or {}) do local cel = lay[n]:cel(spr.frames[i]); cel.position = Point(0, dy) end
end)
