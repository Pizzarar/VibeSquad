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
  b.poly({2,64, 4,50, 12,45, 52,45, 60,50, 62,64}, P)             -- loud hot-pink padded jacket
  for _, d in ipairs({{7,53},{16,58},{9,61},{47,55},{56,59},{51,62},{20,51},{44,50},{57,52}}) do
    b.rect(d[1], d[2], 2, 2, A)                                    -- amber polka dots
  end
  b.poly({24,45, 40,45, 32,60}, M)                                -- shirt V
  b.poly({30,47, 34,47, 35,57, 32,61, 29,57}, T)                  -- teal tie
  b.outline(K)
  b.line(24,45, 31,60, K); b.line(40,45, 33,60, K)                -- lapels
  b.line(30,47, 34,47, K); b.line(29,57, 32,61, K); b.line(35,57, 32,61, K)
  b.line(12,46, 12,63, K); b.line(52,46, 52,63, K)                -- pad seams
  b.hline(5, 50, 6, M); b.hline(54, 50, 5, M)                     -- pad shine
  b.rect(27, 41, 10, 5, S); b.vline(27, 41, 4, K); b.vline(36, 41, 4, K)  -- neck
  local h = C.head
  head(h, 31, 27, 15, 15)
  h.outline(K)
  local r = C.hair
  -- huge pompadour swoop leaning forward and up, forehead left open
  r.poly({16,25, 15,14, 19,6, 27,1, 38,0, 46,3, 49,9, 45,13, 46,18, 46,25, 43,18, 36,16, 26,17, 19,19}, K)
  r.outline(K)
  for _, s in ipairs({{4,25,33},{6,36,42},{9,21,27},{8,30,38},{11,40,45}}) do r.hline(s[2], s[1], s[3]-s[2]+1, V) end
  r.px(20,10,V); r.px(43,5,V)
  face(C.face, 31, 29, {mouth = "grin"})
  local p = C.prop
  -- brick phone held to the viewer's right ear, antenna past the quiff
  p.rect(47, 22, 7, 16, A); p.rect(48, 24, 5, 3, G); p.rect(48, 29, 5, 6, K)
  for y=29,33,2 do for x=48,52,2 do p.px(x, y, M) end end
  p.vline(52, 6, 16, K); p.rect(51, 4, 3, 3, P)
  p.ellipse(47, 36, 4, 4, S)                                       -- fist
  p.outline(K)
  p.vline(52, 6, 16, K); p.line(44, 35, 47, 33, K); p.line(45, 37, 48, 35, K)
end

-- BUDDY: Walkman kid, oversized colour-block windbreaker, big headphones over spiky hair
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
  -- spiky swept-up hair, forehead open; tufts stay inside the headphone band
  r.ellipse(32, 16, 17, 9, K, {0,1,-1,0,1,0,0,-1,0}, {0,-1,1,0,0,1,0,0,-1})
  r.poly({20,13, 22,9, 26,11}, K); r.poly({26,10, 29,7, 32,9}, K); r.poly({33,9, 36,7, 38,10}, K); r.poly({39,11, 42,9, 44,13}, K)
  r.poly({17,36, 12,41, 19,39}, K); r.poly({46,37, 52,42, 45,40}, K)   -- sideways tufts under the cups
  r.spans({{24,16,19},{25,16,18},{26,16,17},{24,45,48},{25,46,48},{26,47,48}}, K)
  r.poly({19,26, 22,20, 27,18, 32,21, 37,18, 42,20, 45,26}, 0)  -- open forehead, wavy hairline
  r.outline(K)
  for _, s in ipairs({{11,22,26},{10,33,38},{14,40,44},{13,27,29}}) do r.hline(s[2], s[1], s[3]-s[2]+1, V) end
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

