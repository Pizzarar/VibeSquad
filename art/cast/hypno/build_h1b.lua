-- H1b busts: art/cast/hypno/<role>-bust-v{1,2,3}.aseprite (rest = the app icon, read by
-- scripts/build-cast-hypno.mjs) and <role>-bust-v{1,2,3}-yo.aseprite (needs-you, gallery only).
-- Each is the role's own H0 body (and held prop) from <role>-bust.aseprite with a new head from h1b.lua.
-- Run: Aseprite.exe -b --script-param root=<repo> [--script-param only=<role>] --script art/cast/hypno/build_h1b.lua
local root = app.params.root
local dir = root.."/art/cast/hypno/"
local L = dofile(dir.."lib.lua")
local D = dofile(dir.."h1b.lua")(L)
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local ROLES = { "lead", "retired-lead", "buddy", "implement", "mechanical", "review", "audit", "spec", "art", "unknown" }
-- the H0 prop layer holds the role's held object; buddy's is the headphones and implement's the TV
-- antennae, which belong to the H0 head, so those roles take no prop
local NOPROP = { buddy = true, implement = true }

local function copy(base, from, spr, to)
  for _, l in ipairs(base.layers) do
    if l.name == from and l:cel(1) then
      local c = l:cel(1)
      spr:newCel(L.layer(spr, to), spr.frames[1], c.image:clone(), c.position)
    end
  end
end

local function bust(role, v, mood)
  local spr = L.new(64, 64, pal)
  local base = app.open(dir..role.."-bust.aseprite")
  copy(base, "body", spr, "body")
  local C = {}
  for _, n in ipairs({"arm", "head", "hair", "face", "mouth"}) do C[n] = L.canvas(spr, L.layer(spr, n), spr.frames[1]) end
  if not NOPROP[role] then copy(base, "prop", spr, "prop0") end
  if mood == "rest" then copy(base, "fx", spr, "fx0") end
  for _, n in ipairs({"prop", "fx", "bubble"}) do C[n] = L.canvas(spr, L.layer(spr, n), spr.frames[1]) end
  base:close()
  local d = D[role][v]
  d.bust(C, mood, role)
  if mood == "yo" then D.yoExtras(C, role, d.bub) end
  for _, c in pairs(C) do c.commit() end
  spr:saveAs(dir..role.."-bust-v"..v..(mood == "yo" and "-yo" or "")..".aseprite")
  spr:close()
end

for _, role in ipairs(ROLES) do
  if (not app.params.only or app.params.only == role) and D[role] then
    for v=1,3 do if D[role][v] then bust(role, v, "rest"); bust(role, v, "yo") end end
    print("busts "..role)
  end
end
