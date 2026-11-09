-- A1 (docs/PLAN_PROJECT_CHIPS_WORKFLOWS.md): the Perfection angel, face of the Workflows/@perfection lane.
-- A goofy "biblically accurate" angel in the sky-gods H0 hand (same 80x48 widescreen cell, SKY bg and gutter
-- contract as RiffBot/Overlord in art/office/faces/faces-h1c.lua, so the SkyZones zone code renders her as is):
-- two interlocking ophanim wheels studded with googly eyes (the one googly motif, 2a), one big friendly
-- cyclops eye with lashes and a grin in the middle, three pairs of pink-tipped wings, an askew AMBER halo,
-- sitting on a little cloud flush to row 47. Fun angle: wheels tilted like a gyroscope, halo cocked, the
-- right top wing waving hello. Flat P0 fills, 1px INK outlines, hand-placed shapes, no dither, no AI art.
--   idle  x0..x160 : wheels turn (ring eyes slide a third of a step per frame, seamless 3-loop), ring eyes
--                    blink at different times, body bobs 1px, right top wing waves
--   blink x240     : the big eye shuts into a happy ^ with lashes
--   hover x320,x400: every eye snaps to the viewer (pupils centred, eyes wide), wings flare up, halo hops
-- Gutter: bg = SKY (13), columns 0 and 79 flat SKY in every frame (asserted).
-- Writes public/office/face-angel-{dark,light}.png (480x48) + art/cast/angel/angel.aseprite,
-- public/office/sky-clouds-{dark,light}.png (96x48, tiles on x) + art/cast/angel/clouds.aseprite.
-- Keys: faces.json "angel" + sky-clouds.json (written by art/cast/angel/angel-json.cjs).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/cast/angel/angel.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local S = dofile(root.."/art/office/sky-lib.lua")
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local K, V, P, CO, A, M, T, MI, Y = 15, 8, 9, 10, 11, 4, 7, 12, 13
local CW, CH = 80, 48
local CX, CY = 40, 25            -- body centre (the big eye)

-- ---------- geometry helpers ----------
-- rotated-ellipse band: returns u, v (ring-local) and whether (x, y) is on the band
local function ringAt(r, x, y)
  local dx, dy = x - r.cx, y - r.cy
  local c, s = math.cos(r.rot), math.sin(r.rot)
  local u, v = dx * c + dy * s, -dx * s + dy * c
  local h = r.th / 2
  local o = (u / (r.rx + h)) ^ 2 + (v / (r.ry + h)) ^ 2
  local i = (u / (r.rx - h)) ^ 2 + (v / (r.ry - h)) ^ 2
  return u, v, o <= 1 and i > 1
end
local function ringPt(r, t)
  local u, v = r.rx * math.cos(t), r.ry * math.sin(t)
  local c, s = math.cos(r.rot), math.sin(r.rot)
  return math.floor(r.cx + u * c - v * s + 0.5), math.floor(r.cy + u * s + v * c + 0.5), v
end
-- filled rotated ellipse
local function rell(C, cx, cy, rx, ry, rot, col)
  local c, s = math.cos(rot), math.sin(rot)
  local R = math.ceil(math.max(rx, ry)) + 1
  for y = math.floor(cy - R), math.ceil(cy + R) do for x = math.floor(cx - R), math.ceil(cx + R) do
    local dx, dy = x - cx, y - cy
    local u, v = dx * c + dy * s, -dx * s + dy * c
    if (u / rx) ^ 2 + (v / ry) ^ 2 <= 1 then C.px(x, y, col) end
  end end
end

-- ---------- wheels ----------
-- VW: the big upright eye-wheel standing behind her (PINK), cocked for the fun angle; HW: the gold Saturn wheel
-- that runs through it and in front of her (back half behind, front half in front)
local HW = { cx = CX, cy = CY + 7, rx = 25, ry = 5, rot = -0.14, th = 3, col = A, n = 4, phase = 0.5 }
local VW = { cx = CX, cy = CY - 1, rx = 17, ry = 18, rot = 0.25, th = 3, col = P, n = 6, phase = 0.25 }

-- per-eye googly look (hand-placed, lopsided) and which eye is shut on which idle frame
local LOOK_H = { {-1, 0}, {0, -1}, {-1, -1}, {0, 0} }
local LOOK_V = { {0, 0}, {-1, -1}, {0, -1}, {-1, 0}, {0, 0}, {-1, -1} }
local SHUT = { { h = { [2] = true }, v = { [4] = true } }, { h = {}, v = { [1] = true, [5] = true } }, { h = { [4] = true }, v = { [3] = true } } }