-- IMPLEMENT: TV-head coder. Wood-cabinet set for a head, the face lives on the screen.
function ROLE.implement(L, C)
  local b = C.body
  b.poly({4,64, 6,50, 16,46, 48,46, 58,50, 60,64}, M)              -- white shirt
  b.outline(K)
  for _, x in ipairs({4, 49}) do                                   -- rolled-up sleeve bunches
    b.hline(x, 51, 11, K); b.hline(x, 56, 11, K)
    b.line(x+2, 52, x+4, 55, K); b.line(x+6, 52, x+8, 55, K)
  end
  b.rect(5, 57, 9, 7, S); b.rect(50, 57, 9, 7, S)                  -- forearms
  b.vline(14, 57, 7, K); b.vline(49, 57, 7, K)
  b.poly({30,47, 34,47, 35,58, 32,62, 29,58}, P)                   -- pink tie
  b.line(29,58, 32,62, K); b.line(35,58, 32,62, K)
  b.vline(29, 47, 11, K); b.vline(35, 47, 11, K); b.hline(30, 47, 5, K)
  b.line(20,47, 20,63, V); b.line(44,47, 44,63, V)                 -- suspenders
  b.rect(29, 42, 7, 5, K)                                          -- neck = a cable stub
  local h = C.head
  -- the set: rounded amber cabinet, coral wood base, knob column on the right
  h.spans({{9,12,52},{10,11,53}}, A); h.rect(10, 11, 45, 30, A); h.spans({{41,11,53},{42,12,52}}, A)
  h.rect(11, 38, 43, 4, CO)
  h.outline(K)
  h.hline(11, 37, 43, K)
  for x=13,52,3 do h.px(x, 39, A) end                              -- wood grain flecks
  h.rect(15, 13, 27, 23, K)                                        -- screen bezel
  h.rect(16, 14, 25, 21, T)                                        -- screen
  for _, k in ipairs({{47,17},{47,26}}) do                         -- dials
    h.ellipse(k[1], k[2], 3.2, 3.2, CO); h.px(k[1], k[2]-2, K); h.px(k[1], k[2]-1, K)
  end
  h.outline(K)
  for y=31,35,2 do h.hline(45, y, 5, K) end                        -- speaker grille
  local f = C.face
  -- face on the screen: big round eyes, wide grin, mint scanlines
  for y=16,34,4 do f.hline(17, y, 23, G) end
  f.ellipse(22, 21, 3.6, 4.1, M); f.ellipse(34, 20, 4.1, 4.6, M)
  f.outline(K)
  f.rect(22, 21, 2, 3, K); f.rect(34, 20, 2, 3, K)
  f.line(19, 27, 21, 30, K); f.hline(21, 30, 15, K); f.line(36, 30, 38, 27, K)
  f.hline(22, 31, 13, P); f.hline(24, 32, 9, P); f.hline(22, 32, 2, K); f.hline(33, 32, 2, K); f.hline(24, 33, 9, K)
  f.rect(17, 27, 2, 1, P); f.rect(38, 27, 2, 1, P)                 -- screen blush
  local p = C.prop
  -- rabbit-ear antenna with pink tips
  p.line(28, 9, 18, 0, K); p.line(36, 9, 47, 1, K); p.rect(29, 7, 7, 2, K)
  p.rect(17, 0, 2, 2, P); p.rect(46, 0, 2, 2, P)
end

-- REVIEW: stalk-eye alien in a cardigan. One giant eye on a wobbly stalk, wide grin below.
function ROLE.review(L, C)
  local b = C.body
  b.poly({6,64, 8,53, 18,49, 46,49, 56,53, 58,64}, V)              -- violet cardigan, lanky
  b.poly({26,49, 38,49, 32,60}, M)                                 -- shirt
  b.outline(K)
  b.line(26,49, 32,60, K); b.line(38,49, 32,60, K); b.vline(32, 60, 4, K)
  for y=59,63,4 do b.rect(33, y, 2, 2, A) end                      -- amber buttons
  b.poly({27,49, 32,51, 37,49, 37,54, 32,52, 27,54}, P)            -- pink bow tie
  b.line(27,49, 27,54, K); b.line(37,49, 37,54, K); b.line(27,49, 32,51, K); b.line(37,49, 32,51, K)
  b.line(27,54, 32,52, K); b.line(37,54, 32,52, K); b.rect(31, 50, 3, 3, K)
  b.line(14,54, 14,63, K); b.line(50,54, 50,63, K)                 -- cardigan seams
  local h = C.head
  -- squat green blob head, wide and lopsided, with a wobbly stalk
  h.ellipse(32, 41, 19, 10, G, {0,-1,0,0,1,0,0,0,-1,0}, {0,1,0,0,0,-1,0,0,1,0})
  h.poly({30,32, 29,24, 31,20, 34,20, 36,24, 35,32}, G)
  h.outline(K)
  h.line(31, 22, 30, 31, K)                                        -- stalk crease
  -- giant eye on top
  h.ellipse(33, 13, 11.6, 11.1, M)
  h.outline(K)
  h.ellipse(31, 14, 6.1, 6.1, T)
  h.ellipse(31, 14, 3.1, 3.1, K)
  h.rect(28, 11, 2, 2, M); h.px(34, 17, M)                         -- catch-lights
  local f = C.face
  -- big wide grin + cheeks on the blob
  f.line(19, 40, 46, 40, K); f.line(19, 40, 22, 44, K); f.hline(22, 44, 21, K); f.line(43, 44, 46, 40, K)
  f.spans({{41,21,44},{42,22,43},{43,23,42}}, P)
  f.rect(15, 36, 3, 2, CO); f.rect(47, 36, 3, 2, CO)
  f.px(24, 47, K); f.px(39, 47, K)                                 -- two little freckles
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
