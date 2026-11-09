-- FF (docs/PLAN_FLOOR_FACES.md): floor cast at cell 48 (was 32) so each floor person wears its bust's face.
-- Front heads (needs = "yo!", idle/ride = rest) are the variant's own 64px bust head re-drawn at 0.7 into the
-- 48px grid (art/office/ff/heads.lua); bodies, chairs, arms and shadows are the S1v2 shapes re-rasterised at
-- 1.5x (art/office/ff/scale.lua, 1px INK outlines stay 1px); the v0 back heads, H0 torsos and raised-hand
-- props (ASCII maps) go through up15() (1.5x with 1px INK kept 1px). No nearest-neighbour upscale.
-- S1v2 cast sheet, 3/4 top-down camera (above + behind, ~45deg):
-- public/office/cast-{dark,light}.png + cast.json (pinned contract shape) and art/office/cast.aseprite.
-- Heads come from the H0 part maps (art/cast/hypno/{floor,front,extra}.lua) so every role keeps its
-- face; bodies, arms, chairs and shadows are redrawn here for the top-down angle.
-- Rows = roles; cols = work0 work1 needs0 needs1 idle ride. Cell 48, anchor = bottom-centre (chair base / feet).
--   work : crown of the head, shoulder tops, forearms reaching up onto the desk (typing: the hands
--          alternate 1px), chair back seen from above covering the lower back
--   needs: chair spun round, looking up at the camera, lap from above, hand up (frame 2 waves 1px)
--   idle : standing, looking up, short foreshortened legs, dithered floor shadow
--   ride : idle + lift-music note
-- Contract v2: 4 variants per role. Sheet cols = variant*6 + pose col, rows = roles (+ the bubble row).
-- v0 = the approved H0/S1 drawing with its own rest/yo face rows (art/cast/hypno/faces.lua); v1-v3 = H1b
-- weirdos (art/cast/hypno/h1b.lua): new heads on the role's own costume. Plain pose keys in cast.json = v0.
-- Faces: needs = "yo!" face, idle/ride = rest face, work = back of the head.
-- riffbot/overlord desk roles are dropped (they are CRT faces now).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/build_cast.lua
local root = app.params.root
local hyp = root.."/art/cast/hypno/"
local L = dofile(hyp.."lib.lua")
local P = dofile(hyp.."floor.lua")
local F = dofile(hyp.."front.lua")
local X = dofile(hyp.."extra.lua")(L, P, F)
local H1B = dofile(hyp.."h1b.lua")(L)
local FACES = dofile(hyp.."faces.lua")
local SC = dofile(root.."/art/office/ff/scale.lua")(L)
local HD = dofile(root.."/art/office/ff/heads.lua")(L, root, SC)
local NV = 4
local pal = { dark = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" },
              light = Palette{ fromFile = root.."/art/palette/pc98-light.gpl" } }
