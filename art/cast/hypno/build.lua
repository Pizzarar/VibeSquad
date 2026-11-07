-- H0 build: writes art/cast/hypno/<role>-floor.aseprite (32x32, frame 1 working, frame 2
-- needs-you) and <role>-bust.aseprite (64x64), then the labelled sheets.
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/cast/hypno/build.lua
local root = app.params.root
local dir = root.."/art/cast/hypno/"
local L = dofile(dir.."lib.lua")
local P = dofile(dir.."floor.lua")
local F = dofile(dir.."front.lua")
local B = dofile(dir.."bust.lua")
local pal = { dark = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" },
              light = Palette{ fromFile = root.."/art/palette/pc98-light.gpl" } }
local ROLES = { "lead", "buddy", "implement", "review" }

local function stampAll(C, parts)
  for _, p in ipairs(parts) do if p then C.stamp(p[1], p[2], p[3]) end end
end

local function floorSprite(role)
  local spr = L.new(32, 32, pal.dark)
  spr:newFrame()
  local names = { "desk", "chair-behind", "body", "chair-over", "head", "fx" }
  local lay = {}
  for _, n in ipairs(names) do lay[n] = L.layer(spr, n) end
  -- frame 1: WORKING (back of head)
  local f = spr.frames[1]
  local C = L.canvas(spr, lay.desk, f); stampAll(C, P.desk); C.flipH(); C.commit()
  C = L.canvas(spr, lay.body, f); C.stamp(table.unpack(P.bodyBack[role])); C.flipH(); C.commit()
  C = L.canvas(spr, lay["chair-over"], f); C.stamp(table.unpack(P.chairBack)); C.flipH(); C.commit()
  C = L.canvas(spr, lay.head, f)
  C.stamp(table.unpack(P.headBack[role]))
  if P.earsBack[role] then C.stamp(table.unpack(P.earsBack[role])) end
  if P.earsBackR[role] then C.stamp(table.unpack(P.earsBackR[role])) end
  if role == "buddy" then stampAll(C, P.phonesBack) end
  if role == "review" or role == "implement" then C.rim(L.VIOLET, 16) end
  C.flipH(); C.commit()
  C = L.canvas(spr, lay.fx, f)
  if P.propBack[role] then C.stamp(table.unpack(P.propBack[role])) end
  C.flipH(); C.commit()
  -- (frame 1 is drawn CRT-left and mirrored as a whole so the glow sits on the right)
  -- frame 2: NEEDS-YOU (turned round)
  f = spr.frames[2]
  C = L.canvas(spr, lay.desk, f); stampAll(C, P.desk); C.flipH(); C.commit()
  C = L.canvas(spr, lay["chair-behind"], f); C.stamp(table.unpack(P.chairFront)); C.commit()
  C = L.canvas(spr, lay.body, f); C.stamp(table.unpack(F.body[role])); C.commit()
  C = L.canvas(spr, lay.head, f); stampAll(C, F.head[role])
  if role == "review" or role == "implement" then C.rim(L.VIOLET, 10) end
  C.commit()
  C = L.canvas(spr, lay.fx, f); stampAll(C, F.fx[role]); C.commit()
  return spr
end

local function bustSprite(role)
  local spr = L.new(64, 64, pal.dark)
  B.draw(L, spr, role)
  return spr
end

-- flatten a sprite frame to an indexed image
local function flat(spr, frame)
  local img = Image(spr.width, spr.height, ColorMode.INDEXED)
  img:clear(0)
  img:drawSprite(spr, frame)
  return img
end

local out = { floor = {}, bust = {} }
for _, r in ipairs(ROLES) do
  local s = floorSprite(r)
  s:saveAs(dir..r.."-floor.aseprite")
  out.floor[r] = { flat(s, 1), flat(s, 2) }
  local b = bustSprite(r)
  b:saveAs(dir..r.."-bust.aseprite")
  out.bust[r] = flat(b, 1)
end

dofile(dir.."sheet.lua")(L, root, pal, ROLES, out)
