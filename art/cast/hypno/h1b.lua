-- H1b cast variants (docs/art/STYLE_BIBLE.md): v1-v3 of every role are different Hypnospace weirdos
-- (new head shape / species / oddity) wearing the role's own H0 costume; v0 stays the H0 drawing.
-- Each variant has a 64px bust head and a 32px floor head, both with a rest face and a "yo!" face.
--   bust(C, mood)  C = named canvases {arm, head, hair, face, mouth, prop, fx, bubble}; the role's H0
--                  body (+ its held prop) is copied in underneath by the builder; mood = "rest" | "yo"
--   floor(N, view) N() = new 32x32 canvas; returns the canvases in draw order; view = "rest" | "yo" | "back"
--                  (back = the work pose, seen from behind and above, drawn facing right before the flip)
-- Hand-placed shapes on the H0 helpers (lib.lua): wobbly ellipses, lopsided polys, 1px INK outline per
-- layer, googly MARBLE eyes, INK line mouths, P0 slots only. No dithering on figures.
return function(L)
local K, V, P, CO, A, S, M, T, G = 15, 8, 9, 10, 11, 14, 4, 7, 12
local WOB_L = {0,0,-1,0,0,1,0,0,0,-1,0,0,1,0,0,0,0,-1,0}
local WOB_R = {0,1,0,0,0,0,1,1,0,0,0,-1,0,0,1,0,0,0,0}
local fl = math.floor
local D = {}

-- ---------- 64px face kit (same language as art/h1/gallery.lua) ----------
local function eyes(C, E) for _, e in ipairs(E) do C.ellipse(e[1], e[2], e[3], e[4], M) end; C.outline(K) end
local function lids(C, E, lidc, frac)
  for _, e in ipairs(E) do
    local top = math.ceil(e[2] - e[4]); local cut = fl(e[2] - e[4] + 2*e[4]*frac + 0.5)
    for y=top, cut do for x=fl(e[1]-e[3])-1, math.ceil(e[1]+e[3])+1 do
      if C.get(x, y) == M then C.px(x, y, y == cut and K or lidc) end
    end end
  end