local CELL = 48
local C32 = 32   -- the S1v2 grid the ASCII parts and back heads are authored in
local ROLES = { "lead", "buddy", "implement", "review" }
for _, r in ipairs(X.roles) do if r ~= "riffbot" and r ~= "overlord" then ROLES[#ROLES+1] = r end end

-- per role: shirt, hand, trouser, chair (slots)
local LOOK = {
  lead           = { L.PINK,   L.SKIN,   L.VIOLET, L.VIOLET },
  buddy          = { L.TEAL,   L.SKIN,   L.VIOLET, L.VIOLET },
  implement      = { L.MARBLE, L.SKIN,   L.VIOLET, L.VIOLET },
  review         = { L.VIOLET, L.MINT,   L.MINT,   L.VIOLET },
  ["retired-lead"] = { L.AMBER, L.CORAL, L.VIOLET, L.VIOLET },
  mechanical     = { L.TEAL,   L.MARBLE, L.TEAL,   L.VIOLET },
  audit          = { L.VIOLET, L.AMBER,  L.VIOLET, L.VIOLET },
  spec           = { L.MINT,   L.MARBLE, L.VIOLET, L.VIOLET },
  art            = { L.TEAL,   L.MARBLE, L.VIOLET, L.VIOLET },
  unknown        = { L.CORAL,  L.MARBLE, L.CORAL,  L.VIOLET },
  riffbot        = { L.PINK,   L.MARBLE, L.VIOLET, L.VIOLET },
  overlord       = { L.VIOLET, L.MARBLE, L.VIOLET, L.PINK },
}

-- current variant: nil = v0 (H0 head maps), else the H1b head (h1b.lua)
local DV, VNOW
local function setVariant(role, v) VNOW = v; DV = v > 0 and H1B[role] and H1B[role][v] or nil end

local tmp = Sprite(CELL, CELL, ColorMode.INDEXED); tmp:setPalette(pal.dark); tmp.transparentColor = 0
local tmp32 = Sprite(C32, C32, ColorMode.INDEXED); tmp32:setPalette(pal.dark); tmp32.transparentColor = 0
local function canvasRaw() return L.canvas(tmp, tmp.layers[1], tmp.frames[1]) end
-- 32-grid geometry re-rasterised into the 48 grid
local function canvasS() return SC.wrap(canvasRaw(), 1.5) end
local function canvas32() return L.canvas(tmp32, tmp32.layers[1], tmp32.frames[1]) end
local function blank() local i = Image(CELL, CELL, ColorMode.INDEXED); i:clear(0); return i end
local function over(dst, src, dx, dy)
  for y=0,src.height-1 do for x=0,src.width-1 do
    local v = src:getPixel(x, y)
    local tx, ty = x + (dx or 0), y + (dy or 0)
    if v ~= 0 and tx >= 0 and ty >= 0 and tx < dst.width and ty < dst.height then dst:drawPixel(tx, ty, v) end
  end end
end
-- up15: a finished 32px ASCII part -> the 48 grid. Every 2nd source column/row is doubled; on the doubled
-- copy an INK pixel takes its far neighbour instead (fill or transparent), so outlines and INK detail
-- lines stay exactly 1px and fills grow by 1.5.
local function up15(src)
  local w, h = src.width, src.height
  local W2, H2 = (w*3 + 1)//2, (h*3 + 1)//2
  local function pass(get, n, n2)
    local t = {}
    for X=0,n2-1 do
      local sx = (X*2)//3
      local dup = X % 3 == 1
      t[X] = function(o) local v = get(sx, o)
        if dup and v == L.INK then local nx = get(sx+1, o); if nx ~= L.INK then v = nx end end
        return v end
    end
    return t
  end
  local mid = Image(W2, h, ColorMode.INDEXED); mid:clear(0)
  local gx = pass(function(x, y) if x >= w then return 0 end return src:getPixel(x, y) end, w, W2)
  for y=0,h-1 do for X=0,W2-1 do mid:drawPixel(X, y, gx[X](y)) end end
  local out = Image(W2, H2, ColorMode.INDEXED); out:clear(0)
  local gy = pass(function(y, x) if y >= h then return 0 end return mid:getPixel(x, y) end, h, H2)
  for Y=0,H2-1 do for x=0,W2-1 do out:drawPixel(x, Y, gy[Y](x)) end end
  return out
end
local function flip(img)
  local o = blank()
  for y=0,CELL-1 do for x=0,CELL-1 do o:drawPixel(CELL-1-x, y, img:getPixel(x, y)) end end
  return o
end
local function bbox(img)
  local y0, y1 = nil, nil
  for y=0,img.height-1 do for x=0,img.width-1 do
    if img:getPixel(x, y) ~= 0 then y0 = y0 or y; y1 = y end
  end end
  return y0 or 0, y1 or 0
end
local function rowCount(img, y)
  local n = 0
  for x=0,img.width-1 do if img:getPixel(x, y) ~= 0 then n = n + 1 end end
  return n
end
local function st(C, part, dx, dy) if part then C.stamp(part[1] + (dx or 0), part[2] + (dy or 0), part[3]) end end
-- a filled part (32-grid shapes, drawn at 48) with a 1px INK outline drawn outside it
local function blob(out, fill)
  local C = canvasS(); fill(C); C.outline(L.INK); over(out, C.img)
end
local function pickRows(map, idx)
  local rows = {}
  for row in map:gmatch("[^\n]+") do rows[#rows+1] = row end
  local o = {}
  for _, i in ipairs(idx) do if rows[i+1] then o[#o+1] = rows[i+1] end end
  return table.concat(o, "\n")
end
local RIM = { review = true, implement = true }
local RIM_TOP = { implement = 7 }
local function rim(C, role)
  local set = {}
  for y=RIM_TOP[role] or 0, C.h-1 do for x=0,C.w-1 do
    if C.img:getPixel(x, y) == L.INK and C.get(x, y-1) == 0 then set[#set+1] = {x, y} end
  end end
  for _, q in ipairs(set) do C.img:drawPixel(q[1], q[2], L.VIOLET) end
end

local PB = { head = P.headBack, prop = P.propBack, ears = P.earsBack, earsR = P.earsBackR }
local FB = { body = F.body, head = F.head, fx = F.fx }
for k, t in pairs(X.back) do if PB[k] then for r, v in pairs(t) do PB[k][r] = v end end end
for k, t in pairs(X.front) do for r, v in pairs(t) do FB[k][r] = v end end

-- ---------- shared pieces (32-grid shapes re-rasterised at 48) ----------
local function chairBase(out)
  local C = canvasS()
  C.rect(15, 27, 2, 3, L.INK)
  C.hline(10, 30, 12, L.INK); C.px(11, 29, L.INK); C.px(20, 29, L.INK)
  C.rect(9, 31, 3, 1, L.INK); C.rect(20, 31, 3, 1, L.INK); C.rect(15, 31, 2, 1, L.INK)
  over(out, C.img)
end
-- dithered floor shadow, drawn in 48-grid px (the dither stays a 1px checker)
local function shadow(out, cx, cy, rx, ry)
  local C = canvasRaw()
  for y=math.floor(cy-ry), math.ceil(cy+ry) do for x=math.floor(cx-rx), math.ceil(cx+rx) do
    local d = ((x+0.5-cx)/rx)^2 + ((y+0.5-cy)/ry)^2
    if d <= 1 and (x + y) % 2 == 0 then C.px(x, y, L.INK) end
  end end
  over(out, C.img)
end
-- H1b back head (v1-v3): the 32px floor "back" head re-drawn at 1.5x
local function h1bBack(role)
  local img = HD.back1(role, VNOW)
  local y0, y1 = bbox(img)
  return img, y0, y1
end
-- v0 back-of-head: the S1v2 32px back head (neck stalk removed), then up15 into the 48 grid
local function backHead(role)
  if DV then return h1bBack(role) end
  local C = canvas32()
  st(C, PB.head[role]); st(C, PB.ears[role]); st(C, PB.earsR[role])
  if X.backExtra[role] then for _, p in ipairs(X.backExtra[role]) do st(C, p) end end
  local Q = canvas32()
  if role == "buddy" then for _, p in ipairs(P.phonesBack) do st(Q, p) end end
  st(Q, PB.prop[role])
  over(C.img, Q.img)
  local y0, y1 = bbox(C.img)
  for _=1,3 do
    if rowCount(C.img, y1) <= 9 then
      for x=0,C32-1 do C.img:drawPixel(x, y1, 0) end
      y1 = y1 - 1
    end
  end
  if RIM[role] then rim(C, role) end
  local img = up15(C.img)
  y0, y1 = bbox(img)
  return img, y0, y1
end
-- front head = the bust head (heads.lua), centred on the cell (busts centre on x 32 -> 22.4 at 0.7)
local function frontHead(role, mode)
  local img = HD.front(role, VNOW, mode)
  local o = blank(); over(o, img, 2, 0)
  local y0, y1 = bbox(o)
  return o, y0, y1
end
-- place a head so its bottom lands on `bottom`, never cropping the top
local function putHead(out, img, y0, y1, bottom)
  local dy = bottom - y1
  if y0 + dy < 0 then dy = -y0 end
  over(out, img, 0, dy)
  return dy
end
-- ---------- work: seen from above + behind ----------
local function work(role, f)
  local lk = LOOK[role]
  local shirt, hand, chair = lk[1], lk[2], lk[4]
  local out = blank()
  chairBase(out)
  blob(out, function(C) C.rect(8, 24, 16, 4, chair); C.px(9, 25, L.MARBLE) end)
  blob(out, function(C)
    local hw = { 8, 10, 11, 11, 11, 11, 11, 11 }
    for i, w in ipairs(hw) do C.hline(16 - w, 15 + i, w*2, shirt) end
    C.hline(8, 17, 3, L.MARBLE); C.hline(21, 17, 3, L.MARBLE)
    if shirt == L.MARBLE then C.hline(8, 17, 3, L.LINE); C.hline(21, 17, 3, L.LINE) end
  end)
  for side=0,1 do
    local s = side == 0 and 1 or -1
    local bx = side == 0 and 5 or 26
    local up = (side + f) % 2
    blob(out, function(C)
      for t=0,1,0.5 do C.line(bx + t*s, 20, bx + (3+t)*s, 12 + up, shirt) end
      C.rect(side == 0 and bx+3 or bx-4, 10 + up, 2, 2, hand)
    end)
  end
  local hi, y0, y1 = backHead(role)
  putHead(out, hi, y0, y1, 32)
  blob(out, function(C)
    C.hline(11, 20, 10, chair); C.rect(10, 21, 12, 6, chair)
    C.hline(11, 22, 10, L.INK)
    C.px(11, 20, L.MARBLE); C.px(12, 20, L.MARBLE); C.px(11, 23, L.MARBLE); C.px(11, 24, L.MARBLE)
  end)
  return flip(out)
end

-- ---------- needs: chair spun round, looking up at the camera ----------
local function torsoMap(role) return FB.body[role][1], pickRows(FB.body[role][3], {0,1,2,3,4,5,6,9}) end
-- an ASCII part stamped on the 32 grid at (x, y), then up15 into the 48 grid at (x*1.5, y*1.5)
local function part15(out, x, y, map, dx)
  local C = canvas32(); C.stamp(0, 0, map)
  local x1, y1 = 0, 0
  for yy=0,C32-1 do for xx=0,C32-1 do if C.img:getPixel(xx, yy) ~= 0 then x1 = math.max(x1, xx); y1 = math.max(y1, yy) end end end
  local cut = Image(x1+1, y1+1, ColorMode.INDEXED); cut:clear(0); over(cut, C.img)
  over(out, up15(cut), math.floor(x*1.5 + 0.5) + (dx or 0), math.floor(y*1.5 + 0.5))
end
local function needs(role, wave)
  local lk = LOOK[role]
  local trouser, chair = lk[3], lk[4]
  local out = blank()
  blob(out, function(C)
    C.hline(10, 11, 12, chair); C.rect(9, 12, 14, 11, chair)
    C.px(10, 12, L.MARBLE); C.px(11, 12, L.MARBLE); C.px(10, 13, L.MARBLE)
  end)
  chairBase(out)
  blob(out, function(C) C.rect(7, 23, 18, 4, chair); C.px(8, 24, L.MARBLE) end)
  blob(out, function(C)
    C.rect(10, 24, 5, 3, trouser); C.rect(17, 24, 5, 3, trouser)
    C.px(11, 24, L.MARBLE); C.px(18, 24, L.MARBLE)
  end)
  do local C = canvasS()
    C.rect(10, 28, 5, 2, L.INK); C.rect(17, 28, 5, 2, L.INK); C.px(11, 28, L.MARBLE); C.px(18, 28, L.MARBLE)
    over(out, C.img) end
  local bx, map = torsoMap(role)
  part15(out, bx, 17, map)
  local hi, y0, y1 = frontHead(role, "yo")
  putHead(out, hi, y0, y1, 27)
  for i, p in ipairs(FB.fx[role]) do if i > 1 then part15(out, p[1], p[2] - 3, p[3], wave * 2) end end
  return out
end

-- ---------- idle / ride: standing, seen from above ----------
local NOTE = [[
|...kk.|
|...kpk|
|...k.k|
|.kkk..|
|kpppk.|
|.kkk..|
]]
local function stand(role, ride)
  local lk = LOOK[role]
  local trouser = lk[3]
  local out = blank()
  shadow(out, 24, 44.5, 15, 3.5)
  blob(out, function(C) C.rect(11, 24, 4, 3, trouser); C.rect(17, 24, 4, 3, trouser) end)
  do local C = canvasS()
    C.rect(10, 28, 5, 2, L.INK); C.rect(17, 28, 5, 2, L.INK); C.px(11, 28, L.MARBLE); C.px(18, 28, L.MARBLE)
    over(out, C.img) end
  local bx, map = torsoMap(role)
  part15(out, bx, 17, map)
  local hi, y0, y1 = frontHead(role, "rest")
  putHead(out, hi, y0, y1, 27)
  if ride then part15(out, 26, 1, NOTE, 2) end
  return out
end

-- "!" callout, drawn at 48-grid size (19x19)
local BUBBLE = [[
|.kkkkkkkkkkkkkkkk..|
|kppppppppppppppppk.|
|kppppppppppppppppkk|
|kppppppmmmkppppppkk|
|kppppppmmmkppppppkk|
|kppppppmmmkppppppkk|
|kppppppmmmkppppppkk|
|kppppppmmmkppppppkk|
|kppppppmmmkppppppkk|
|kpppppppkkkppppppkk|
|kppppppppppppppppkk|
|kppppppmmmkppppppkk|
|kppppppmmmkppppppkk|
|kpppppppkkkppppppkk|
|kppppppppppppppppkk|
|.kkkpkkkkkkkkkkkkk.|
|...kppk............|
|...kpk.............|
|...kk..............|
]]
local BW, BH = 19, 19

local SW, SH = CELL*6*NV, CELL*(#ROLES + 1)
local sheet = Image(SW, SH, ColorMode.INDEXED); sheet:clear(0)
local cells = {}
for r, role in ipairs(ROLES) do
  local y = (r-1)*CELL
  cells[role] = {}
  for v=0,NV-1 do
    setVariant(role, v)
    local x = v*6*CELL
    local frames = { work(role, 0), work(role, 1), needs(role, 0), needs(role, 1), stand(role, false), stand(role, true) }
    for c, img in ipairs(frames) do sheet:drawImage(img, Point(x + (c-1)*CELL, y)) end
    cells[role][v+1] = { work = {{x,y},{x+CELL,y}}, needs = {{x+CELL*2,y},{x+CELL*3,y}}, idle = {{x+CELL*4,y}}, ride = {{x+CELL*5,y}} }
  end
  setVariant(role, 0)
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
tmp:close(); tmp32:close()

local function xy(t) local s = {} for _, p in ipairs(t) do s[#s+1] = '{"x":'..p[1]..',"y":'..p[2]..'}' end return "["..table.concat(s, ",").."]" end
local parts = {}
local function poses(c) return '"work":'..xy(c.work)..',"needs":'..xy(c.needs)..',"idle":'..xy(c.idle)..',"ride":'..xy(c.ride) end
for _, role in ipairs(ROLES) do
  local vs = {}
  -- each variant also carries x,y (= its work[0] cell) so v1 readers that treat "variants" as a pose still validate
  for _, c in ipairs(cells[role]) do vs[#vs+1] = '\n      {"x":'..c.work[1][1]..',"y":'..c.work[1][2]..','..poses(c)..'}' end
  parts[#parts+1] = '    "'..role..'":{"variants":['..table.concat(vs, ",")..'\n     ],\n     '..poses(cells[role][1])..'}'
end
-- bubble offset = bubble top-left relative to the sprite anchor (cell bottom-centre)
local json = '{\n  "version":2,\n  "cell":48,\n  "anchor":"bottom-centre",\n  "roles":{\n'..table.concat(parts, ",\n")..
  '\n  },\n  "bubble":{"x":'..BX..',"y":'..BY..',"w":'..BW..',"h":'..BH..',"offset":{"x":-27,"y":-60}},\n'..
  '  "fallback":{}\n}\n'
local f = io.open(root.."/public/office/cast.json", "wb"); f:write(json); f:close()
print("wrote cast.json ("..#ROLES.." roles)")
