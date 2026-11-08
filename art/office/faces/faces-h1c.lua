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
--   Overlord: the sky-CRT screen IS the jar (no inner TV). H1c-v4 (owner pick B): a GIANT brain
--             cropped off the top and sides, INK-outlined lumpy lobes bulging over 2 lopsided googly
--             eyeballs that hang on short nerve tails, floating teeth below; folds pulse PINK on talk.
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

-- ---------- Overlord (80x48, owner H1c-v4 pick B: a giant brain fills the jar) ----------
-- The sky-CRT screen is still the jar (no inner TV). A GIANT brain fills the top of the jar, cropped
-- off the top. H1c-v4 fix c (owner: "a better fade out of the brain than just right angles"): the
-- brain sits higher and ends in 2 rounded, lumpy hemispheres with a 1px INK outline along their
-- bottom (no stair-stepped lobe row); above the outline the gyri fade UPWARD into the SKY water with
-- a 4x4 ordered dither (dense at the lobe edge, sparse toward the top, never a flat 50% slab) and
-- the VIOLET fold lines thin out with it. On talk the folds pulse PINK, on needs they burn AMBER.
-- 2 lopsided googly eyeballs hang from the lobes on short CORAL nerve tails, a floating set of
-- chunky teeth sits below, bubbles rise only in the clear water. Brain never bobs (it is cropped);
-- eyes + teeth bob on their own cel offsets.
-- RS-a (Riff slam, appended after needs so no existing cell moves): `smacked` = RiffBot's chat window
-- slams in from the left: eyes squashed shut >< then popped wide with pin pupils, face shoved right,
-- teeth knocked crooked and the gold tooth flies out. `dizzy` = spiral eyes that spin and a ring of
-- AMBER stars circling under the lobes, teeth hanging loose, gold tooth still missing (it returns on idle). Brain stays put (gutter contract).
local OVER = { "back", "bubbles", "brain", "eyeL", "eyeR", "teeth", "fx" }
local OEYES = {
  eyeL = { x = 20, y = 27, r = 7.6, hook = 1, pup = 3, up = 13,
           veins = {{-7,-2,-5,-1}, {-6,4,-4,3}, {6,-4,4,-3}, {5,4,3,3}} },
  eyeR = { x = 59, y = 25, r = 6.6, hook = -1, pup = 3, up = 12,
           veins = {{-6,-1,-4,0}, {5,-3,3,-2}, {4,4,3,3}} },
}
-- 2 hemispheres {cx, cy, rx outer, rx inner, ry, bumps, phase, outer side}: rounded superellipses, wider
-- toward the cleft (they overlap there) and tucked in on the outer side (the rim fades out up the sides,
-- no wall at the gutter); the rim wobbles into rounded cortical bumps with shallow INK sulci between them
local HEMI = { {21, -4, 19.5, 30, 19, 4.0, 0.9, -1}, {59, -5, 19, 29, 19, 3.6, 0.2, 1} }
-- gyri: C-shaped fold arcs ring these sub-lobe centres {x, y, r} (the d23454e fold language)
local GYRI = { {7,4,9}, {19,9,9}, {31,5,8}, {48,5,8}, {60,8,9}, {73,4,9} }
local SUPER = 2.4                                  -- superellipse power: fuller, rounder shoulders
local LUMP = 0.11                                  -- bump depth as a fraction of ry
local FADE_Y = 7.5                                 -- top rows dither out into the SKY; below is solid brain
local BAYER = { {0, 8, 2, 10}, {12, 4, 14, 6}, {3, 11, 1, 9}, {15, 7, 13, 5} }
local BUBS = { {26,44,3}, {56,41,2}, {7,30,1}, {72,25,1}, {54,46,1}, {34,47,2}, {70,44,3}, {9,45,2}, {50,28,1} }

local function hemiDepth(h, x, y, g)               -- px inside the lumpy rim (>0 inside), bump phase
  local outer = (x - h[1]) * h[8] > 0
  local u = math.abs(x - h[1]) / ((outer and h[3] or h[4]) + g)
  local v = math.abs(y - h[2]) / (h[5] + g)
  local rho = (u^SUPER + v^SUPER)^(1 / SUPER)
  local a = math.atan(y - h[2], (x - h[1]) * h[5] / h[3])
  local bump = math.abs(math.sin(h[6] * a + h[7]))
  local lump = LUMP * math.min(1, math.min(a, math.pi - a) / 0.35)  -- lumps fade out only right at the cleft: the halves stay joined
  return (1 + lump * (bump - 0.6) - rho) * (h[5] + g), bump
