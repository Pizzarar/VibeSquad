-- H0 64px busts (future app icons). Hand-chosen shapes per role, each layer gets its own
-- 1px INK outline (lib C.outline), then faces and props are stamped pixel by pixel.
-- Layers: body, head, hair, face, prop, fx.
local B = {}
local K, V, P, CO, A, S, M, T, G = 15, 8, 9, 10, 11, 14, 4, 7, 12

-- lopsided wobble tables (x offsets per row, hand-picked so no two rows repeat evenly)
local WOB_L = {0,0,-1,0,0,1,0,0,0,-1,0,0,1,0,0,0,0,-1,0}
local WOB_R = {0,1,0,0,0,0,1,1,0,0,0,-1,0,0,1,0,0,0,0}

-- shared googly face; cx = face centre x, ey = eye row. look = pupil shift table
local function face(C, cx, ey, opt)
  opt = opt or {}
  -- eyes: left smaller, right bigger (lopsided)
  C.ellipse(cx-7, ey, 3.6, 4.6, M); C.ellipse(cx+6, ey-1, 4.6, 5.6, M)
  C.outline(K)
  local pl = opt.pupL or {0, 1}; local pr = opt.pupR or {-1, 0}
  C.rect(cx-8+pl[1], ey-1+pl[2], 2, 3, K)
  C.rect(cx+5+pr[1], ey-2+pr[2], 2, 3, K)
  C.px(cx-8+pl[1], ey-1+pl[2], M); C.px(cx+5+pr[1], ey-2+pr[2], M)   -- catch-light
  -- brows (raised, uneven)
  if not opt.noBrows then
    C.line(cx-11, ey-6, cx-5, ey-8, K); C.line(cx-11, ey-5, cx-10, ey-5, K)
    C.line(cx+2, ey-10, cx+9, ey-9, K); C.line(cx+9, ey-8, cx+10, ey-8, K)
  end
  -- blush
  C.rect(cx-13, ey+5, 3, 2, CO); C.rect(cx+10, ey+5, 4, 2, CO)
  -- nose: two coral pixels, off-centre
  C.px(cx, ey+4, CO); C.px(cx+1, ey+5, CO)
  -- mouth
  local my = ey + 8 + (opt.mouthDy or 0)
  if opt.mouth == "grin" then
    C.line(cx-6, my, cx+5, my-1, K)
    C.spans({{my+1, cx-5, cx+4}, {my+2, cx-4, cx+3}, {my+3, cx-2, cx+1}}, P)
    C.px(cx-6, my+1, K); C.px(cx+5, my, K)
    C.line(cx-5, my+2, cx-3, my+4, K); C.line(cx+4, my+1, cx+2, my+4, K); C.hline(cx-3, my+4, 5, K)
    C.hline(cx-4, my+1, 3, M)   -- teeth, a bit crooked
  elseif opt.mouth == "o" then
    C.ellipse(cx, my+2, 2.2, 2.6, P); C.px(cx-2, my+1, K)
    C.line(cx-2, my, cx+1, my, K); C.line(cx-3, my+1, cx-3, my+3, K); C.line(cx+2, my+1, cx+2, my+3, K)
    C.line(cx-2, my+4, cx+1, my+4, K)
  else -- lopsided smile
    C.line(cx-5, my, cx-3, my+2, K); C.line(cx-3, my+2, cx+2, my+2, K); C.line(cx+2, my+2, cx+5, my-1, K)
    C.px(cx-1, my+3, P); C.px(cx, my+3, P)
  end
end

local function head(C, cx, cy, rx, ry, ears)
  C.ellipse(cx, cy, rx, ry, S, WOB_L, WOB_R)
  if ears ~= false then
    C.ellipse(cx-rx-1, cy+2, 2.6, 3.6, S); C.ellipse(cx+rx+1, cy+3, 2.6, 3.6, S)
  end
end

local function layers(L, spr)
  local f = spr.frames[1]
  local t = {}
  for _, n in ipairs({"body", "head", "hair", "face", "prop", "fx"}) do
    t[n] = L.canvas(spr, L.layer(spr, n), f)
  end
  return t
end

local ROLE = {}

