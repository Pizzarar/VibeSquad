-- Contract v2 bust variants: art/cast/hypno/<role>-bust-v{1,2,3}.aseprite (64x64, layered) from the
-- base <role>-bust.aseprite (= v0), using the same hand-picked spec as the floor cast
-- (art/cast/hypno/variants.lua), so bust column v and floor variant v are the same person.
-- Per layer: head/face = head map; hair = hair mass recolour + head map; body = outfit (+ skin on
-- necks/forearms); prop = prop map (+ skin on fists); fx untouched. The accessory gets its own layer
-- ("acc"): neck pieces sit under the head, hats/bows above the hair. A hat that would poke out of
-- the top shifts the whole bust down (the body crops at the bottom, as busts do).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/cast/hypno/build_variants.lua
local root = app.params.root
local dir = root.."/art/cast/hypno/"
local L = dofile(dir.."lib.lua")
local VAR = dofile(dir.."variants.lua")
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local ROLES = { "lead", "buddy", "implement", "review", "retired-lead", "mechanical", "audit", "spec", "art", "unknown" }
local CELL = 64
local ORDER = { "body", "head", "hair", "face", "prop", "fx" }

local function full(cel)
  local img = Image(CELL, CELL, ColorMode.INDEXED); img:clear(0)
  if cel then img:drawImage(cel.image, cel.position) end
  return img
end
local function union(a, b)
  local o = a:clone()
  for y=0,CELL-1 do for x=0,CELL-1 do local v = b:getPixel(x, y); if v ~= 0 then o:drawPixel(x, y, v) end end end
  return o
end

for _, role in ipairs(ROLES) do
  local base = app.open(dir..role.."-bust.aseprite")
  local src = {}
  for _, l in ipairs(base.layers) do src[l.name] = full(l:cel(1)) end
  base:close()
  for v=1,3 do
    local s = VAR.roles[role][v]
    local img = {}
    for _, n in ipairs(ORDER) do img[n] = (src[n] or Image(CELL, CELL, ColorMode.INDEXED)):clone() end
    VAR.remap(img.head, s.head); VAR.remap(img.face, s.head)
    VAR.hair(img.hair, s.hair); VAR.remap(img.hair, s.head)
    VAR.remap(img.body, VAR.handMap(role, v, s.body))
    local pm = VAR.handMap(role, v, s.body); for k, t in pairs(s.prop or {}) do pm[k] = t end
    VAR.remap(img.prop, pm)
    -- accessory, anchored on head+hair
    local a = VAR.ACC[s.acc[1]]
    local w, h = VAR.size(a.b)
    local hh = union(img.head, img.hair)
    local an = VAR.anchor(hh, s.acc.bdrop or 7)
    local hx0, hy0, hx1 = VAR.bbox(img.head)
    local _, _, _, hy1 = VAR.bbox(img.head)
    local n = s.acc.b or {0, 0}
    local x, y
    if a.kind == "top" then
      x = math.floor((an[1] + an[3] + 1)/2 - w/2 + 0.5); y = an[2] - h + (a.bsink or 0)
    elseif a.kind == "side" then
      x = an.sx - w//2; y = an.sy - h//2
    else
      x = math.floor((hx0 + hx1 + 1)/2 - w/2 + 0.5); y = hy1 - 1
    end
    x, y = x + n[1], y + n[2]
    local shift = math.max(0, 1 - y)
    local spr = L.new(CELL, CELL, pal)
    local accC
    local function put(name, im)
      local layer = L.layer(spr, name)
      local C = L.canvas(spr, layer, spr.frames[1])
      if im then C.img:drawImage(im, Point(0, shift)) end
      return C
    end
    for _, nme in ipairs(ORDER) do
      if nme == "head" and a.kind == "neck" then accC = put("acc") end
      put(nme, img[nme]).commit()
      if nme == "hair" and a.kind ~= "neck" then accC = put("acc") end
      if accC and not accC.done then
        VAR.drawAcc(L, accC, a.b, x, y + shift, s.acc); accC.commit(); accC.done = true
      end
    end
    spr:saveAs(dir..role.."-bust-v"..v..".aseprite"); spr:close()
  end
  print("busts "..role.." v1-v3")
end
