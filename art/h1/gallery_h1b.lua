-- H1b gallery: the H0 sheet (canon) on the left, every role x 4 variants on the right:
-- bust rest (= app icon) + bust "yo!", and the floor work / needs ("yo!") / idle (rest) frames.
-- Two sheets (roles 1-5, 6-10) so each fits a 4K screen at 3x. Pure palette swap dark / light.
-- Run: Aseprite.exe -b --script-param root=<repo> --script-param shots=<dir> --script art/h1/gallery_h1b.lua
local root = app.params.root
local shots = app.params.shots or (root.."/scratch/shots")
local L = dofile(root.."/art/cast/hypno/lib.lua")
local D = dofile(root.."/art/cast/hypno/h1b.lua")(L)
local hyp = root.."/art/cast/hypno/"
local pal = { dark = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" },
              light = Palette{ fromFile = root.."/art/palette/pc98-light.gpl" } }
local BGc, PANEL, PHI, LINE = 0, 1, 2, 3
local K, V, P, M = 15, 8, 9, 4
-- bust file name, floor sheet row, label
local ROLES = {
  { "lead", 0, "LEAD", "BIG CHEESE" }, { "retired-lead", 4, "RETIRED", "WALRUS" },
  { "buddy", 1, "BUDDY", "WALKMAN KID" }, { "implement", 2, "IMPLEMENT", "TV HEAD" },
  { "mechanical", 5, "MECHANICAL", "ROBOT" }, { "review", 3, "REVIEW", "STALK EYE" },
  { "audit", 6, "AUDIT", "OWL" }, { "spec", 7, "SPEC", "CAT" }, { "art", 8, "ART", "POODLE" },
  { "unknown", 9, "UNKNOWN", "PAPER BAG" },
}

local function flat(file)
  local s = app.open(file)
  local img = Image(s.width, s.height, ColorMode.INDEXED); img:clear(0); img:drawSprite(s, 1)
  s:close()
  return img
end
local floorSheet = flat(root.."/art/office/cast.aseprite")
local h0 = flat(hyp.."sheet.aseprite")

local function sheet(first, last, tag)
  local CW, CH = 134, 104             -- variant cell
  local LW = 44                       -- row label column
  local PAD, TOP = 6, 18
  local RX = PAD + h0.width + PAD + 4
  local W = RX + LW + 4*CW + PAD
  local H = math.max(TOP + 14 + h0.height + PAD, TOP + 16 + (last-first+1)*CH + PAD)
  local spr = L.new(W, H, pal.dark)
  local C = L.canvas(spr, spr.layers[1], spr.frames[1])
  C.rect(0, 0, W, H, PANEL)
  for y=2,H-1,12 do for x=((y//12)%2)*8+2, W-1, 16 do
    C.px(x, y, PHI); C.px(x-1, y, PHI); C.px(x+1, y, PHI); C.px(x, y-1, PHI); C.px(x, y+1, PHI)
  end end
  C.rect(2, 2, W-4, 11, V); C.hline(2, 2, W-4, M); C.hline(2, 12, W-4, K)
  L.text(C, 6, 5, "H1B CAST.EXE - SAME HAND AS H0 + H1A - SHEET "..tag:upper().." OF 2", M)
  local function blit(img, x, y, sx, sy, w, h)
    sx, sy, w, h = sx or 0, sy or 0, w or img.width, h or img.height
    for j=0,h-1 do for i=0,w-1 do local v = img:getPixel(sx+i, sy+j); if v ~= 0 then C.px(x+i, y+j, v) end end end
  end
  local function well(x, y, w, h, fill)
    C.rect(x, y, w, h, fill or BGc)
    C.hline(x-1, y-1, w+1, K); C.vline(x-1, y-1, h+1, K)
    C.hline(x-1, y+h, w+2, M); C.vline(x+w, y-1, h+2, M)
  end
  local function head(x, y, w, s, c)
    L.plate(C, x, y, w, 11, LINE, M, K)
    L.text(C, x + (w - L.textW(s))//2, y+3, s, c or 5)
  end
  head(PAD, TOP, h0.width, "CANON: H0 CAST SHEET", 5)
  blit(h0, PAD, TOP + 14)
  C.vline(RX - 5, TOP, H - TOP - 2, K); C.vline(RX - 4, TOP, H - TOP - 2, M)
  for v=0,3 do head(RX + LW + v*CW + 2, TOP, CW - 4, v == 0 and "V0 (H0)" or ("V"..v)) end
  local y = TOP + 16
  for i=first,last do
    local r = ROLES[i]
    L.plate(C, RX + 1, y + 2, LW - 4, 24, LINE, M, K)
    L.text(C, RX + 3, y + 5, r[3]:sub(1, 10), 5)
    C.hline(RX + 3, y + 11, math.min(L.textW(r[3]), LW - 8), P)
    for v=0,3 do
      local x = RX + LW + v*CW + 2
      local name = v == 0 and r[4] or D[r[1]][v].name
      L.text(C, x, y + 1, name, 6)
      well(x, y + 8, 64, 64)
      blit(flat(hyp..r[1].."-bust"..(v > 0 and "-v"..v or "")..".aseprite"), x, y + 8)
      if v > 0 then well(x + 66, y + 8, 64, 64); blit(flat(hyp..r[1].."-bust-v"..v.."-yo.aseprite"), x + 66, y + 8)
      else L.text(C, x + 72, y + 36, "REST ICON", 6) end
      for k, col in ipairs({0, 2, 4}) do
        local fx = x + (k-1)*34 + 14
        well(fx, y + 74, 32, 26, PHI)
        blit(floorSheet, fx, y + 74, (v*6 + col)*32, r[2]*32 + 4, 32, 26)
      end
    end
    y = y + CH
  end
  C.commit()
  local img = Image(W, H, ColorMode.INDEXED); img:drawSprite(spr, 1)
  spr:close()
  return img
end
-- paint an indexed image at zoom z through a palette
local function rgb(img, p, z, out, oy)
  for j=0,img.height-1 do for i=0,img.width-1 do
    local c = p:getColor(img:getPixel(i, j)); local px = app.pixelColor.rgba(c.red, c.green, c.blue, 255)
    for q=0,z-1 do for o=0,z-1 do out:drawPixel(i*z+o, (oy+j)*z+q, px) end end
  end end
end
local round = app.params.round or "r1"
local A, B = sheet(1, 5, "a"), sheet(6, 10, "b")
for _, mode in ipairs({"dark", "light"}) do
  for tag, img in pairs({a = A, b = B}) do
    local out = Image(img.width*3, img.height*3, ColorMode.RGB); rgb(img, pal[mode], 3, out, 0)
    local path = shots.."/h1b-gallery-"..tag.."-"..mode.."-"..round.."-3x.png"
    out:saveAs(path); print("wrote "..path)
  end
  -- both sheets stacked, 2x: the one-file review sheet
  local out = Image(A.width*2, (A.height + B.height)*2, ColorMode.RGB)
  rgb(A, pal[mode], 2, out, 0); rgb(B, pal[mode], 2, out, A.height)
  local path = shots.."/h1b-gallery-"..mode.."-"..round..".png"
  out:saveAs(path); print("wrote "..path.." "..out.width.."x"..out.height)
end