-- full wheel (band + INK outline) split into back (v < 0) and front pixels
local function key(x, y) return (y + 4) * 256 + x + 4 end
local function unkey(k) return k % 256 - 4, k // 256 - 4 end
local function wheel(r)
  local band, out = {}, {}
  for y = -2, CH + 1 do for x = -2, CW + 1 do
    local _, _, on = ringAt(r, x, y); if on then band[key(x, y)] = true end
  end end
  for k in pairs(band) do
    local x, y = unkey(k)
    for _, d in ipairs({ {-1,0}, {1,0}, {0,-1}, {0,1} }) do
      if not band[key(x + d[1], y + d[2])] then out[key(x + d[1], y + d[2])] = true end
    end
  end
  return band, out
end

local function drawWheel(C, r, front)
  local band, out = wheel(r)
  for k in pairs(out) do local x, y = unkey(k); local _, v = ringAt(r, x, y); if (v >= 0) == front then C.px(x, y, K) end end
  for k in pairs(band) do local x, y = unkey(k); local _, v = ringAt(r, x, y); if (v >= 0) == front then C.px(x, y, r.col) end end
end

-- one googly ring eye: MARBLE disk, INK rim, 2x2 pupil; shut = lid in the wheel colour with an INK lash line
local function ringEye(C, x, y, look, shut, wide, lidc)
  local rx, ry = wide and 2.9 or 2.6, wide and 3.3 or 3.1
  C.ellipse(x, y, rx + 1, ry + 1, K)
  C.ellipse(x, y, rx, ry, M)
  if shut then
    C.ellipse(x, y, rx, ry, lidc); C.hline(x - 2, y, 5, K); C.px(x - 3, y + 1, K); C.px(x + 3, y + 1, K)
  elseif wide then
    C.rect(x - 1, y - 1, 3, 3, K); C.px(x - 1, y - 1, M)            -- staring right at you
  else
    C.rect(x + look[1], y + look[2] - 1, 2, 3, K)
  end
end

local function wheelEyes(C, r, s, front, looks, shutset)
  for i = 1, r.n do
    local t = (i - 1 + (r.phase or 0)) * 2 * math.pi / r.n + (s.turn or 0) * (2 * math.pi / r.n) / 3
    local x, y, v = ringPt(r, t)
    if (v >= 0) == front then
      ringEye(C, x, y, looks[i], not s.wide and shutset[i], s.wide, r.col)
    end
  end
end

-- ---------- wings ----------
-- a wing = a fan of feathers from a root; each feather is drawn INK-grown then MARBLE, back to front,
-- so INK seams fall between feathers; the outer 5px of every feather is VIOLET (lilac vaporwave tips)
local function feather(C, x0, y0, a, len, w)
  local dx, dy = math.cos(a), math.sin(a)
  local cx, cy = x0 + dx * len / 2, y0 + dy * len / 2
  rell(C, cx, cy, len / 2 + 1, w + 1, a, K)
  local c, s = math.cos(a), math.sin(a)
  local R = math.ceil(len / 2) + 1
  for y = math.floor(cy - R), math.ceil(cy + R) do for x = math.floor(cx - R), math.ceil(cx + R) do
    local ex, ey = x - cx, y - cy
    local u, v = ex * c + ey * s, -ex * s + ey * c
    if (u / (len / 2)) ^ 2 + (v / w) ^ 2 <= 1 then C.px(x, y, u > len / 2 - 5 and V or M) end
  end end
end
-- angles in degrees for the LEFT wing (0 = right, 180 = left, y grows down); mirrored for the right
local function wing(C, side, root, fan)
  for _, f in ipairs(fan) do
    local a = math.rad(f[1])
    local rx = root[1]
    if side > 0 then a = math.pi - a; rx = CW - 1 - root[1] end
    feather(C, rx, root[2], a, f[2], f[3] or 2.2)
  end
end
local WING = {
  top = { root = {30, 18}, fan = { {226, 20, 3}, {212, 25, 3.2}, {198, 26, 3} } },
  mid = { root = {29, 26}, fan = { {182, 25, 3}, {170, 22, 2.8} } },
  low = { root = {31, 32}, fan = { {155, 18, 2.6}, {143, 14, 2.4} } },
}
local function lift(fan, d) local o = {} for i, f in ipairs(fan) do o[i] = { f[1] + d, f[2], f[3] } end return o end

