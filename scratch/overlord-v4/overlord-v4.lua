-- H1c-v4 MOCK (scratch only, not shipped): Overlord idle[0] with a GIANT faded brain as the jar backdrop.
-- Base = shipped H1c-v3 Overlord (art/office/faces/faces-h1c.lua @ 8380fed): same eyeball/teeth/bubble
-- helpers, H0 hand, 1px INK outlines on every foreground organ, P0 slots only (no new colours).
--   A       : brain-fold wallpaper edge to edge (2 muddy tones: SKY/LINE dither + LINE sulci); eyes on
--             dangling nerves + teeth float on top at full contrast.
--   B       : one giant brain cropped off the top and both sides (~top 2/3), Bayer-dithered down into
--             SKY; bigger googly eyes hang from it on CORAL nerve tails; teeth float below.
--   B-pulse : B talk frame (teeth open) where the fold lines light up PINK.
-- Columns 0 and 79 stay flat SKY (gutter contract kept even for A).
-- Writes scratch/overlord-v4/overlord-v4-{dark,light}.png (3 cells: A | B | B-pulse) + overlord-v4.aseprite.
-- Run: Aseprite.exe -b --script-param root=<repo> --script scratch/overlord-v4/overlord-v4.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local K, V, P, CO, A, M, T, Y, LN = 15, 8, 9, 10, 11, 4, 7, 13, 3
local CW, CH = 80, 48

-- ---------- shipped v3 organ helpers (copied, unchanged except params) ----------
local function nerve(C, pts)
  for i = 1, #pts - 3, 2 do
    C.line(pts[i], pts[i+1], pts[i+2], pts[i+3], CO); C.line(pts[i]+1, pts[i+1], pts[i+2]+1, pts[i+3], CO)
  end
end

