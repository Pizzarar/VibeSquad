-- S2b-2 shipping export (Aseprite batch): same paint rules as build.lua (INDEXED P0 dark,
-- 1px INK outline outside every shape, INK hard shadow +1 at 16 / +2 at 32, pure palette swap
-- for light) on icons-big.lua. 16 = native (icon-<name>-<theme>.png), 32 = @2x master.
--   Aseprite.exe -b --script-param root=<repo> --script art/ui/icons-s2b/build-big.lua
-- Writes: art/ui/icons-s2b/icon-<name>-<16|32>.aseprite, public/ui/icon-<name>-<theme>{,@2x}.png
local root = app.params.root
local out = root.."/public/ui"
local L = dofile(root.."/art/cast/hypno/lib.lua")
local I = dofile(root.."/art/ui/icons-s2b/icons-big.lua")
local pal = { dark = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" },
              light = Palette{ fromFile = root.."/art/palette/pc98-light.gpl" } }
local SHADOW = { [16] = 1, [32] = 2 }

local function dims(art)
  local w, h = 0, 0
  for row in art:gmatch("[^\n]+") do h = h + 1; w = math.max(w, #row) end
  return w, h
end

local function paint(art, n)
  local d = SHADOW[n]
  local spr = L.new(n, n, pal.dark)
  local lart = L.layer(spr, "art")
  local lsh = L.layer(spr, "shadow")
  lsh.stackIndex = 1
  local f = spr.frames[1]
  local w, h = dims(art)
  -- footprint = fill + 1px outline each side + shadow; centre it in the cell
  local x0 = (n - (w + 2 + d)) // 2 + 1
  local y0 = (n - (h + 2 + d)) // 2 + 1
  local A = L.canvas(spr, lart, f)
  A.stamp(x0, y0, art)
  A.outline(L.INK)
  local S = L.canvas(spr, lsh, f)
  for y=0,n-1 do for x=0,n-1 do
    if A.get(x, y) ~= 0 then
      for i=1,d do if A.get(x+i, y+i) == 0 then S.px(x+i, y+i, L.INK) end end
    end
  end end
  A.commit(); S.commit()
  return spr
end

local function toRGB(img, p)
  local o = Image(img.width, img.height, ColorMode.RGB)
  o:clear(0)
  for y=0,img.height-1 do for x=0,img.width-1 do
    local i = img:getPixel(x, y)
    if i ~= 0 then
      local c = p:getColor(i)
      o:drawPixel(x, y, app.pixelColor.rgba(c.red, c.green, c.blue, 255))
    end
  end end
  return o
end

for _, name in ipairs(I.ORDER) do
  for _, n in ipairs({ 16, 32 }) do
    local spr = paint(I[name][n], n)
    spr:saveAs(root.."/art/ui/icons-s2b/icon-"..name.."-"..n..".aseprite")
    local flat = Image(spr)
    spr:close()
    for _, th in ipairs({ "dark", "light" }) do
      toRGB(flat, pal[th]):saveAs(out.."/icon-"..name.."-"..th..(n == 32 and "@2x" or "")..".png")
    end
  end
end
print("ok")