-- ---------- the big eye (cyclops face) ----------
local function bigEye(C, s)
  C.ellipse(CX, CY, 9.6, 9.6, K)
  C.ellipse(CX, CY, 8.6, 8.6, M)
  -- lashes (3 per side of the top), INK
  for _, l in ipairs({ {-6,-7,-8,-10}, {-2,-9,-3,-12}, {2,-9,3,-12}, {6,-7,8,-10} }) do
    C.line(CX + l[1], CY + l[2], CX + l[3], CY + l[4], K)
  end
  if s.shut then                                                         -- happy ^ shut eye
    C.line(CX - 5, CY + 1, CX, CY - 3, K); C.line(CX, CY - 3, CX + 5, CY + 1, K)
    C.line(CX - 5, CY + 2, CX, CY - 2, K); C.line(CX, CY - 2, CX + 5, CY + 2, K)
  else
    local ix, iy = CX + (s.ix or 0), CY - 2 + (s.iy or 0)
    C.ellipse(ix, iy, s.wide and 4.6 or 4.2, s.wide and 4.6 or 4.2, T)
    C.ellipse(ix, iy, s.wide and 2.6 or 2.1, s.wide and 2.6 or 2.1, K)
    C.rect(ix - 2, iy - 3, 2, 2, M)                                      -- wet glint
    if s.wide then C.px(ix + 2, iy + 2, M) end
  end
  -- grin + blush under the iris
  local gy = CY + 4
  if s.wide then                                                         -- open delighted mouth
    C.hline(CX - 3, gy, 7, K); C.rect(CX - 3, gy + 1, 7, 2, K); C.hline(CX - 2, gy + 3, 5, K)
    C.rect(CX - 1, gy + 2, 3, 1, P)
  else
    C.px(CX - 3, gy, K); C.hline(CX - 2, gy + 1, 5, K); C.px(CX + 3, gy, K)
  end
  C.hline(CX - 7, gy - 1, 2, P); C.hline(CX + 6, gy - 1, 2, P)
end

