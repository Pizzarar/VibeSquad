-- S1 stretch cast: the 6 roles beyond H0, as goofy non-human office workers (hand-placed
-- ASCII maps, same key + conventions as floor.lua / front.lua). Loaded by art/office/build_cast.lua.
--   retired-lead: old walrus in a mustard cardigan with tea   (back: bald dome + whisker wings)
--   mechanical  : boxy robot, backwards pink cap, teal jumpsuit, wrench (back: cap brim + bolt)
--   audit       : owl night guard, violet cap, flashlight       (back: ear tufts + cap)
--   spec        : cat in big round glasses, clipboard            (back: pointy ears + scrunchie tuft)
--   art         : poodle with a pink beret, paint-dot smock      (back: fluffy cloud + beret)
--   unknown     : paper-bag head in a trench coat                (back: crumpled bag top)
-- Key: k INK, v VIOLET, p PINK, c CORAL, a AMBER, s SKIN, m MARBLE, t TEAL, g MINT
return function(L, P, F)
  local function pad(map)
    local rows, w = {}, 0
    for row in map:gmatch("[^\n]+") do
      row = row:gsub("^%s*|", ""):gsub("|%s*$", "")
      rows[#rows+1] = row; w = math.max(w, #row)
    end
    for i, r in ipairs(rows) do rows[i] = "|"..r..string.rep(".", w - #r).."|" end
    return table.concat(rows, "\n")
  end
  local function part(x, y, map) return { x, y, pad(map) } end
  local function recol(map, from, to) return (map:gsub(from, to)) end

  -- shared torsos (X = coat, Y = shirt/inner, H = hand, Z = trouser/knee)
  local BACK = [[
|....kkkkkkkkkkkkkk....|
|...kXXXXXXXXXXXXXXk...|
|..kXXXXXXXXXXXXXXXXk..|
|.kXXXXXXXXXXXXXXXXXXk.|
|.kXXXXXXXXXXXXXXXXXXk.|
|.kXXkXXXXXXXXXXXXkXXk.|
|.kXXkXXXXXXXXXXXXkXXk.|
|.kXXkXXXXXXXXXXXXkXXk.|
|.kXXkXXXXXXXXXXXXkXXk.|
|.kkkkkkkkkkkkkkkkkkkk.|
]]
  local FRONT = [[
|....kkkkkkkkkkkkkk....|
|...kXXXXkYYYYkXXXXk...|
|..kXXXXXkYYYYkXXXXXk..|
|.kXXXXXXkYYYYkXXXXXXk.|
|.kXXXXXXXkYYkXXXXXXXk.|
|.kXXkXXXXXkkXXXXXXkXXk|
|.kXXkXXXXXXXXXXXXXkXXk|
|.kXXkXXXXXXXXXXXXXkXXk|
|.kXXkXXXXXXXXXXXXXkHHk|
|.kkkkkkkkkkkkkkkkkkkkk|
|....kZZZk....kZZZk....|
|....kkkkk....kkkkk....|
]]
  local ARM = [[
|.k.k.k.|
|kHkHkk.|
|kHHHHk.|
|kHHHHk.|
|.kHHk..|
|.kXXk..|
|..kXXk.|
|..kXXk.|
|..kXXk.|
|...kXk.|
]]
  local function torso(t, X, Y, H, Z)
    t = t:gsub("X", X):gsub("Y", Y or X):gsub("H", H or "s"):gsub("Z", Z or "v")
    return t
  end
  local function arm(X, H) return (ARM:gsub("X", X):gsub("H", H)) end

  local back, front, backExtra = { body = {}, head = {}, prop = {}, ears = {}, earsR = {} }, { body = {}, head = {}, fx = {} }, {}
  local stand = {}
  local NOBUB = { 0, 0, "|.|" } -- fx[1] slot is the (skipped) bubble

  -- ---------------- retired-lead: walrus grandpa ----------------
  back.head["retired-lead"] = part(6, 3, [[
|.......kkkkk.......|
|.....kkcccccckk....|
|....kccmmccccccck..|
|...kccmcccccccccck.|
|..kcccccccccccccck.|
|..kcccccccccccccck.|
|.kcccccccccccccccck|
|.kmcccccccccccccmck|
|kmmmcccccccccccmmmk|
|kmmmcccccccccccmmmk|
|.kmcccccccccccccmk.|
|.kmmcccccccccccmmk.|
|kmmmmkcccccccckmmmmk|
|.kkkk.kccccccck.kkkk|
|.......kcccck.......|
|.......kcccck.......|
|.......kcccck.......|
|......kkkkkkkk......|
]])
  back.body["retired-lead"] = part(5, 21, torso(BACK, "a"):gsub("akaa", "akca", 1))
  front.head["retired-lead"] = { part(6, 3, [[
|.......kkkkk.......|
|.....kkcccccckk....|
|....kccmmccccccck..|
|...kccmcccccccccck.|
|..kcccccccccccccck.|
|..kkkkkcccccckkkkk.|
|.kckmmkkcccckkmmkck|
|.kckmkmkcccckmkmkck|
|.kckkkkcccccckkkkck|
|.kcccccccppccccccck|
|kmmmmmmmmppmmmmmmmk|
|kmmmmmmmmmmmmmmmmmk|
|.kkmmmkkppppkkmmmkk|
|...kmk.kkkkk..kmk..|
|....k..........k...|
]]) }
  front.body["retired-lead"] = part(5, 20, torso(FRONT, "a", "m", "c", "v"):gsub("kYYk", "kpYk", 1))
  front.fx["retired-lead"] = { NOBUB, part(0, 11, arm("a", "c")),
    -- tea cup in the raised flipper
    part(0, 5, [[
|.k.k...|
|..k.k..|
|kkkkkk.|
|kmmmmkk|
|kmppmk.|
|.kmmk..|
]]) }
  stand["retired-lead"] = { 3, L.VIOLET }

  -- ---------------- mechanical: robot in a backwards cap ----------------
  back.head.mechanical = part(6, 2, [[
|........kpk........|
|.........k.........|
|.....kkkkkkkkk.....|
|....kpppppppppk....|
|...kpppppppppppk...|
|...kpppppppppppk...|
|..kpppppkkkpppppk..|
|..kppppkmmmkppppk..|
|.kkkkkkkkkkkkkkkkk.|
|.kmmmmmmmmmmmmmmmk.|
|.kmmmmmmmmmmmmmmmk.|
|.kmmkkmmmmmmmkkmmk.|
|.kmmkkmmmmmmmkkmmk.|
|.kmmmmmmmmmmmmmmmk.|
|.kmmmmmmmmmmmmmmmk.|
|.kkkkkkkkkkkkkkkkk.|
|.......kmmmk.......|
|.......kkkkk.......|
|.......kmmmk.......|
]])
  back.body.mechanical = part(5, 21, torso(BACK, "t"):gsub("ktttttttttttttttttk", "ktttttmmmmmmmttttk", 1))
  front.head.mechanical = { part(6, 1, [[
|........kpk........|
|.........k.........|
|.....kkkkkkkkk.....|
|....kpppppppppk....|
|...kpppppppppppk...|
|..kkkkkkkkkkkkkkk..|
|.kmmmmmmmmmmmmmmmk.|
|.kmkkkkkkkkkkkkkmk.|
|.kmkttktttttkttkmk.|
|.kmktkkttttkkttkmk.|
|.kmkttktttttkttkmk.|
|.kmkkkkkkkkkkkkkmk.|
|.kmmmmmmmmmmmmmmmk.|
|.kmmmkkkkkkkkmmmmk.|
|.kmmmkgmgmgmkmmmmk.|
|.kmmmkkkkkkkkmmmmk.|
|.kkkkkkkkkkkkkkkkk.|
|.......kmmmk.......|
|.......kkkkk.......|
]]) }
  front.body.mechanical = part(5, 20, torso(FRONT, "t", "a", "m", "t"))
  front.fx.mechanical = { NOBUB, part(0, 11, arm("t", "m")),
    -- wrench
    part(1, 3, [[
|k.k..|
|kmk..|
|kmmk.|
|.kmk.|
|.kmk.|
|.kmk.|
|.kmk.|
|..k..|
]]) }
  stand.mechanical = { 1, L.TEAL }

  -- ---------------- audit: owl night guard ----------------
  back.head.audit = part(6, 2, [[
|.kk.............kk.|
|.kak...........kak.|
|.kaak.kkkkkkk.kaak.|
|..kaakvvvvvvvkaak..|
|..kavvvvvvvvvvvak..|
|..kvvvvvvvvvvvvvk..|
|.kvvvvvvvvvvvvvvvk.|
|.kkkkkkkkkkkkkkkkk.|
|.kaaaaaaaaaaaaaaak.|
|kaacaaaaacaaaaacaak|
|kaaaaaacaaaaacaaaak|
|kaacaaaaaaacaaaacak|
|kaaaaacaaaaaaacaaak|
|.kaacaaaaacaaaaaak.|
|.kaaaaaacaaaaaaaak.|
|..kaaaaaaaaaaaaak..|
|...kkaaaaaaaaakk...|
|.....kkkaaakkk.....|
|.......kaaak.......|
]])
  back.body.audit = part(5, 21, torso(BACK, "v"):gsub("kvvvvvvvvvvvvvvvvvvk", "kvvvvvvvvvvvvvvvvvak", 1))
  front.head.audit = { part(6, 1, [[
|.kk.............kk.|
|.kak...........kak.|
|.kaak.kkkkkkk.kaak.|
|..kaakvvvvvvvkaak..|
|..kavvvvvavvvvvak..|
|..kvvvvvaaavvvvvk..|
|.kkkkkkkkkkkkkkkkk.|
|.kmmmmmmakmmmmmmak.|
|kammmmmmakmmmmmmmak|
|kmmkkkmmmmmmkkkkmak|
|kmkmmmkmmmmkmmmmkmk|
|kmkmkmkmmmmkmmkmkmk|
|kmkmmmkmmmmkmmmmkmk|
|kammkkkmaamkkkkmmak|
|.kammmmmmaammmmmak.|
|..kaaammmmmmmaaak..|
|...kkaaaaaaaaakk...|
|.....kkkaaakkk.....|
|.......kaaak.......|
]]) }
  front.body.audit = part(5, 20, torso(FRONT, "v", "m", "a", "v"):gsub("kYYk", "kaak", 1))
  front.fx.audit = { NOBUB, part(0, 11, arm("v", "a")),
    -- flashlight, beam up
    part(0, 1, [[
|a.a.a..|
|.aaa...|
|..a....|
|.kkkk..|
|.kaak..|
|.kkkk..|
|.kkkk..|
|.kkkk..|
|..kk...|
|..kk...|
]]) }
  stand.audit = { 1, L.VIOLET }

  -- ---------------- spec: cat in round glasses ----------------
  back.head.spec = part(6, 1, [[
|........kkk........|
|.......kaaak.......|
|.......kaaak.......|
|........kmk........|
|..k.....kmk.....k..|
|.kpk...kmmmk...kpk.|
|.kmpk.kmmmmmk.kpmk.|
|.kmmpkkkkkkkkkpmmk.|
|.kmmmmmmmmmmmmmmmk.|
|kmmmmmmmmmmmmmmmmmk|
|kmmmmmmmmmmmmmmmmmk|
|kmmmmmmmmmmmmmmmmmk|
|kmmmmmmmmmmmmmmmmmk|
|kmmmmmmmmmmmmmmmmmk|
|.kmmmmmmmmmmmmmmmk.|
|.kmmmmmmmmmmmmmmmk.|
|..kkmmmmmmmmmmmkk..|
|....kkkkmmmkkkk....|
|.......kmmmk.......|
|.......kmmmk.......|
]])
  back.body.spec = part(5, 21, torso(BACK, "g"))
  front.head.spec = { part(6, 4, [[
|..k.............k..|
|.kpk...........kpk.|
|.kmpk..kkkkk..kpmk.|
|.kmmpkkmmmmmkkpmmk.|
|.kmmmmmmmmmmmmmmmk.|
|kmkkkkkmmmmmkkkkkmk|
|kkmtttkkkkkkkttmkkk|
|kmkttkkmmmmmkktttkm|
|kmkkkkkmmmmmkkkkkmk|
|kmmmmmmmmpmmmmmmmmk|
|kccmmmmmkpkmmmmmcck|
|kmmmmmmmmkmmmmmmmmk|
|.kmmmmkmkmkmmmmmmk.|
|.kmmmmmkmkmmmmmmmk.|
|..kkmmmmmmmmmmmkk..|
|....kkkkmmmkkkk....|
|.......kmmmk.......|
]]) }
  front.body.spec = part(5, 20, torso(FRONT, "g", "m", "m", "v"))
  front.fx.spec = { NOBUB, part(0, 11, arm("g", "m")),
    -- clipboard held up
    part(0, 2, [[
|..kkk..|
|kkkakkk|
|kmmmmmk|
|kmkkkmk|
|kmmmmmk|
|kmkkmmk|
|kmmmmmk|
|kkkkkkk|
]]) }
  stand.spec = { 3, L.MINT }

  -- ---------------- art: poodle in a beret ----------------
  back.head.art = part(5, 1, [[
|.......kkkkkkkk.....|
|.....kkppppppppkk...|
|....kppppppppppppk..|
|....kkkkkkkkkkkkkk..|
|...kmmkmmkmmkmmkmmk.|
|..kmmmmmmmmmmmmmmmmk|
|.kmmmmmmmmmmmmmmmmmk|
|kmmmmmmmmmmmmmmmmmmmk|
|kmmmmmmmmmmmmmmmmmmmk|
|.kmmmmmmmmmmmmmmmmmk|
|kmmmmmmmmmmmmmmmmmmmk|
|kmmmmmmmmmmmmmmmmmmmk|
|.kmmmmmmmmmmmmmmmmmk|
|kmmmkmmmmmmmmmmmkmmmk|
|kmmk.kmmmmmmmmmk.kmmk|
|.kk...kmmmmmmmk...kk.|
|.......kmmmmmk.......|
|........kmmmk........|
|........kmmmk........|
|........kmmmk........|
]])
  back.body.art = part(5, 21, torso(BACK, "t"):gsub("kttttttttttttttttttk", "kttpttttattttgtttttk", 1))
  backExtra.art = { part(16, 1, "|..k|\n|.kpk|\n|..k.|") }
  front.head.art = { part(5, 1, [[
|.......kkkkkkkk.....|
|.....kkppppppppkk...|
|....kppppppppppppkk.|
|....kkkkkkkkkkkkkkpk|
|...kmmkmmkmmkmmkmmk.|
|..kmmmmmmmmmmmmmmmmk|
|.kmmmmmmmmmmmmmmmmmk|
|kmmmmkkkmmmmmkkkmmmmk|
|kmmmkkmkmmmmkkmkmmmmk|
|kmmmkkkkmmmmkkkkmmmmk|
|.kmmmmmmmmmmmmmmmmmk|
|kmmmccmmmkkkmmmccmmmk|
|kmmmmmmmmkpkmmmmmmmmk|
|.kmmmmmkkkkkkkmmmmmk|
|kmmmmmmkpppppkmmmmmmk|
|kmmk.kmmkkkkkmmk.kmmk|
|.kk...kmmmmmmmk...kk.|
|.......kmmmmmk.......|
|........kmmmk........|
]]) }
  front.body.art = part(5, 20, torso(FRONT, "t", "m", "m", "v"):gsub("kttkttttt", "kttkptttt", 1):gsub("ttttttkttk", "ttatttkttk", 1))
  front.fx.art = { NOBUB, part(0, 11, arm("t", "m")),
    -- paintbrush, pink tip
    part(2, 3, [[
|.kk.|
|kppk|
|kppk|
|.kk.|
|.ka.|
|.ka.|
|.ka.|
|.ka.|
]]) }
  stand.art = { 1, L.VIOLET }

  -- ---------------- unknown: paper-bag head in a trench coat ----------------
  back.head.unknown = part(6, 2, [[
|..k..k...k...k..k..|
|.kak.kakkak.kakkak.|
|.kaakaaaaaakaaaaak.|
|.kaaaaaaaaaaaaaaak.|
|.kaaaaaaaaaaaaaaak.|
|.kaacaaaaaaaaaaaak.|
|.kaaaaaaaaaaaacaak.|
|.kaaaaaaaaaaaaaaak.|
|.kaaaaaacaaaaaaaak.|
|.kaaaaaaaaaaaaaaak.|
|.kaaaaaaaaaaaaaaak.|
|.kaaacaaaaaaaaaaak.|
|.kaaaaaaaaaaaaaaak.|
|.kaaaaaaaaaaaaaaak.|
|.kkkkkkkkkkkkkkkkk.|
|...kcccccccccccck..|
|....kcckkkkkkcck...|
|.....kk......kk....|
]])
  back.body.unknown = part(5, 21, torso(BACK, "c"):gsub("kccccccccccccccccccck", "kcccccckkkkkkkcccccck", 1))
  front.head.unknown = { part(6, 2, [[
|..k..k...k...k..k..|
|.kak.kakkak.kakkak.|
|.kaakaaaaaakaaaaak.|
|.kaaaaaaaaaaaaaaak.|
|.kaaaaaaaaaaaaaaak.|
|.kaakkkaaaaaakkkak.|
|.kaakkkaaaaaakkkak.|
|.kaaaaaaakkkaaaaak.|
|.kaaaaaakaaakaaaak.|
|.kaaaaaaaaaakaaaak.|
|.kaaaaaaaakkaaaaak.|
|.kaaaaaaaakaaaaaak.|
|.kaaaaaaaaaaaaaaak.|
|.kaaaaaaaakaaaaaak.|
|.kkkkkkkkkkkkkkkkk.|
|...kcccccccccccck..|
|....kcckkkkkkcck...|
|.....kk......kk....|
]]) }
  front.body.unknown = part(5, 20, torso(FRONT, "c", "m", "m", "c"):gsub("kmmmmk", "kkkkkk", 1))
  front.fx.unknown = { NOBUB, part(0, 11, arm("c", "m")) }
  stand.unknown = { 2, L.CORAL }

  return {
    roles = { "retired-lead", "mechanical", "audit", "spec", "art", "unknown" },
    back = back, front = front, backExtra = backExtra, stand = stand,
  }
end