-- LEAD: shoulder-pad salaryman exec, slick side-parted hair, brick phone at ear
function ROLE.lead(L, C)
  local b = C.body
  b.poly({2,64, 4,50, 12,45, 52,45, 60,50, 62,64}, V)             -- boxy padded jacket
  b.poly({24,45, 40,45, 32,60}, M)                                -- shirt V
  b.poly({30,47, 34,47, 35,57, 32,61, 29,57}, P)                  -- tie
  b.outline(K)
  b.line(24,45, 31,60, K); b.line(40,45, 33,60, K)                -- lapels
  b.line(30,47, 34,47, K); b.line(29,57, 32,61, K); b.line(35,57, 32,61, K)
  b.line(12,46, 12,63, K); b.line(52,46, 52,63, K)                -- pad seams
  b.hline(5, 50, 6, M); b.hline(54, 50, 5, M)                     -- pad shine
  b.rect(27, 41, 10, 5, S); b.vline(27, 41, 4, K); b.vline(36, 41, 4, K)  -- neck
  local h = C.head
  head(h, 31, 26, 15, 16)
  h.outline(K)
  local r = C.hair
  -- slick helmet with a side part and a forelock swoop to the viewer's right
  r.spans({{8,24,38},{9,21,41},{10,19,43},{11,18,44},{12,17,45},{13,16,46},{14,16,46},
           {15,16,30},{15,33,46},{16,16,27},{16,36,46},{17,16,24},{17,39,46},
           {18,16,21},{18,42,46},{19,16,19},{19,44,46},{20,16,18},{20,45,46},{21,16,17},{22,16,17},{23,16,16}}, K)
  r.outline(K)
  for _, s in ipairs({{11,22,28},{10,30,34},{13,35,40},{12,20,23},{15,40,43},{14,26,29}}) do r.hline(s[2], s[1], s[3]-s[2]+1, V) end
  r.px(37,11,V); r.px(38,12,V)
  face(C.face, 31, 28, {mouth = "grin"})
  local p = C.prop
  -- brick phone held to the viewer's right ear, antenna past the hair
  p.rect(47, 22, 7, 16, A); p.rect(48, 24, 5, 3, G); p.rect(48, 29, 5, 6, K)
  for y=29,33,2 do for x=48,52,2 do p.px(x, y, M) end end
  p.vline(52, 6, 16, K); p.rect(51, 4, 3, 3, P)
  p.ellipse(47, 36, 4, 4, S)                                       -- fist
  p.outline(K)
  p.vline(52, 6, 16, K); p.line(44, 35, 47, 33, K); p.line(45, 37, 48, 35, K)
end

-- BUDDY: Walkman kid, oversized colour-block windbreaker, big headphones over a mop
function ROLE.buddy(L, C)
  local b = C.body
  b.poly({0,64, 2,51, 14,44, 50,44, 62,51, 64,64}, T)
  b.poly({0,64, 2,51, 14,44, 22,44, 18,54, 4,58}, P)               -- pink block left
  b.poly({64,64, 62,51, 50,44, 42,44, 46,54, 60,58}, P)            -- pink block right
  b.poly({2,56, 18,52, 46,52, 62,56, 62,59, 46,55, 18,55, 2,59}, A) -- amber zig band
  b.poly({22,41, 42,41, 45,48, 32,52, 19,48}, T)                   -- popped collar
  b.outline(K)
  b.line(19,48, 32,52, K); b.line(32,52, 45,48, K)
  b.vline(32, 52, 12, K)                                           -- zip
  b.rect(36, 56, 9, 7, A); b.rect(37, 57, 7, 3, M); b.px(38,58,K); b.px(42,58,K)  -- walkman
  b.hline(36, 55, 9, K); b.vline(35, 56, 7, K); b.vline(45, 56, 7, K); b.hline(36, 63, 9, K)
  b.line(40, 55, 44, 44, K)                                        -- cord up to the cups
  local h = C.head
  head(h, 32, 27, 15, 15)
  h.outline(K)
  local r = C.hair
  -- messy mop: lumpy cap + spikes + jagged fringe
  r.ellipse(32, 19, 17, 11, K, {0,1,-1,0,1,0,0,-1,0}, {0,-1,1,0,0,1,0,0,-1})
  -- tufts stay under the band; a couple stick out sideways below the cups instead
  r.poly({17,36, 12,41, 19,39}, K); r.poly({46,37, 52,42, 45,40}, K)
  r.spans({{24,16,20},{25,16,18},{26,16,17},{24,45,48},{25,46,48},{26,47,48}}, K)
  -- jagged fringe teeth
  for i, x in ipairs({19,23,27,31,35,39,43}) do
    local d = ({3,2,4,2,3,1,3})[i]
    r.poly({x,26, x+2,26+d, x+4,26}, K)
  end
  r.outline(K)
  for _, s in ipairs({{12,22,26},{11,33,38},{15,40,44},{14,27,29}}) do r.hline(s[2], s[1], s[3]-s[2]+1, V) end
  face(C.face, 32, 33, {mouth = "o", mouthDy = -2, pupL = {1, 1}, pupR = {0, 1}})
  local p = C.prop
  -- headphones: amber band arching over the mop, pink cups with marble shine
  for t=0,40 do
    local a = math.pi * (1 - t/40)
    local x = math.floor(32 + 19*math.cos(a) + 0.5); local y = math.floor(24 - 20*math.sin(a) + 0.5)
    p.rect(x, y, 2, 2, A)
  end
  p.ellipse(13, 30, 4.6, 6.6, P); p.ellipse(51, 30, 4.6, 6.6, P)
  p.outline(K)
  p.vline(11, 27, 4, M); p.vline(49, 27, 4, M)