end
local function brainAt(x, y, g)                    -- deepest hemisphere: index, depth, bump phase
  local bi, bd, bb = 1, -1e9, 1
  for i, h in ipairs(HEMI) do
    local d, bp = hemiDepth(h, x, y, g)
    if d > bd then bi, bd, bb = i, d, bp end
  end
  return bi, bd, bb
end
local function inBrain(x, y, g)
  if y < 0 then return true end                    -- cropped off the top: no rim there
  local _, d = brainAt(x, y, g or 0); return d >= 0
end

local function nerve(C, pts)                       -- 2px-thick CORAL optic nerve along a polyline
  for i = 1, #pts - 3, 2 do
    C.line(pts[i], pts[i+1], pts[i+2], pts[i+3], CO); C.line(pts[i]+1, pts[i+1], pts[i+2]+1, pts[i+3], CO)
  end
end

local function eyeball(C, e, s, look)
  local cx, cy = e.x, e.y
  local r = e.r + (s.wide and 1 or 0)
  local h, sw = e.hook, (s.swing or 0) * e.hook
  local rx, ry = r, r
  if s.squish then rx, ry = r * 1.2, r * 0.62 end  -- smacked: eyeball squashed flat by the hit
  local by = math.floor(cy + ry)
  local ty = math.ceil(cy - ry)
  nerve(C, {cx, ty + 1, cx + h + sw, ty - 2, cx, ty - 4, cx - h, e.up - 1, cx, e.up - 3})   -- plugs into the lobe
  C.ellipse(cx, cy, rx, ry, M)
  if not s.squish then
    for _, v in ipairs(e.veins) do C.line(cx + v[1], cy + v[2], cx + v[3], cy + v[4], P) end
  end
  if s.squish then                                 -- squeezed shut: one clean INK chevron pointing at the nose (> <)
    local w = math.floor(rx) - 3
    local tip, tail, k = cx + h * (w - 1), cx - h * (w - 2), math.floor(ry) - 1
    C.line(tail, cy - k, tip, cy, K); C.line(tip, cy, tail, cy + k, K)
    C.px(cx - h * (w + 2), cy - math.floor(ry) - 1, K); C.px(cx - h * (w + 3), cy - math.floor(ry), K)  -- wince creases
    C.px(cx - h * (w + 2), cy + math.floor(ry) + 1, K); C.px(cx - h * (w + 3), cy + math.floor(ry), K)
  elseif s.spiral then                             -- dizzy: 2-turn INK spiral, phase turns it each frame
    local ph = s.spiral * h
    for i = 0, 140 do
      local a = i / 140 * 4 * math.pi
      local rr = 0.6 + (r - 1.6) * i / 140
      C.px(math.floor(cx + rr * math.cos(a * h + ph) + 0.5), math.floor(cy + rr * math.sin(a * h + ph) + 0.5), K)
    end
  elseif s.pin then                                -- smacked recoil: popped wide, iris gone, pin pupils spun apart
    local ix, iy = cx + look[1], cy + look[2]
    C.ellipse(ix + 0.5, iy + 0.5, 2.2, 2.2, T); C.rect(ix, iy, 2, 2, K)
  elseif s.shut then                                   -- blink: PINK lid shut, INK slit + 3 lashes
    for y = ty, by do for x = math.floor(cx - r), math.ceil(cx + r) do
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
    if s.lid then                                  -- lookDown: heavy PINK upper lid (eyeball only, not the nerve)
      local cut = math.floor(cy - r + 2 * r * s.lid + 0.5)
      for y = ty, cut do for x = math.floor(cx - r), math.ceil(cx + r) do
        local c = C.get(x, y)
        if c ~= 0 and c ~= CO then C.px(x, y, y == cut and K or P) end
      end end
    end
  end
  C.outline(K)
end

