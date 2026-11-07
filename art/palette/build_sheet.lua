-- Builds scratch/shots/palette-p0.png: both PC-98 palettes + mini floor + UI tiles.
-- One INDEXED sprite is painted once, then exported with the dark and the light
-- palette (a pure palette swap), and the two exports are composed side by side at 3x.
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/palette/build_sheet.lua
local root = app.params.root
local W, H = 200, 260
local BG,PANEL,PHI,LINE,MARBLE,TEXT,MUTED,TEAL,VIOLET,PINK,CORAL,AMBER,MINT,SKY,SKIN,INK =
      0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15
local NAMES = {"BG","PANEL","PNLHI","LINE","MARBL","TEXT","MUTED","TEAL",
               "VIOLT","PINK","CORAL","AMBER","MINT","SKY","SKIN","INK"}

local spr = Sprite(W, H, ColorMode.INDEXED)
local pal = { dark = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" },
              light = Palette{ fromFile = root.."/art/palette/pc98-light.gpl" } }
spr:setPalette(pal.dark)
local img = spr.cels[1].image

local function px(x, y, c) if x>=0 and y>=0 and x<W and y<H then img:drawPixel(x, y, c) end end
local function rect(x, y, w, h, c) for j=y,y+h-1 do for i=x,x+w-1 do px(i,j,c) end end end
local function box(x, y, w, h, c)
  for i=x,x+w-1 do px(i,y,c); px(i,y+h-1,c) end
  for j=y,y+h-1 do px(x,j,c); px(x+w-1,j,c) end
end
local function hline(x, y, w, c) for i=x,x+w-1 do px(i,y,c) end end
local function line(x0, y0, x1, y1, c)
  local n = math.max(math.abs(x1-x0), math.abs(y1-y0))
  for t=0,n do px(x0 + math.floor((x1-x0)*t/n + 0.5), y0 + math.floor((y1-y0)*t/n + 0.5), c) end
end

-- ordered 4x4 Bayer dither between two slots, t in [0,1]
local BAYER = {{0,8,2,10},{12,4,14,6},{3,11,1,9},{15,7,13,5}}
local function dith(x, y, a, b, t)
  if (BAYER[y%4+1][x%4+1] + 0.5) < t*16 then return b end
  return a
end
-- vertical gradient through stops {{y,slot},...}
local function vgrad(x0, w, stops)
  for k=1,#stops-1 do
    local y0, a = stops[k][1], stops[k][2]
    local y1, b = stops[k+1][1], stops[k+1][2]
    for y=y0,y1-1 do for x=x0,x0+w-1 do px(x, y, dith(x, y, a, b, (y-y0)/(y1-y0))) end end
  end
end

-- 3x5 font
local F = {
 A="010101111101101",B="110101110101110",C="011100100100011",D="110101101101110",
 E="111100110100111",F="111100110100100",G="011100101101011",H="101101111101101",
 I="111010010010111",J="001001001101010",K="101101110101101",L="100100100100111",
 M="101111111101101",N="110101101101101",O="010101101101010",P="110101110100100",
 Q="010101101110011",R="110101110101101",S="011100010001110",T="111010010010010",
 U="101101101101111",V="101101101101010",W="101101111111101",X="101101010101101",
 Y="101101010010010",Z="111001010100111",
 ["0"]="111101101101111",["1"]="010110010010111",["2"]="110001010100111",
 ["3"]="110001010001110",["4"]="101101111001001",["5"]="111100110001110",
 ["6"]="011100111101111",["7"]="111001010010010",["8"]="111101111101111",
 ["9"]="111101111001110",["!"]="010010010000010",[":"]="000010000010000",
 ["("]="010100100100010",[")"]="010001001001010",["."]="000000000000010",
 ["-"]="000000111000000",["/"]="001001010100100",[" "]="000000000000000",
}
local function text(x, y, s, c)
  for n=1,#s do
    local g = F[s:sub(n,n)] or F[" "]
    for r=0,4 do for q=0,2 do
      if g:sub(r*3+q+1, r*3+q+1) == "1" then px(x+(n-1)*4+q, y+r, c) end
    end end
  end
end

-- ---------- page ----------
rect(0, 0, W, H, BG)

