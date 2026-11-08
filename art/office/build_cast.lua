-- S1v2 cast sheet, 3/4 top-down camera (above + behind, ~45deg):
-- public/office/cast-{dark,light}.png + cast.json (pinned contract shape) and art/office/cast.aseprite.
-- Heads come from the H0 part maps (art/cast/hypno/{floor,front,extra}.lua) so every role keeps its
-- face; bodies, arms, chairs and shadows are redrawn here for the top-down angle.
-- Rows = roles; cols = work0 work1 needs0 needs1 idle ride. Cell 32, anchor = bottom-centre (chair base / feet).
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
local NV = 4
local pal = { dark = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" },
              light = Palette{ fromFile = root.."/art/palette/pc98-light.gpl" } }
local CELL = 32
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
local function bbox(img)
  local y0, y1 = nil, nil
  for y=0,CELL-1 do for x=0,CELL-1 do
    if img:getPixel(x, y) ~= 0 then y0 = y0 or y; y1 = y end
  end end
  return y0 or 0, y1 or 0
end
local function rowCount(img, y)
  local n = 0
  for x=0,CELL-1 do if img:getPixel(x, y) ~= 0 then n = n + 1 end end
  return n
end
local function st(C, part, dx, dy) if part then C.stamp(part[1] + (dx or 0), part[2] + (dy or 0), part[3]) end end
-- a filled part with a 1px INK outline drawn outside it
local function blob(out, fill)
  local C = canvas(); fill(C); C.outline(L.INK); over(out, C.img)
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
  for y=RIM_TOP[role] or 0, CELL-1 do for x=0,CELL-1 do
    if C.img:getPixel(x, y) == L.INK and C.get(x, y-1) == 0 then set[#set+1] = {x, y} end
  end end
  for _, q in ipairs(set) do C.img:drawPixel(q[1], q[2], L.VIOLET) end
end

local PB = { head = P.headBack, prop = P.propBack, ears = P.earsBack, earsR = P.earsBackR }
local FB = { body = F.body, head = F.head, fx = F.fx }
for k, t in pairs(X.back) do if PB[k] then for r, v in pairs(t) do PB[k][r] = v end end end
for k, t in pairs(X.front) do for r, v in pairs(t) do FB[k][r] = v end end

-- ---------- shared pieces ----------
local function chairBase(out)
  local C = canvas()
  C.rect(15, 27, 2, 3, L.INK)
  C.hline(10, 30, 12, L.INK); C.px(11, 29, L.INK); C.px(20, 29, L.INK)
  C.rect(9, 31, 3, 1, L.INK); C.rect(20, 31, 3, 1, L.INK); C.rect(15, 31, 2, 1, L.INK)
  over(out, C.img)
end
local function shadow(out, cx, cy, rx, ry)
  local C = canvas()
  for y=cy-ry, cy+ry do for x=cx-rx, cx+rx do
    local d = ((x+0.5-cx)/rx)^2 + ((y+0.5-cy)/ry)^2
    if d <= 1 and (x + y) % 2 == 0 then C.px(x, y, L.INK) end
  end end
  over(out, C.img)
end
-- H1b head (v1-v3): the variant's canvases from h1b.lua flattened into one image
local function h1bHead(view)
  local C = canvas()
  for _, c in ipairs(DV.floor(canvas, view)) do over(C.img, c.img) end
  local y0, y1 = bbox(C.img)
  return C.img, y0, y1
end
-- back-of-head layer, neck stalk removed (from above the head sits straight on the shoulders)
local function backHead(role)
  if DV then return h1bHead("back") end
  local C = canvas()
  st(C, PB.head[role]); st(C, PB.ears[role]); st(C, PB.earsR[role])
  if X.backExtra[role] then for _, p in ipairs(X.backExtra[role]) do st(C, p) end end
  local Q = canvas()
  if role == "buddy" then for _, p in ipairs(P.phonesBack) do st(Q, p) end end
  st(Q, PB.prop[role])
  over(C.img, Q.img)
  local y0, y1 = bbox(C.img)
  for _=1,3 do
    if rowCount(C.img, y1) <= 9 then
      for x=0,CELL-1 do C.img:drawPixel(x, y1, 0) end
      y1 = y1 - 1
    end
  end
  if RIM[role] then rim(C, role) end
  return C.img, y0, y1
end
-- v0 faces: hand-drawn rest / yo rows (faces.lua) laid over a copy of the H0 head map;
-- "_" in a face row keeps the H0 pixel underneath
local function patchRows(map, row, rows)
  local src, put = {}, {}
  for r in map:gmatch("[^\n]+") do src[#src+1] = (r:gsub("^%s*|", ""):gsub("|%s*$", "")) end
  for r in rows:gmatch("[^\n]+") do put[#put+1] = r end
  for i, r in ipairs(put) do
    local o, s = {}, src[row + i] or ""
    for c=1,math.max(#r, #s) do
      local ch = r:sub(c, c)
      o[c] = (ch == "" or ch == "_") and (s:sub(c, c) ~= "" and s:sub(c, c) or ".") or ch
    end
    src[row + i] = table.concat(o)
  end
  for i, r in ipairs(src) do src[i] = "|"..r.."|" end
  return table.concat(src, "\n")
end
local function faceParts(role, mode)
  local parts = FB.head[role]
  local fv = FACES[role] and FACES[role][1]
  local face = fv and fv[mode]
  if not face then return parts end
  if face.part then face = { face } end
  local out = {}
  for i, q in ipairs(parts) do out[i] = q end
  for _, f in ipairs(face) do
    local q = out[f.part]
    out[f.part] = { q[1], q[2], patchRows(q[3], f.row, f.rows) }
  end
  return out
end
-- mode: "yo" (needs) or "rest" (idle / ride)
local function frontHead(role, mode)
  if DV then return h1bHead(mode) end
  local C = canvas()
  for _, p in ipairs(faceParts(role, mode)) do st(C, p) end
  if RIM[role] then rim(C, role) end
  local y0, y1 = bbox(C.img)
  return C.img, y0, y1
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
  -- seat (wider than the back; only its corners show)
  blob(out, function(C) C.rect(8, 24, 16, 4, chair); C.px(9, 25, L.MARBLE) end)
  -- shoulders: a broad hump, the top surface catches a little light
  blob(out, function(C)
    local hw = { 8, 10, 11, 11, 11, 11, 11, 11 }
    for i, w in ipairs(hw) do C.hline(16 - w, 15 + i, w*2, shirt) end
    C.hline(8, 17, 3, L.MARBLE); C.hline(21, 17, 3, L.MARBLE)
    if shirt == L.MARBLE then C.hline(8, 17, 3, L.LINE); C.hline(21, 17, 3, L.LINE) end
  end)
  -- forearms reaching up-and-in onto the keyboard past the head; hands alternate (typing)
  for side=0,1 do
    local s = side == 0 and 1 or -1
    local bx = side == 0 and 5 or 26
    local up = (side + f) % 2
    blob(out, function(C)
      for t=0,1 do C.line(bx + t*s, 20, bx + (3+t)*s, 12 + up, shirt) end
      C.rect(side == 0 and bx+3 or bx-4, 10 + up, 2, 2, hand)
    end)
  end
  local hi, y0, y1 = backHead(role)
  putHead(out, hi, y0, y1, 21)
  -- chair back from above: cap on top, padded back below, covers the lower back
  if role == "overlord" then
    blob(out, function(C)
      C.rect(6, 19, 20, 9, L.PINK); C.hline(6, 19, 20, L.AMBER); C.hline(6, 20, 20, L.AMBER)
      C.px(6, 18, L.AMBER); C.px(25, 18, L.AMBER); C.px(15, 18, L.AMBER); C.px(16, 18, L.AMBER)
      C.px(9, 23, L.MARBLE); C.px(22, 23, L.MARBLE); C.px(15, 25, L.MARBLE)
    end)
  else
    blob(out, function(C)
      C.hline(11, 20, 10, chair); C.rect(10, 21, 12, 6, chair)
      C.hline(11, 22, 10, L.INK)
      C.px(11, 20, L.MARBLE); C.px(12, 20, L.MARBLE); C.px(11, 23, L.MARBLE); C.px(11, 24, L.MARBLE)
    end)
  end
  return flip(out)
end

-- ---------- needs: chair spun round, looking up at the camera ----------
local function torsoMap(role) return FB.body[role][1], pickRows(FB.body[role][3], {0,1,2,3,4,5,6,9}) end
local function needs(role, wave)
  local lk = LOOK[role]
  local trouser, chair = lk[3], lk[4]
  local out = blank()
  -- chair back behind the sitter
  if role == "overlord" then
    blob(out, function(C)
      C.rect(5, 6, 22, 18, L.PINK); C.rect(5, 6, 22, 2, L.AMBER); C.vline(5, 6, 18, L.AMBER); C.vline(26, 6, 18, L.AMBER)
      C.px(5, 5, L.AMBER); C.px(26, 5, L.AMBER); C.px(15, 5, L.AMBER); C.px(16, 5, L.AMBER)
      C.px(8, 10, L.MARBLE); C.px(23, 10, L.MARBLE)
    end)
  else
    blob(out, function(C)
      C.hline(10, 11, 12, chair); C.rect(9, 12, 14, 11, chair)
      C.px(10, 12, L.MARBLE); C.px(11, 12, L.MARBLE); C.px(10, 13, L.MARBLE)
    end)
  end
  chairBase(out)
  blob(out, function(C) C.rect(7, 23, 18, 4, chair); C.px(8, 24, L.MARBLE) end)
  -- lap from above: thighs toward the camera, shoes peeking past the seat
  blob(out, function(C)
    C.rect(10, 24, 5, 3, trouser); C.rect(17, 24, 5, 3, trouser)
    C.px(11, 24, L.MARBLE); C.px(18, 24, L.MARBLE)
  end)
  do local C = canvas()
    C.rect(10, 28, 5, 2, L.INK); C.rect(17, 28, 5, 2, L.INK); C.px(11, 28, L.MARBLE); C.px(18, 28, L.MARBLE)
    over(out, C.img) end
  local bx, map = torsoMap(role)
  local C = canvas(); C.stamp(bx, 17, map); over(out, C.img)
  local hi, y0, y1 = frontHead(role, "yo")
  putHead(out, hi, y0, y1, 18)
  C = canvas(); for i, p in ipairs(FB.fx[role]) do if i > 1 then st(C, p, 0, -3) end end
  over(out, C.img, wave, 0)
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
  shadow(out, 16, 29.5, 10, 2.5)
  blob(out, function(C) C.rect(11, 24, 4, 3, trouser); C.rect(17, 24, 4, 3, trouser) end)
  do local C = canvas()
    C.rect(10, 28, 5, 2, L.INK); C.rect(17, 28, 5, 2, L.INK); C.px(11, 28, L.MARBLE); C.px(18, 28, L.MARBLE)
    over(out, C.img) end
  local bx, map = torsoMap(role)
  local C = canvas(); C.stamp(bx, 17, map); over(out, C.img)
  local hi, y0, y1 = frontHead(role, "rest")
  putHead(out, hi, y0, y1, 18)
  if ride then C = canvas(); C.stamp(26, 2, NOTE); over(out, C.img) end
  return out
end

-- "!" callout (unchanged from S1)
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
tmp:close()

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
local json = '{\n  "version":2,\n  "cell":32,\n  "anchor":"bottom-centre",\n  "roles":{\n'..table.concat(parts, ",\n")..
  '\n  },\n  "bubble":{"x":'..BX..',"y":'..BY..',"w":'..BW..',"h":'..BH..',"offset":{"x":-18,"y":-40}},\n'..
  '  "fallback":{}\n}\n'
local f = io.open(root.."/public/office/cast.json", "wb"); f:write(json); f:close()
print("wrote cast.json ("..#ROLES.." roles)")
