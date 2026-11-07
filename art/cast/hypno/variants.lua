-- Contract v2 per-agent variants: 4 looks per desk role (v0 = the approved H0/S1 drawing, v1-v3 below).
-- Each variant is hand-picked, per role: a P0 slot remap for skin/fur (+ face blush), hair (or the
-- role's hair stand-in: cap, beret, whiskers, antenna tips), outfit, plus one hand-drawn accessory.
-- The same spec drives the 32px floor cast (art/office/build_cast.lua) and the 64px busts
-- (art/cast/hypno/build_variants.lua), so floor variant v and bust column v are the same person.
--   head : slot -> slot on head/face/hair pixels (skin, fur, blush, headgear)
--   hair : interior INK hair mass -> `to`, its VIOLET streaks -> `hi` (outline + hairline stay INK)
--   body : slot -> slot on the torso/sleeves/trousers (outfit)
--   prop : slot -> slot on held props / headphones
--   acc  : { name, x = main slot, z = second slot, f = {dx,dy} floor nudge, b = {dx,dy} bust nudge }
-- Accessory maps are fills only ('x' main, 'z' second, 'm' MARBLE, 'k' INK); the builder adds the
-- 1px INK outline (house style: blob = fill + outline).
local K, V, P, CO, A, S, M, T, G = 15, 8, 9, 10, 11, 14, 4, 7, 12
local VAR = {}

-- ---------- accessories: floor (32px cell) and bust (64px cell) ----------
-- kind: "top" sits on the crown, "side" clips to the upper right of the head, "neck" wraps the neck
VAR.ACC = {
  bow = { kind = "side",
    f = [[
|xx...xx|
|xzx.xzx|
|xxxkxxx|
|xzx.xzx|
|xx...xx|
]],
    b = [[
|xxx.....xxx|
|xzzxx.xxzzx|
|xzxxxkxxxzx|
|xxxxkxkxxxx|
|xzxxxkxxxzx|
|xzzxx.xxzzx|
|xxx.....xxx|
]] },
  flower = { kind = "side",
    f = [[
|.x.x.|
|xxxxx|
|.xzx.|
|xxxxx|
|.x.x.|
]],
    b = [[
|.xx.xx.|
|xxxxxxx|
|xxzzzxx|
|.xzmzx.|
|xxzzzxx|
|xxxxxxx|
|.xx.xx.|
]] },
  party = { kind = "top", sink = 2, bsink = 3,
    f = [[
|..m..|
|..x..|
|.xzx.|
|.zxx.|
|xxzxx|
|xzxxz|
]],
    b = [[
|...mmm...|
|..mmmmm..|
|...mmm...|
|....x....|
|...xxz...|
|...xzz...|
|..xzzxx..|
|..zzxxx..|
|.xxxxzzx.|
|.xxxzzxx.|
|xxxxxxzzx|
|xzzxxxxxx|
]] },
  propeller = { kind = "top", sink = 2, bsink = 4,
    f = [[
|zzzkzzz|
|...k...|
|..xxx..|
|.xxmxx.|
|xxxxxxx|
]],
    b = [[
|zzzzzkzzzzz|
|zmzzzkzzzmz|
|.....k.....|
|.....k.....|
|...xxxxx...|
|..xxmmxxx..|
|.xxmxxxxxx.|
|xxxxxxxxxxx|
|xzxxzxxzxxz|
]] },
  crown = { kind = "top", sink = 1, bsink = 3,
    f = [[
|x..x..x|
|xx.x.xx|
|xxxxxxx|
|xzxxxzx|
]],
    b = [[
|z.....z.....z|
|x....xxx....x|
|xx..xxxxx..xx|
|xxxxxxxxxxxxx|
|xxxzxxxxxzxxx|
|xxxxxxzxxxxxx|
|xxxxxxxxxxxxx|
]] },
  medal = { kind = "neck",
    f = [[
|x...x|
|.x.x.|
|..x..|
|.zzz.|
|.zmz.|
|.zzz.|
]],
    fb = [[
|xxxxxxxxxxxxxxxx|
]],
    b = [[
|xx.......xx|
|.xx.....xx.|
|..xx...xx..|
|...xx.xx...|
|....xxx....|
|...zzzzz...|
|..zzmmzzz..|
|..zmzzzzz..|
|..zzzzzzz..|
|...zzzzz...|
]] },
  scarf = { kind = "neck",
    -- floor front: ring under the chin + a tail down the chest
    f = [[
|xxzxxzxxzxxz|
|xzxxzxxzxxzx|
|.......xz...|
|.......zx...|
]],
    -- floor back (work): ring round the neck, seen from above; ends show past the head
    fb = [[
|xxzxxzxxzxxzxxzxxz|
|xzxxzxxzxxzxxzxxzx|
]],
    b = [[
|xxzxxzxxzxxzxxzxxzxxzxxzxxzx|
|xxzxxzxxzxxzxxzxxzxxzxxzxxzx|
|xxzxxzxxzxxzxxzxxzxxzxxzxxzx|
|..................xxxxx.....|
|..................xxzzx.....|
|..................xxxxx.....|
|..................xzzxx.....|
]] },
}

-- ---------- per-role variants (v1..v3; v0 is the base drawing) ----------
VAR.roles = {
  -- hand = the slot the role's hands/necks are drawn in (follows the head map); 0 = hands keep v0 colour
  -- MARBLE is kept off main fills: it is near-white in the light palette and vanishes on the light floor.
  lead = { hand = S,
    { head = {[S]=CO, [CO]=P, [T]=M}, hair = {to=A, hi=M}, body = {[P]=T, [A]=P, [T]=P}, acc = {"party", x=P, z=M} },
    { head = {[S]=A, [T]=A},          hair = {to=CO, hi=A}, body = {[P]=V, [A]=M, [T]=A}, acc = {"bow", x=T, z=M} },
    { head = {[S]=CO, [CO]=P, [T]=P}, hair = {to=V, hi=P}, body = {[P]=G, [A]=V, [T]=V}, acc = {"crown", x=A, z=P} },
  },
  -- headphones stay amber band + pink cups in every look; hair and collar never take those slots
  buddy = { hand = S,
    { head = {[S]=A},          hair = {to=V, hi=M}, body = {[T]=G, [P]=T, [A]=M}, acc = {"scarf", x=T, z=M} },
    { head = {[S]=CO, [CO]=P}, hair = {to=T, hi=M}, body = {[T]=A, [P]=T, [A]=V}, acc = {"bow", x=V, z=M} },
    { head = {[S]=A},          hair = {to=CO, hi=A}, body = {[T]=V, [P]=A, [A]=T}, acc = {"flower", x=T, z=A} },
  },
  implement = { hand = S,
    { head = {[A]=T, [CO]=V, [T]=G, [G]=T, [P]=A, [S]=CO}, body = {[M]=A, [P]=V, [V]=P}, prop = {[P]=A}, acc = {"party", x=P, z=M} },
    { head = {[A]=P, [CO]=V, [G]=M, [S]=A},                body = {[M]=T, [P]=A, [V]=M}, prop = {[P]=T}, acc = {"bow", x=A, z=M} },
    { head = {[A]=V, [CO]=A, [T]=P, [G]=CO, [S]=CO, [P]=G}, body = {[M]=P, [P]=T, [V]=T}, prop = {[P]=G}, acc = {"propeller", x=G, z=P} },
  },
  -- the eyeball stays clear: neck pieces, or a flower on the side of the head blob (fdrop/bdrop)
  review = { hand = G,
    { head = {[G]=T, [T]=P},                body = {[V]=A, [P]=T, [A]=P}, acc = {"scarf", x=P, z=M} },
    { head = {[G]=P, [P]=V, [T]=G, [CO]=A}, body = {[V]=T, [P]=A, [A]=P}, acc = {"medal", x=V, z=A} },
    { head = {[G]=A, [T]=V},                body = {[V]=G, [P]=V},         acc = {"flower", x=P, z=T, fdrop=12, bdrop=40} },
  },
  -- walrus stays in warm skin tones (gold / peach); variety from cardigan + accessory
  ["retired-lead"] = { hand = CO,
    { head = {[CO]=A, [P]=CO}, body = {[A]=T},  prop = {[P]=A}, acc = {"scarf", x=V, z=M} },
    { head = {[CO]=S},         body = {[A]=V},  prop = {[P]=T}, acc = {"crown", x=P, z=M} },
    { head = {[CO]=A, [P]=CO}, body = {[A]=P},  prop = {[P]=T}, acc = {"medal", x=T, z=A} },
  },
  mechanical = { hand = M,
    { head = {[M]=A, [P]=T},  body = {[T]=V, [A]=M}, acc = {"bow", x=P, z=M} },
    { head = {[M]=G, [P]=A},  body = {[T]=P, [A]=T}, acc = {"scarf", x=V, z=A} },
    { head = {[M]=CO, [P]=V}, body = {[T]=A, [A]=V}, acc = {"flower", x=T, z=M} },
  },
  -- owl: back-of-head speckles fold into the feather colour; wing-hands + flashlight beam stay amber
  audit = { hand = 0,
    { head = {[A]=CO, [V]=T},          body = {[V]=T}, acc = {"scarf", x=P, z=M} },
    { head = {[A]=T, [CO]=T, [V]=P},   body = {[V]=P}, acc = {"bow", x=A, z=M} },
    { head = {[A]=S, [CO]=S, [V]=G},   body = {[V]=G}, acc = {"flower", x=P, z=A} },
  },
  spec = { hand = M,
    { head = {[M]=A, [A]=P},  body = {[G]=P, [P]=A},  acc = {"party", x=T, z=M} },
    { head = {[M]=V, [A]=T},  body = {[G]=A, [P]=T},  acc = {"bow", x=P, z=M} },
    { head = {[M]=CO, [A]=G}, body = {[G]=V, [P]=G},  acc = {"scarf", x=T, z=M} },
  },
  art = { hand = M,
    { head = {[M]=A, [P]=T},  body = {[T]=P, [P]=T},  acc = {"scarf", x=V, z=M} },
    { head = {[M]=CO, [P]=V}, body = {[T]=A, [A]=V},  acc = {"flower", x=T, z=M} },
    { head = {[M]=P, [P]=G},  body = {[T]=V, [G]=A},  acc = {"bow", x=T, z=M} },
  },
  unknown = { hand = M,
    { head = {[A]=T, [CO]=G},  body = {[CO]=P},         acc = {"party", x=P, z=A} },
    { head = {[A]=P, [CO]=V},  body = {[CO]=V, [A]=P},  acc = {"crown", x=A, z=T} },
    { head = {[A]=G, [CO]=T},  body = {[CO]=A, [A]=CO}, acc = {"propeller", x=V, z=P} },
  },
}

-- remap an indexed image in place: map = { [from] = to }
function VAR.remap(img, map)
  if not map or next(map) == nil then return end
  local w, h = img.width, img.height
  for y=0,h-1 do for x=0,w-1 do
    local v = img:getPixel(x, y)
    local to = map[v]
    if to then img:drawPixel(x, y, to) end
  end end
end

-- hair: interior INK (all 4 neighbours INK/VIOLET) -> to; VIOLET touching that mass -> hi.
-- Outline, hairline and facial ink (eyes, brows) border skin/transparent, so they stay INK.
function VAR.hair(img, spec, ymax)
  if not spec then return end
  local w, h = img.width, img.height
  local function g(x, y) if x < 0 or y < 0 or x >= w or y >= h then return 0 end return img:getPixel(x, y) end
  local inner, streak = {}, {}
  for y=0,math.min(h, ymax or h)-1 do for x=0,w-1 do
    local v = g(x, y)
    if v == K or v == V then
      local ok = true
      for _, d in ipairs({{-1,0},{1,0},{0,-1},{0,1}}) do
        local n = g(x+d[1], y+d[2]); if n ~= K and n ~= V then ok = false; break end
      end
      if ok then if v == K then inner[#inner+1] = {x, y} else streak[#streak+1] = {x, y} end end
    end
  end end
  for _, q in ipairs(inner) do img:drawPixel(q[1], q[2], spec.to) end
  for _, q in ipairs(streak) do img:drawPixel(q[1], q[2], spec.hi or spec.to) end
end

-- merged map for hand-bearing canvases (torso, arms, props): body wins, then the skin slot from head
function VAR.handMap(role, v, extra)
  local R = VAR.roles[role]; local s = R[v]
  local m = {}
  if R.hand ~= 0 and s.head and s.head[R.hand] then m[R.hand] = s.head[R.hand] end
  for k, to in pairs(extra or {}) do m[k] = to end
  return m
end

-- stamp an accessory map (fill) onto canvas C at x,y with its slots, then INK-outline it
function VAR.drawAcc(L, C, map, x, y, acc)
  local key = { x = acc.x, z = acc.z, m = M, k = K }
  C.stamp(x, y, map, key)
  C.outline(K)
end

function VAR.size(map)
  local w, h = 0, 0
  for row in map:gmatch("[^\n]+") do
    row = row:gsub("^%s*|", ""):gsub("|%s*$", ""); w = math.max(w, #row); h = h + 1
  end
  return w, h
end

-- head anchor: bbox + the side clip point (rightmost pixel `drop` rows below the crown)
function VAR.anchor(img, drop)
  local x0, y0, x1, y1 = VAR.bbox(img)
  local t = { x0, y0, x1, y1 }
  local sy = y0 + (drop or 3)
  local sx = x1
  for x=img.width-1,0,-1 do if img:getPixel(x, sy) ~= 0 then sx = x; break end end
  t.sx, t.sy = sx, sy
  return t
end

-- bbox of non-transparent pixels: x0, y0, x1, y1 (nil if empty)
function VAR.bbox(img)
  local x0, y0, x1, y1
  for y=0,img.height-1 do for x=0,img.width-1 do
    if img:getPixel(x, y) ~= 0 then
      x0 = x0 and math.min(x0, x) or x; x1 = x1 and math.max(x1, x) or x
      y0 = y0 or y; y1 = y
    end
  end end
  return x0, y0, x1, y1
end

return VAR