-- ---------- swatches: 2 rows x 8 ----------
-- label slot per swatch chosen so it reads in both palettes
local LBL = { [BG]=TEXT, [PANEL]=TEXT, [PHI]=TEXT, [LINE]=TEXT, [MARBLE]=INK, [TEXT]=BG,
              [MUTED]=BG, [TEAL]=BG, [VIOLET]=BG, [PINK]=BG, [CORAL]=INK, [AMBER]=INK,
              [MINT]=BG, [SKY]=TEXT, [SKIN]=INK, [INK]=MARBLE }
for s=0,15 do
  local x, y = 4 + (s%8)*24, 13 + (s//8)*18
  rect(x, y, 23, 16, s); box(x, y, 23, 16, INK)
  text(x+2, y+2, string.format("%02d", s), LBL[s])
  text(x+2, y+9, NAMES[s+1], LBL[s])
end

-- ---------- mini floor tile (192x100 at 4,50) ----------
local fx, fy = 4, 50
local function FP(x, y, c) px(fx+x, fy+y, c) end
local function FR(x, y, w, h, c) rect(fx+x, fy+y, w, h, c) end
local function FB(x, y, w, h, c) box(fx+x, fy+y, w, h, c) end
-- sky: Bayer-dithered sunset ramp SKY > VIOLET > PINK > CORAL > AMBER
vgrad(fx, 192, {{fy+0,SKY},{fy+16,VIOLET},{fy+32,PINK},{fy+46,CORAL},{fy+56,AMBER}})
-- striped vaporwave sun (flat)
for j=-14,14 do for i=-14,14 do
  if i*i+j*j <= 14*14+14 then
    local cut = (j==3 or j==7 or j==8 or j==11 or j==12 or j==13)
    if not cut then FP(140+i, 30+j, AMBER) end
  end
end end
-- marble mall facade with columns + lit shop windows
FR(6, 26, 64, 30, PHI)
for c=0,3 do FR(15 + c*13, 33, 6, 10, AMBER); FR(15 + c*13, 38, 6, 1, CORAL) end
for c=0,4 do local cx = 9 + c*13; FR(cx, 27, 5, 29, MARBLE); FR(cx+4, 27, 1, 29, LINE) end
FB(6, 25, 64, 31, INK)
FR(4, 21, 68, 5, MARBLE); FR(4, 25, 68, 1, LINE); FB(4, 21, 68, 5, INK)
-- Memphis shapes: teal triangle, mint squiggle, pink dot
for k=0,5 do hline(fx+80+k, fy+14-k, 1, TEAL); hline(fx+80+k, fy+14, 1, TEAL)
  for q=0,k do FP(80+k, 14-q, TEAL) end end
for k=0,8 do local o = (k%4<2) and 0 or 1; FP(92+k, 8+o, MINT); FP(92+k, 9+o, MINT) end
for j=-2,2 do for i=-2,2 do if i*i+j*j<=5 then FP(110+i, 12+j, PINK) end end end
-- palm silhouette
for j=0,30 do local o = j//8; FP(172+o, 56-j, INK); FP(173+o, 56-j, INK) end
for _,d in ipairs({{-11,3},{-13,8},{-6,-4},{4,-5},{11,0},{14,6},{8,9},{-5,9}}) do
  line(fx+176, fy+26, fx+176+d[1], fy+26+d[2], INK)
  line(fx+176, fy+27, fx+176+d[1], fy+27+d[2], INK)
end
-- floor: panel + haze dither below horizon + perspective grid
FR(0, 56, 192, 44, PANEL)
vgrad(fx, 192, {{fy+56,PINK},{fy+60,PHI},{fy+66,PANEL}})
for _,yy in ipairs({56,58,61,65,70,77,86,98}) do hline(fx, fy+yy, 192, VIOLET) end
for k=-14,14 do   -- rays clipped to the tile interior so the INK frame stays clean
  local x0, y0, x1, y1 = fx+96 + k*2, fy+56, fx+96 + k*18, fy+99
  local n = math.max(math.abs(x1-x0), math.abs(y1-y0))
  for t=0,n do
    local x = x0 + math.floor((x1-x0)*t/n + 0.5)
    local y = y0 + math.floor((y1-y0)*t/n + 0.5)
    if x > fx and x < fx+191 and y < fy+99 then px(x, y, VIOLET) end
  end
end
-- desk (Memphis): teal top, panel-hi front with confetti
FR(18, 74, 72, 3, TEAL); FB(18, 74, 72, 3, INK)
FR(20, 77, 68, 14, PHI); FB(20, 77, 68, 14, INK)
for _,d in ipairs({{26,81,PINK},{40,85,AMBER},{56,81,TEAL},{70,86,PINK},{80,80,AMBER}}) do
  FR(d[1], d[2], 2, 2, d[3]) end
hline(fx+30, fy+87, 6, MINT); hline(fx+62, fy+83, 6, MINT)
FR(22, 91, 2, 8, INK); FR(84, 91, 2, 8, INK)
-- CRT on desk: marble case, Win95-ish window on the screen
FR(34, 50, 34, 24, MARBLE); FR(66, 51, 1, 22, LINE); FR(35, 72, 32, 1, LINE)
FB(34, 50, 34, 24, INK)
FR(37, 53, 26, 16, SKY); FB(37, 53, 26, 16, INK)
FR(40, 56, 20, 11, PANEL); FB(40, 56, 20, 11, INK)
FR(41, 57, 18, 2, VIOLET); FP(57, 57, MARBLE); FP(55, 57, MARBLE)
hline(fx+42, fy+61, 12, MUTED); hline(fx+42, fy+63, 8, TEAL); hline(fx+42, fy+65, 10, MUTED)
FP(64, 70, MINT)
FR(46, 74, 10, 1, INK)
FR(72, 71, 14, 3, MARBLE); FB(72, 71, 14, 3, INK)

-- chibi A: front, the "yo!" beat - raised hand, clean flat face (no dither)
local cx, cy = 104, 60
FR(cx+1, cy+12, 10, 9, PINK); FB(cx+1, cy+12, 10, 9, INK)
FR(cx+2, cy+21, 3, 6, INK); FR(cx+7, cy+21, 3, 6, INK)
FR(cx, cy, 12, 11, SKIN); FB(cx, cy, 12, 11, INK)
FR(cx, cy-1, 12, 4, INK); FR(cx-1, cy, 2, 6, INK); FR(cx+11, cy, 2, 6, INK)
FP(cx+3, cy+5, INK); FP(cx+3, cy+6, INK); FP(cx+8, cy+5, INK); FP(cx+8, cy+6, INK)
FP(cx+2, cy+8, CORAL); FP(cx+9, cy+8, CORAL)
FP(cx+5, cy+8, INK); FP(cx+6, cy+8, INK)
FR(cx+12, cy+6, 2, 7, PINK); for j=6,12 do FP(cx+14, cy+j, INK) end
FR(cx+12, cy+2, 4, 4, SKIN); FB(cx+12, cy+2, 4, 4, INK)
-- needs-you bubble: marble fill, ink line, bold pink "!"
FR(cx+14, cy-16, 13, 12, MARBLE); FB(cx+14, cy-16, 13, 12, INK)
FP(cx+15, cy-4, INK); FP(cx+16, cy-4, INK); FP(cx+15, cy-3, INK)
FR(cx+19, cy-14, 3, 5, PINK); FR(cx+19, cy-8, 3, 2, PINK)

-- chibi B: back of head, seated, working at a second CRT
local bx, by = 140, 66
FR(bx-4, by-14, 24, 18, MARBLE); FR(bx+18, by-13, 1, 16, LINE); FB(bx-4, by-14, 24, 18, INK)
FR(bx-8, by+4, 32, 3, TEAL); FB(bx-8, by+4, 32, 3, INK)
FR(bx-6, by+7, 2, 16, INK); FR(bx+20, by+7, 2, 16, INK)
FR(bx+1, by+10, 12, 10, TEAL); FB(bx+1, by+10, 12, 10, INK)
FR(bx+5, by+9, 4, 2, SKIN)
FR(bx, by-2, 14, 12, INK); FR(bx+1, by-3, 12, 1, INK)
FR(bx+5, by+2, 4, 2, PINK)
FR(bx+6, by+4, 2, 6, INK)
FR(bx+2, by+20, 10, 3, VIOLET); FB(bx+2, by+20, 10, 3, INK)
FR(bx+6, by+23, 2, 7, INK)
box(fx, fy, 192, 100, INK)

-- ---------- mini UI mock (192x100 at 4,154) ----------
local ux, uy = 4, 154
local function UR(x, y, w, h, c) rect(ux+x, uy+y, w, h, c) end
local function UB(x, y, w, h, c) box(ux+x, uy+y, w, h, c) end
local function UT(x, y, s, c) text(ux+x, uy+y, s, c) end
UR(0, 0, 192, 100, BG)
UR(170, 70, 3, 3, TEAL); UR(178, 82, 2, 6, PINK); UR(158, 90, 6, 2, AMBER); UR(184, 64, 2, 2, MINT)
-- window with flat violet title bar
UR(6, 6, 146, 88, PANEL)
vgrad(ux+7, 144, {{uy+78,PANEL},{uy+93,PHI}})   -- panel fade (gradient: dither allowed)
UB(6, 6, 146, 88, LINE)
UR(7, 7, 144, 9, VIOLET)
UT(10, 9, "VIBESQUAD.EXE", INK)
for k=0,2 do local b = 120 + k*10; UR(b, 8, 8, 7, MARBLE); UB(b, 8, 8, 7, INK) end
UT(122, 9, "-", INK); UT(132, 9, "O", INK); UT(142, 9, "X", INK)
UT(12, 22, "TEAM NEON", TEXT)
UT(12, 30, "3 AGENTS LIVE", MUTED)
UT(12, 38, "LEAD: BUDDY", TEAL)
hline(ux+12, uy+46, 134, LINE)
UT(12, 51, "TEXT ON PANEL", TEXT)
UT(12, 58, "MUTED ON PANEL", MUTED)
-- needs-you badge: pink fill, BG-slot label
UR(92, 20, 51, 9, PINK); UB(92, 20, 51, 9, INK)
UT(95, 22, "! NEEDS YOU", BG)
-- buttons
UR(12, 68, 34, 11, PHI); UB(12, 68, 34, 11, LINE); UT(18, 71, "CANCEL", TEXT)
UR(52, 68, 26, 11, TEAL); UB(52, 68, 26, 11, INK); UT(58, 71, "SEND", BG)
-- status chips
for k,c in ipairs({MINT, AMBER, PINK}) do
  local yy = 10 + (k-1)*14
  UR(158, yy, 30, 10, PANEL); UB(158, yy, 30, 10, LINE); UR(161, yy+3, 4, 4, c)
  UT(167, yy+3, ({"RUN","WAIT","YOU"})[k], MUTED)
end
UT(158, 52, "TEXT", TEXT); UT(158, 59, "ON BG", MUTED)
box(ux, uy, 192, 100, INK)

local function header(name) rect(0, 0, W, 11, BG); text(4, 4, name, TEXT) end

local out = root.."/scratch/shots/"
header("MIDNIGHT MALL - DARK");   spr:setPalette(pal.dark);  spr:saveCopyAs(out.."palette-p0-dark-1x.png")
header("PASTEL MORNING - LIGHT"); spr:setPalette(pal.light); spr:saveCopyAs(out.."palette-p0-light-1x.png")

-- compose side by side at 3x nearest
local A = Image{ fromFile = out.."palette-p0-dark-1x.png" }
local B = Image{ fromFile = out.."palette-p0-light-1x.png" }
local function asRGB(src, p)
  local r = Image(src.width, src.height, ColorMode.RGB)
  for y=0,src.height-1 do for x=0,src.width-1 do
    local v = src:getPixel(x, y)
    if src.colorMode == ColorMode.INDEXED then
      local c = p:getColor(v); v = app.pixelColor.rgba(c.red, c.green, c.blue, 255)
    end
    r:drawPixel(x, y, v)
  end end
  return r
end
A = asRGB(A, pal.dark); B = asRGB(B, pal.light)
local GAP, S = 4, 3
local comp = Image((W*2 + GAP)*S, H*S, ColorMode.RGB)
comp:clear(app.pixelColor.rgba(7, 4, 15, 255))
local function blit(src, ox)
  for y=0,H-1 do for x=0,W-1 do
    local p = src:getPixel(x, y)
    for j=0,S-1 do for i=0,S-1 do comp:drawPixel((ox+x)*S+i, y*S+j, p) end end
  end end
end
blit(A, 0); blit(B, W + GAP)
comp:saveAs(out.."palette-p0.png")
print("wrote "..out.."palette-p0.png "..comp.width.."x"..comp.height)