end
local function pupil(C, x, y, w, h) C.rect(x, y, w or 2, h or 3, K); C.px(x, y, M) end
local function smile(C, x, y, w)
  C.line(x, y, x+2, y+2, K); C.hline(x+2, y+2, w-5, K); C.line(x+w-3, y+2, x+w, y-1, K)
  C.px(x+w//2-1, y+3, P); C.px(x+w//2, y+3, P)
end
local function shout(C, cx, cy, rx, ry) C.ellipse(cx, cy, rx, ry, P) end
local function tongue(C, cx, cy, rx) C.ellipse(cx, cy, rx, 1.6, CO) end
-- generic googly face: o.E eyes, o.lid lid colour, o.mouth {x,y,w} smile, o.shout {cx,cy,rx,ry},
-- o.blush {{x,y,w}}, o.nose {x,y}, o.brow (default on), o.frac lid depth
local function face64(C, mood, o)
  local f, m = C.face, C.mouth
  eyes(f, o.E)
  for _, b in ipairs(o.blush or {}) do f.rect(b[1], b[2], b[3], 2, CO) end
  if o.nose then f.px(o.nose[1], o.nose[2], CO); f.px(o.nose[1]+1, o.nose[2]+1, CO) end
  local bc = o.browc or K
  if mood == "rest" then
    lids(f, o.E, o.lid, o.frac or 0.5)
    for i, e in ipairs(o.E) do
      local h = math.min(3, fl(e[4]))
      pupil(f, fl(e[1] - 1 + (i == 1 and -1 or 0) + 0.5), fl(e[2] + 1 + 0.5), 2, h)
      if o.brow ~= false then
        local t = fl(e[2] - e[4]) - 2
        f.line(fl(e[1]-e[3]), t + (i == 1 and 0 or -1), fl(e[1]+e[3]) + 1, t + (i == 1 and 1 or 0), bc)
      end
    end
    if o.mouth then smile(f, o.mouth[1], o.mouth[2], o.mouth[3]) end
  else
    for i, e in ipairs(o.E) do
      pupil(f, fl(e[1] - 1 + (i == 1 and 0 or 1) + 0.5), fl(e[2] - e[4] + 2 + 0.5), 2, e[4] > 3 and 3 or 2)
      if o.brow ~= false then
        local t = fl(e[2] - e[4]) - 3
        if i == 1 then f.line(fl(e[1]-e[3]) - 1, t + 1, fl(e[1]+e[3]), t - 1, bc)
        else f.line(fl(e[1]-e[3]), t - 1, fl(e[1]+e[3]) + 1, t, bc); f.px(fl(e[1]+e[3]) + 2, t + 1, bc) end
      end
    end
    local s = o.shout
    if s then shout(m, s[1], s[2], s[3], s[4]); m.outline(K); tongue(m, s[1], s[2] + fl(s[4]*0.5), math.max(2, s[3]*0.5)) end
  end
end
local function palm(C, x, y, sc, H)
  if sc then C.poly({x-5, H, x-4, y+4, x+4, y+4, x+5, H}, sc) end
  C.ellipse(x, y, 3.6, 3.6, S)
  C.rect(x-4, y-7, 2, 5, S); C.rect(x-1, y-8, 2, 6, S); C.rect(x+2, y-7, 2, 5, S)
  C.rect(x+4, y-2, 3, 2, S)
end
local function wiggle(C, x, y, side) C.line(x, y, x+side, y-2, K); C.line(x, y+4, x+side*2, y+3, K) end
local function yo(C, x, y, tx, ty)
  C.rect(x+1, y, 17, 11, M); C.rect(x, y+1, 19, 9, M)
  C.poly({x+12, y+9, x+16, y+9, tx, ty}, M)
  C.outline(K)
  L.text(C, x+4, y+3, "YO!", P)
end

-- role costume cues the builder needs: sleeve slot (raised arm) and which side the hand goes
D.sleeve = { lead = P, ["retired-lead"] = A, buddy = T, implement = M, mechanical = T, review = V, audit = V, spec = G, art = T, unknown = CO }
D.handLeft = { lead = true, ["retired-lead"] = true, mechanical = true, audit = true, spec = true, art = true }
-- raised waving hand + "YO!" balloon (every yo bust)
function D.yoExtras(C, role, bub)
  local p = C.prop
  if D.handLeft[role] then palm(p, 9, 39, D.sleeve[role], 64); p.outline(K); wiggle(p, 16, 32, 1)
  else palm(p, 55, 40, D.sleeve[role], 64); p.outline(K); wiggle(p, 48, 33, -1) end
  local b = bub or {2, 2, 20, 16}
  yo(C.bubble, b[1], b[2], b[3], b[4])
  L.twinkle(C.fx, 59, 44, P, nil, 1)
end

-- ---------- 32px face kit ----------
-- E = {{x, y, w, h}, ...} MARBLE eye blocks (left smaller), INK-outlined on their own canvas
local function face32(f, m, view, o)
  for _, e in ipairs(o.E) do f.rect(e[1], e[2], e[3], e[4], M) end
  f.outline(K)
  for _, b in ipairs(o.blush or {}) do f.rect(b[1], b[2], b[3] or 2, 1, CO) end
  local bc = o.browc or K
  if view == "rest" then
    for i, e in ipairs(o.E) do
      if e[4] >= 3 then f.hline(e[1], e[2], e[3], o.lid); f.hline(e[1], e[2]+1, e[3], K)
      else f.hline(e[1], e[2], e[3], K) end
      f.px(e[1] + (i == 1 and 0 or 1), e[2] + e[4] - 1, K)
    end
    local s = o.mouth
    if s then
      f.px(s[1], s[2], K); f.hline(s[1]+1, s[2]+1, s[3]-2, K); f.px(s[1]+s[3]-1, s[2]-(s[4] or 0), K)
      if s[3] >= 5 then f.px(s[1] + s[3]//2, s[2]+2, P) end
    end
  else
    for i, e in ipairs(o.E) do
      f.vline(e[1] + (i == 1 and 0 or 1), e[2], e[4] >= 3 and 2 or 1, K)
      if o.brow ~= false then
        if i == 1 then f.line(e[1]-1, e[2]-2, e[1]+e[3]-1, e[2]-3, bc)
        else f.line(e[1], e[2]-3, e[1]+e[3], e[2]-2, bc) end
      end
    end
    local s = o.shout
    if s then m.rect(s[1], s[2], s[3], s[4], P); m.outline(K); m.hline(s[1]+1, s[2]+s[4]-1, s[3]-2, CO) end
  end
end
local function shine(C, list) for _, q in ipairs(list) do C.px(q[1], q[2], M) end end

-- ====================================================================================
-- LEAD: pink shoulder-pad jacket, teal tie, brick phone
-- ====================================================================================
D.lead = {}
-- v1 CONE HEAD (H1a, owner OK): tall cone skull, comb-over curl, shades at rest, pushed up on "yo!"
D.lead[1] = { name = "CONE HEAD",
  bust = function(C, mood)
    local h = C.head
    h.ellipse(31, 32, 14, 11, S, WOB_L, WOB_R)
    h.poly({18,30, 23,16, 28,6, 32,1, 36,5, 40,16, 45,30}, S)
    h.ellipse(16, 33, 2.6, 3.6, S); h.ellipse(46, 34, 2.6, 3.6, S)
    h.outline(K)
    h.line(26, 15, 29, 7, M); h.px(25, 17, M)
    local r = C.hair
    r.poly({16,30, 18,25, 21,30}, K); r.poly({46,30, 44,25, 41,30}, K)
    r.outline(K)
    r.line(32, 2, 35, 0, K); r.px(36, 1, K); r.px(36, 2, K); r.px(35, 3, K)
    local f, m = C.face, C.mouth
    f.rect(17, 36, 3, 2, CO); f.rect(43, 36, 4, 2, CO)
    f.px(31, 34, CO); f.px(32, 35, CO)
    local function shades(y, x0, x1)
      f.poly({x0, y, x0+10, y, x0+9, y+5, x0+1, y+5}, K)
      f.poly({x1, y-1, x1+12, y-1, x1+11, y+5, x1+1, y+5}, K)
      f.hline(x0+10, y+1, x1-x0-10, K)
      f.line(x0+2, y+1, x0+3, y+2, V); f.line(x1+2, y, x1+4, y+2, V); f.px(x1+9, y+1, M)
    end
    if mood == "rest" then
      shades(27, 18, 32)
      f.line(20, 24, 28, 25, K); f.line(33, 23, 43, 24, K)
      f.line(24, 40, 30, 41, K); f.line(30, 41, 38, 38, K); f.px(36, 40, P); f.px(35, 40, P)
    else
      local E = {{25, 29, 3.6, 4.6}, {38, 28, 4.6, 5.6}}
      eyes(f, E); pupil(f, 25, 26); pupil(f, 38, 24)
      shades(9, 21, 32)
      f.line(20, 21, 27, 19, K); f.line(34, 19, 42, 20, K)
      shout(m, 31, 40, 6.6, 3.6); m.outline(K); tongue(m, 31, 42, 3)
      m.hline(27, 37, 9, M)
    end
  end,
  bub = {2, 2, 22, 18},
  floor = function(N, view)
    local h, r, f, m = N(), N(), N(), N()
    h.ellipse(16, 13, 7.1, 5.1, S, {0,0,-1,0,0}, {0,1,0,0,0})
    h.poly({9,12, 12,6, 15,1, 17,1, 20,6, 23,12}, S)
    h.px(8, 13, S); h.px(24, 14, S)
    h.outline(K)
    if view == "back" then
      r.poly({8,13, 9,9, 11,13}, K); r.poly({24,13, 23,9, 21,13}, K)
      r.line(16, 1, 18, 0, K)
      shine(h, {{13,5},{14,4}})
      return {h, r}
    end
    shine(h, {{13,6},{14,5}})
    r.line(16, 1, 18, 0, K)
    f.px(9, 14, CO); f.px(23, 14, CO); f.px(16, 14, CO)
    if view == "rest" then
      f.rect(10, 10, 5, 2, K); f.rect(17, 9, 6, 3, K); f.hline(15, 10, 2, K); f.px(18, 10, V)
      f.px(13, 16, K); f.hline(14, 17, 4, K); f.px(18, 16, K); f.px(19, 15, K)
      return {h, r, f}
    end
    face32(f, m, "yo", { E = {{11,10,2,3},{18,9,3,4}}, shout = {13,15,6,2}, brow = false })
    f.rect(11, 5, 4, 2, K); f.rect(17, 4, 5, 2, K); f.hline(15, 5, 2, K)
    return {h, r, f, m}
  end }

-- v2 BLOCK HEAD: wobbly brick skull, tall crooked flat-top, gap-tooth grin
D.lead[2] = { name = "BLOCK HEAD",
  bust = function(C, mood)
    local h = C.head
    h.poly({16,17, 31,15, 47,16, 48,29, 46,40, 34,44, 19,42, 15,30}, S)
    h.ellipse(14, 30, 2.6, 3.6, S); h.ellipse(49, 31, 2.6, 3.6, S)
    h.outline(K)
    h.line(20, 39, 26, 42, K); h.line(43, 39, 38, 42, K)   -- jaw creases
    local r = C.hair
    r.poly({15,19, 14,5, 30,3, 48,2, 49,18, 31,16}, K)
    r.rect(14, 18, 3, 8, K); r.rect(46, 17, 3, 8, K)        -- sideburns
    r.outline(K)
    r.hline(17, 6, 12, V); r.hline(33, 5, 12, V); r.hline(19, 10, 7, V); r.hline(37, 9, 8, V); r.px(16, 13, V)
    face64(C, mood, { E = {{25, 25, 3.6, 4.6}, {39, 24, 4.6, 5.6}}, lid = S,
      blush = {{17, 31, 3}, {44, 31, 4}}, nose = {32, 30}, mouth = {25, 35, 15}, shout = {32, 37, 6.6, 4.1} })
    if mood == "rest" then C.face.rect(31, 38, 2, 2, M); C.face.px(33, 38, K) end   -- gap tooth
  end,
  bub = {2, 2, 18, 18},
  floor = function(N, view)
    local h, r, f, m = N(), N(), N(), N()
    h.poly({9,7, 16,6, 24,7, 24,13, 22,18, 10,18, 8,13}, S)
    h.px(7, 12, S); h.px(25, 12, S)
    h.outline(K)
    r.poly({8,8, 8,0, 16,1, 25,0, 25,7}, K)
    r.outline(K)
    r.hline(10, 2, 5, V); r.hline(18, 1, 5, V)
    if view == "back" then
      r.poly({8,7, 25,6, 25,15, 8,15}, K); r.hline(11, 9, 8, V)
      return {h, r}
    end
    face32(f, m, view, { E = {{10,10,2,3},{17,9,3,4}}, lid = S, blush = {{9,14},{22,14}},
      mouth = {12,15,7,1}, shout = {13,15,5,2} })
    if view == "rest" then f.px(15, 17, M) end
    return {h, r, f, m}
  end }

-- v3 CHEESE WEDGE: a literal big cheese, wedge head with holes, tiny pompadour curl
D.lead[3] = { name = "CHEESE WEDGE",
  bust = function(C, mood)
    local h = C.head
    h.poly({13,40, 15,24, 34,7, 49,20, 51,41, 33,44}, A)
    h.outline(K)
    h.line(15, 24, 49, 21, K)                               -- top face edge
    h.line(16, 23, 33, 9, M); h.px(35, 9, M)
    for _, o in ipairs({{20,18,2.1,1.6}, {44,32,2.6,2.6}, {18,37,1.6,1.6}, {40,16,1.6,1.1}}) do
      h.ellipse(o[1], o[2], o[3], o[4], CO)
    end
    local r = C.hair
    r.ellipse(33, 6, 3.1, 2.6, K); r.line(35, 4, 38, 2, K); r.px(39, 3, K)
    r.px(32, 5, V); r.px(33, 4, V)
    face64(C, mood, { E = {{25, 29, 3.6, 4.6}, {38, 28, 4.6, 5.6}}, lid = A,
      blush = {{18, 34, 3}, {45, 34, 4}}, nose = {31, 34}, mouth = {24, 37, 16}, shout = {31, 39, 6.1, 3.6} })
  end,
  floor = function(N, view)
    local h, r, f, m = N(), N(), N(), N()
    h.poly({8,18, 9,9, 17,2, 24,8, 25,18}, A)
    h.outline(K)
    if view == "back" then
      h.line(9, 9, 24, 8, K); h.px(12, 13, CO); h.px(13, 13, CO); h.px(20, 15, CO); h.px(18, 6, CO)
      r.px(17, 1, K); r.px(18, 0, K)
      return {h, r}
    end
    h.line(9, 9, 24, 8, K); h.px(10, 16, CO); h.px(22, 5, CO); h.px(13, 6, M)
    r.px(17, 1, K); r.px(18, 0, K)
    face32(f, m, view, { E = {{11,11,2,3},{17,10,3,4}}, lid = A, blush = {{9,15},{22,15}},
      mouth = {13,16,6,1}, shout = {14,15,4,2} })
    return {h, r, f, m}
  end }

-- ====================================================================================
-- REVIEW: violet cardigan, pink bow tie (H0 stalk-eye alien = v0)
-- ====================================================================================
D.review = {}
-- v1 3-EYE PEAR (H1a, owner OK)
D.review[1] = { name = "3-EYE PEAR",
  bust = function(C, mood)
    local h = C.head
    h.ellipse(32, 38, 17, 10, A, WOB_L, WOB_R)
    h.ellipse(31, 21, 10, 11, A, {0,1,0,0,-1,0,0}, {0,0,1,0,0,-1,0})
    h.outline(K)
    h.hline(24, 14, 3, M); h.px(23, 15, M); h.px(19, 32, M); h.px(19, 33, M)
    local r = C.hair
    r.poly({30,11, 31,4, 33,3, 33,11}, CO); r.ellipse(38, 5, 4.2, 2.1, G)
    r.outline(K); r.line(35, 5, 41, 5, K)
    local f, m = C.face, C.mouth
    local E = {{24, 30, 3.1, 4.1}, {40, 29, 4.6, 5.6}, {31, 18, 2.6, 3.1}}
    eyes(f, E)
    f.rect(17, 37, 3, 2, CO); f.rect(45, 36, 4, 2, CO)
    f.px(25, 46, K); f.px(39, 46, K)
    if mood == "rest" then
      lids(f, E, A, 0.5)
      pupil(f, 23, 31); pupil(f, 39, 31); f.rect(31, 19, 1, 2, K)
      f.line(20, 24, 26, 24, K); f.line(36, 22, 43, 23, K)
      smile(f, 24, 39, 16)
    else
      pupil(f, 24, 27); pupil(f, 40, 25); f.rect(31, 16, 2, 2, K)
      f.line(20, 22, 26, 20, K); f.line(36, 19, 43, 17, K); f.px(44, 18, K)
      shout(m, 32, 41, 6.1, 4.1); m.outline(K); tongue(m, 32, 43, 3)
    end
  end,
  floor = function(N, view)
    local h, r, f, m = N(), N(), N(), N()
    h.ellipse(16, 14, 8.1, 4.6, A, {0,-1,0,0,0,0,0,0,0,0}, {0,0,1,0,0,0,0,0,0,0})
    h.ellipse(15, 6, 5.1, 5.1, A, {0,1,0,0,0}, {0,0,1,0,0})
    h.outline(K)
    r.vline(15, 0, 2, CO); r.px(17, 0, G); r.px(18, 0, G); r.px(18, 1, G)
    r.outline(K)
    if view == "back" then shine(h, {{11,4},{9,12}}); return {h, r} end
    shine(h, {{12,3},{9,12}})
    face32(f, m, view, { E = {{10,11,2,2},{17,10,3,3},{14,5,2,2}}, lid = A, blush = {{8,15},{22,14}},
      mouth = {12,16,7,1}, shout = {14,15,4,2}, brow = false })
    return {h, r, f, m}
  end }

-- v2 SOCK PUPPET (H1a, owner OK)
D.review[2] = { name = "SOCK PUPPET",
  bust = function(C, mood)
    local h = C.head
    h.ellipse(31, 32, 13, 19, T, WOB_L, WOB_R)
    h.ellipse(43, 15, 10, 6, T, {0,0,1,0,0}, {0,1,0,0,1})
    h.ellipse(51, 21, 4.1, 4.6, T)
    for y=42,50 do for x=0,63 do
      if h.get(x, y) == T and (y == 43 or y == 44 or y == 47 or y == 48) then h.px(x, y, P) end
    end end
    h.outline(K)
    h.vline(20, 22, 9, M); h.px(21, 20, M); h.hline(44, 11, 3, M)
    for x=21,41,4 do h.vline(x, 45, 2, K) end
    local r = C.hair
    r.ellipse(26, 13, 2.6, 2.6, A); r.ellipse(31, 11, 3.1, 2.6, CO); r.ellipse(36, 13, 2.6, 2.6, A)
    r.outline(K)
    local f, m = C.face, C.mouth
    eyes(f, {{24, 25, 4.1, 4.6}, {37, 24, 5.1, 5.6}})
    if mood == "rest" then
      f.rect(22, 27, 3, 3, K); f.rect(34, 27, 3, 3, K)
      f.line(18, 36, 22, 38, K); f.hline(22, 38, 15, K); f.line(37, 38, 43, 35, K)
      f.hline(28, 39, 4, P)
    else
      f.rect(24, 21, 3, 3, K); f.rect(37, 19, 3, 3, K)
      f.line(19, 17, 25, 16, P); f.line(33, 15, 40, 14, P)
      shout(m, 31, 40, 9.1, 5.1); m.outline(K); tongue(m, 31, 43, 4)
      C.prop.line(55, 12, 58, 10, K); C.prop.line(56, 16, 60, 16, K)
    end
  end,
  bub = {2, 2, 19, 15},
  floor = function(N, view)
    local h, r, f, m = N(), N(), N(), N()
    h.ellipse(15, 11, 6.6, 8.1, T, {0,0,-1,0,0,1,0}, {0,1,0,0,0,0,1})
    h.ellipse(21, 4, 4.6, 2.6, T); h.ellipse(25, 6, 1.6, 2.1, T)
    for x=0,31 do if h.get(x, 16) == T then h.px(x, 16, P) end end
    h.outline(K)
    r.px(13, 2, A); r.px(15, 2, CO); r.px(16, 2, CO); r.px(17, 3, A)
    r.outline(K)
    if view == "back" then shine(h, {{10,8},{10,9}}); return {h, r} end
    shine(h, {{10,8},{10,9}})
    if view == "rest" then
      f.rect(11, 8, 3, 3, M); f.rect(16, 7, 4, 4, M); f.outline(K)
      f.rect(11, 9, 2, 2, K); f.rect(16, 9, 2, 2, K)
      f.px(10, 13, K); f.hline(11, 14, 8, K); f.px(19, 13, K); f.px(15, 15, P)
      return {h, r, f}
    end
    f.rect(11, 8, 3, 3, M); f.rect(16, 7, 4, 4, M); f.outline(K)
    f.px(12, 8, K); f.px(18, 7, K); f.px(18, 8, K)
    f.line(10, 5, 13, 5, P); f.line(16, 4, 19, 4, P)
    m.rect(12, 13, 6, 3, P); m.outline(K); m.hline(13, 15, 4, CO)
    return {h, r, f, m}
  end }

-- v3 MUSHROOM: huge spotted pink cap, stubby marble stem face
D.review[3] = { name = "MUSHROOM",
  bust = function(C, mood)
    local h = C.head
    h.ellipse(32, 36, 12, 13, M, {0,1,0,0,0,-1,0,0,1}, {0,0,0,1,0,0,-1,0,0})
    h.outline(K)
    h.vline(22, 30, 8, CO)                                  -- stem shade
    local r = C.hair
    r.ellipse(32, 17, 23, 13, P, WOB_L, WOB_R)
    for y=24,31 do for x=0,63 do r.px(x, y, 0) end end      -- flat-ish underside
    r.poly({9,23, 55,23, 52,27, 12,27}, P)
    r.outline(K)
    r.hline(12, 27, 41, K)
    for _, d in ipairs({{19,14,3.1,2.6}, {32,9,3.6,2.6}, {44,15,2.6,2.1}, {27,20,2.1,1.6}, {50,21,1.6,1.6}}) do
      r.ellipse(d[1], d[2], d[3], d[4], M)
    end
    r.hline(18, 6, 4, M)
    face64(C, mood, { E = {{27, 34, 3.6, 4.1}, {38, 33, 4.1, 5.1}}, lid = M,
      blush = {{21, 40, 3}, {42, 40, 3}}, nose = {32, 39}, mouth = {26, 42, 13}, shout = {32, 44, 5.1, 3.1}, brow = false })
  end,
  bub = {2, 2, 14, 15},
  floor = function(N, view)
    local h, r, f, m = N(), N(), N(), N()
    h.ellipse(16, 13, 5.1, 5.6, M)
    h.outline(K)
    r.ellipse(16, 6, 10.1, 5.6, P, {0,0,-1,0,0}, {0,1,0,0,0})
    for y=9,12 do for x=0,31 do r.px(x, y, 0) end end
    r.hline(6, 9, 20, P)
    r.outline(K)
    for _, d in ipairs({{10,5},{16,2},{21,6},{13,7}}) do r.px(d[1], d[2], M); r.px(d[1]+1, d[2], M) end
    if view == "back" then return {h, r} end
    face32(f, m, view, { E = {{12,12,2,2},{17,11,3,3}}, lid = M, blush = {{11,16},{20,16}},
      mouth = {14,16,5,1}, shout = {14,16,4,2}, brow = false })
    return {h, r, f, m}
  end }

-- ---------- costume cues shared by a role's variants ----------
-- filled ring (headphone band), only rows <= ymax
local function ring(C, cx, cy, rx, ry, w, c, ymax)
  for y=fl(cy-ry), math.min(math.ceil(cy+ry), ymax) do for x=fl(cx-rx), math.ceil(cx+rx) do
    local o = ((x+0.5-cx)/rx)^2 + ((y+0.5-cy)/ry)^2
    local i = ((x+0.5-cx)/(rx-w))^2 + ((y+0.5-cy)/(ry-w))^2
    if o <= 1 and i > 1 then C.px(x, y, c) end
  end end
end
-- buddy: amber band + pink cups (bust on the prop layer, above the head)
local function phones64(C, cx, cy, rx, ry, lx, rxx, cupy)
  local p = C.prop
  ring(p, cx, cy, rx, ry, 2, A, cupy - 3)
  p.ellipse(lx, cupy, 3.6, 5.6, P); p.ellipse(rxx, cupy, 3.6, 5.6, P)
  p.outline(K)
  p.vline(lx + 1, cupy - 3, 5, M); p.vline(rxx - 2, cupy - 3, 3, CO)
end
local function phones32(C, cx, cy, rx, ry, lx, rxx, cupy)
  ring(C, cx, cy, rx, ry, 1, A, cupy - 2)
  C.rect(lx, cupy - 2, 2, 4, P); C.rect(rxx, cupy - 2, 2, 4, P)
  C.outline(K)
end
-- spec: teal round specs around the eyes (drawn under the face layer)
local function specs64(C, E)
  for _, e in ipairs(E) do C.ellipse(e[1], e[2], e[3] + 2.6, e[4] + 2.6, T) end
  C.outline(K)
  C.line(fl(E[1][1] + E[1][3]) + 3, E[1][2] - 2, fl(E[2][1] - E[2][3]) - 3, E[2][2] - 2, K)
end
local function specs32(C, E)
  for _, e in ipairs(E) do C.rect(e[1] - 2, e[2] - 2, e[3] + 4, e[4] + 4, T) end
  C.outline(K)
end
-- art: pink beret, tilted, with a nub
local function beret64(C, x, y)
  C.ellipse(x, y, 12.1, 4.6, P, {0,-1,0,0,0,1,0,0,0,0}, {0,0,1,0,0,0,0,0,0,0})
  C.rect(x - 1, y - 7, 3, 3, P)
  C.outline(K)
  C.hline(x - 7, y - 3, 4, M); C.hline(x - 9, y + 3, 18, K)
end
local function beret32(C, x, y) C.ellipse(x, y, 6.1, 2.1, P); C.px(x, y - 3, P); C.outline(K); C.px(x - 3, y - 1, M) end
-- audit: violet cap with the amber badge; mechanical: pink cap worn backwards
local function cap64(C, x, y, c, badge, brimLeft)
  C.ellipse(x, y, 10.1, 6.6, c, {0,0,-1,0,0,0,0}, {0,1,0,0,0,0,0})
  for yy=y+1, y+7 do for xx=0,63 do C.px(xx, yy, 0) end end
  if brimLeft then C.poly({x-9, y, x-20, y+2, x-19, y+4, x-8, y+3}, c) else C.rect(x - 11, y, 22, 3, c) end
  C.outline(K)
  if badge then C.ellipse(x, y - 3, 2.1, 2.1, badge) end
  C.hline(x - 6, y - 5, 3, M)
end
local function cap32(C, x, y, c, badge, brimLeft)
  C.ellipse(x, y, 5.1, 3.1, c)
  for yy=y+1, y+4 do for xx=0,31 do C.px(xx, yy, 0) end end
  if brimLeft then C.hline(x - 9, y + 1, 6, c) else C.hline(x - 6, y + 1, 13, c) end
  C.outline(K)
  if badge then C.px(x, y - 1, badge) end
end
-- unknown: a pink "?" (s = pixel size)
local QM = { "0110", "1001", "0010", "0100", "0000", "0100" }
local function qmark(C, x, y, c, s)
  for r, row in ipairs(QM) do for q=1,4 do if row:sub(q, q) == "1" then C.rect(x + (q-1)*s, y + (r-1)*s, s, s, c) end end end
end

-- ====================================================================================
-- RETIRED LEAD: amber cardigan, coffee mug (H0 walrus = v0)
-- ====================================================================================
D["retired-lead"] = {}
-- v1 TORTOISE: bald mint dome, wrinkly neck, teal age spots, beak smile
D["retired-lead"][1] = { name = "TORTOISE",
  bust = function(C, mood)
    local h = C.head
    h.ellipse(32, 41, 6.6, 6.1, G)
    h.ellipse(31, 27, 14, 13, G, WOB_L, WOB_R)
    h.outline(K)
    for _, y in ipairs({41, 44}) do h.line(27, y, 31, y + 1, K); h.line(33, y + 1, 37, y, K) end
    h.hline(26, 16, 5, K); h.hline(34, 15, 4, K)
    for _, d in ipairs({{21,18}, {40,19}, {38,15}, {22,33}}) do h.rect(d[1], d[2], 2, 2, T) end
    h.hline(24, 15, 2, M); h.px(23, 16, M)
    face64(C, mood, { E = {{25, 26, 3.6, 4.1}, {37, 25, 4.6, 5.1}}, lid = G,
      blush = {{18, 31, 3}, {42, 31, 3}}, mouth = {23, 33, 18}, shout = {31, 36, 6.6, 3.6} })
    C.face.px(31, 30, K); C.face.px(33, 30, K)
  end,
  floor = function(N, view)
    local h, f, m = N(), N(), N()
    h.rect(13, 14, 6, 4, G)
    h.ellipse(16, 8, 7.6, 6.6, G, {0,0,-1,0,0,0,0}, {0,1,0,0,0,0,1})
    h.outline(K)
    h.hline(14, 16, 4, K)
    if view == "back" then h.px(11, 5, T); h.px(19, 8, T); h.px(14, 10, T); shine(h, {{13,3},{14,2}}); return {h} end
    h.px(10, 5, T); h.px(21, 4, T); shine(h, {{12,3}})
    face32(f, m, view, { E = {{11,7,2,3},{17,6,3,4}}, lid = G, blush = {{9,11},{21,11}},
      mouth = {11,12,9,1}, shout = {13,12,6,2} })
    return {h, f, m}
  end }
-- v2 MAD PROFESSOR: bald dome, two exploding marble hair clouds, droopy moustache
D["retired-lead"][2] = { name = "MAD PROFESSOR",
  bust = function(C, mood)
    local r = C.hair
    for _, q in ipairs({{15,25,6.6,8.1}, {49,24,6.6,8.6}, {18,14,5.1,5.1}, {46,13,5.6,5.1}, {11,34,4.1,4.1}, {53,34,4.1,4.6}}) do
      r.ellipse(q[1], q[2], q[3], q[4], M, WOB_L, WOB_R)
    end
    r.outline(K)
    r.line(14, 20, 17, 23, K); r.line(48, 19, 51, 22, K); r.px(17, 12, K); r.px(46, 11, K)
    local h = C.head
    h.rect(28, 40, 8, 7, S)
    h.ellipse(32, 29, 12.1, 14.1, S, WOB_L, WOB_R)
    h.outline(K)
    h.hline(26, 17, 4, M); h.px(25, 18, M)
    face64(C, mood, { E = {{27, 27, 3.1, 3.6}, {38, 26, 3.6, 4.6}}, lid = S, browc = M,
      blush = {{21, 31, 3}, {41, 31, 3}}, nose = {32, 31}, mouth = {27, 38, 11}, shout = {32, 40, 4.6, 3.1} })
    local f = C.face
    f.poly({25,35, 32,33, 39,35, 41,39, 37,37, 32,36, 27,37, 23,39}, M)
    f.line(25, 35, 23, 39, K); f.line(39, 35, 41, 39, K); f.line(26, 34, 32, 32, K); f.line(32, 32, 38, 34, K)
  end,
  floor = function(N, view)
    local h, r, f, m = N(), N(), N(), N()
    for _, q in ipairs({{9,9,3.1,4.1}, {23,9,3.1,4.1}, {11,4,2.6,2.6}, {21,4,2.6,2.6}}) do r.ellipse(q[1], q[2], q[3], q[4], M) end
    r.outline(K)
    h.ellipse(16, 9, 5.6, 7.6, S)
    h.outline(K)
    if view == "back" then
      shine(h, {{14,3},{15,2}})
      local b = N(); b.ellipse(16, 12, 5.1, 3.6, M); b.outline(K)
      return {r, h, b}
    end
    shine(h, {{13,3}})
    face32(f, m, view, { E = {{12,7,2,2},{17,6,3,3}}, lid = S, browc = M, blush = {{11,11},{20,11}},
      mouth = {14,14,4,0}, shout = {14,14,4,2} })
    f.hline(12, 12, 8, M); f.px(11, 13, M); f.px(20, 13, M)
    return {r, h, f, m}
  end }
-- v3 BULLDOG: marble fur, coral eye patch, floppy INK ears, jowls, underbite
D["retired-lead"][3] = { name = "BULLDOG",
  bust = function(C, mood)
    local h = C.head
    h.ellipse(32, 28, 15, 12, M, WOB_L, WOB_R)
    h.ellipse(21, 39, 7.1, 5.6, M); h.ellipse(43, 39, 7.1, 5.6, M)
    h.outline(K)
    h.ellipse(39, 25, 6.1, 5.6, CO)
    h.line(32, 34, 32, 41, K)
    local r = C.hair
    r.poly({17,19, 11,24, 13,33, 19,26}, K); r.poly({47,18, 54,22, 52,32, 46,25}, K)
    r.px(14, 25, V); r.px(52, 24, V)
    face64(C, mood, { E = {{25, 26, 3.1, 3.6}, {39, 25, 4.1, 4.6}}, lid = M,
      blush = {{18, 33, 3}, {45, 33, 3}}, mouth = {24, 38, 17}, shout = {32, 40, 6.6, 3.6} })
    local f = C.face
    f.ellipse(32, 33, 3.1, 2.1, K); f.px(31, 32, M)
    if mood == "rest" then f.px(27, 39, M); f.px(27, 38, M); f.px(37, 39, M); f.px(37, 38, M) end
  end,
  floor = function(N, view)
    local h, r, f, m = N(), N(), N(), N()
    h.ellipse(16, 9, 7.6, 6.1, M)
    h.ellipse(11, 14, 3.1, 2.6, M); h.ellipse(21, 14, 3.1, 2.6, M)
    h.outline(K)
    r.poly({8,4, 6,7, 7,11, 10,6}, K); r.poly({24,4, 26,7, 25,11, 22,6}, K)
    if view == "back" then h.rect(17, 6, 3, 3, CO); return {h, r} end
    h.rect(17, 6, 5, 4, CO)
    face32(f, m, view, { E = {{11,7,2,2},{18,6,3,3}}, lid = M, mouth = {12,14,8,1}, shout = {13,13,6,2} })
    f.hline(15, 11, 2, K)
    return {h, r, f, m}
  end }

-- ====================================================================================
-- BUDDY (brainstorm): rainbow windbreaker, walkman, amber/pink headphones
-- ====================================================================================
D.buddy = {}
-- v1 JELLYBEAN ALIEN: tilted mint bean, two bobble antennae
D.buddy[1] = { name = "JELLYBEAN",
  bust = function(C, mood)
    local h = C.head
    h.ellipse(30, 27, 13.1, 14.1, G, WOB_L, WOB_R)
    h.ellipse(38, 33, 9.1, 8.1, G)
    h.outline(K)
    h.line(22, 15, 25, 13, M); h.px(21, 17, M)
    local r = C.hair
    r.line(24, 13, 19, 4, K); r.line(36, 13, 41, 3, K)
    r.ellipse(19, 4, 2.6, 2.6, A); r.ellipse(41, 3, 2.6, 2.6, P)
    r.outline(K)
    phones64(C, 31, 27, 17, 17, 14, 48, 28)
    face64(C, mood, { E = {{25, 25, 4.1, 4.6}, {37, 24, 4.6, 5.6}}, lid = G,
      blush = {{20, 33, 3}, {41, 33, 4}}, mouth = {26, 35, 14}, shout = {33, 37, 5.6, 3.6} })
  end,
  bub = {2, 8, 16, 18},
  floor = function(N, view)
    local h, r, f, m, p = N(), N(), N(), N(), N()
    h.ellipse(15, 10, 6.6, 7.6, G); h.ellipse(19, 13, 4.6, 4.1, G)
    h.outline(K)
    r.line(12, 3, 10, 0, K); r.line(18, 3, 20, 0, K); r.px(10, 0, A); r.px(20, 0, P)
    phones32(p, 16, 10, 9, 9, 6, 24, 10)
    if view == "back" then return {h, r, p} end
    shine(h, {{11,5}})
    face32(f, m, view, { E = {{11,8,2,3},{16,7,3,4}}, lid = G, blush = {{10,13},{20,13}},
      mouth = {13,14,6,1}, shout = {14,14,4,2} })
    return {h, r, f, m, p}
  end }
-- v2 RED ONION: violet bulb with marble layer lines, mint sprout
D.buddy[2] = { name = "RED ONION",
  bust = function(C, mood)
    local h = C.head
    h.ellipse(32, 30, 14.1, 12.1, V, WOB_L, WOB_R)
    h.poly({20,23, 28,13, 33,6, 37,13, 44,23}, V)
    h.outline(K)
    h.line(26, 16, 21, 33, M); h.line(39, 16, 44, 32, M); h.line(31, 9, 29, 14, M)
    local r = C.hair
    r.poly({32,7, 30,1, 33,3}, G); r.poly({34,7, 37,0, 36,5}, G)
    r.outline(K)
    phones64(C, 32, 27, 17, 16, 16, 48, 30)
    face64(C, mood, { E = {{26, 28, 3.6, 4.1}, {38, 27, 4.1, 5.1}}, lid = V,
      blush = {{21, 35, 3}, {41, 35, 3}}, mouth = {25, 36, 15}, shout = {32, 38, 5.6, 3.1} })
  end,
  floor = function(N, view)
    local h, r, f, m, p = N(), N(), N(), N(), N()
    h.ellipse(16, 12, 7.1, 5.6, V)
    h.poly({10,9, 14,4, 16,1, 18,4, 22,9}, V)
    h.outline(K)
    r.px(16, 0, G); r.px(17, 0, G)
    phones32(p, 16, 11, 9, 9, 6, 24, 11)
    h.line(12, 7, 10, 14, M); h.line(20, 7, 22, 14, M)
    if view == "back" then return {h, r, p} end
    face32(f, m, view, { E = {{12,9,2,3},{17,8,3,4}}, lid = V, blush = {{11,14},{20,14}},
      mouth = {13,15,6,1}, shout = {14,14,4,2} })
    return {h, r, f, m, p}
  end }
-- v3 SPUD CYCLOPS: lumpy amber potato, one huge eye, coral sprout spots
D.buddy[3] = { name = "SPUD CYCLOPS",
  bust = function(C, mood)
    local h = C.head
    h.ellipse(32, 28, 15.1, 13.1, A, {0,-1,-2,-1,0,1,0,0,-1,0,1}, {0,1,2,1,0,0,-1,0,1,2,1})
    h.ellipse(20, 18, 4.1, 3.6, A)
    h.outline(K)
    for _, d in ipairs({{22,36}, {42,18}, {44,35}, {19,27}}) do h.px(d[1], d[2], CO); h.px(d[1]+1, d[2], K) end
    h.hline(22, 16, 3, M)
    phones64(C, 32, 28, 18, 17, 14, 50, 29)
    face64(C, mood, { E = {{32, 25, 6.1, 6.6}}, lid = A,
      blush = {{20, 33, 3}, {42, 33, 4}}, mouth = {24, 35, 17}, shout = {32, 38, 6.6, 3.6} })
  end,
  floor = function(N, view)
    local h, f, m, p = N(), N(), N(), N()
    h.ellipse(16, 10, 7.6, 6.6, A, {0,-1,0,0,1,0,0,-1,0}, {0,1,0,0,-1,0,1,0,0})
    h.outline(K)
    phones32(p, 16, 10, 9, 9, 6, 24, 10)
    if view == "back" then h.px(12, 7, CO); h.px(19, 11, CO); h.px(14, 13, CO); return {h, p} end
    h.px(11, 13, CO); h.px(21, 6, CO)
    face32(f, m, view, { E = {{14,6,4,4}}, lid = A, blush = {{10,12},{21,12}},
      mouth = {12,13,8,1}, shout = {14,13,4,2} })
    return {h, f, m, p}
  end }

-- ====================================================================================
-- IMPLEMENT: white shirt, pink tie (H0 TV head = v0); variants are other gadget heads
-- ====================================================================================
D.implement = {}
-- v1 BOOMBOX: violet box, amber speaker rings round googly eyes, handle, tape deck
D.implement[1] = { name = "BOOMBOX",
  bust = function(C, mood)
    local h = C.head
    h.rect(29, 39, 6, 5, S)
    h.poly({10,15, 32,13, 54,15, 55,28, 53,40, 32,41, 11,40, 9,28}, V)
    h.outline(K)
    h.ellipse(20, 27, 7.6, 7.6, K); h.ellipse(44, 27, 8.1, 8.1, K)
    h.ellipse(20, 27, 6.6, 6.6, A); h.ellipse(44, 27, 7.1, 7.1, A)
    h.rect(27, 17, 10, 6, M); h.rect(28, 18, 8, 4, K); h.px(30, 19, M); h.px(33, 19, M)
    h.hline(11, 16, 6, M)
    local r = C.hair
    r.rect(18, 7, 28, 3, M); r.rect(18, 7, 3, 8, M); r.rect(43, 7, 3, 8, M)
    r.outline(K)
    face64(C, mood, { E = {{20, 27, 3.6, 4.1}, {44, 27, 4.1, 4.6}}, lid = A, brow = false,
      mouth = {27, 32, 10}, shout = {32, 35, 4.1, 3.1} })
  end,
  floor = function(N, view)
    local h, r, f, m = N(), N(), N(), N()
    h.rect(14, 15, 4, 3, S)
    h.rect(6, 6, 20, 10, V)
    h.outline(K)
    r.rect(10, 3, 12, 1, M); r.vline(10, 3, 3, M); r.vline(21, 3, 3, M)
    r.outline(K)
    if view == "back" then h.rect(10, 8, 12, 5, K); h.hline(11, 10, 10, A); return {h, r} end
    h.rect(7, 8, 6, 6, A); h.rect(19, 8, 6, 6, A); h.hline(14, 7, 4, M)
    face32(f, m, view, { E = {{9,10,2,2},{21,9,2,3}}, lid = A, brow = false, mouth = {14,11,4,0}, shout = {14,10,4,2} })
    return {h, r, f, m}
  end }
-- v2 TOASTER: teal chrome toaster, two amber slices popping out, side lever
D.implement[2] = { name = "TOASTER",
  bust = function(C, mood)
    local r = C.hair
    r.poly({17,20, 18,6, 23,3, 28,6, 29,20}, A); r.poly({34,20, 35,4, 40,1, 45,4, 46,20}, A)
    r.outline(K)
    r.line(19, 7, 23, 4, CO); r.line(36, 5, 40, 2, CO)
    local h = C.head
    h.rect(29, 41, 6, 3, S)
    h.poly({13,18, 32,16, 51,18, 52,30, 50,42, 32,43, 14,42, 12,30}, T)
    h.rect(52, 24, 5, 3, K)
    h.outline(K)
    h.ellipse(57, 25, 2.1, 2.1, P)
    h.hline(16, 18, 11, K); h.hline(36, 18, 11, K)
    h.vline(15, 22, 12, M); h.vline(16, 21, 3, M); h.px(48, 38, M)
    face64(C, mood, { E = {{25, 28, 3.6, 4.6}, {39, 27, 4.6, 5.6}}, lid = T,
      blush = {{18, 35, 3}, {44, 35, 4}}, mouth = {25, 36, 15}, shout = {32, 38, 5.6, 3.1} })
  end,
  floor = function(N, view)
    local h, r, f, m = N(), N(), N(), N()
    r.rect(10, 2, 4, 5, A); r.rect(18, 1, 4, 6, A)
    r.outline(K)
    h.rect(7, 6, 18, 12, T); h.rect(25, 10, 2, 1, K)
    h.outline(K)
    h.hline(9, 6, 5, K); h.hline(17, 6, 6, K)
    if view == "back" then h.vline(23, 8, 6, M); return {h, r} end
    h.vline(8, 8, 6, M)
    face32(f, m, view, { E = {{11,9,2,3},{17,8,3,4}}, lid = T, blush = {{9,14},{21,14}}, mouth = {13,14,6,1}, shout = {14,14,4,2} })
    return {h, r, f, m}
  end }
-- v3 FLOPPY DISK: mint 3.5" disk, marble shutter, the face drawn on the label
D.implement[3] = { name = "FLOPPY DISK",
  bust = function(C, mood)
    local h = C.head
    h.poly({14,10, 46,9, 51,14, 51,45, 14,46}, G)
    h.outline(K)
    h.rect(23, 10, 17, 10, M); h.rect(34, 12, 4, 6, K)
    h.rect(17, 24, 31, 20, M); h.hline(18, 25, 29, K); h.hline(18, 27, 29, P)
    h.rect(16, 11, 3, 3, K)
    face64(C, mood, { E = {{25, 33, 3.6, 4.1}, {38, 32, 4.6, 5.1}}, lid = M, brow = false,
      blush = {{19, 38, 3}, {43, 38, 3}}, mouth = {26, 39, 13}, shout = {32, 41, 4.6, 2.6} })
  end,
  floor = function(N, view)
    local h, f, m = N(), N(), N()
    h.poly({7,3, 23,3, 25,5, 25,18, 7,18}, G)
    h.outline(K)
    if view == "back" then h.rect(12, 3, 8, 5, M); h.ellipse(16, 12, 2.1, 2.1, M); h.px(16, 12, K); return {h} end
    h.rect(12, 3, 8, 4, M); h.rect(17, 4, 2, 2, K)
    h.rect(9, 9, 14, 9, M); h.hline(9, 9, 14, P)
    face32(f, m, view, { E = {{11,11,2,2},{17,11,3,3}}, lid = M, brow = false, mouth = {13,15,6,1}, shout = {14,15,4,2} })
    return {h, f, m}
  end }

-- ====================================================================================
-- MECHANICAL: teal coveralls, wrench; variants keep a pink cap
-- ====================================================================================
D.mechanical = {}
local function grille(f, x, y, w) f.rect(x, y, w, 4, K); for i=x+1, x+w-2, 2 do f.vline(i, y+1, 2, M) end end
-- v1 DOME BOT: amber round dome, rivet band, bolt neck, backwards cap
D.mechanical[1] = { name = "DOME BOT",
  bust = function(C, mood)
    local h = C.head
    h.rect(28, 40, 8, 6, M)
    h.ellipse(32, 28, 14.1, 13.1, A, WOB_L, WOB_R)
    h.outline(K)
    h.hline(29, 42, 6, K)
    for x=20,44,6 do h.px(x, 37, K) end
    h.vline(21, 20, 5, M); h.px(22, 18, M)
    cap64(C.hair, 31, 16, P, nil, true)
    face64(C, mood, { E = {{26, 26, 3.6, 4.1}, {38, 25, 4.6, 5.1}}, lid = A, blush = {{19, 31, 3}, {43, 31, 3}},
      shout = {32, 35, 5.6, 3.1} })
    if mood == "rest" then grille(C.face, 26, 32, 13) end
  end,
  floor = function(N, view)
    local h, r, f, m = N(), N(), N(), N()
    h.rect(14, 15, 4, 3, M)
    h.ellipse(16, 9, 7.1, 6.6, A)
    h.outline(K)
    cap32(r, 16, 3, P, nil, true)
    if view == "back" then h.px(10, 12, K); h.px(16, 13, K); h.px(22, 12, K); return {h, r} end
    face32(f, m, view, { E = {{11,8,2,3},{17,7,3,4}}, lid = A, blush = {{10,12},{21,12}}, shout = {14,12,4,2} })
    if view == "rest" then f.rect(13, 13, 6, 2, K); f.px(14, 13, M); f.px(16, 13, M) end
    return {h, r, f, m}
  end }
-- v2 TRASH-CAN BOT: violet ribbed bin, the pink lid worn as the cap
D.mechanical[2] = { name = "TRASH-CAN BOT",
  bust = function(C, mood)
    local h = C.head
    h.poly({17,17, 47,16, 46,44, 18,45}, V)
    h.outline(K)
    for x=21,43,6 do h.line(x, 34, x, 44, K) end
    h.hline(18, 33, 28, K)
    h.vline(19, 19, 12, M)
    local r = C.hair
    r.poly({13,18, 15,12, 33,9, 50,12, 51,17}, P)
    r.rect(29, 5, 7, 4, P)
    r.outline(K)
    r.hline(16, 13, 6, M); r.hline(30, 6, 3, M)
    face64(C, mood, { E = {{26, 24, 3.6, 4.1}, {38, 23, 4.1, 5.1}}, lid = V, brow = false,
      blush = {{20, 29, 3}, {42, 29, 3}}, shout = {32, 38, 5.6, 3.6} })
    if mood == "rest" then grille(C.face, 26, 36, 13) end
  end,
  floor = function(N, view)
    local h, r, f, m = N(), N(), N(), N()
    h.rect(9, 5, 14, 13, V)
    h.outline(K)
    h.vline(13, 13, 5, K); h.vline(18, 13, 5, K)
    r.poly({7,6, 8,3, 16,2, 24,3, 25,6}, P); r.rect(14, 0, 4, 2, P)
    r.outline(K)
    if view == "back" then h.vline(21, 7, 5, M); return {h, r} end
    h.vline(10, 7, 5, M)
    face32(f, m, view, { E = {{11,8,2,2},{17,7,3,3}}, lid = V, brow = false, shout = {14,12,4,2} })
    if view == "rest" then f.rect(13, 12, 6, 1, K) end
    return {h, r, f, m}
  end }
-- v3 HEX NUT: coral hex nut, one googly eye peering through the hole, pink cap
D.mechanical[3] = { name = "HEX NUT",
  bust = function(C, mood)
    local h = C.head
    h.poly({18,15, 32,10, 47,15, 49,31, 46,43, 32,46, 17,43, 14,30}, CO)
    h.outline(K)
    h.line(18, 15, 17, 43, K); h.line(47, 15, 46, 43, K)
    h.ellipse(32, 27, 9.1, 9.1, K)
    h.hline(21, 13, 6, M); h.vline(16, 22, 6, M)
    cap64(C.hair, 32, 12, P, nil, true)
    face64(C, mood, { E = {{32, 27, 6.6, 6.6}}, lid = K, brow = false,
      blush = {{20, 37, 3}, {42, 37, 3}}, mouth = {26, 38, 13}, shout = {32, 40, 4.6, 2.6} })
  end,
  floor = function(N, view)
    local h, r, f, m = N(), N(), N(), N()
    h.poly({9,5, 16,3, 23,5, 24,11, 23,17, 16,18, 9,17, 8,11}, CO)
    h.outline(K)
    cap32(r, 16, 3, P, nil, true)
    if view == "back" then h.ellipse(16, 11, 3.1, 3.1, K); return {h, r} end
    h.ellipse(16, 10, 4.1, 4.1, K)
    face32(f, m, view, { E = {{15,8,3,3}}, lid = K, brow = false, mouth = {13,15,6,1}, shout = {14,15,4,2} })
    return {h, r, f, m}
  end }

-- ====================================================================================
-- AUDIT: violet jacket, torch; variants keep the violet cap with the amber badge
-- ====================================================================================
D.audit = {}
-- v1 BAT: pink head, huge ears, two little fangs
D.audit[1] = { name = "BAT",
  bust = function(C, mood)
    local h = C.head
    h.poly({19,22, 12,4, 26,15}, P); h.poly({44,21, 52,3, 38,15}, P)
    h.ellipse(32, 31, 13.1, 13.1, P, WOB_L, WOB_R)
    h.outline(K)
    h.poly({18,17, 15,9, 22,15}, CO); h.poly({45,16, 49,8, 42,15}, CO)
    h.hline(22, 21, 3, M)
    cap64(C.hair, 32, 19, V, A)
    face64(C, mood, { E = {{26, 30, 3.6, 4.1}, {38, 29, 4.1, 5.1}}, lid = P, blush = {{20, 36, 3}, {41, 36, 3}},
      mouth = {25, 38, 15}, shout = {32, 40, 5.6, 3.1} })
    if mood == "rest" then C.face.rect(28, 41, 1, 2, M); C.face.rect(36, 41, 1, 2, M) end
  end,
  floor = function(N, view)
    local h, r, f, m = N(), N(), N(), N()
    h.poly({10,8, 6,0, 13,6}, P); h.poly({22,8, 26,0, 19,6}, P)
    h.ellipse(16, 11, 7.1, 6.6, P)
    h.outline(K)
    cap32(r, 16, 5, V, A)
    if view == "back" then return {h, r} end
    face32(f, m, view, { E = {{11,10,2,3},{17,9,3,4}}, lid = P, blush = {{9,14},{22,14}}, mouth = {13,15,6,1}, shout = {14,15,4,2} })
    if view == "rest" then f.px(14, 17, M); f.px(17, 17, M) end
    return {h, r, f, m}
  end }
-- v2 MOLE: coral head, long snout with a pink star nose, huge round glasses
D.audit[2] = { name = "MOLE",
  bust = function(C, mood)
    local h = C.head
    h.ellipse(32, 31, 13.1, 15.1, CO, WOB_L, WOB_R)
    h.ellipse(32, 40, 7.1, 5.1, CO)
    h.outline(K)
    h.hline(22, 21, 3, M)
    cap64(C.hair, 32, 17, V, A)
    local E = {{25, 29, 5.1, 5.6}, {39, 28, 5.6, 6.1}}
    local g = C.hair
    face64(C, mood, { E = E, lid = CO, brow = false, mouth = {28, 43, 9}, shout = {32, 45, 3.6, 2.1} })
    for _, e in ipairs(E) do
      for y=fl(e[2]-e[4])-2, math.ceil(e[2]+e[4])+2 do for x=fl(e[1]-e[3])-2, math.ceil(e[1]+e[3])+2 do
        local d = ((x+0.5-e[1])/(e[3]+2))^2 + ((y+0.5-e[2])/(e[4]+2))^2
        if d <= 1 and d > 0.62 and C.face.get(x, y) == 0 then C.face.px(x, y, K) end
      end end
    end
    C.face.hline(31, 27, 3, K)
    C.face.rect(31, 37, 3, 3, P); C.face.px(30, 38, P); C.face.px(34, 38, P); C.face.px(32, 36, P)
  end,
  floor = function(N, view)
    local h, r, f, m = N(), N(), N(), N()
    h.ellipse(16, 11, 6.6, 7.6, CO); h.ellipse(16, 15, 3.6, 2.6, CO)
    h.outline(K)
    cap32(r, 16, 4, V, A)
    if view == "back" then return {h, r} end
    face32(f, m, view, { E = {{10,9,4,3},{18,8,5,4}}, lid = CO, brow = false, mouth = {14,17,4,0}, shout = {14,16,4,2} })
    f.hline(15, 9, 2, K)
    f.px(15, 14, P); f.px(16, 14, P)
    return {h, r, f, m}
  end }
-- v3 CACTUS: tall mint cactus head, ink spines, a pink flower, cap perched on top
D.audit[3] = { name = "CACTUS",
  bust = function(C, mood)
    local h = C.head
    h.ellipse(31, 30, 11.1, 17.1, G, WOB_L, WOB_R)
    h.ellipse(18, 30, 3.1, 6.1, G)
    h.outline(K)
    h.vline(25, 18, 22, T); h.vline(37, 17, 23, T)
    for _, s in ipairs({{19,20,-1}, {43,22,1}, {20,40,-1}, {42,38,1}, {14,27,-1}}) do
      h.px(s[1] + s[3], s[2], K); h.px(s[1] + 2*s[3], s[2] - 1, K)
    end
    local r = C.hair
    r.ellipse(44, 26, 3.6, 3.6, P); r.outline(K); r.rect(43, 25, 2, 2, A)
    cap64(r, 31, 14, V, A)
    face64(C, mood, { E = {{27, 27, 3.1, 3.6}, {36, 26, 3.6, 4.6}}, lid = G, blush = {{22, 33, 3}, {39, 33, 3}},
      mouth = {25, 35, 13}, shout = {31, 37, 4.6, 3.1} })
  end,
  floor = function(N, view)
    local h, r, f, m = N(), N(), N(), N()
    h.ellipse(16, 10, 5.6, 8.1, G); h.ellipse(9, 11, 1.6, 3.1, G)
    h.outline(K)
    r.rect(21, 9, 2, 2, P); r.outline(K)
    cap32(r, 16, 2, V, A)
    if view == "back" then h.vline(14, 5, 10, T); h.vline(18, 5, 10, T); return {h, r} end
    face32(f, m, view, { E = {{12,8,2,3},{17,7,3,4}}, lid = G, mouth = {13,13,6,1}, shout = {14,13,4,2} })
    return {h, r, f, m}
  end }

-- ====================================================================================
-- SPEC: mint shirt, clipboard; variants keep the teal round specs
-- ====================================================================================
D.spec = {}
-- v1 MOTH: fuzzy amber head, marble ruff, feathery coral antennae
D.spec[1] = { name = "MOTH",
  bust = function(C, mood)
    local h = C.head
    h.ellipse(32, 44, 15.1, 4.6, M, {0,-1,0,1,0,-1,0,1,0,-1}, {0,1,0,-1,0,1,0,-1,0,1})
    h.ellipse(32, 30, 13.1, 13.1, A, {0,-1,0,-1,0,-1,0,-1,0,-1,0,-1}, {0,1,0,1,0,1,0,1,0,1,0,1})
    h.outline(K)
    local r = C.hair
    r.line(27, 18, 18, 3, CO); r.line(37, 18, 46, 3, CO)
    for i=0,4 do r.line(25 - i*2, 13 - i*2, 22 - i*2, 13 - i*2, CO); r.line(39 + i*2, 13 - i*2, 42 + i*2, 13 - i*2, CO) end
    r.outline(K)
    local E = {{25, 29, 3.6, 4.1}, {39, 28, 4.1, 4.6}}
    local g = C.arm
    specs64(g, E)
    face64(C, mood, { E = E, lid = A, brow = false, blush = {{19, 36, 3}, {43, 36, 3}},
      mouth = {26, 37, 12}, shout = {32, 39, 4.6, 2.6} })
  end,
  floor = function(N, view)
    local h, r, g, f, m = N(), N(), N(), N(), N()
    h.ellipse(16, 17, 7.6, 2.1, M)
    h.ellipse(16, 10, 6.6, 6.6, A, {0,-1,0,-1,0,-1,0}, {0,1,0,1,0,1,0})
    h.outline(K)
    r.line(13, 4, 9, 0, CO); r.line(19, 4, 23, 0, CO); r.px(10, 0, CO); r.px(22, 0, CO)
    r.outline(K)
    if view == "back" then return {h, r} end
    local E = {{11,9,2,2},{18,8,3,3}}
    specs32(g, E)
    face32(f, m, view, { E = E, lid = A, brow = false, mouth = {14,14,4,0}, shout = {14,13,4,2} })
    return {h, r, g, f, m}
  end }
-- v2 HAMSTER: coral head, stuffed marble cheek pouches, round ears, buck teeth
D.spec[2] = { name = "HAMSTER",
  bust = function(C, mood)
    local h = C.head
    h.ellipse(20, 15, 4.6, 4.6, CO); h.ellipse(44, 14, 4.6, 4.6, CO)
    h.ellipse(32, 29, 13.1, 12.1, CO, WOB_L, WOB_R)
    h.ellipse(19, 37, 7.1, 6.6, M); h.ellipse(45, 37, 7.1, 6.6, M)
    h.outline(K)
    h.ellipse(20, 15, 2.1, 2.1, P); h.ellipse(44, 14, 2.1, 2.1, P)
    local E = {{26, 27, 3.6, 4.1}, {38, 26, 4.1, 4.6}}
    specs64(C.hair, E)
    face64(C, mood, { E = E, lid = CO, brow = false, mouth = {27, 37, 10}, shout = {32, 39, 4.1, 2.6} })
    local f = C.face
    f.rect(31, 33, 3, 2, P)
    if mood == "rest" then f.rect(30, 40, 4, 3, M); f.vline(32, 40, 3, K) end
  end,
  floor = function(N, view)
    local h, g, f, m = N(), N(), N(), N()
    h.rect(9, 2, 3, 2, CO); h.rect(20, 2, 3, 2, CO)
    h.ellipse(16, 9, 7.1, 6.1, CO)
    h.ellipse(10, 14, 3.6, 3.1, M); h.ellipse(22, 14, 3.6, 3.1, M)
    h.outline(K)
    if view == "back" then return {h} end
    local E = {{11,7,2,2},{18,6,3,3}}
    specs32(g, E)
    face32(f, m, view, { E = E, lid = CO, brow = false, mouth = {14,14,4,0}, shout = {14,13,4,2} })
    f.px(15, 11, P); f.px(16, 11, P)
    return {h, g, f, m}
  end }
-- v3 DICE: marble die head, pink pips, specs
D.spec[3] = { name = "DICE",
  bust = function(C, mood)
    local h = C.head
    h.poly({16,17, 23,11, 52,10, 47,16}, M)
    h.poly({47,16, 52,10, 51,40, 47,46}, P)
    h.poly({16,17, 47,16, 47,46, 17,45}, M)
    h.outline(K)
    h.line(16, 17, 47, 16, K); h.line(47, 16, 47, 46, K); h.line(47, 16, 52, 10, K)
    h.ellipse(33, 13, 2.1, 1.1, P); h.rect(49, 21, 2, 2, M); h.rect(49, 33, 2, 2, M)
    for _, d in ipairs({{20,20}, {42,20}, {20,41}, {42,41}}) do h.rect(d[1], d[2], 2, 2, P) end
    local E = {{26, 28, 3.6, 4.1}, {38, 27, 4.1, 4.6}}
    specs64(C.hair, E)
    face64(C, mood, { E = E, lid = M, brow = false, blush = {{20, 35, 3}, {41, 35, 3}},
      mouth = {26, 37, 12}, shout = {32, 39, 4.6, 2.6} })
  end,
  floor = function(N, view)
    local h, g, f, m = N(), N(), N(), N()
    h.poly({8,5, 11,2, 25,2, 23,5}, M); h.poly({23,5, 25,2, 25,15, 23,18}, P)
    h.rect(8, 5, 15, 13, M)
    h.outline(K)
    h.hline(8, 5, 15, K); h.vline(23, 5, 13, K)
    if view == "back" then h.rect(11, 8, 2, 2, P); h.rect(18, 13, 2, 2, P); h.rect(15, 10, 2, 2, P); return {h} end
    h.px(9, 6, P); h.px(21, 16, P)
    local E = {{11,9,2,2},{17,8,3,3}}
    specs32(g, E)
    face32(f, m, view, { E = E, lid = M, brow = false, mouth = {13,15,5,0}, shout = {14,14,4,2} })
    return {h, g, f, m}
  end }

-- ====================================================================================
-- ART: teal smock, paintbrush; variants keep the pink beret
-- ====================================================================================
D.art = {}
-- v1 PALETTE: amber painter's palette head with a thumb hole and paint dabs
D.art[1] = { name = "PALETTE",
  bust = function(C, mood)
    local h = C.head
    h.rect(29, 41, 6, 6, S)
    h.ellipse(32, 30, 17.1, 13.1, A, WOB_L, WOB_R)
    for y=0,63 do for x=0,63 do if ((x-19.5)/3.1)^2 + ((y-38.5)/2.6)^2 <= 1 then h.px(x, y, 0) end end end
    h.outline(K)
    for _, d in ipairs({{17,26,P}, {22,19,T}, {44,19,G}, {48,28,V}, {43,38,P}}) do h.ellipse(d[1], d[2], 2.6, 2.1, d[3]) end
    h.hline(24, 18, 4, M)
    beret64(C.hair, 31, 15)
    face64(C, mood, { E = {{28, 28, 3.6, 4.1}, {39, 27, 4.1, 5.1}}, lid = A, blush = {{23, 34, 3}, {42, 33, 3}},
      mouth = {27, 36, 13}, shout = {33, 38, 5.1, 3.1} })
  end,
  floor = function(N, view)
    local h, r, f, m = N(), N(), N(), N()
    h.ellipse(16, 11, 8.6, 6.6, A)
    h.px(10, 14, 0); h.px(11, 14, 0)
    h.outline(K)
    beret32(r, 16, 4)
    if view == "back" then return {h, r} end
    h.px(9, 10, P); h.px(22, 8, T); h.px(23, 12, G); h.px(20, 15, V)
    face32(f, m, view, { E = {{12,9,2,3},{18,8,3,4}}, lid = A, mouth = {13,14,6,1}, shout = {14,14,4,2} })
    return {h, r, f, m}
  end }
-- v2 DAISY: ring of marble petals round an amber face, mint stem neck
D.art[2] = { name = "DAISY",
  bust = function(C, mood)
    local h = C.head
    h.rect(29, 40, 6, 7, G)
    for i=0,9 do
      local a = i * math.pi / 5 + 0.2
      h.ellipse(32 + math.cos(a)*15, 28 + math.sin(a)*14, 5.1, 5.1, M)
    end
    h.outline(K)
    local c = C.arm
    c.ellipse(32, 28, 11.1, 11.1, A, WOB_L, WOB_R)
    c.outline(K)
    local hc = C.head
    for y=0,63 do for x=0,63 do local v = c.get(x, y); if v ~= 0 then hc.px(x, y, v) end end end
    for y=0,63 do for x=0,63 do c.px(x, y, 0) end end
    beret64(C.hair, 30, 11)
    face64(C, mood, { E = {{27, 27, 3.6, 4.1}, {37, 26, 4.1, 4.6}}, lid = A, blush = {{21, 32, 3}, {40, 32, 3}},
      mouth = {26, 33, 12}, shout = {32, 35, 4.6, 3.1} })
  end,
  floor = function(N, view)
    local h, c, r, f, m = N(), N(), N(), N(), N()
    h.rect(15, 15, 2, 3, G)
    for i=0,7 do local a = i * math.pi / 4 + 0.3; h.ellipse(16 + math.cos(a)*7, 9 + math.sin(a)*6, 2.6, 2.6, M) end
    h.outline(K)
    if view == "back" then
      -- back of the flower: marble petals all round, a small mint calyx with sepal ticks, stem below
      c.ellipse(16, 9, 3.1, 3.1, G); c.outline(K)
      for _, q in ipairs({{16,4}, {12,8}, {20,8}, {13,12}, {19,12}}) do c.px(q[1], q[2], T) end
      beret32(r, 15, 2); return {h, c, r}
    end
    c.ellipse(16, 9, 5.1, 5.1, A)
    c.outline(K)
    beret32(r, 15, 2)
    face32(f, m, view, { E = {{12,8,2,2},{17,7,3,3}}, lid = A, brow = false, mouth = {14,12,4,0}, shout = {14,11,4,2} })
    return {h, c, r, f, m}
  end }
-- v3 PATINA STATUE: mint bronze classical bust, teal curls, roman nose
D.art[3] = { name = "STATUE",
  bust = function(C, mood)
    local h = C.head
    h.rect(27, 40, 10, 7, G)
    h.ellipse(32, 28, 12.1, 15.1, G, WOB_L, WOB_R)
    h.outline(K)
    h.line(28, 42, 29, 46, T)
    local r = C.hair
    for _, q in ipairs({{21,17}, {26,14}, {32,13}, {38,14}, {43,17}, {19,23}, {45,23}}) do r.ellipse(q[1], q[2], 3.1, 3.1, T) end
    r.outline(K)
    for _, q in ipairs({{21,17}, {26,14}, {32,13}, {38,14}, {43,17}}) do r.px(q[1], q[2], K) end
    local b = C.arm
    face64(C, mood, { E = {{27, 27, 3.6, 4.1}, {38, 26, 4.1, 4.6}}, lid = G, blush = {{21, 33, 3}, {41, 33, 3}},
      mouth = {27, 37, 12}, shout = {32, 39, 4.6, 3.1} })
    C.face.line(32, 26, 31, 33, K); C.face.hline(31, 33, 3, K)
    beret64(C.prop, 34, 9)
  end,
  floor = function(N, view)
    local h, r, b, f, m = N(), N(), N(), N(), N()
    h.ellipse(16, 10, 6.1, 7.6, G)
    h.outline(K)
    for _, x in ipairs({10, 13, 16, 19, 22}) do r.ellipse(x, 5, 1.6, 1.6, T) end
    r.outline(K)
    beret32(b, 17, 2)
    if view == "back" then local q = N(); q.ellipse(16, 10, 5.1, 4.1, T); q.outline(K); return {h, r, q, b} end
    face32(f, m, view, { E = {{12,8,2,3},{17,7,3,4}}, lid = G, mouth = {13,14,6,1}, shout = {14,14,4,2} })
    return {h, r, b, f, m}
  end }

-- ====================================================================================
-- UNKNOWN: coral sweater; variants keep a pink "?" (H0 paper bag = v0)
-- ====================================================================================
D.unknown = {}
-- v1 BOX HEAD: teal cardboard box, open flaps, amber tape
D.unknown[1] = { name = "BOX HEAD",
  bust = function(C, mood)
    local h = C.head
    h.poly({15,15, 6,9, 13,6, 21,14}, T); h.poly({48,15, 58,8, 52,5, 43,14}, T)
    h.poly({15,15, 48,14, 49,46, 16,47}, T)
    h.outline(K)
    h.rect(29, 15, 6, 6, A); h.hline(17, 31, 30, K)
    qmark(h, 40, 34, P, 2)
    face64(C, mood, { E = {{25, 24, 3.6, 4.1}, {38, 23, 4.1, 5.1}}, lid = T, brow = false,
      blush = {{19, 31, 3}, {44, 30, 3}}, mouth = {22, 36, 13}, shout = {28, 38, 5.1, 3.1} })
  end,
  bub = {2, 12, 18, 22},
  floor = function(N, view)
    local h, f, m = N(), N(), N()
    h.poly({8,5, 4,1, 9,1, 11,4}, T); h.poly({24,5, 28,1, 23,1, 21,4}, T)
    h.rect(8, 5, 16, 13, T)
    h.outline(K)
    h.rect(14, 5, 4, 2, A)
    if view == "back" then qmark(h, 14, 9, P, 1); return {h} end
    qmark(h, 20, 12, P, 1)
    face32(f, m, view, { E = {{10,8,2,3},{16,8,3,3}}, lid = T, brow = false, mouth = {11,14,5,0}, shout = {11,13,4,2} })
    return {h, f, m}
  end }
-- v2 LAMPSHADE: pink fringed shade worn low, amber tassels, a "?" tag dangling
D.unknown[2] = { name = "LAMPSHADE",
  bust = function(C, mood)
    local h = C.head
    h.ellipse(32, 36, 11.1, 10.1, S)
    h.outline(K)
    local r = C.prop
    r.poly({21,6, 43,5, 52,28, 12,29}, P)
    r.outline(K)
    for x=14,50,4 do r.vline(x, 30, 2, A); r.px(x, 32, A) end
    r.hline(22, 8, 20, M); r.line(19, 12, 15, 25, M)
    r.line(48, 29, 52, 35, K)
    local t = C.fx
    t.rect(50, 36, 7, 9, M); t.outline(K); qmark(t, 52, 38, P, 1)
    face64(C, mood, { E = {{27, 35, 3.1, 3.6}, {37, 34, 3.6, 4.1}}, lid = S, brow = false,
      blush = {{22, 40, 3}, {39, 40, 3}}, mouth = {27, 41, 11}, shout = {32, 43, 4.1, 2.6} })
  end,
  floor = function(N, view)
    local h, r, f, m = N(), N(), N(), N()
    h.ellipse(16, 13, 5.6, 4.6, S)
    h.outline(K)
    r.poly({11,1, 21,1, 25,11, 7,11}, P)
    r.outline(K)
    r.px(8, 12, A); r.px(12, 12, A); r.px(16, 12, A); r.px(20, 12, A); r.px(24, 12, A)
    r.hline(12, 2, 6, M)
    if view == "back" then qmark(r, 14, 5, M, 1); return {h, r} end
    face32(f, m, view, { E = {{12,13,2,2},{17,13,3,2}}, lid = S, brow = false, mouth = {14,16,4,0}, shout = {14,16,4,2} })
    return {h, f, m, r}
  end }
-- v3 MELON: striped mint watermelon head, amber "?" sticker
D.unknown[3] = { name = "MELON",
  bust = function(C, mood)
    local h = C.head
    h.ellipse(32, 29, 16.1, 15.1, G, WOB_L, WOB_R)
    h.outline(K)
    for _, x in ipairs({19, 27, 37, 45}) do
      for y=15,43 do local xx = x + fl(math.sin(y*0.6)*1.5); if h.get(xx, y) == G then h.px(xx, y, T) end end
    end
    h.line(31, 13, 33, 10, K)
    local s = C.hair
    s.ellipse(43, 38, 4.6, 4.1, A); s.outline(K); qmark(s, 41, 35, P, 1)
    face64(C, mood, { E = {{25, 26, 3.6, 4.1}, {37, 25, 4.6, 5.1}}, lid = G,
      blush = {{18, 32, 3}, {41, 31, 3}}, mouth = {23, 35, 14}, shout = {30, 37, 5.6, 3.1} })
  end,
  floor = function(N, view)
    local h, s, f, m = N(), N(), N(), N()
    h.ellipse(16, 10, 8.1, 7.6, G)
    h.outline(K)
    for _, x in ipairs({11, 16, 21}) do h.vline(x, 4, 13, T) end
    if view == "back" then return {h} end
    s.rect(20, 13, 4, 5, A); s.outline(K); qmark(s, 20, 13, P, 1)
    face32(f, m, view, { E = {{10,8,2,3},{16,7,3,4}}, lid = G, mouth = {11,13,6,1}, shout = {12,13,4,2} })
    return {h, s, f, m}
  end }

return D
end
