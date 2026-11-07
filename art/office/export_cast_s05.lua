-- S0.5 provisional cast export (H0 sprites only, 4 roles), pinned contract shape.
-- Writes public/office/cast-{dark,light}.png + cast.json. S1 (export_cast.lua) overwrites
-- these with the full frame set; the json shape stays the same.
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/export_cast_s05.lua
local root = app.params.root
local hyp = root.."/art/cast/hypno/"
local L = dofile(hyp.."lib.lua")
local pal = { dark = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" },
              light = Palette{ fromFile = root.."/art/palette/pc98-light.gpl" } }
local ROLES = { "lead", "buddy", "implement", "review" }
local CELL = 32

local function flat(spr, frame)
  local img = Image(spr.width, spr.height, ColorMode.INDEXED)
  img:clear(0); img:drawSprite(spr, frame)
  return img
end

-- sheet: one row per role; col 0 = working (H0 frame 1), col 1 = needs-you (H0 frame 2)
-- bubble on the last row
local W, H = CELL*2, CELL*(#ROLES+1)
local sheet = L.new(W, H, pal.dark)
local C = L.canvas(sheet, sheet.layers[1], sheet.frames[1])
local cells = {}
for r, role in ipairs(ROLES) do
  local spr = app.open(hyp..role.."-floor.aseprite")
  local y = (r-1)*CELL
  C.img:drawImage(flat(spr, 1), Point(0, y))
  C.img:drawImage(flat(spr, 2), Point(CELL, y))
  spr:close()
  cells[role] = { work = {{0,y},{0,y}}, needs = {{CELL,y},{CELL,y}}, idle = {{0,y}}, ride = {{CELL,y}} }
end
-- "!" bubble (same art as the H0 needs-you bubble): pink, INK rim, MARBLE "!", tail down-right
local BX, BY, BW, BH = 0, CELL*#ROLES, 10, 11
C.stamp(BX, BY, [[
|.kkkkkkkk.|
|kppppmpppk|
|kpppmmmppk|
|kpppmmmppk|
|kppppmpppk|
|kppppmpppk|
|kppppppppk|
|kppppmpppk|
|.kkkkkpkk.|
|......pk..|
|.......k..|
]])
C.commit()

local flatSheet = flat(sheet, 1)
for _, mode in ipairs({"dark", "light"}) do
  local out = Sprite(W, H, ColorMode.INDEXED)
  out:setPalette(pal[mode]); out.transparentColor = 0
  out.cels[1].image = flatSheet
  local path = root.."/public/office/cast-"..mode..".png"
  out:saveAs(path); out:close()
  print("wrote "..path.." "..W.."x"..H)
end
sheet:close()

-- cast.json (hand-ordered writer so diffs stay stable)
local function xy(t) local s = {} for _, p in ipairs(t) do s[#s+1] = '{"x":'..p[1]..',"y":'..p[2]..'}' end return "["..table.concat(s, ",").."]" end
local parts = {}
for _, role in ipairs(ROLES) do
  local c = cells[role]
  parts[#parts+1] = '    "'..role..'":{"work":'..xy(c.work)..',"needs":'..xy(c.needs)..',"idle":'..xy(c.idle)..',"ride":'..xy(c.ride)..'}'
end
-- bubble offset = bubble top-left relative to the sprite anchor (cell bottom-centre),
-- which puts it top-left of the head like the H0 needs-you pose
local json = '{\n  "version":1,\n  "cell":32,\n  "anchor":"bottom-centre",\n  "roles":{\n'..table.concat(parts, ",\n")..
  '\n  },\n  "bubble":{"x":'..BX..',"y":'..BY..',"w":'..BW..',"h":'..BH..',"offset":{"x":-16,"y":-32}},\n'..
  '  "fallback":{"spec":"review","audit":"review","art":"implement","mechanical":"implement","retired-lead":"lead","unknown":"buddy"}\n}\n'
local f = io.open(root.."/public/office/cast.json", "w"); f:write(json); f:close()
print("wrote cast.json")
