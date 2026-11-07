-- U3b shared airbrush primitives (same hand as the U3a style frame, art/ui/u3a/paint.lua).
-- Paints into "index images": plain Lua tables of P0 slot numbers, nil = transparent.
-- Grain = the hand-laid 8x8 SPRAY threshold matrix. Two lookups:
--   grain(x,y)  block-shifted, for one-off pieces (clouds, sparkles) so no grid shows
--   grainT(x,y) plain 8px period, for anything that tiles (strips, edges, faces)
-- No filters, no blur, no generated imagery.
local A = {}
A.BG,A.PANEL,A.PHI,A.LINE,A.MARBLE,A.TEXT,A.MUTED,A.TEAL,A.VIOLET,A.PINK,A.CORAL,A.AMBER,A.MINT,A.SKY,A.SKIN,A.INK =
  0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15
local INK, MARBLE, VIOLET, TEAL, PINK, CORAL, AMBER = 15, 4, 8, 7, 9, 10, 11

A.SPRAY = {
  {34,12,50, 3,41,22,59, 8},
  {57,27, 6,45,17,63,30,46},
  { 1,39,61,24,53, 9,37,20},
  {48,15,32,11,35,49, 2,56},
  {25,58, 4,43,28,18,42,13},
  {40, 7,52,19,62, 5,31,60},
  {16,44,29,36,10,55,23,38},
  {54,21,47, 0,33,26,51,14},
}
do local seen = {}; for _, r in ipairs(A.SPRAY) do for _, v in ipairs(r) do
  assert(not seen[v], "SPRAY dup "..v); seen[v] = true end end end
local S = A.SPRAY
function A.grain(x, y) local bx, by = x // 8, y // 8
  return S[(y + bx*5) % 8 + 1][(x + by*3) % 8 + 1] end
function A.grainT(x, y) return S[y % 8 + 1][x % 8 + 1] end
local function clamp(v) return v < 0 and 0 or (v > 1 and 1 or v) end
A.clamp = clamp

-- ---------------------------------------------------------------- index images
-- T is the current target; every primitive paints into it.
local T
function A.new(w, h) return { w = w, h = h, d = {} } end
function A.use(img) T = img; return img end
function A.target() return T end
-- tiled modes: false = block-shifted spray (one-off pieces); true = 8px-period spray (2D ramps
-- that tile); "bayer" = ordered 4x4 for 1px bands on repeating edges/faces, so a single row reads
-- as even dots instead of clumped dashes
local tiled = false
local BAYER4 = {{0,8,2,10},{12,4,14,6},{3,11,1,9},{15,7,13,5}}
function A.tiled(on) tiled = on end
function A.hit(x, y, t)
  if tiled == "bayer" then return BAYER4[y%4+1][x%4+1] + 0.5 < t*16 end
  return (tiled and A.grainT(x, y) or A.grain(x, y)) + 0.5 < t*64
end
local hit = A.hit
function A.px(x, y, c)
  if x >= 0 and y >= 0 and x < T.w and y < T.h then T.d[y*T.w + x + 1] = c end
end
function A.get(img, x, y)
  if x < 0 or y < 0 or x >= img.w or y >= img.h then return nil end
  return img.d[y*img.w + x + 1]
end
local px = A.px
function A.rect(x, y, w, h, c) for j=y,y+h-1 do for i=x,x+w-1 do px(i, j, c) end end end
function A.hline(x, y, w, c) for i=x,x+w-1 do px(i, y, c) end end
function A.vline(x, y, h, c) for j=y,y+h-1 do px(x, j, c) end end
function A.line(x0, y0, x1, y1, c)
  local n = math.max(math.abs(x1-x0), math.abs(y1-y0))
  if n == 0 then px(x0, y0, c) return end
  for t=0,n do px(x0 + math.floor((x1-x0)*t/n + 0.5), y0 + math.floor((y1-y0)*t/n + 0.5), c) end
