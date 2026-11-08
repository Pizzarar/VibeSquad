-- S2b Squads + Teams icon candidates: hand-placed ASCII fills, one drawing per master size
-- (16 is its own drawing, not a downscale of 32). build.lua adds the 1px INK outline
-- (outside every shape) and the INK hard shadow (+1 at 16, +2 at 32), then saves INDEXED
-- .aseprite sources and dark/light PNGs as a pure P0 palette swap.
-- Key = lib.lua L.KEY: k INK, v VIOLET, p PINK, c CORAL, a AMBER, s SKIN, m MARBLE, t TEAL, g MINT
-- Candidates (docs/PLAN_NEON_OFFICE.md S2b): 1 mini tower, 2 tiny H0 heads, 3 tower + pennant.
-- Squads = the whole tower / 4 heads; Teams = one desk pod / 2 heads / one floor + pennant.
-- R2 (Director R1): facades are MARBLE (VIOLET sat on the violet bar/button), taller CRTs +
-- 2-row desk, compact pennant, floor slice gets a stepped cornice, heads get lopsided googly
-- eyes, a swept pompadour and H0 shoulders.
local I = {}

-- Blocks are tables of equal-width rows; place() lays blocks at (x, y) on one grid.
local function B(s) local t = {} for r in s:gmatch("[^\n]+") do t[#t+1] = r end return t end
local function place(parts)
  local W, H = 0, 0
  for _, p in ipairs(parts) do
    for _, row in ipairs(p[1]) do W = math.max(W, p[2] + #row) end
    H = math.max(H, p[3] + #p[1])
  end
  local g = {}
  for y=1,H do g[y] = {} for x=1,W do g[y][x] = "." end end
  for _, p in ipairs(parts) do
    for r, row in ipairs(p[1]) do for i=1,#row do
      local ch = row:sub(i, i)
      if ch ~= "." then g[p[3]+r][p[2]+i] = ch end
    end end
  end
  local out = {}
  for y=1,H do out[y] = table.concat(g[y]) end
  return table.concat(out, "\n")
end

-- ============================================================ 1 · mini tower
-- Squads: crooked MARBLE tower, AMBER lit windows with INK sills (one PINK "needs you",
-- one dark), PINK roof, bent mast with an AMBER blinker, TEAL plinth.
local TOWER32 = B[[
kkkkkkkkkkkkk
mmmmmmmmmmmmm
mmaamaamaammm
mmaamaamaammm
mmkkmkkmkkmmm
mmmmmmmmmmmmm
mmaamppmaammm
mmaamppmaammm
mmkkmkkmkkmmm
mmmmmmmmmmmmm
mmkkmaamaammm
mmkkmaamaammm
mmkkmkkmkkmmm
mmmmmmmmmmmmm
mmmmmkkkmmmmm
mmmmmkkkmmmmm
mmmmmkkkmmmmm
]]
local PLINTH32 = B[[
ttttttttttttttttt
ttttttttttttttttt
]]
local ROOF32 = B[[
...ppppppp...
..ppppppppp..
.ppppppppppp.
]]
I["squads-1"] = {
[16] = [[
........a....
.......m.....
.....ppp.....
....ppppp....
...kkkkkkk...
...mamamam...
...mmmmmmm...
...mampmam...
...mmmmmmm...
...mkmamam...
...mmmkkmm...
..ttttttttt..
]],
[32] = place({
  { B[[
........a
.......ama
........a.
.......m..
......m...
......m...
]], 0, 0 },
  { ROOF32, 2, 6 }, { TOWER32, 2, 9 }, { PLINTH32, 0, 26 },
}),
}
-- Teams: one desk pod = two chunky MARBLE CRTs (TEAL text screen, PINK googly-face screen)
-- on a 2-row AMBER desk.
local CRT_L = B[[
mmmmmmmmmmmm
mttttttttttm
mtgggggttttm
mttttttttttm
mtggggggggtm
mttttttttttm
mtgggttttttm
mttttttttttm
mttttttttttm
mmmmmmmmmmmm
mmmmmmmmmamm
]]
local CRT_R = B[[
mmmmmmmmmmmm
mppppppppppm
mpppppmmmppm
mpmmppmmkppm
mpkmppmmkppm
mppppppppppm
mpkpppppkppm
mppkkkkkpppm
mppppppppppm
mmmmmmmmmmmm
mmmmmmmmmamm
]]
I["teams-1"] = {
[16] = [[
mmmmmm.mmmmmm
mttttm.mppppm
mtggtm.mkpmkm
mttttm.mppppm
mtgttm.mpkkpm
mmmmmm.mmmmmm
..mm.....mm..
aaaaaaaaaaaaa
aaaaaaaaaaaaa
.a.........a.
.a.........a.
]],
[32] = place({
  { CRT_L, 1, 0 }, { CRT_R, 15, 0 },
  { B[[
.....mm............mm.....
....mmmm..........mmmm....
]], 1, 11 },
  { B[[
aaaaaaaaaaaaaaaaaaaaaaaaaaaa
aaaaaaaaaaaaaaaaaaaaaaaaaaaa
.aa.....................aa..
.aa.....................aa..
.aa.....................aa..
]], 0, 13 },
}),
}

-- ============================================================ 2 · tiny H0 heads
-- Squads: 2x2 cast heads, each one loud silhouette: lead (swept INK pompadour), stalk-eye
-- alien (MINT), TV head (AMBER cabinet, TEAL screen), Buddy (PINK headphone arc).
-- Googly eyes per the bible: left smaller, right bigger and 1px higher.
local LEAD = B[[
....kkkkkkk..
..kkkkkkkkkkk
.kkkkkkvvkkkk
kkkssssssskk.
kssssssmmmss.
ssmmsssmmkss.
ssmksssmmkss.
sssssssssscs.
sccssssssccs.
sskkkkkpsss..
.sssssssss...
..sssssss....
]]
local ALIEN = B[[
....mmmm.....
...mmmmmm....
...mmmkkm....
....mmmm.....
.....gg......
.....gg......
.gggggggggg..
ggggggggggggg
gcggggggggcgg
ggggggggggggg
.ggkkkkkkgg..
..ggpppggg...
]]
local TV = B[[
aaaaaaaaaaaa.
attttttttaaa.
atttttmmmtaa.
attmmtmmktaa.
attkmtmmktaa.
attttttttaaa.
atkkkkkpttaa.
attttttttama.
aaaaaaaaaaaa.
.aa.....aa...
]]
local BUDDY = B[[
....ppppp....
..pp.kkk.pp..
.p.kkkkkkk.p.
.p.sssssss.p.
ppssssmmmsspp
ppsmmsmmksspp
ppskmsmmksspp
..ssssssscs..
..scsskkkss..
...sssssss...
....sssss....
]]
I["squads-2"] = {
[16] = [[
..kkkk.mkm...
kkkkkk..g....
sssmms.gggggg
skssks.gkggkg
ssssss.gggggg
.skks..ggkkg.
.............
aaaaaa..pppp.
atttta.pkkkkp
atktka.pskskp
atttta.pssssp
aaaaaa..skks.
.a..a...ssss.
]],
[32] = place({ { LEAD, 0, 0 }, { ALIEN, 14, 0 }, { TV, 0, 14 }, { BUDDY, 14, 13 } }),
}
-- Teams: lead (PINK pads) + Buddy (TEAL windbreaker) busts behind one thin AMBER ledge.
I["teams-2"] = {
[16] = [[
..kkkk..pppp.
kkkkkk.pkkkkp
sssmms.pskskp
skssks.pssssp
ssssss..skks.
.skks...ssss.
pppppp.tttttt
ppkkpp.ttmmtt
aaaaaaaaaaaaa
]],
[32] = place({
  { LEAD, 0, 0 }, { BUDDY, 14, 1 },
  { B[[
ppppkssskpppp
pppppkmkppppp
ppppppkpppppp
]], 0, 12 },
  { B[[
ttttsssssttt.
tttttmmmtttt.
tttttmmmtttt.
]], 14, 12 },
  { B[[
aaaaaaaaaaaaaaaaaaaaaaaaaaa
aaaaaaaaaaaaaaaaaaaaaaaaaaa
]], 0, 15 },
}),
}

-- ============================================================ 3 · tower + pennant
-- Squads: the cand-1 tower with a compact PINK pennant (TEAL stripe) on the mast.
I["squads-3"] = {
[16] = [[
.....mppp....
.....mpp.....
.....mp......
.....m.......
...ppppp.....
..kkkkkkk....
..mamamam....
..mmmmmmm....
..mampmam....
..mmmmmmm....
..mkmamam....
..mmmkkmm....
.ttttttttt...
]],
[32] = place({
  { B[[
mppppppp
mppttttp
mppppp..
mpp.....
m.......
]], 8, 0 },
  { ROOF32, 2, 5 }, { TOWER32, 2, 8 }, { PLINTH32, 0, 25 },
}),
}
-- Teams: one floor slice of the tower: stepped PINK cornice, MARBLE wall with AMBER
-- windows + MARBLE mullions, small rooftop pennant.
I["teams-3"] = {
[16] = [[
.mppp........
.mp..........
.ppppppppppp.
ppppppppppppp
kkkkkkkkkkkkk
mamamamamamam
mmmmmmmmmmmmm
mamampmamkmam
mmmmmmmmmmmmm
]],
[32] = place({
  { B[[
mppppp
mpttpp
mppp..
m.....
]], 3, 0 },
  { B[[
..........................
.ppppppppppppppppppppppp..
pppppppppppppppppppppppppp
kkkkkkkkkkkkkkkkkkkkkkkkkk
mmmmmmmmmmmmmmmmmmmmmmmmmm
maammaammaammaammaammaammm
maammaammaammaammaammaammm
mkkmmkkmmkkmmkkmmkkmmkkmmm
mmmmmmmmmmmmmmmmmmmmmmmmmm
maammaammppmmaammkkmmaammm
maammaammppmmaammkkmmaammm
mkkmmkkmmkkmmkkmmkkmmkkmmm
mmmmmmmmmmmmmmmmmmmmmmmmmm
]], 0, 3 },
}),
}

I.ORDER = { "squads-1", "teams-1", "squads-2", "teams-2", "squads-3", "teams-3" }
return I
