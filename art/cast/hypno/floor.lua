-- H0 floor sprites (32x32): hand-placed ASCII part maps.
-- Key (lib.lua): k INK, v VIOLET, p PINK, c CORAL, a AMBER, s SKIN, m MARBLE, t TEAL, g MINT, y SKY
-- Each part = { x, y, map }. Layers: desk (CRT + desk), chair, body, head, fx.
local P = {}

-- ---------- shared props ----------
-- CRT sits left of centre so its glow shows over the left shoulder
-- CRT drawn at the left here; build.lua mirrors the desk so it sits right of the head
-- and its glow shows over the sitter's shoulder without crowding the head silhouette
P.desk = {
-- desk sits low (y 18-21) so its strip runs under the shoulders, not through heads
 {0, 7, [[
|.kkkkkkkkkk.....................|
|kmmmmmmmmmmk....................|
|kmkkkkkkkkmk....................|
|kmkttttttkmk....................|
|kmkmmtggtkmk....................|
|kmkttttttkmk....................|
|kmkgggmmtkmk....................|
|kmkttttttkmk....................|
|kmkmmtgggkmk....................|
|kmkkkkkkkkmk....................|
|kmmmmmmmgmmk....................|
|kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk|
|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|
|cccccccccccccccccccccccccccccccc|
|kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk|
]]},
}

P.chairBack = { 10, 24, [[
|.kkkkkkkkkkk.|
|kvvvvvvvvvvvk|
|kvmmvvvvvvvvk|
|kvmvvvvvvvvvk|
|kvvvvvvvvvvvk|
|kvvvvvvvvvvvk|
|kvvvvvvvvvvvk|
|.kkkkkkkkkkk.|
]]}
-- chair seen behind a turned-round sitter: just the top rim peeking out
P.chairFront = { 6, 22, [[
|.kkkkkkkkkkkkkkkkkkk.|
|kvmmvvvvvvvvvvvvvvvvk|
|kvmvvvvvvvvvvvvvvvvvk|
]]}

-- ---------- back-of-head heads (origin 8,8) ----------
P.headBack = {}
-- lead: tall pompadour quiff (reads above the CRT line) + phone antenna
P.headBack.lead = { 8, 4, [[
|....kkkkk......|
|..tkkkkkkkk....|
|.tkkkkkkkkkk...|
|.tkkkkkkkkkkk..|
|..tkkkkkkkkkk..|
|.tkkkkkkkkkkkk.|
|tkkkkkkkkkkkkkk|
|tkkkkkkkkkkkkkk|
|tkkkkkkkkkkkkkk|
|tkkkkkkkkkkkkkk|
|tkkkkkkkkkkkkkk|
|kkkkkkkkkkkkkkk|
|kkkkkkkkvkkkkkk|
|.kkkkkkvkkkkkk.|
|..kkkkvkkkkkk..|
|....kkkkkkk....|
|....ksssssk....|
]]}
P.headBack.buddy = { 8, 4, [[
|......k........|
|...k..kk...k...|
|...kk.kkk.kk...|
|..kkkkkkkkkkk..|
|.kkkkkkkkkkkkk.|
|kkkkkkkkkkkkkkk|
|kkkkkkkkkkkkkkk|
|kkkkkkkkkkkkkkk|
|kkkkkkkkkkkkkkk|
|kkkkkkkkkkkkkkk|
|kkkkkkkkkkkkkkk|
|kkkkkkkkkkkkkkk|
|.kkkkkkkkkkkkk.|
|.k.kkkkkkkkk.k.|
|...kkkkkkkkk...|
|....ksssssk....|
]]}
-- implement: TV-head. From behind: back of the set, vents, rabbit ears
P.headBack.implement = { 6, 1, [[
|.....p.........p..|
|.....k........k...|
|......k......k....|
|......k.....k.....|
|.......k...k......|
|........kkk.......|
|..kkkkkkkkkkkkkk..|
|.taaaaaaaaaaaaaak.|
|.taaaaaaaaaaaaaak.|
|.taakkkkkkkkkkaak.|
|.taaaaaaaaaaaaaak.|
|.taakkkkkkkkkkaak.|
|.taaaaaaaaaaaaaak.|
|.taakkkkkkkkkkaak.|
|.kaaaaaaaaaaaaaak.|
|.kcccccccccccccck.|
|..kkkkkkkkkkkkkk..|
|........kk........|
|.......kkk........|
]]}
-- review: stalk-eye alien; from behind the eyeball on its stalk rises over the head
P.headBack.review = { 6, 0, [[
|........kkkkk.....|
|.......kmmmmmk....|
|......ktmmmmmmk...|
|......kttmmmmmk...|
|......ktmmmmmmk...|
|.......kmmmmmk....|
|........kkkkk.....|
|.........kgk......|
|........kgk.......|
|........kgk.......|
|...kkkkkkgkkkkk...|
|..kggggggggggggk..|
|.kggggggggggggggk.|
|kggggggggggggggggk|
|kggggggggggggggggk|
|kggggggggggggggggk|
|kggggggggggggggggk|
|kggggggggggggggggk|
|.kggggggggggggggk.|
|...kkggggggggkk...|
|......kggggk......|
]]}