end
-- ASCII stamp ('.' and ' ' skipped)
function A.stamp(x0, y0, art, key)
  local r = 0
  for row in art:gmatch("[^\n]+") do
    row = row:gsub("^%s*|", ""):gsub("|%s*$", "")
    for i=1,#row do local ch = row:sub(i, i)
      if ch ~= "." and ch ~= " " then px(x0+i-1, y0+r, key[ch]) end end
    r = r + 1
  end
end
-- copy another index image in (nil pixels skipped)
function A.blit(src, x, y)
  for j=0,src.h-1 do for i=0,src.w-1 do
    local v = src.d[j*src.w + i + 1]
    if v then px(x+i, y+j, v) end
  end end
end
-- 9-slice draw with repeated edges/centre (how CSS border-image + repeat will lay it out)
function A.nine(src, sl, x, y, w, h, noCentre)
  local L, R, Tp, B = sl.left, sl.right, sl.top, sl.bottom
  local mw, mh = src.w - L - R, src.h - Tp - B
  for j=0,h-1 do
    local sy = j < Tp and j or (j >= h-B and src.h-(h-j) or Tp + (j-Tp) % mh)
    for i=0,w-1 do
      local sx = i < L and i or (i >= w-R and src.w-(w-i) or L + (i-L) % mw)
      local centre = sx >= L and sx < src.w-R and sy >= Tp and sy < src.h-B
      if not (noCentre and centre) then
        local v = src.d[sy*src.w + sx + 1]
        if v then px(x+i, y+j, v) end
      end
    end
  end
end
-- tile a piece over a rect
function A.tile(src, x, y, w, h, ox, oy)
  ox, oy = ox or 0, oy or 0
  for j=0,h-1 do for i=0,w-1 do
    local v = src.d[((j+oy) % src.h)*src.w + (i+ox) % src.w + 1]
    if v then px(x+i, y+j, v) end
  end end
end

-- ---------------------------------------------------------------- airbrush
function A.grad(x, y, w, h, cols, horiz)
  local n = #cols
  for j=0,h-1 do for i=0,w-1 do
    local f = horiz and i/math.max(1, w-1) or j/math.max(1, h-1)
    local s = f*(n-1); local k = math.min(n-1, math.floor(s)); local t = s - k
    if k >= n-1 then px(x+i, y+j, cols[n])
    else px(x+i, y+j, hit(x+i, y+j, t) and cols[k+2] or cols[k+1]) end
  end end
end
-- structured pool: solid core -> 75 -> 50 -> 25 -> feather
A.LEVELS = { {0.34,1.0}, {0.52,0.75}, {0.68,0.5}, {0.84,0.25}, {1.0,0.09} }
function A.pool(cx, cy, rx, ry, c, maxLevel, clip)
  for y=math.floor(cy-ry), math.ceil(cy+ry) do for x=math.floor(cx-rx), math.ceil(cx+rx) do
    if not clip or (x >= clip[1] and y >= clip[2] and x <= clip[3] and y <= clip[4]) then
      local d = math.sqrt(((x-cx)/rx)^2 + ((y-cy)/ry)^2)
      for _, lv in ipairs(A.LEVELS) do
        if d < lv[1] then
          if hit(x, y, math.min(lv[2], maxLevel or 1)) then px(x, y, c) end
          break
        end
      end
    end
  end end
end
function A.puff(cx, cy, rx, ry, c, amt)
  for y=math.floor(cy-ry), math.ceil(cy+ry) do for x=math.floor(cx-rx), math.ceil(cx+rx) do
    local d = ((x-cx)/rx)^2 + ((y-cy)/ry)^2
    if d < 1 and hit(x, y, amt*(1-d)^2) then px(x, y, c) end
  end end
end
-- airbrush pass along a segment, tapered at both ends
function A.stroke(x0, y0, x1, y1, r, c, amt, noTaper)
  local dx, dy = x1-x0, y1-y0; local len2 = math.max(1, dx*dx + dy*dy)
  for y=math.floor(math.min(y0,y1)-r), math.ceil(math.max(y0,y1)+r) do
    for x=math.floor(math.min(x0,x1)-r), math.ceil(math.max(x0,x1)+r) do
      local t = clamp(((x-x0)*dx + (y-y0)*dy) / len2)
      local d = math.sqrt((x-x0-t*dx)^2 + (y-y0-t*dy)^2) / r
      local taper = noTaper and 1 or math.sin(t*math.pi)
      if d < 1 and hit(x, y, amt*taper*(1-d*d)) then px(x, y, c) end
    end
  end