end

-- IMPLEMENT: rolled sleeves + hachimaki, spiky hair, determined grin
function ROLE.implement(L, C)
  local b = C.body
  b.poly({4,64, 6,50, 16,44, 48,44, 58,50, 60,64}, M)              -- white shirt
  b.poly({4,64, 5,55, 14,55, 14,64}, M)
  b.outline(K)
  -- rolled-up sleeve bunches: fat marble rolls with fold lines
  for _, x in ipairs({4, 49}) do
    b.hline(x, 51, 11, K); b.hline(x, 56, 11, K)
    b.line(x+2, 52, x+4, 55, K); b.line(x+6, 52, x+8, 55, K)
  end
  b.rect(5, 57, 9, 7, S); b.rect(50, 57, 9, 7, S)                  -- forearms
  b.vline(14, 57, 7, K); b.vline(49, 57, 7, K)
  b.poly({25,44, 32,51, 39,44}, S); b.line(25,44, 32,51, K); b.line(39,44, 32,51, K)  -- open collar
  b.line(22,44, 27,50, K); b.line(42,44, 37,50, K)
  b.px(32, 55, K); b.px(32, 60, K)                                 -- buttons
  b.line(20,47, 20,63, V); b.line(44,47, 44,63, V)                 -- suspenders
  b.rect(27, 40, 10, 5, S); b.vline(27, 40, 4, K); b.vline(36, 40, 4, K)
  local h = C.head
  head(h, 32, 26, 15, 15)
  h.outline(K)
  local r = C.hair
  r.spans({{9,22,42},{10,19,45},{11,18,46},{12,17,47},{13,17,47},{14,17,47},{15,17,47}}, K)
  r.poly({18,11, 17,2, 24,9}, K); r.poly({24,9, 27,1, 31,8}, K); r.poly({31,8, 35,0, 38,8}, K); r.poly({38,9, 44,2, 45,11}, K)
  r.outline(K)
  r.hline(25, 10, 5, V); r.hline(37, 11, 4, V)
  r.rim(V, 16)                                                     -- violet rim so spikes read on dark BG
  -- hachimaki: marble band across the forehead, pink sun, knot + tails out to the right
  r.spans({{16,16,48},{17,16,48},{18,16,48},{19,17,47}}, M)
  r.ellipse(30, 17, 2.6, 2.1, P)
  r.hline(16, 15, 33, K); r.line(17, 20, 47, 20, K)
  r.poly({47,14, 58,10, 61,15, 50,18}, M); r.poly({47,18, 57,21, 58,26, 48,20}, M)
  r.hline(16, 15, 33, K)
  local tmp = {}
  r.line(47,14, 58,10, K); r.line(58,10, 61,15, K); r.line(61,15, 50,18, K)
  r.line(47,18, 57,21, K); r.line(57,21, 58,26, K); r.line(58,26, 48,20, K)
  r.vline(48, 15, 6, K); r.vline(16, 16, 4, K)
  face(C.face, 32, 29, {mouth = "grin", noBrows = true, pupL = {1, 0}, pupR = {0, 0}})
  local f = C.face
  -- determined brows: slanted down toward the nose
  f.line(21, 23, 27, 25, K); f.line(37, 21, 43, 19, K)
  local p = C.prop
  -- pencil behind the ear
  p.line(9, 21, 15, 27, A); p.line(10, 21, 16, 27, A); p.px(9, 20, P); p.px(10, 20, P)
  p.outline(K)