-- ---------- back bodies (origin 3,20) ----------
P.bodyBack = {}
P.bodyBack.lead = { 3, 21, [[
|..kkkkkkkmmmmmmmkkkkkkkkk.|
|.kpppppppppppppppppppppppk|
|.kppppkpppppppppppppkppppk|
|.kppppkpppppppppppppkppppk|
|.kpppppppppppppppppppppppk|
|.kpppppppppppppppppppppppk|
|.kpppppppppppppppppppppppk|
|.kpppppppppppppppppppppppk|
|.kpppppppppppppppppppppppk|
|.kkkkkkkkkkkkkkkkkkkkkkkkk|
]]}
P.bodyBack.buddy = { 1, 20, [[
|........kkkttttttkkk..........|
|....kkkkpktttttttttkpkkkk.....|
|...kpppppkttttttttkpppppk.....|
|..kppppppkkkkkkkkkkppppppk....|
|.kpppppppppppppppppppppppk....|
|.kaaaaaaaaaaaaaaaaaaaaaaak....|
|.ktttttttttttttttttttttttk....|
|.ktttttttttttttttttttttttk....|
|.ktttttttttttttttttttttttk....|
|.ktttttttttttttttttttttttk....|
|.kkkkkkkkkkkkkkkkkkkkkkkkk....|
]]}
P.bodyBack.implement = { 2, 21, [[
|....kkkkkkkkkkkkkkkkkkk....|
|...kmmmmmmmmmmmmmmmmmmmk...|
|..kmmmmmmmmmmmmmmmmmmmmmk..|
|.kmmmmkmmmmmmmmmmmmmkmmmmk.|
|kmmmmkkmmmmmmmmmmmmmkkmmmmk|
|kaaaakkmmmmmmmmmmmmmkkaaaak|
|ksssskkmmmmmmmmmmmmmkkssssk|
|.kssk.kmmmmmmmmmmmmmk.kssk.|
|..kk..kmmmmmmmmmmmmmk..kk..|
|......kkkkkkkkkkkkkkk......|
]]}
P.bodyBack.review = { 5, 21, [[
|....kkkkkkkkkkkkkk....|
|...kvvvvvvvvvvvvvvk...|
|..kvvvvvvvvvvvvvvvvk..|
|.kvvvvvvvvvvvvvvvvvvk.|
|.kvvvvvvvvvvvvvvvvvvk.|
|.kvvkvvvvvvvvvvvvkvvk.|
|.kvvkvvvvvvvvvvvvkvvk.|
|.kvvkvvvvvvvvvvvvkvvk.|
|.kvvkvvvvvvvvvvvvkvvk.|
|.kkkkkkkkkkkkkkkkkkkk.|
]]}

-- ---------- back props ----------
P.propBack = {}
-- lead: brick phone at right ear, antenna up past the head, sleeve to shoulder
P.propBack.lead = { 21, 0, [[
|...p....|
|...k....|
|...k....|
|...k....|
|...k....|
|...k....|
|...k....|
|...k....|
|..kkkk..|
|..kaak..|
|..kkkk..|
|..kaak..|
|..kaak..|
|.ksaak..|
|.ksssk..|
|.kssskk.|
|..kppk..|
|...kppk.|
|...kppk.|
|...kppk.|
|...kppk.|
]]}
P.earsBack = {
 lead = { 6, 13, "|.k|\n|ks|\n|ks|\n|.k|" },
 implement = { 6, 13, "|.k|\n|ks|\n|ks|\n|.k|" },
}
P.earsBackR = {
 implement = { 23, 13, "|k.|\n|sk|\n|sk|\n|k.|" },
}
-- buddy headphones: cups + band drawn as stamps (band traced on the hair by hand)
P.phonesBack = {
 { 5, 12, [[
|.kkk.............kkk.|
|kpppk...........kpppk|
|kpmpk...........kpmpk|
|kpppk...........kpppk|
|kpppk...........kpppk|
|kpppk...........kpppk|
|.kkk.............kkk.|
]]},
 { 6, 6, [[
|.....aaaaaaa.....|
|...aa.......aa...|
|..a...........a..|
|.a.............a.|
|.a.............a.|
|a...............a|
]]},
}
P.tailsBack = nil

return P
