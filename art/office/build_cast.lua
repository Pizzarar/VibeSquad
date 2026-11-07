-- S1 cast sheet: public/office/cast-{dark,light}.png + cast.json (pinned contract shape) and
-- art/office/cast.aseprite. Built from the H0 part maps (art/cast/hypno/{floor,front}.lua) plus
-- any extra roles in art/cast/hypno/extra.lua. The plate draws the desks, so sprites carry
-- only the chair + character. Rows = roles; cols = work0 work1 needs0 needs1 idle ride.
--   work : back of head; frame 2 bobs the head 1px (typing)
--   needs: turned round, hand up; frame 2 sways the hand 1px (wave). No baked bubble.
--   idle : standing (lobby queue)      ride: standing in the car, humming lift music
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/build_cast.lua
local root = app.params.root
local hyp = root.."/art/cast/hypno/"
local L = dofile(hyp.."lib.lua")
local P = dofile(hyp.."floor.lua")
local F = dofile(hyp.."front.lua")
local X = io.open(hyp.."extra.lua") and dofile(hyp.."extra.lua")(L, P, F) or nil
local pal = { dark = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" },
              light = Palette{ fromFile = root.."/art/palette/pc98-light.gpl" } }
local CELL = 32
local ROLES = { "lead", "buddy", "implement", "review" }
if X then for _, r in ipairs(X.roles) do ROLES[#ROLES+1] = r end end
local ALL = { "lead", "buddy", "implement", "review", "retired-lead", "mechanical", "audit", "spec", "art", "unknown" }
local FALLBACK = { spec="review", audit="review", art="implement", mechanical="implement", ["retired-lead"]="lead", unknown="buddy" }
-- standing: how far the head/torso move up, and the trouser slot
local STAND = { lead = {3, L.PINK}, buddy = {3, L.VIOLET}, implement = {1, L.VIOLET}, review = {0, L.MINT} }
if X then for r, v in pairs(X.stand) do STAND[r] = v end end

local tmp = Sprite(CELL, CELL, ColorMode.INDEXED); tmp:setPalette(pal.dark); tmp.transparentColor = 0
local function canvas() return L.canvas(tmp, tmp.layers[1], tmp.frames[1]) end
local function blank() local i = Image(CELL, CELL, ColorMode.INDEXED); i:clear(0); return i end
local function over(dst, src, dx, dy)
  for y=0,CELL-1 do for x=0,CELL-1 do
    local v = src:getPixel(x, y)
    local tx, ty = x + (dx or 0), y + (dy or 0)
    if v ~= 0 and tx >= 0 and ty >= 0 and tx < CELL and ty < CELL then dst:drawPixel(tx, ty, v) end
  end end
end
local function flip(img)
  local o = blank()
  for y=0,CELL-1 do for x=0,CELL-1 do o:drawPixel(CELL-1-x, y, img:getPixel(x, y)) end end
  return o
end
local function st(C, part, dx, dy) if part then C.stamp(part[1] + (dx or 0), part[2] + (dy or 0), part[3]) end end
local function firstRows(map, n)
  local out, i = {}, 0
  for row in map:gmatch("[^\n]+") do i = i + 1; if i <= n then out[#out+1] = row end end
  return table.concat(out, "\n")
end
local RIM = { review = true, implement = true }
local RIM_TOP = { implement = 7 } -- TV-head: keep the antenna rods INK
local function rim(C, role, ymax, lift)
  local y0 = math.max(0, (RIM_TOP[role] or 0) - (lift or 0))
  local set = {}
  for y=y0,ymax-1 do for x=0,CELL-1 do
    if C.img:getPixel(x, y) == L.INK and C.get(x, y-1) == 0 then set[#set+1] = {x, y} end
  end end
  for _, q in ipairs(set) do C.img:drawPixel(q[1], q[2], L.VIOLET) end
end

-- part tables (H0 + extra)
local PB = { body = P.bodyBack, head = P.headBack, prop = P.propBack, ears = P.earsBack, earsR = P.earsBackR }
local FB = { body = F.body, head = F.head, fx = F.fx }
if X then
  for k, t in pairs(X.back) do for r, v in pairs(t) do PB[k][r] = v end end
  for k, t in pairs(X.front) do for r, v in pairs(t) do FB[k][r] = v end end
end

local function work(role, bob)
  local out = blank()
  local C = canvas(); st(C, PB.body[role]); over(out, C.img)
  C = canvas(); st(C, P.chairBack); over(out, C.img)
  C = canvas(); st(C, PB.head[role]); st(C, PB.ears[role]); st(C, PB.earsR[role])
  if role == "buddy" then for _, p in ipairs(P.phonesBack) do st(C, p) end end
  if X and X.backExtra[role] then for _, p in ipairs(X.backExtra[role]) do st(C, p) end end
  if RIM[role] then rim(C, role, 16) end
  if role == "implement" and bob == 0 then C.px(14, 20, L.INK); C.px(15, 20, L.INK) end
  over(out, C.img, 0, bob)
  C = canvas(); st(C, PB.prop[role]); over(out, C.img, 0, bob)
  return flip(out)
end

-- fx[1] is the H0 baked bubble; the sheet ships the bubble as its own sprite
local function needs(role, wave)
  local out = blank()
  local C = canvas(); st(C, P.chairFront); over(out, C.img)
  C = canvas(); st(C, FB.body[role]); over(out, C.img)
  C = canvas(); for _, p in ipairs(FB.head[role]) do st(C, p) end
  if RIM[role] then rim(C, role, 10) end
  over(out, C.img)
  C = canvas(); for i, p in ipairs(FB.fx[role]) do if i > 1 then st(C, p) end end
  over(out, C.img, wave, 0)
  return out
end

local NOTE = [[
|...kk.|
|...kpk|
|...k.k|
|.kkk..|
|kpppk.|
|.kkk..|
]]
local function stand(role, ride)
  local s, trouser = STAND[role][1], STAND[role][2]
  local out = blank()
  local C = canvas()
  local b = FB.body[role]
  C.stamp(b[1], b[2] - s, firstRows(b[3], 10))
  -- legs from under the torso to the shoes
  local top = b[2] - s + 10
  for _, x0 in ipairs({11, 17}) do
    for y=top, 30 do C.px(x0, y, L.INK); C.px(x0+1, y, trouser); C.px(x0+2, y, trouser); C.px(x0+3, y, L.INK) end
    C.hline(x0 - (x0 == 11 and 1 or 0), 31, 5, L.INK)
  end
  over(out, C.img)
  C = canvas(); for _, p in ipairs(FB.head[role]) do st(C, p, 0, -s) end
  if RIM[role] then rim(C, role, 10 - s, s) end
  over(out, C.img)
  if ride then C = canvas(); C.stamp(26, 4, NOTE); over(out, C.img) end
  return out
end

-- "!" callout: bold 2px bang, tail down-left toward the raised hand
local BUBBLE = [[
|.kkkkkkkkkkk.|
|kppppppppppkk|
|kpppmmkpppppk|
|kpppmmkpppppk|
|kpppmmkpppppk|
|kpppmmkpppppk|
|kppppkkpppppk|
|kpppmmkpppppk|
|kppppkkpppppk|
|kppppppppppkk|
|.kkpkkkkkkkk.|
|..kpk........|
|..kk.........|
]]
local BW, BH = 13, 13

local SW, SH = CELL*6, CELL*(#ROLES + 1)
local sheet = Image(SW, SH, ColorMode.INDEXED); sheet:clear(0)
local cells = {}
for r, role in ipairs(ROLES) do
  local y = (r-1)*CELL
  local frames = { work(role, 0), work(role, 1), needs(role, 0), needs(role, 1), stand(role, false), stand(role, true) }
  for c, img in ipairs(frames) do sheet:drawImage(img, Point((c-1)*CELL, y)) end
  cells[role] = { work = {{0,y},{CELL,y}}, needs = {{CELL*2,y},{CELL*3,y}}, idle = {{CELL*4,y}}, ride = {{CELL*5,y}} }
end
local BX, BY = 0, CELL*#ROLES
do
  local s = Sprite(SW, SH, ColorMode.INDEXED); s:setPalette(pal.dark); s.transparentColor = 0
  local C = L.canvas(s, s.layers[1], s.frames[1])
  C.img:drawImage(sheet, Point(0, 0))
  C.stamp(BX, BY, BUBBLE)
  C.commit()
  sheet = C.img:clone()
  s:saveAs(root.."/art/office/cast.aseprite"); s:close()
end
for _, mode in ipairs({"dark", "light"}) do
  local out = Sprite(SW, SH, ColorMode.INDEXED)
  out:setPalette(pal[mode]); out.transparentColor = 0
  out.cels[1].image = sheet
  out:saveAs(root.."/public/office/cast-"..mode..".png"); out:close()
  print("wrote cast-"..mode..".png "..SW.."x"..SH)
end
tmp:close()

-- cast.json (hand-ordered writer so diffs stay stable)
local function xy(t) local s = {} for _, p in ipairs(t) do s[#s+1] = '{"x":'..p[1]..',"y":'..p[2]..'}' end return "["..table.concat(s, ",").."]" end
local parts, fb = {}, {}
for _, role in ipairs(ROLES) do
  local c = cells[role]
  parts[#parts+1] = '    "'..role..'":{"work":'..xy(c.work)..',"needs":'..xy(c.needs)..',"idle":'..xy(c.idle)..',"ride":'..xy(c.ride)..'}'
end
for _, r in ipairs(ALL) do if not cells[r] then fb[#fb+1] = '"'..r..'":"'..FALLBACK[r]..'"' end end
-- bubble offset = bubble top-left relative to the sprite anchor (cell bottom-centre):
-- floats just above the raised hand, top-left of the head
local json = '{\n  "version":1,\n  "cell":32,\n  "anchor":"bottom-centre",\n  "roles":{\n'..table.concat(parts, ",\n")..
  '\n  },\n  "bubble":{"x":'..BX..',"y":'..BY..',"w":'..BW..',"h":'..BH..',"offset":{"x":-18,"y":-40}},\n'..
  '  "fallback":{'..table.concat(fb, ",")..'}\n}\n'
local f = io.open(root.."/public/office/cast.json", "wb"); f:write(json); f:close()
print("wrote cast.json ("..#ROLES.." roles)")