local function eyeball(C, e, s, look)
  local cx, cy, r = e.x, e.y, e.r
  local h = e.hook
  local by = math.floor(cy + r)
  if e.up then                                     -- B: nerve rises from the eye top into the brain
    local ty = math.ceil(cy - r)
    nerve(C, {cx, ty + 1, cx + h, ty - 3, cx, ty - 6, cx - h, ty - 9, cx, e.up})
  else                                             -- A/v3: nerve dangles below
    nerve(C, {cx, by - 1, cx - h, by + 5, cx, by + 10, cx - h, by + 15, cx, by + 18,
              cx + 2*h, by + 18, cx + 3*h, by + 16})
  end
  C.ellipse(cx, cy, r, r, M)
  for _, v in ipairs(e.veins) do C.line(cx + v[1], cy + v[2], cx + v[3], cy + v[4], P) end
  local ix, iy = cx + look[1], cy + look[2]
  local ir = r * 0.46
  C.ellipse(ix, iy, ir, ir, T)
  local p = e.pup
  C.rect(ix - p // 2, iy - p // 2, p, p, K); C.px(ix - p // 2, iy - p // 2, M)
  C.outline(K)
end

local function teeth(C, s, oy)
  local gap = s.gap or 0
  C.rect(32, 30+oy, 17, 1, P); C.rect(30, 31+oy, 21, 1, P)
  C.rect(31, 32+oy, 19, 3, M); C.rect(43, 32+oy, 3, 3, A)
  if gap > 0 then C.rect(35, 35+oy, 3, 1, M) end
  local lt = 36 + gap + oy
  C.rect(32, lt, 19, 3, M)
  C.rect(31, lt + 3, 21, 1, P); C.rect(33, lt + 4, 17, 1, P)
  C.outline(K)
  for i = 0, 3 do C.vline(34 + i*4, 32+oy, 2, K); C.vline(35 + i*4, lt + 1, 2, K) end
end

local BUBS = { {26,44,3}, {56,41,2}, {7,30,1}, {72,25,1}, {54,46,1}, {34,47,2}, {70,44,3}, {9,45,2}, {50,28,1} }
local function bubbles(C, s, keep)
  local list = {}
  for _, b in ipairs(BUBS) do list[#list+1] = b end
  if s.chomp then list[#list+1] = {54, 35, 2}; list[#list+1] = {27, 34, 1} end
  for _, b in ipairs(list) do
    local x, y = b[1], (b[2] - 2 * (s.t or 0) - 3) % 46 + 2
    if keep(x, y) then
      if b[3] == 1 then C.px(x, y, M)
      elseif b[3] == 2 then C.px(x, y-1, M); C.px(x-1, y, M); C.px(x+1, y, M); C.px(x, y+1, M)
      else
        C.hline(x, y-1, 2, M); C.hline(x, y+2, 2, M); C.vline(x-1, y, 2, M); C.vline(x+2, y, 2, M)
      end
    end
  end
end

-- ---------- brain folds: zero-contour of a meandering field = 1px worm-like gyri lines ----------
-- mirrored about x=40 so the two hemispheres read as one brain
local function field(x, y, k)
  local u = math.abs(x - 39.5)
  return math.sin(y * 0.62 * k + 2.3 * math.sin(u * 0.27 * k + 0.9 * math.sin(y * 0.19)) + 0.4)
       + 0.45 * math.sin(u * 0.5 * k + 1.3)
end
local function sulcus(x, y, k)
  local f = field(x, y, k)
  return (f > 0) ~= (field(x + 1, y, k) > 0) or (f > 0) ~= (field(x, y + 1, k) > 0)
end

-- A: wallpaper, 2 muddy tones (gyri = 25% SKY/LINE dither, sulci = solid LINE)
local function wallpaper(C)
  for y = 0, CH - 1 do for x = 1, CW - 2 do
    if x ~= 39 and x ~= 40 and sulcus(x, y, 1.15) then C.px(x, y, LN)
    elseif L.dith(x, y, 0, 1, 0.25) == 1 then C.px(x, y, LN) end
  end end
end

-- B: giant brain, centre top, cropped by top + sides, lumpy lower rim near y~31,
-- dithered down into SKY; fold lines VIOLET up top, LINE lower; pulse = PINK folds
local function rimY(x)
  local dx = (x - 39.5) / 44
  return 31 - 10 * dx * dx + 1.3 * math.sin(math.abs(x - 39.5) * 0.6) - (math.abs(x - 39.5) < 2 and 3 or 0)
end
local function bigbrain(C, s)
  for y = 0, CH - 1 do for x = 1, CW - 2 do
    local rim = rimY(x)
    if y <= rim then
      local d = (rim - y) / 24                     -- 0 at rim -> 1 at top
      local t = math.min(1, 0.15 + d)              -- fill density
      local fiss = (x == 39 or x == 40) and y < rim - 1
      if fiss then
        if t > 0.35 then C.px(x, y, (x == 39) and (s.pulse and P or V) or 0) end
      elseif sulcus(x, y, 1.0) then
        if s.pulse and t > 0.3 then C.px(x, y, P)
        elseif t > 0.55 then C.px(x, y, V)
        elseif t > 0.3 then C.px(x, y, LN)
        elseif L.dith(x, y, 0, 1, 0.5) == 1 then C.px(x, y, LN) end
      elseif y >= rim - 1 then                     -- soft lower rim so the silhouette reads
        if L.dith(x, y, 0, 1, 0.75) == 1 then C.px(x, y, LN) end
      elseif L.dith(x, y, 0, 1, t * 0.6) == 1 then C.px(x, y, LN) end
    end
  end end
end

-- ---------- variants ----------
local EA = {
  eyeL = { x = 22, y = 13, r = 6.6, hook = -1, pup = 3, veins = {{-6,-2,-4,-1}, {-5,3,-3,2}, {5,-3,3,-2}} },
  eyeR = { x = 58, y = 11, r = 5.6, hook = 1, pup = 2, veins = {{-5,-1,-3,0}, {4,-2,2,-1}, {3,3,2,2}} },
}
local EB = {
  eyeL = { x = 20, y = 27, r = 8.2, hook = 1, pup = 3, up = 14,
           veins = {{-8,-2,-5,-1}, {-7,4,-4,3}, {7,-4,4,-3}, {6,4,4,3}} },
  eyeR = { x = 60, y = 25, r = 7.1, hook = -1, pup = 3, up = 12,
           veins = {{-7,-1,-4,0}, {6,-3,3,-2}, {5,4,3,3}} },
}
local VARS = {
  { name = "A", back = "wall", eyes = EA, s = { t = 0 }, look = {{2,0},{-2,-1}}, toy = 0, off = {0, 1} },
  { name = "B", back = "big", eyes = EB, s = { t = 0 }, look = {{2,0},{-2,-1}}, toy = 3, off = {0, 1} },
  { name = "B-pulse", back = "big", eyes = EB, s = { t = 0, gap = 4, chomp = true, pulse = true },
    look = {{2,0},{-2,0}}, toy = 2, off = {0, 1} },
}

local LAYERS = { "back", "brain", "bubbles", "eyeL", "eyeR", "teeth" }
local spr = L.new(CW, CH, pal)
for i = 2, #VARS do spr:newFrame() end
local lay = {}
for _, n in ipairs(LAYERS) do lay[n] = L.layer(spr, n) end
local strip = Image(CW * #VARS, CH, ColorMode.INDEXED); strip:clear(0)
for i, v in ipairs(VARS) do
  local C = {}
  for _, n in ipairs(LAYERS) do C[n] = L.canvas(spr, lay[n], spr.frames[i]) end
  C.back.rect(0, 0, CW, CH, Y)
  if v.back == "wall" then wallpaper(C.brain) else bigbrain(C.brain, v.s) end
  bubbles(C.bubbles, v.s, function(x, y) return v.back == "wall" or y > 30 end)
  eyeball(C.eyeL, v.eyes.eyeL, v.s, v.look[1])
  eyeball(C.eyeR, v.eyes.eyeR, v.s, v.look[2])
  teeth(C.teeth, v.s, v.toy)
  for _, n in ipairs(LAYERS) do C[n].commit() end
  lay.eyeL:cel(spr.frames[i]).position = Point(0, v.off[1])
  lay.eyeR:cel(spr.frames[i]).position = Point(0, v.off[2])
  local img = Image(CW, CH, ColorMode.INDEXED); img:clear(0); img:drawSprite(spr, i)
  for y = 0, CH - 1 do for _, x in ipairs({0, CW - 1}) do
    assert(img:getPixel(x, y) == Y, v.name.." edge x"..x.." y"..y.." not SKY")
  end end
  strip:drawImage(img, Point((i - 1) * CW, 0))
end
local dir = root.."/scratch/overlord-v4/"
spr:saveAs(dir.."overlord-v4.aseprite"); spr:close()
for _, mode in ipairs({"dark", "light"}) do
  local out = Sprite(CW * #VARS, CH, ColorMode.INDEXED)
  out:setPalette(Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" })
  out.transparentColor = 0
  out.cels[1].image = strip
  out:saveAs(dir.."overlord-v4-"..mode..".png"); out:close()
end
print("wrote overlord-v4 "..#VARS.." cells")
