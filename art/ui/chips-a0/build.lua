-- A0 chip icons build (Aseprite batch). Same paint rules as art/ui/icons-s2b/build-big.lua:
-- INDEXED sprite on the P0 dark palette, "art" layer = ASCII fill + 1px INK outline outside
-- every shape, "shadow" layer below = INK hard shadow (+1 at 16, +2 at 32), light = pure
-- palette swap. 16 = native (chip-<name>-<theme>.png), 32 = @2x master.
--   Aseprite.exe -b --script-param root=<repo> --script art/ui/chips-a0/build.lua
-- Writes: art/ui/chips-a0/chip-<name>-<16|32>.aseprite, public/ui/chip-<name>-<theme>{,@2x}.png
local root = app.params.root
local out = root.."/public/ui"
local L = dofile(root.."/art/cast/hypno/lib.lua")
local C = dofile(root.."/art/ui/chips-a0/chips.lua")
local pal = { dark = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" },
              light = Palette{ fromFile = root.."/art/palette/pc98-light.gpl" } }
local SHADOW = { [16] = 1, [32] = 2 }

local function dims(art)
  local w, h = 0, 0
  for row in art:gmatch("[^\n]+") do h = h + 1; w = math.max(w, #row) end
  return w, h
end

local function paint(entry, n)
  local d = SHADOW[n]
  local spr = L.new(n, n, pal.dark)
  local lart = L.layer(spr, "art")
  local lsh = L.layer(spr, "shadow")
  lsh.stackIndex = 1
  local f = spr.frames[1]
  local art, x0, y0 = entry, nil, nil
  if type(entry) == "table" then art, x0, y0 = entry[1], entry[2], entry[3] end
  if not x0 then
    -- footprint = fill + 1px outline each side + shadow; centre it in the cell
    local w, h = dims(art)
    x0 = (n - (w + 2 + d)) // 2 + 1
    y0 = (n - (h + 2 + d)) // 2 + 1
  end
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

for _, name in ipairs(C.ORDER) do
  for _, n in ipairs({ 16, 32 }) do
    local spr = paint(C[name][n], n)
    spr:saveAs(root.."/art/ui/chips-a0/chip-"..name.."-"..n..".aseprite")
    local flat = Image(spr)
    spr:close()
    for _, th in ipairs({ "dark", "light" }) do
      toRGB(flat, pal[th]):saveAs(out.."/chip-"..name.."-"..th..(n == 32 and "@2x" or "")..".png")
    end
  end
end
print("ok")
