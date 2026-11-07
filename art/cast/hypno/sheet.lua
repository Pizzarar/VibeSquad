-- H0 labelled sheet: rows = roles, cols = WORKING / NEEDS-YOU / BUST. The sheet is one
-- INDEXED sprite, exported with each palette (pure swap), shown at 3x nearest with a 1x
-- strip under it. Writes scratch/shots/cast-h0-dark.png and cast-h0-light.png.
return function(L, root, pal, ROLES, out)
  local LABEL = { lead = "LEAD", buddy = "BUDDY", implement = "IMPLEMENT", review = "REVIEW" }
  local SUB = { lead = "BRICK PHONE", buddy = "WALKMAN KID", implement = "HACHIMAKI", review = "FEDORA" }
  local LW, CW, BW, RH, PAD = 50, 40, 72, 76, 6
  local W = PAD + LW + PAD + CW + PAD + CW + PAD + BW + PAD
  local TOP = 34
  local H = TOP + #ROLES*RH + PAD
  local spr = L.new(W, H, pal.dark)
  local C = L.canvas(spr, spr.layers[1], spr.frames[1])

  -- tiled late-90s wallpaper: tiny 4-point stars on PANEL, offset rows
  C.rect(0, 0, W, H, L.PANEL)
  for y=2,H-1,12 do for x=((y//12)%2)*8+2, W-1, 16 do
    C.px(x, y, L.PHI); C.px(x-1, y, L.PHI); C.px(x+1, y, L.PHI); C.px(x, y-1, L.PHI); C.px(x, y+1, L.PHI)
  end end

  -- title bar (Win95-ish): violet bar, bevelled close buttons
  C.rect(2, 2, W-4, 11, L.VIOLET)
  C.hline(2, 2, W-4, L.MARBLE); C.hline(2, 12, W-4, L.INK)
  L.text(C, 6, 5, "H0 CAST.EXE - HYPNO OFFICE", L.MARBLE)
  for i=0,2 do L.plate(C, W-12-i*10, 4, 7, 7, L.MARBLE, L.MARBLE, L.LINE) end
  C.hline(W-30, 9, 3, L.INK)
  C.rect(W-20, 6, 3, 3, L.INK); C.rect(W-19, 7, 1, 1, L.MARBLE)
  C.line(W-10, 6, W-8, 8, L.INK); C.line(W-8, 6, W-10, 8, L.INK)
  L.twinkle(C, W-48, 7, L.AMBER, L.MARBLE, 2)

  -- column header plates
  local cx = { PAD + LW + PAD, PAD + LW + PAD + CW + PAD, PAD + LW + PAD + (CW + PAD)*2 }
  local heads = { "WORKING", "NEEDS-YOU", "BUST 64" }
  local widths = { CW, CW, BW }
  for i=1,3 do
    L.plate(C, cx[i], 18, widths[i], 11, L.LINE, L.MARBLE, L.INK)
    local s = heads[i]
    L.text(C, cx[i] + (widths[i] - L.textW(s))//2, 21, s, i == 2 and L.PINK or L.TEXT)
  end

  local function blit(img, x, y)
    for j=0,img.height-1 do for i=0,img.width-1 do
      local v = img:getPixel(i, j); if v ~= 0 then C.px(x+i, y+j, v) end
    end end
  end
  local function well(x, y, w, h)
    -- sunken Win95 well (dark top-left, light bottom-right)
    C.rect(x, y, w, h, L.BG)
    C.hline(x-1, y-1, w+1, L.INK); C.vline(x-1, y-1, h+1, L.INK)
    C.hline(x-1, y+h, w+2, L.MARBLE); C.vline(x+w, y-1, h+2, L.MARBLE)
  end

  for n, r in ipairs(ROLES) do
    local y = TOP + (n-1)*RH
    -- role label plate
    L.plate(C, PAD, y + 22, LW, 24, L.LINE, L.MARBLE, L.INK)
    L.text(C, PAD + 3, y + 26, LABEL[r], L.TEXT)
    C.hline(PAD + 3, y + 32, L.textW(LABEL[r]), L.PINK)
    local sub = SUB[r]
    if L.textW(sub) > LW - 6 then sub = sub:sub(1, (LW-3)//4) end
    L.text(C, PAD + 3, y + 36, sub, L.MUTED)
    -- floor cells (32px sprites centred in 40px wells)
    for f=1,2 do
      well(cx[f], y + 16, CW, CW)
      blit(out.floor[r][f], cx[f] + 4, y + 20)
    end
    well(cx[3], y + 2, BW, BW - 2)
    blit(out.bust[r], cx[3] + 4, y + 4)
  end
  -- little doodle twinkles on the wallpaper margin
  L.twinkle(C, 10, TOP + 6, L.AMBER, L.MARBLE, 1); L.twinkle(C, 44, H - 12, L.TEAL, nil, 1)

  -- 1x strip: every sprite at real size on BG
  local SW, SH = PAD + #ROLES*(32+2+32+4+64+8), 64 + 14
  local strip = L.new(SW, SH, pal.dark)
  local S = L.canvas(strip, strip.layers[1], strip.frames[1])
  S.rect(0, 0, SW, SH, L.BG)
  L.text(S, 4, 3, "1X", L.MUTED)
  local x = PAD
  for _, r in ipairs(ROLES) do
    for f=1,2 do
      local img = out.floor[r][f]
      for j=0,31 do for i=0,31 do local v = img:getPixel(i, j); if v ~= 0 then S.px(x+i, 12+32+j, v) end end end
      x = x + 34
    end
    x = x + 2
    local img = out.bust[r]
    for j=0,63 do for i=0,63 do local v = img:getPixel(i, j); if v ~= 0 then S.px(x+i, 12+j, v) end end end
    x = x + 72
  end
  S.commit()
  C.commit()

  local function toRGB(img, p)
    local r = Image(img.width, img.height, ColorMode.RGB)
    for j=0,img.height-1 do for i=0,img.width-1 do
      local c = p:getColor(img:getPixel(i, j))
      r:drawPixel(i, j, app.pixelColor.rgba(c.red, c.green, c.blue, 255))
    end end
    return r
  end
  local sheetImg = Image(W, H, ColorMode.INDEXED); sheetImg:drawSprite(spr, 1)
  local stripImg = Image(SW, SH, ColorMode.INDEXED); stripImg:drawSprite(strip, 1)
  local Z = 3
  for _, mode in ipairs({"dark", "light"}) do
    local a, b = toRGB(sheetImg, pal[mode]), toRGB(stripImg, pal[mode])
    local OW = math.max(W*Z, SW)
    local comp = Image(OW, H*Z + SH, ColorMode.RGB)
    local bg = pal[mode]:getColor(0)
    comp:clear(app.pixelColor.rgba(bg.red, bg.green, bg.blue, 255))
    for j=0,H-1 do for i=0,W-1 do
      local v = a:getPixel(i, j)
      for q=0,Z-1 do for p=0,Z-1 do comp:drawPixel(i*Z+p, j*Z+q, v) end end
    end end
    comp:drawImage(b, Point(0, H*Z))
    local path = root.."/scratch/shots/cast-h0-"..mode..".png"
    comp:saveAs(path)
    print("wrote "..path.." "..comp.width.."x"..comp.height)
  end
  spr:saveAs(root.."/art/cast/hypno/sheet.aseprite")
  -- painter's zoom of the floor sprites (8x, both palettes) for checking by eye
  local Zf = 8
  local zoom = Image((34*2*#ROLES)*Zf, 68*Zf, ColorMode.RGB)
  for m, mode in ipairs({"dark", "light"}) do
    local p = pal[mode]; local x0 = 0
    for _, r in ipairs(ROLES) do for f=1,2 do
      local img = out.floor[r][f]
      for j=0,31 do for i=0,31 do
        local v = img:getPixel(i, j); local c = p:getColor(v ~= 0 and v or 1)
        local px = app.pixelColor.rgba(c.red, c.green, c.blue, 255)
        for q=0,Zf-1 do for o=0,Zf-1 do zoom:drawPixel((x0+i)*Zf+o, ((m-1)*34+j)*Zf+q, px) end end
      end end
      x0 = x0 + 34
    end end
  end
  zoom:saveAs(root.."/scratch/h0/floor-zoom.png")
end