-- ---------- halo ----------
local function halo(C, s)
  local hx, hy = CX + 5 + (s.hx or 0), 4 + (s.hy or 0)
  local r = { cx = hx, cy = hy, rx = 8, ry = 2, rot = 0.22, th = 2 }
  local band = {}
  for y = 0, 8 do for x = hx - 13, hx + 13 do local _, _, on = ringAt(r, x, y); if on then band[#band + 1] = {x, y} end end end
  for _, p in ipairs(band) do C.px(p[1], p[2], A) end
  C.outline(K)
  if s.glint then C.px(hx - 6, hy - 1, M); C.px(hx - 5, hy - 2, M) end
end

-- ---------- frames ----------
local FRAMES = {
  { turn = 0, bob = 0, wave = 0,  ix = -2, iy = 0, sh = 1 },                      -- idle x0
  { turn = 1, bob = -1, wave = 10, ix = -2, iy = 1, sh = 2 },                     -- idle x80
  { turn = 2, bob = 0, wave = 4,  ix = -1, iy = 0, sh = 3 },                      -- idle x160
  { turn = 0, bob = 0, wave = 0,  shut = true, sh = 0 },                          -- blink x240
  { turn = 0, bob = -1, wide = true, flare = 12, hy = 0, glint = true },          -- hover x320 (snap)
  { turn = 0, bob = -1, wide = true, flare = 22, hy = -1, glint = true },         -- hover x400 (flare peak)
}
local LAYERS = { "back", "wings", "wheelB", "eye", "cloud", "wheelF", "eyes", "halo" }

local function draw(C, s)
  C.back.rect(0, 0, CW, CH, Y)
  local w = C.wings
  local fl = s.flare or 0
  for _, side in ipairs({ -1, 1 }) do
    wing(w, side, WING.low.root, lift(WING.low.fan, side < 0 and -fl / 3 or -fl / 3))
    wing(w, side, WING.mid.root, lift(WING.mid.fan, fl / 2))
    wing(w, side, WING.top.root, lift(WING.top.fan, fl + ((side > 0) and (s.wave or 0) or 0)))
  end
  local shutset = SHUT[s.sh] or { h = {}, v = {} }
  drawWheel(C.wheelB, HW, false); wheelEyes(C.wheelB, HW, s, false, LOOK_H, shutset.h)
  drawWheel(C.wheelB, VW, false); drawWheel(C.wheelB, VW, true)            -- the upright wheel stands wholly behind her
  bigEye(C.eye, s)
  drawWheel(C.wheelF, HW, true)
  -- the googly ring eyes sit on top of every band (stuck on, never cut by the other wheel)
  wheelEyes(C.eyes, VW, s, false, LOOK_V, shutset.v); wheelEyes(C.eyes, VW, s, true, LOOK_V, shutset.v)
  wheelEyes(C.eyes, HW, s, true, LOOK_H, shutset.h)
  halo(C.halo, s)
  -- the little cloud she sits on, flush to row 47 (same painter as the sky band / side clouds)
  S.cloud(C.cloud, L, { {29, 44, 9, 4}, {40, 41, 11, 6}, {52, 44, 9, 4} }, { base = 47, und = 2 })
end

-- ---------- build + export ----------
local function flat(spr, frame)
  local img = Image(spr.width, spr.height, ColorMode.INDEXED); img:clear(0)
  img:drawSprite(spr, frame)
  return img
end
local function export(strip, w, name)
  for _, mode in ipairs({ "dark", "light" }) do
    local out = Sprite(w, CH, ColorMode.INDEXED)
    out:setPalette(Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" })
    out.transparentColor = 0
    out.cels[1].image = strip
    out:saveAs(root.."/public/office/"..name.."-"..mode..".png"); out:close()
  end
end

do
  local spr = L.new(CW, CH, pal)
  for i = 2, #FRAMES do spr:newFrame() end
  local lay = {}
  for _, n in ipairs(LAYERS) do lay[n] = L.layer(spr, n) end
  local strip = Image(CW * #FRAMES, CH, ColorMode.INDEXED); strip:clear(0)
  for i, s in ipairs(FRAMES) do
    local C = {}
    for _, n in ipairs(LAYERS) do C[n] = L.canvas(spr, lay[n], spr.frames[i]) end
    draw(C, s)
    for _, n in ipairs(LAYERS) do C[n].commit() end
    for _, n in ipairs({ "wings", "wheelB", "eye", "wheelF", "eyes", "halo" }) do
      lay[n]:cel(spr.frames[i]).position = Point(0, s.bob or 0)
    end
    local img = flat(spr, i)
    for y = 0, CH - 1 do for _, x in ipairs({ 0, CW - 1 }) do
      assert(img:getPixel(x, y) == Y, "angel frame "..i.." edge x"..x.." y"..y.." is not SKY")
    end end
    strip:drawImage(img, Point((i - 1) * CW, 0))
  end
  spr:saveAs(root.."/art/cast/angel/angel.aseprite"); spr:close()
  export(strip, CW * #FRAMES, "face-angel")
  print("wrote angel "..#FRAMES.." frames")
end

-- ---------- side clouds: 96x48 tile, wraps on x, bottom bank lines up with her cloud ----------
do
  local TW = 96
  local spr = L.new(TW, CH, pal)
  local back = L.canvas(spr, L.layer(spr, "sky"), spr.frames[1])
  back.rect(0, 0, TW, CH, Y); back.commit()
  local c = L.canvas(spr, L.layer(spr, "clouds"), spr.frames[1])
  -- high wisp, then the low bank (runs off the bottom edge: no belly) with puffy tops
  S.cloud(c, L, { {22, 13, 7, 3}, {30, 11, 7, 4}, {37, 14, 5, 2} }, { base = 15, und = 2, wrap = TW })
  S.cloud(c, L, { {8, 41, 10, 6}, {24, 38, 11, 8}, {40, 42, 9, 5}, {58, 39, 12, 7}, {76, 42, 9, 5}, {90, 40, 10, 7} },
    { base = 47, belly = false, wrap = TW, body = {44, 0, TW - 1} })
  c.commit()
  local img = flat(spr, 1)
  for y = 0, CH - 1 do                                           -- seam: wrap columns must continue each other
    assert(img:getPixel(0, y) ~= 0 and img:getPixel(TW - 1, y) ~= 0, "cloud tile hole at y"..y)
  end
  spr:saveAs(root.."/art/cast/angel/clouds.aseprite"); spr:close()
  export(img, TW, "sky-clouds")
  print("wrote sky-clouds")
end
