-- MM1 main-marker build (Aseprite batch). Pipeline copied from art/ui/bug-roach/build.lua (INDEXED
-- on the P0 dark palette, "art" layer = ASCII fill + 1px INK outline, "shadow" layer = INK hard
-- shadow +1 at 16 / +2 at 32, light = pure palette swap). One sprite per size with 3 frames
-- (idle, blink0, blink1) exported as a horizontal strip (public/ui/main-marker.json).
-- Extra vs bug-roach: '_' gap rows in marker.lua are cleared on both layers after the outline and
-- shadow passes, so the googly eye floats free of the pin.
--   aseprite -b --script-param root=<repo> --script art/ui/main-marker/build.lua
-- Writes: art/ui/main-marker/main-marker-<16|32>.aseprite, public/ui/main-marker-<theme>{,@2x}.png
local root = app.params.root
local out = root.."/public/ui"
local L = dofile(root.."/art/cast/hypno/lib.lua")
local M = dofile(root.."/art/ui/main-marker/marker.lua")
local pal = { dark = Palette{ fromFile = root.."/"..M.PALETTE.dark },
              light = Palette{ fromFile = root.."/"..M.PALETTE.light } }
local KEY = { k = M.SLOTS.k, m = M.SLOTS.m, p = M.SLOTS.p, v = M.SLOTS.v }
local SHADOW = { [16] = 1, [32] = 2 }

local function dims(art)
  local w, h = 0, 0
  for row in art:gmatch("[^\n]+") do h = h + 1; w = math.max(w, #row) end
  return w, h
end

local function gapRows(art)
  local g, r = {}, 0
  for row in art:gmatch("[^\n]+") do
    if row:find("_", 1, true) then g[#g + 1] = r end
    r = r + 1
  end
  return g
end

local function clearRows(C, rows, y0)
  for _, r in ipairs(rows) do C.hline(0, y0 + r, C.w, 0) end
end

local function paintFrame(spr, lart, lsh, f, art, n)
  local d = SHADOW[n]
  local w, h = dims(art)
  local x0 = (n - (w + 2 + d)) // 2 + 1
  local y0 = (n - (h + 2 + d)) // 2 + 1
  local gaps = gapRows(art)
  local A = L.canvas(spr, lart, f)
  A.stamp(x0, y0, art:gsub("_", "."), KEY)
  A.outline(L.INK)
  clearRows(A, gaps, y0)
  local S = L.canvas(spr, lsh, f)
  for y=0,n-1 do for x=0,n-1 do
    if A.get(x, y) ~= 0 then
      for i=1,d do if A.get(x+i, y+i) == 0 then S.px(x+i, y+i, L.INK) end end
    end
  end end
  clearRows(S, gaps, y0)
  A.commit(); S.commit()
end

local function toRGB(img, p, o, ox)
  for y=0,img.height-1 do for x=0,img.width-1 do
    local i = img:getPixel(x, y)
    if i ~= 0 then
      local c = p:getColor(i)
      o:drawPixel(ox + x, y, app.pixelColor.rgba(c.red, c.green, c.blue, 255))
    end
  end end
end

for _, n in ipairs({ 16, 32 }) do
  local spr = L.new(n, n, pal.dark)
  local lart = L.layer(spr, "art")
  local lsh = L.layer(spr, "shadow")
  lsh.stackIndex = 1
  for i, key in ipairs(M.ORDER) do
    if i > 1 then spr:newEmptyFrame() end
    spr.frames[i].duration = 0.1
    paintFrame(spr, lart, lsh, spr.frames[i], M[key][n], n)
  end
  spr:saveAs(root.."/art/ui/main-marker/main-marker-"..n..".aseprite")
  local flats = {}
  for i = 1, #M.ORDER do
    local im = Image(n, n, ColorMode.INDEXED); im:clear(0)
    im:drawSprite(spr, i)
    flats[i] = im
  end
  spr:close()
  for _, th in ipairs({ "dark", "light" }) do
    local o = Image(n * #M.ORDER, n, ColorMode.RGB); o:clear(0)
    for i, im in ipairs(flats) do toRGB(im, pal[th], o, (i - 1) * n) end
    o:saveAs(out.."/main-marker-"..th..(n == 32 and "@2x" or "")..".png")
  end
end
print("ok")