end
-- mall-art sparkle: optional sprayed halo, tapering arms, hard core
function A.sparkle(cx, cy, len, halo, core)
  if halo then A.pool(cx, cy, len*1.3, len*1.3, halo, 0.75) end
  for k=1,len do
    local t = 1 - (k-1)/len
    for _, d in ipairs({{1,0},{-1,0},{0,1},{0,-1}}) do
      local x, y = cx + d[1]*k, cy + d[2]*k
      if k <= 2 or hit(x, y, t*1.1) then px(x, y, MARBLE) end
    end
  end
  if len >= 4 then for _, d in ipairs({{-1,-1},{1,1},{1,-1},{-1,1}}) do px(cx+d[1], cy+d[2], MARBLE) end end
  px(cx, cy, core or MARBLE)
end
function A.star(x, y, c) px(x, y, c); px(x-1, y, c); px(x+1, y, c); px(x, y-1, c); px(x, y+1, c) end

-- ---------------------------------------------------------------- 3x5 text (H0 font)
A.F = {}
function A.useFont(L)
  for k, v in pairs(L.F) do A.F[k] = v end
  A.F["@"] = "011101111100011"; A.F[">"] = "100010001010100"; A.F["%"] = "101001010100101"
  A.F["<"] = "001010100010001"; A.F[","] = "000000000010100"; A.F["?"] = "110001010000010"
  A.F["_"] = "000000000000111"; A.F["'"] = "010010000000000"; A.F["&"] = "010101010101011"
  A.F["#"] = "101111101111101"; A.F["="] = "000111000111000"
end
function A.text(x, y, s, c)
  for n=1,#s do
    local g = A.F[s:sub(n,n)] or A.F[" "]
    for r=0,4 do for q=0,2 do
      if g:sub(r*3+q+1, r*3+q+1) == "1" then px(x+(n-1)*4+q, y+r, c) end
    end end
  end
end
function A.textW(s) return #s*4 - 1 end
function A.keyText(x, y, s, c)
  for _, d in ipairs({{-1,0},{1,0},{0,-1},{0,1},{1,1}}) do A.text(x+d[1], y+d[2], s, INK) end
  A.text(x, y, s, c)
end

