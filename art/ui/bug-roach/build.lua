-- BC-art roach build (Aseprite batch). Paint rules = art/ui/chips-a0/build.lua (INDEXED on the P0
-- dark palette, "art" layer = ASCII fill + 1px INK outline, "shadow" layer = INK hard shadow
-- +1 at 16 / +2 at 32, light = pure palette swap). One sprite per size with 3 frames
-- (idle, twitch1, twitch2) exported as a horizontal strip for .bug-btn (public/ui/bug-icon.json).
--   Aseprite.exe -b --script-param root=<repo> --script art/ui/bug-roach/build.lua
-- Writes: art/ui/bug-roach/bug-roach-<16|32>.aseprite, public/ui/bug-roach-<theme>{,@2x}.png
-- The A0 bugs chip (public/ui/chip-bugs-*) is the idle frame, built by art/ui/chips-a0/build.lua.
local root = app.params.root
local out = root.."/public/ui"
local L = dofile(root.."/art/cast/hypno/lib.lua")
local R = dofile(root.."/art/ui/bug-roach/roach.lua")
local pal = { dark = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" },
              light = Palette{ fromFile = root.."/art/palette/pc98-light.gpl" } }
local SHADOW = { [16] = 1, [32] = 2 }

local function dims(art)
  local w, h = 0, 0
  for row in art:gmatch("[^\n]+") do h = h + 1; w = math.max(w, #row) end
  return w, h
end

local function paintFrame(spr, lart, lsh, f, art, n)
  local d = SHADOW[n]
  local w, h = dims(art)
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
  for i, key in ipairs(R.ORDER) do
    if i > 1 then spr:newEmptyFrame() end
    spr.frames[i].duration = 0.12
    paintFrame(spr, lart, lsh, spr.frames[i], R[key][n], n)
  end
  spr:saveAs(root.."/art/ui/bug-roach/bug-roach-"..n..".aseprite")
  local flats = {}
  for i = 1, #R.ORDER do
    local im = Image(n, n, ColorMode.INDEXED); im:clear(0)
    im:drawSprite(spr, i)
    flats[i] = im
  end
  spr:close()
  for _, th in ipairs({ "dark", "light" }) do
    local o = Image(n * #R.ORDER, n, ColorMode.RGB); o:clear(0)
    for i, im in ipairs(flats) do toRGB(im, pal[th], o, (i - 1) * n) end
    o:saveAs(out.."/bug-roach-"..th..(n == 32 and "@2x" or "")..".png")
  end
end
print("ok")