end

-- REVIEW: trench-coat detective, big fedora, magnifying glass making one eye huge
function ROLE.review(L, C)
  local b = C.body
  b.poly({2,64, 4,51, 14,45, 50,45, 60,51, 62,64}, A)
  b.poly({16,45, 28,45, 32,58, 22,56, 12,48}, A); b.poly({36,45, 48,45, 52,48, 42,56, 32,58}, A)
  b.outline(K)
  b.line(16,45, 32,58, K); b.line(48,45, 32,58, K)                 -- popped lapels
  b.line(12,48, 22,56, K); b.line(52,48, 42,56, K)
  b.line(22,56, 32,58, K); b.line(42,56, 32,58, K)
  b.poly({28,45, 36,45, 32,55}, M); b.line(28,45, 32,55, K); b.line(36,45, 32,55, K)
  b.poly({31,46, 33,46, 33,53, 32,55, 31,53}, P)
  b.hline(3, 59, 58, CO); b.hline(3, 60, 58, K)                    -- belt
  b.rect(30, 58, 5, 4, A); b.hline(30, 58, 5, K); b.hline(30, 62, 5, K); b.vline(30, 58, 5, K); b.vline(34, 58, 5, K)
  b.line(8, 52, 8, 63, CO); b.line(56, 52, 56, 63, CO)              -- coat seams
  b.rect(27, 41, 10, 5, S); b.vline(27, 41, 4, K); b.vline(36, 41, 4, K)
  local h = C.head
  head(h, 31, 29, 15, 14)
  h.outline(K)
  local r = C.hair
  -- fedora: pinched crown + wide tilted brim (pink band)
  r.poly({17,16, 19,5, 26,2, 38,2, 45,5, 47,16}, K)
  r.poly({4,20, 12,15, 52,14, 61,17, 54,21, 10,23}, K)
  r.outline(K)
  r.spans({{13,18,46},{14,18,46}}, P)
  r.line(24,4, 20,12, V); r.line(25,4, 21,12, V); r.line(30,3, 33,6, V)
  r.line(8,19, 18,17, V); r.line(46,16, 55,17, V)
  r.rim(V, 22)                                                     -- violet rim on crown + brim for dark BG
  -- sideburns under the brim
  r.spans({{22,17,18},{23,17,18},{24,17,17},{22,44,45},{23,45,45}}, K)
  face(C.face, 31, 31, {mouth = "smile", noBrows = true, pupL = {1, 0}, pupR = {-1, 1}})
  local f = C.face
  f.line(20, 24, 26, 25, K); f.line(35, 23, 42, 24, K)          -- low suspicious brows
  local p = C.prop
  -- magnifying glass over the right eye: amber rim, glass = teal-ish, eye drawn huge inside
  p.ellipse(38, 30, 8.6, 8.6, A); p.ellipse(38, 30, 6.6, 6.6, T)
  p.ellipse(38, 31, 5.1, 5.6, M)
  p.rect(37, 30, 4, 4, K); p.px(37, 30, M); p.px(38, 30, M)
  p.poly({44,36, 47,35, 56,46, 53,48}, V)
  p.ellipse(54, 50, 5.2, 4.6, S)                                  -- chunky fist on the handle
  p.outline(K)
  p.line(50, 48, 57, 48, K); p.line(50, 50, 56, 51, K)             -- knuckle creases
  p.line(44,36, 53,48, K); p.line(47,35, 56,46, K)
  p.px(33, 26, M); p.px(34, 25, M); p.px(32, 27, M)               -- glint
end

function B.draw(L, spr, role)
  local C = layers(L, spr)
  ROLE[role](L, C)
  local fx = C.fx
  -- little star twinkles around every bust
  L.twinkle(fx, 4, 6, A, P, 2); L.twinkle(fx, 59, 40, P, nil, 1); L.twinkle(fx, 6, 38, T, nil, 1)
  for _, c in pairs(C) do c.commit() end
end

return B