-- ---------------------------------------------------------------- chrome face
-- hand-drawn 6x7 source glyphs (2px stems); grown by row/column maps per size
A.CHROME = {
  A={".####.","##..##","##..##","######","##..##","##..##","##..##"},
  B={"#####.","##..##","#####.","##..##","##..##","##..##","#####."},
  C={".#####","##....","##....","##....","##....","##....",".#####"},
  D={"#####.","##..##","##..##","##..##","##..##","##..##","#####."},
  E={"######","##....","#####.","##....","##....","##....","######"},
  F={"######","##....","#####.","##....","##....","##....","##...."},
  G={".#####","##....","##....","##.###","##..##","##..##",".#####"},
  H={"##..##","##..##","##..##","######","##..##","##..##","##..##"},
  I={"####",".##.",".##.",".##.",".##.",".##.","####"},
  J={"....##","....##","....##","....##","....##","##..##",".####."},
  K={"##..##","##.##.","####..","###...","####..","##.##.","##..##"},
  L={"##....","##....","##....","##....","##....","##....","######"},
  M={"##...##","###.###","#######","##.#.##","##...##","##...##","##...##"},
  N={"##..##","###.##","######","##.###","##..##","##..##","##..##"},
  O={".####.","##..##","##..##","##..##","##..##","##..##",".####."},
  P={"#####.","##..##","##..##","#####.","##....","##....","##...."},
  Q={".####.","##..##","##..##","##..##","##.###","##..##",".###.#"},
  R={"#####.","##..##","##..##","#####.","##.##.","##..##","##..##"},
  S={".#####","##....","##....",".####.","....##","....##","#####."},
  T={"######","..##..","..##..","..##..","..##..","..##..","..##.."},
  U={"##..##","##..##","##..##","##..##","##..##","##..##",".####."},
  V={"##..##","##..##","##..##","##..##",".####.",".####.","..##.."},
  W={"##...##","##...##","##...##","##.#.##","#######","###.###","##...##"},
  X={"##..##","##..##",".####.","..##..",".####.","##..##","##..##"},
  Y={"##..##","##..##","##..##",".####.","..##..","..##..","..##.."},
  Z={"######","....##","...##.","..##..",".##...","##....","######"},
  ["0"]={".####.","##..##","##.###","######","###.##","##..##",".####."},
  ["1"]={".##.","###.",".##.",".##.",".##.",".##.","####"},
  ["2"]={".####.","##..##","....##","..###.",".##...","##....","######"},
  ["3"]={"#####.","....##","....##","..###.","....##","....##","#####."},
  ["4"]={"##..##","##..##","##..##","######","....##","....##","....##"},
  ["5"]={"######","##....","#####.","....##","....##","##..##",".####."},
  ["6"]={".####.","##....","##....","#####.","##..##","##..##",".####."},
  ["7"]={"######","....##","...##.","..##..","..##..","..##..","..##.."},
  ["8"]={".####.","##..##","##..##",".####.","##..##","##..##",".####."},
  ["9"]={".####.","##..##","##..##",".#####","....##","....##",".####."},
  ["."]={"..","..","..","..","..","##","##"},
  [","]={"..","..","..","..","..","##","#."},
  ["!"]={"##","##","##","##","##","..","##"},
  ["?"]={".####.","##..##","....##","..###.","..##..","......","..##.."},
  ["-"]={"....","....","....","####","....","....","...."},
  ["'"]={"##","##","#.","..","..","..",".."},
  [":"]={"..","##","##","..","##","##",".."},
  ["/"]={"....##","....##","...##.","..##..",".##...","##....","##...."},
  ["&"]={".###..","##.##.","##.##.",".###..","##.###","##..#.",".###.#"},
  ["("]={".##","##.","##.","##.","##.","##.",".##"},
  [")"]={"##.",".##",".##",".##",".##",".##","##."},
  ["+"]={"......","..##..","..##..","######","..##..","..##..","......"},
  ["_"]={"......","......","......","......","......","......","######"},
  ["#"]={".##.##.","#######",".##.##.",".##.##.",".##.##.","#######",".##.##."},
  ["@"]={".#####.","##...##","##.####","##.#.##","##.####","##.....",".#####."},
  [" "]={"...","...","...","...","...","...","..."},
}
A.CHROME_ORDER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,!?-':/&()+_#@ "
-- cool half MARBLE/VIOLET (light in both palettes); TEAL line above the horizon; INK horizon (big)
A.BANDS = {
  small = { MARBLE, MARBLE, {MARBLE,VIOLET}, VIOLET, TEAL, PINK, PINK, CORAL, {CORAL,AMBER}, AMBER },
  big   = { MARBLE, MARBLE, MARBLE, {MARBLE,VIOLET}, VIOLET, VIOLET, TEAL, INK,
            PINK, PINK, {PINK,CORAL}, CORAL, {CORAL,AMBER}, AMBER },
}
A.ROWMAP = { small = {1,1,2,3,4,4,5,6,7,7}, big = {1,1,2,2,3,3,4,4,5,5,6,6,7,7} }
A.COLMAP = { [2] = {2,1}, [3] = {2,1,1}, [4] = {1,2,1,1}, [6] = {2,1,1,1,1,2}, [7] = {2,1,1,1,1,1,2} }
A.GAP = { small = 1, big = 2 }
local BAYER = {{0,8,2,10},{12,4,14,6},{3,11,1,9},{15,7,13,5}}
local function dith(x, y, a, b) return (BAYER[y%4+1][x%4+1] + 0.5) < 8 and b or a end