local function brain(C, s)
  local g = s.pulse and 1 or 0                     -- talk pulse: lobes swell 1px
  local fold = s.glow and A or ((s.pulse or s.sting) and P or V)
  local function dens(x, y)                        -- fade band wobbles along x so no dither row reads as a line
    local dip = (x >= 38 and x <= 41) and 2 or 0   -- the fissure dips the top fade at the centre line
    return math.max(0, math.min(1, (y + 1.5 - dip + 1.0 * math.sin(0.33 * x + 1.1) + 0.6 * math.sin(0.71 * x)) / FADE_Y))
  end
  local function lit(x, y, t) return BAYER[y % 4 + 1][x % 4 + 1] < t * 16 end
  local function ring(x, y)                        -- nearest gyrus centre + wobbly ring index, angle
    local bi, bd = 1, 1e9
    for k, c in ipairs(GYRI) do
      local d = math.sqrt((x - c[1])^2 + (y - c[2])^2) / (c[3] + g)
      if d < bd then bi, bd = k, d end
    end
    local c = GYRI[bi]
    local a = math.atan(y - c[2], x - c[1])
    return bi * 100 + math.floor((bd * (c[3] + g) + 1.4 * math.sin(3 * a + bi * 1.7)) / 3.5), a
  end
  local folds = {}
  for y = 0, CH - 1 do for x = 1, CW - 2 do
    if inBrain(x, y, g) then
      local _, d, bump = brainAt(x, y, g)
      local rg, a = ring(x, y)
      local onFold = (rg ~= ring(x + 1, y) or rg ~= ring(x, y + 1)) and math.sin(2 * a + rg * 2.3) > -0.35 and d >= 2.5
      local sulcus = bump < 0.16 and d >= 1 and d < 4.5                            -- rim indent runs up into the mass
      if (onFold or sulcus) and dens(x, y) > 0.45 and (x < 37 or x > 42) then folds[y * CW + x] = true end
    end
  end end
  local bars = {}                                  -- 3px+ straight vertical fold runs bow out 1px (no [ ] brackets)
  for k in pairs(folds) do
    local x, y = k % CW, k // CW
    if folds[k - CW] and folds[k + CW] and not folds[k - 1] and not folds[k + 1] then bars[#bars + 1] = k end
  end
  for _, k in ipairs(bars) do
    if folds[k] and folds[k - CW] and folds[k + CW] then
      local dx = (k % CW < 40) and -1 or 1
      folds[k] = nil; folds[k + dx] = true
    end
  end
  for k in pairs(folds) do                         -- no lone 1px fold specks
    local x, y, n = k % CW, k // CW, 0
    for dy = -1, 1 do for dx = -1, 1 do if (dx ~= 0 or dy ~= 0) and folds[(y + dy) * CW + x + dx] then n = n + 1 end end end
    if n == 0 then folds[k] = nil end
  end
  local col = {}
  for y = 0, CH - 1 do for x = 1, CW - 2 do
    if inBrain(x, y, g) then
      local _, d = brainAt(x, y, g)
      local under = not inBrain(x, y + 1, g)
      local side = not inBrain(x - 1, y, g) or not inBrain(x + 1, y, g)
      -- the outer flanks never get an INK wall: above the lobe shoulders they dissolve sideways into the SKY
      local flank = (x < 14 or x > CW - 15) and y < 10
      local shoulder = (x < 8 or x > CW - 9) and y < 8   -- outer rim stops below the shoulders
      local t = dens(x, y)
      if flank then t = t * math.min(1, d / 4) end
      local c = Y                                                                  -- water shows through
      if (under and not shoulder and lit(x, y, dens(x, y) * 2.2)) or (side and not flank and lit(x, y, t * 2.2)) then c = K -- 1px INK lobe outline
      elseif x == 40 and d < 2.5 then c = K                                        -- cleft tapers up out of the notch
      elseif folds[y * CW + x] and t > 0.45 then c = fold
      elseif not (under or side) and lit(x, y, t) then c = LN end                  -- solid mass, dithers out up top
      col[y * CW + x] = c
    end
  end end
  for k, c in pairs(col) do                        -- the fade ends in small clumps, never lone pixels or dot rows
    local x, y = k % CW, k // CW
    if (c == LN or c == K and x ~= 40) and y < FADE_Y + 2 then
      local n = 0
      for dy = -1, 1 do for dx = -1, 1 do
        local o = col[(y + dy) * CW + x + dx]
        if (dx ~= 0 or dy ~= 0) and o and o ~= Y then n = n + 1 end
      end end
      if n == 0 then col[k] = Y end
    end
  end
  for k, c in pairs(col) do C.px(k % CW, k // CW, c) end
  for y = 0, CH - 1 do C.px(0, y, Y); C.px(CW - 1, y, Y) end                -- gutter columns stay SKY
end

local function teeth(C, s)
  if s.shear then                                  -- knocked askew: every pixel slides with a column shear
    local px = C.px
    C.px = function(x, y, c) px(x, y + math.floor(s.shear * (x - 40) + 0.5), c) end
    local ok, err = pcall(function() teeth(C, { gap = s.gap, knock = s.knock }) end)
    C.px = px
    assert(ok, err)
    return
  end
  local gap, oy = s.gap or 0, 0                    -- 0 = closed on one 1px INK bite line
  C.rect(32, 30+oy, 17, 1, P); C.rect(30, 31+oy, 21, 1, P)                        -- upper gum, rounded
  C.rect(31, 32+oy, 19, 3, M); C.rect(43, 32+oy, 3, 3, A)                         -- upper teeth + gold tooth
  if s.knock then C.rect(43, 32+oy, 3, 3, K) end                                  -- smacked: gold tooth knocked out
  if gap > 0 then C.rect(35, 35+oy, 3, 1, M) end                                  -- fang shows when open
  local lt = 36 + gap + oy
  C.rect(32, lt, 19, 3, M)                                                        -- lower teeth
  C.rect(31, lt + 3, 21, 1, P); C.rect(33, lt + 4, 17, 1, P)                      -- lower gum, rounded
  C.outline(K)
  for i = 0, 3 do C.vline(34 + i*4, 32+oy, 2, K); C.vline(35 + i*4, lt + 1, 2, K) end  -- short tooth gaps
end

local function over(C, s)
  C.back.rect(0, 0, CW, CH, Y)
  local bu = C.bubbles
  local bubs = {}
  for _, b in ipairs(BUBS) do bubs[#bubs + 1] = b end
  if s.chomp then bubs[#bubs + 1] = {54, 38, 2}; bubs[#bubs + 1] = {27, 40, 1} end
  for _, b in ipairs(bubs) do
    local x, y = b[1], (b[2] - 2 * (s.t or 0) - 3) % 46 + 2
    if not inBrain(x, y - 3, 1) then
      if b[3] == 1 then bu.px(x, y, LN)
      elseif b[3] == 2 then bu.px(x, y-1, LN); bu.px(x-1, y, LN); bu.px(x+1, y, LN); bu.px(x, y+1, LN)
      else
        bu.hline(x, y-1, 2, LN); bu.hline(x, y+2, 2, LN); bu.vline(x-1, y, 2, LN); bu.vline(x+2, y, 2, LN)
        bu.px(x+1, y, M)
      end
    end
  end
  brain(C.brain, s)
  eyeball(C.eyeL, OEYES.eyeL, s, s.lookL)
  eyeball(C.eyeR, OEYES.eyeR, s, s.lookR)
  teeth(C.teeth, s)
  local fx = C.fx
  if s.zap then bang(fx, 70, 31 + (s.zap == 2 and -1 or 0)) end
  if s.zap == 1 then                               -- AMBER zaps crackle off the lower lobes
    fx.line(29, 13, 31, 15, A); fx.line(31, 15, 29, 17, A); fx.line(29, 17, 31, 19, A)
    fx.line(50, 13, 48, 15, A); fx.line(48, 15, 50, 17, A)
  elseif s.zap == 2 then
    fx.line(31, 13, 29, 15, A); fx.line(29, 15, 31, 17, A); fx.line(31, 17, 29, 19, A)
    fx.line(48, 13, 50, 15, A); fx.line(50, 15, 48, 17, A); fx.line(48, 17, 50, 19, A)
  end
  if s.tooth then                                  -- smacked: the gold tooth tumbles out to the right
    local tx, ty = s.tooth[1], s.tooth[2]
    if s.tooth[3] then fx.poly({tx+1,ty, tx+3,ty+1, tx+2,ty+3, tx,ty+2}, A) else fx.rect(tx, ty, 3, 3, A) end
    fx.px(tx + 1, ty + 1, M)
  end
  for _, st in ipairs(s.stars or {}) do            -- dizzy: chunky 5px AMBER stars (MARBLE core) ringing the head
    local x, y = st[1], st[2]
    fx.rect(x - 2, y, 5, 1, A); fx.rect(x - 1, y - 1, 3, 3, A); fx.px(x, y - 2, A)
    fx.px(x - 1, y + 2, A); fx.px(x + 1, y + 2, A); fx.px(x, y, M)
  end
  if s.tooth or s.stars then fx.outline(K) end      -- (only RS-a frames: needs zaps stay un-outlined)
  if s.tooth then                                  -- its INK motion ticks trail back toward the gap
    local tx, ty = s.tooth[1], s.tooth[2]
    fx.hline(tx - 5, ty + 1, 2, K); fx.hline(tx - 4, ty + 3, 2, K)
  end
  if s.hit then                                    -- smacked: INK impact streaks off the left (the window hits from Riff's side)
    local o = s.hit
    fx.hline(2, 14 + o, 5, K); fx.hline(3, 20 - o, 6, K); fx.hline(2, 27 + o, 4, K); fx.hline(4, 34, 5, K)
    if o == 0 then fx.line(9, 9, 11, 11, K); fx.line(9, 41, 11, 39, K) end
  end
end

-- off = cel y offsets per organ (out-of-sync bob; brain fixed); t = bubble rise step
local OVER_FRAMES = {
  { lid = 0.42, lookL = {1, 3}, lookR = {-1, 2}, t = 0, off = {eyeL = 1, eyeR = 1, teeth = 1} },                 -- lookDown x0
  { lid = 0.42, lookL = {0, 3}, lookR = {0, 2}, t = 1, swing = 1, off = {eyeL = 2, eyeR = 1, teeth = 1} },       -- lookDown x80
  { lookL = {2, 0}, lookR = {-2, -1}, t = 0, off = {eyeL = 0, eyeR = 1, teeth = 0} },                            -- idle x160
  { lookL = {2, 1}, lookR = {-1, -1}, t = 1, swing = 1, off = {eyeL = 1, eyeR = 0, teeth = -1} },               -- idle x240
  { shut = true, t = 0, off = {eyeL = 0, eyeR = 1, teeth = 0} },                                                 -- blink x320
  { lookL = {2, 0}, lookR = {-2, 0}, gap = 4, chomp = true, pulse = true, t = 0, off = {eyeL = 0, eyeR = 1, teeth = -1} },        -- talk x400
  { lookL = {2, 0}, lookR = {-2, 0}, gap = 0, chomp = true, t = 1, swing = 1, off = {eyeL = 1, eyeR = 0, teeth = 0} },            -- talk x480
  { lookL = {2, 1}, lookR = {-1, 0}, gap = 2, chomp = true, pulse = true, t = 2, off = {eyeL = 0, eyeR = 1, teeth = -1} },        -- talk x560
  { wide = true, lookL = {0, 0}, lookR = {0, 0}, gap = 3, zap = 1, glow = true, t = 0,
    off = {eyeL = -1, eyeR = 0, teeth = -1} },                                                                   -- needs x640
  { wide = true, lookL = {1, 0}, lookR = {-1, 0}, gap = 4, zap = 2, glow = true, pulse = true, swing = 1, t = 1,
    off = {eyeL = 0, eyeR = -1, teeth = -1} },                                                                   -- needs x720
  -- RS-a, appended (existing cells keep their x)
  { squish = true, sting = true, shear = 0.22, gap = 1, knock = true, tooth = {54, 37}, hit = 0, t = 0,
    off = {eyeL = 0, eyeR = 1, teeth = 1}, offx = {eyeL = 2, eyeR = 2, teeth = 2} },                            -- smacked x800
  { wide = true, pin = true, lookL = {-4, -4}, lookR = {3, 2}, sting = true, shear = -0.16, gap = 3, knock = true,
    tooth = {62, 41, true}, hit = 1, swing = 1, t = 1, off = {eyeL = -1, eyeR = 0, teeth = 0}, offx = {eyeL = 1, eyeR = 1, teeth = 1} }, -- smacked x880
  { spiral = 0, shear = 0.08, gap = 2, knock = true, swing = 1, t = 0, stars = {{11, 16}, {40, 20}, {69, 14}},
    off = {eyeL = 1, eyeR = 0, teeth = 0} },                                                                     -- dizzy x960
  { spiral = math.pi, shear = -0.08, gap = 2, knock = true, t = 1, stars = {{28, 15}, {52, 14}, {72, 31}},
    off = {eyeL = 0, eyeR = 1, teeth = 1} },                                                                     -- dizzy x1040
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
  for n, dy in pairs(s.off or {}) do local cel = lay[n]:cel(spr.frames[i]); cel.position = Point((s.offx or {})[n] or 0, dy) end
end)
