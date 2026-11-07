-- S1 stretch build: art/cast/hypno/<role>-bust.aseprite (64x64) for the 6 extra roles, plus flat
-- PNGs of all 10 busts (dark/light) under scratch/s1-busts/ for the gallery.
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/cast/hypno/build_extra.lua
local root = app.params.root
local dir = root.."/art/cast/hypno/"
local L = dofile(dir.."lib.lua")
local B = dofile(dir.."bust_extra.lua")
local pal = { dark = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" },
              light = Palette{ fromFile = root.."/art/palette/pc98-light.gpl" } }
local EXTRA = { "retired-lead", "mechanical", "audit", "spec", "art", "unknown" }
local ALL = { "lead", "buddy", "implement", "review", "retired-lead", "mechanical", "audit", "spec", "art", "unknown" }
for _, r in ipairs(EXTRA) do
  local spr = L.new(64, 64, pal.dark)
  B.draw(L, spr, r)
  spr:saveAs(dir..r.."-bust.aseprite"); spr:close()
end
os.execute('mkdir "'..root:gsub("/", "\\")..'\\scratch\\s1-busts" 2>nul')
for _, r in ipairs(ALL) do
  local spr = app.open(dir..r.."-bust.aseprite")
  local img = Image(64, 64, ColorMode.INDEXED); img:clear(0); img:drawSprite(spr, 1)
  spr:close()
  for _, mode in ipairs({"dark", "light"}) do
    local o = Sprite(64, 64, ColorMode.INDEXED); o:setPalette(pal[mode]); o.transparentColor = 0
    o.cels[1].image = img
    o:saveAs(root.."/scratch/s1-busts/"..r.."-"..mode..".png"); o:close()
  end
end
print("busts ok")