-- glyph mask width in px for a char at a size
function A.chromeGlyphW(ch, size)
  local g = A.CHROME[ch]; local w = 0
  if size == "big" then for _, k in ipairs(A.COLMAP[#g[1]]) do w = w + k end else w = #g[1] end
  return w
end
-- paint a chrome word; glint = function(n, ch) -> bool (which letters get a sheen)
function A.chrome(x0, y0, s, size, glint)
  local rows, bands = A.ROWMAP[size], A.BANDS[size]
  local mask, starts = {}, {}
  local K = 8192
  local x = x0
  for n=1,#s do
    local ch = s:sub(n,n); local g = A.CHROME[ch] or A.CHROME["?"]
    local cm = size == "big" and A.COLMAP[#g[1]] or nil
    local cx = {}; local acc = 0
    for q=1,#g[1] do cx[q] = acc; acc = acc + (cm and cm[q] or 1) end
    starts[n] = x
    for r, src in ipairs(rows) do local row = g[src]
      for q=1,#row do if row:sub(q,q) == "#" then
        for k=0,(cm and cm[q] or 1)-1 do mask[(y0+r-1)*K + x+cx[q]+k] = r end
      end end
    end
    x = x + acc + A.GAP[size]
  end
  local ring = {}
  for key, _ in pairs(mask) do
    local mx, my = key % K, key // K
    for dy=-1,1 do for dx=-1,1 do
      local q = (my+dy)*K + mx+dx
      if not mask[q] then ring[q] = true end
    end end
  end
  for key, _ in pairs(ring) do
    local q = key + K + 1
    if not mask[q] and not ring[q] then px(q % K, q // K, INK) end
  end
  for key, _ in pairs(ring) do px(key % K, key // K, INK) end
  for key, r in pairs(mask) do
    local b = bands[r]; local mx, my = key % K, key // K
    if type(b) == "table" then b = dith(mx, my, b[1], b[2]) end
    px(mx, my, b)
  end
  local h = #rows
  for n=1,#s do
    local ch = s:sub(n,n)
    if ch ~= " " and (glint and glint(n, ch) or (not glint and n % 3 == 1)) then
      local gx = starts[n] + 2
      for k=0,(size == "big" and 3 or 2) do
        local key = (y0+h-2-k)*K + gx+k
        if mask[key] and mask[key] > h//2 then px(gx+k, y0+h-2-k, MARBLE) end
      end
    end
  end
  return x - x0 - A.GAP[size], starts
end

-- ---------------------------------------------------------------- export
function A.toImage(img, pal, z, bgSlot)
  z = z or 1
  local out = Image(img.w*z, img.h*z, ColorMode.RGB)
  local bg
  if bgSlot then local c = pal:getColor(bgSlot); bg = app.pixelColor.rgba(c.red, c.green, c.blue, 255)
  else bg = app.pixelColor.rgba(0, 0, 0, 0) end
  local cache = {}
  for i=0,15 do local c = pal:getColor(i); cache[i] = app.pixelColor.rgba(c.red, c.green, c.blue, 255) end
  for j=0,img.h-1 do for i=0,img.w-1 do
    local v = img.d[j*img.w + i + 1]
    local p = v and cache[v] or bg
    if z == 1 then out:drawPixel(i, j, p)
    else for q=0,z-1 do for o=0,z-1 do out:drawPixel(i*z+o, j*z+q, p) end end end
  end end
  return out
end
-- read an indexed .aseprite (P0 slots, 0 = transparent) into an index image
function A.load(path)
  local spr = Sprite{ fromFile = path }
  local im = Image(spr.width, spr.height, ColorMode.INDEXED); im:drawSprite(spr, 1)
  spr:close()
  local out = A.new(im.width, im.height)
  for j=0,im.height-1 do for i=0,im.width-1 do
    local v = im:getPixel(i, j); if v ~= 0 then out.d[j*out.w + i + 1] = v end
  end end
  return out
end

return A
