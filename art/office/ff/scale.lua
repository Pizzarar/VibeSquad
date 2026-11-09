-- FF (docs/PLAN_FLOOR_FACES.md): re-raster helpers for the 48px floor cast + the 960x498 floor kit.
-- wrap(C, s, ox, oy) = a canvas with the lib.lua API (px/get/rect/hline/vline/line/ellipse/poly/spans/outline)
-- whose shape coordinates are scaled by s before they are rasterised. Shapes are re-drawn at the target
-- resolution (ellipses/polys keep their curves, 1px lines and outlines stay 1px), so nothing is a
-- nearest-neighbour upscale or downscale of finished pixels.
--   s = 0.7  : a 64px bust head drawn straight into a 48px floor cell (the bust's own face, smaller)
--   s = 1.5  : a 32px floor piece (H1b floor heads, bubble) redrawn into the 48px grid
-- canvas(w, h) = a free-standing canvas (no sprite/cel) with the same API, for scratch work.
return function(L)
local M = {}
local fl = math.floor

function M.canvas(w, h)
  local fake = { width = w, height = h, newCel = function() return {} end }
  return L.canvas(fake, nil, nil)
end

-- edge map, round half to even (mirror-safe: 960 - E(640 - v) == E(v))
function M.even(t)
  local f = fl(t)
  if t - f == 0.5 then return (f % 2 == 0) and f or f + 1 end
  return fl(t + 0.5)
end

-- opt.area: px / 1px lines cover the whole scaled pixel area [E(x), E(x+1)) (1 or 2 px; the floor kit
-- then runs M.thin on the layer so every accidental 2px run collapses back to 1px), stamps draw 2x2 blocks.
function M.wrap(C, s, ox, oy, opt)
  ox, oy = ox or 0, oy or 0
  local area = opt and opt.area
  local W = { img = C.img, w = C.w, h = C.h, raw = C, s = s }
  local function P(v) return fl((v + 0.5) * s) end   -- pixel index -> pixel index (centre map)
  local E = area and function(v) return M.even(v * s) end or function(v) return fl(v * s + 0.5) end
  W.P, W.E = P, E
  function W.px(x, y, c)
    if area then C.rect(E(x) + ox, E(y) + oy, E(x + 1) - E(x), E(y + 1) - E(y), c)
    else C.px(P(x) + ox, P(y) + oy, c) end
  end
  function W.get(x, y) return C.get(P(x) + ox, P(y) + oy) end
  function W.rect(x, y, w, h, c)
    local x0, x1, y0, y1 = E(x), E(x + w), E(y), E(y + h)
    if w <= 1 and not area then x0 = P(x); x1 = x0 + 1 end
    if h <= 1 and not area then y0 = P(y); y1 = y0 + 1 end
    if x1 <= x0 then x1 = x0 + 1 end
    if y1 <= y0 then y1 = y0 + 1 end
    C.rect(x0 + ox, y0 + oy, x1 - x0, y1 - y0, c)
  end
  function W.hline(x, y, w, c) W.rect(x, y, w, 1, c) end
  function W.vline(x, y, h, c) W.rect(x, y, 1, h, c) end
  function W.line(x0, y0, x1, y1, c) C.line(P(x0) + ox, P(y0) + oy, P(x1) + ox, P(y1) + oy, c) end
  function W.ellipse(cx, cy, rx, ry, c, wl, wr)
    C.ellipse((cx + 0.5) * s - 0.5 + ox, (cy + 0.5) * s - 0.5 + oy, rx * s, ry * s, c,
      s >= 1 and wl or nil, s >= 1 and wr or nil)
  end
  function W.poly(pts, c)
    local q = {}
    for i = 1, #pts, 2 do q[i] = pts[i] * s + ox; q[i + 1] = pts[i + 1] * s + oy end
    C.poly(q, c)
  end
  function W.spans(t, c) for _, sp in ipairs(t) do W.rect(sp[2], sp[1], sp[3] - sp[2] + 1, 1, c) end end
  function W.stamp(x0, y0, art, key)
    key = key or L.KEY
    if area then   -- 2x2 blocks from the scaled origin (even, crisp; never a 1.5 smear)
      local r, bx, by = 0, E(x0) + ox, E(y0) + oy
      for row in art:gmatch("[^\n]+") do
        row = row:gsub("^%s*|", ""):gsub("|%s*$", "")
        for i = 1, #row do
          local ch = row:sub(i, i)
          if ch ~= "." and ch ~= " " and key[ch] then C.rect(bx + (i - 1) * 2, by + r * 2, 2, 2, key[ch]) end
        end
        r = r + 1
      end
      return
    end
    local r = 0
    for row in art:gmatch("[^\n]+") do
      row = row:gsub("^%s*|", ""):gsub("|%s*$", "")
      for i = 1, #row do
        local ch = row:sub(i, i)
        if ch ~= "." and ch ~= " " and key[ch] then W.rect(x0 + i - 1, y0 + r, 1, 1, key[ch]) end
      end
      r = r + 1
    end
  end
  W.outline = C.outline
  W.rim = C.rim
  W.flipH = C.flipH
  W.commit = function() end
  return W
end

-- thin(C, cx): every run of exactly 2 same-colour px (horizontal, then vertical) whose two neighbours are
-- other colours collapses to 1px. These runs only come from 1px features landing on a 2px-wide scaled pixel
-- (scaled widths >= 2 always come out >= 3), so outlines, bevels, seams and shine dots end up 1px again.
-- The freed pixel takes the neighbour on its side: the painted side over transparent, else the longer run,
-- ties to the side away from the mirror axis cx (keeps team B a mirror of team A).
function M.thin(C, cx)
  local img, w, h = C.img, C.w, C.h
  local function pass(horiz)
    local n1, n2 = horiz and h or w, horiz and w or h
    local function get(a, b) if horiz then return img:getPixel(b, a) end return img:getPixel(a, b) end
    local function put(a, b, v) if horiz then img:drawPixel(b, a, v) else img:drawPixel(a, b, v) end end
    for a = 0, n1 - 1 do
      local b = 0
      local row = {}
      for i = 0, n2 - 1 do row[i] = get(a, i) end
      while b < n2 do
        local v = row[b]
        local e = b
        while e + 1 < n2 and row[e + 1] == v do e = e + 1 end
        if e == b + 1 and v ~= 0 then
          local lv = b > 0 and row[b - 1] or -1
          local rv = e < n2 - 1 and row[e + 1] or -1
          if lv ~= -1 and rv ~= -1 then
            local function runlen(i, dir) local c0, k = row[i], 0
              while i >= 0 and i < n2 and row[i] == c0 and k < 64 do k = k + 1; i = i + dir end
              return k end
            local side
            if lv == 0 and rv == 0 then side = nil
            elseif lv == 0 then side = "r" elseif rv == 0 then side = "l"
            else
              local ll, rl = runlen(b - 1, -1), runlen(e + 1, 1)
              if ll ~= rl then side = ll > rl and "l" or "r"
              else side = (horiz and cx and b < cx) and "l" or "r" end
            end
            if side == "l" then put(a, b, lv) elseif side == "r" then put(a, e, rv)
            else -- lone 2px dot/line on transparency: drop the pixel away from the axis
              if horiz and cx and b >= cx then put(a, e, 0) else put(a, b, 0) end
            end
          end
        end
        b = e + 1
      end
    end
  end
  pass(true); pass(false)
end

-- flatten canvases (in order) into one w x h indexed image
function M.flatten(list, w, h)
  local o = Image(w, h, ColorMode.INDEXED); o:clear(0)
  for _, c in ipairs(list) do
    for y = 0, h - 1 do for x = 0, w - 1 do
      local v = c.img:getPixel(x, y)
      if v ~= 0 then o:drawPixel(x, y, v) end
    end end
  end
  return o
end

return M
end
