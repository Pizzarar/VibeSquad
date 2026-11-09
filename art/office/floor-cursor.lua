-- FS-b keyboard-focus selector: a small RPG menu cursor that points down at a floor worker's head
-- (docs/PLAN_FLOOR_SELECT.md). H0 hand: flat P0 fills, 1px INK outline, MARBLE top highlight, CORAL
-- shade on the lower-right edge, AMBER face. No googly prop. Floor native scale (cast cell = 48 art px, FF).
--   f0 up: arrow at the top of the cell     f1 down: the same arrow 2px lower (the bob)
-- FF (docs/PLAN_FLOOR_FACES.md): redrawn for the 48px heads, cell 13x12 (was 9x8), 1px INK outline kept.
-- Cell 13x12, transparent (index 0). Tip = INK pixel (6,9) on f0, (6,11) on f1.
-- Writes public/office/floor-cursor-{dark,light}.png + art/office/floor-cursor.aseprite
-- (json by node: art/office/floor-cursor-json.mjs).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/floor-cursor.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local K, M, C_, A = 15, 4, 10, 11
local FW, FH, N, BOB = 13, 12, 2, 2

-- rows of the arrow, top to bottom: K ink, M marble, A amber, C coral, . clear
local ART = {
  "KKKKKKKKKKKKK",
  "KMMMMMMMMMMMK",
  "KMAAAAAAAAACK",
  "KAAAAAAAAAACK",
  ".KAAAAAAAACK.",
  "..KAAAAAACK..",
  "...KAAAACK...",
  "....KAACK....",
  ".....KCK.....",
  "......K......",
}
local MAP = { K = K, M = M, A = A, C = C_ }

local function arrow(C, dy)
  for y, row in ipairs(ART) do
    for x = 1, #row do
      local c = MAP[row:sub(x, x)]
      if c then C.px(x - 1, y - 1 + dy, c) end
    end
  end
end

local spr = L.new(FW, FH, pal)
for i = 2, N do spr:newFrame() end
local lay = L.layer(spr, "cursor")
local strip = Image(FW * N, FH, ColorMode.INDEXED); strip:clear(0)
for i = 1, N do
  local C = L.canvas(spr, lay, spr.frames[i])
  arrow(C, (i - 1) * BOB); C.commit()
  strip:drawImage(C.img, Point((i - 1) * FW, 0))
end
spr:saveAs(root.."/art/office/floor-cursor.aseprite"); spr:close()
for _, mode in ipairs({"dark", "light"}) do
  local out = Sprite(FW * N, FH, ColorMode.INDEXED)
  out:setPalette(Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" })
  out.transparentColor = 0
  out.cels[1].image = strip
  out:saveAs(root.."/public/office/floor-cursor-"..mode..".png"); out:close()
end
print("wrote floor-cursor "..N.." frames")
