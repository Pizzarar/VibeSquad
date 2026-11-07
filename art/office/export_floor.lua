-- S1 export: floor.aseprite -> public/office/floor-{dark,light}.png + floor.json (from the slices).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/export_floor.lua
local root = app.params.root
local spr = app.open(root.."/art/office/floor.aseprite")
local img = Image(spr.width, spr.height, ColorMode.INDEXED)
img:clear(0); img:drawSprite(spr, 1)
local zeros = 0
for it in img:pixels() do if it() == 0 then zeros = zeros + 1 end end
print("transparent px: "..zeros)
for _, mode in ipairs({"dark", "light"}) do
  local out = Sprite(spr.width, spr.height, ColorMode.INDEXED)
  out:setPalette(Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" })
  out.transparentColor = 0
  out.cels[1].image = img
  out:saveAs(root.."/public/office/floor-"..mode..".png"); out:close()
  print("wrote floor-"..mode..".png "..spr.width.."x"..spr.height)
end
local S = {}
for _, s in ipairs(spr.slices) do S[s.name] = s.bounds end
local function R(n)
  local b = S[n]; assert(b, "missing slice "..n)
  return '{"x":'..b.x..',"y":'..b.y..',"w":'..b.width..',"h":'..b.height..'}'
end
local function team(t)
  local d = {}
  for i=0,5 do d[#d+1] = R(t..".desk"..i) end
  return '{"lead":'..R(t..".lead")..',"buddyOffice":'..R(t..".buddyOffice")..
    ',"desks":['..table.concat(d, ",")..'],"lobby":'..R(t..".lobby")..'}'
end
-- penthouse: its own plate (public/office/roof-*.png); its rects are in ROOF-plate px
local roof = app.open(root.."/art/office/roof.aseprite")
local rimg = Image(roof.width, roof.height, ColorMode.INDEXED)
rimg:clear(0); rimg:drawSprite(roof, 1)
for _, mode in ipairs({"dark", "light"}) do
  local out = Sprite(roof.width, roof.height, ColorMode.INDEXED)
  out:setPalette(Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" })
  out.transparentColor = 0
  out.cels[1].image = rimg
  out:saveAs(root.."/public/office/roof-"..mode..".png"); out:close()
  print("wrote roof-"..mode..".png "..roof.width.."x"..roof.height)
end
for _, s in ipairs(roof.slices) do S[s.name] = s.bounds end
local pent = '{"plate":"roof","w":'..roof.width..',"h":'..roof.height..
  ',"riffbot":{"seat":'..R("penthouse.riffbot.seat")..',"lounge":'..R("penthouse.riffbot.lounge")..'}'..
  ',"overlord":{"seat":'..R("penthouse.overlord.seat")..',"crtWall":'..R("penthouse.overlord.crtWall")..'}'..
  ',"elevatorTop":'..R("penthouse.elevatorTop")..'}'
local json = '{"w":'..spr.width..',"h":'..spr.height..',\n "teamA":'..team("teamA")..',\n "teamB":'..team("teamB")..
  ',\n "elevator":{"doorA":'..R("elevator.doorA")..',"doorB":'..R("elevator.doorB")..',"car":'..R("elevator.car")..'},'..
  '\n "penthouse":'..pent..'}\n'
local f = io.open(root.."/public/office/floor.json", "wb"); f:write(json); f:close()
print("wrote floor.json ("..#spr.slices.." slices)")
