-- C2a reference: flattens the H0 stalk-eye alien (review-bust 64px, review-floor both frames)
-- to scratch/c2a/alien-{bust,floor1,floor2}-{dark,light}.png for the face comparison shot.
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/export_alien_ref.lua
local root = app.params.root
local src = { bust = {"review-bust", 1}, floor1 = {"review-floor", 1}, floor2 = {"review-floor", 2} }
for key, s in pairs(src) do
  local spr = app.open(root.."/art/cast/hypno/"..s[1]..".aseprite")
  local img = Image(spr.width, spr.height, ColorMode.INDEXED); img:clear(0)
  img:drawSprite(spr, s[2])
  for _, mode in ipairs({"dark", "light"}) do
    local out = Sprite(spr.width, spr.height, ColorMode.INDEXED)
    out:setPalette(Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" })
    out.transparentColor = 0
    out.cels[1].image = img
    out:saveAs(root.."/scratch/c2a/alien-"..key.."-"..mode..".png"); out:close()
  end
  spr:close()
end
print("ok")
