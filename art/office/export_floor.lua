-- S1v2 export (Contract v2 screens): floor.aseprite + roof.aseprite -> public/office/{floor,roof}-{dark,light}.png,
-- the front overlays {floor,roof}-front-{dark,light}.png (the "front" layer alone, same size as the
-- plate, index 0 = transparent) and floor.json (from the slices, "front": true).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/export_floor.lua
local root = app.params.root
local function layerImage(spr, name)
  local img = Image(spr.width, spr.height, ColorMode.INDEXED); img:clear(0)
  for _, l in ipairs(spr.layers) do
    if l.name == name then
      local cel = l:cel(1)
      if cel then img:drawImage(cel.image, cel.position) end
      return img
    end
  end
  return nil
end
local function write(img, w, h, name)
  for _, mode in ipairs({"dark", "light"}) do
    local out = Sprite(w, h, ColorMode.INDEXED)
    out:setPalette(Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" })
    out.transparentColor = 0
    out.cels[1].image = img
    out:saveAs(root.."/public/office/"..name.."-"..mode..".png"); out:close()
    print("wrote "..name.."-"..mode..".png "..w.."x"..h)
  end
end
local function plate(spr, name)
  local img = Image(spr.width, spr.height, ColorMode.INDEXED)
  img:clear(0); img:drawSprite(spr, 1)
  local zeros = 0
  for it in img:pixels() do if it() == 0 then zeros = zeros + 1 end end
  print(name.." transparent px: "..zeros)
  write(img, spr.width, spr.height, name)
  local fr = layerImage(spr, "front")
  if fr then write(fr, spr.width, spr.height, name.."-front") end
  return fr ~= nil
end

local spr = app.open(root.."/art/office/floor.aseprite")
assert(plate(spr, "floor"), "floor.aseprite has no front layer")
local S = {}
for _, s in ipairs(spr.slices) do S[s.name] = s.bounds end
local function R(n)
  local b = S[n]; assert(b, "missing slice "..n)
  return '{"x":'..b.x..',"y":'..b.y..',"w":'..b.width..',"h":'..b.height..'}'
end
local function team(t)
  local d = {}
  local i = 0
  while S[t..".desk"..i] do d[#d+1] = R(t..".desk"..i); i = i + 1 end
  -- statsTv (F4): the wall CRT's glass rect; optional for the parser, so only written when the slice exists
  return '{"lead":'..R(t..".lead")..',"buddyOffice":'..R(t..".buddyOffice")..
    ',"desks":['..table.concat(d, ",")..'],"lobby":'..R(t..".lobby")..
    (S[t..".statsTv"] and ',"statsTv":'..R(t..".statsTv") or '')..'}'
end
-- screens (Contract v2): the roof band is its own plate (public/office/roof-*.png); rects in ROOF-plate px.
-- riffbot/overlord = the CRT glass (one face cell from faces.json), elevatorTop = 32x32 sprite cell.
local roof = app.open(root.."/art/office/roof.aseprite")
local roofFront = plate(roof, "roof")
for _, s in ipairs(roof.slices) do S[s.name] = s.bounds end
local scr = '{"plate":"roof","w":'..roof.width..',"h":'..roof.height..
  (roofFront and ',"front":true' or '')..
  ',"riffbot":'..R("screens.riffbot")..',"overlord":'..R("screens.overlord")..
  ',"elevatorTop":'..R("screens.elevatorTop")..'}'
local json = '{"w":'..spr.width..',"h":'..spr.height..',"front":true,\n "teamA":'..team("teamA")..',\n "teamB":'..team("teamB")..
  ',\n "elevator":{"doorA":'..R("elevator.doorA")..',"doorB":'..R("elevator.doorB")..',"car":'..R("elevator.car")..'},'..
  '\n "screens":'..scr..'}\n'
local f = io.open(root.."/public/office/floor.json", "wb"); f:write(json); f:close()
print("wrote floor.json ("..#spr.slices.." slices)")
