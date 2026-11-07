-- S1v2 shared 3/4 top-down furniture (camera above + behind, ~45deg): desks seen from above with the
-- CRT's top face + rear bulge toward the camera, glass fronts, plates. Used by build_floor.lua and
-- build_roof.lua. All shapes hand-placed; P0 slots only.
return function(L)
  local K = { k=15, v=8, p=9, c=10, a=11, s=14, m=4, t=7, g=12, y=13, l=3, h=2, n=1 }
  local M = { K = K }

  -- desktop slab: top face (light far edge) + front face, INK rim. x,y = top-left of the top face.
  function M.slab(c, x, y, w, d, top, front, fh)
    top, front, fh = top or L.AMBER, front or L.CORAL, fh or 3
    c.rect(x-1, y-1, w+2, d+fh+2, L.INK)
    c.rect(x, y, w, d, top)
    c.hline(x, y, w, L.MARBLE)
    c.rect(x, y+d+1, w, fh-1, front)
    c.hline(x, y+d, w, L.INK)
  end

  -- CRT from above + behind: screen glow lip on the far edge, top face, tapered rear bulge with vents.
  -- x,y = top-left of the case top face; 16 wide.
  function M.crt(c, x, y, sticker)
    c.hline(x+2, y-2, 12, L.TEAL); c.hline(x+1, y-1, 14, L.INK)                -- screen light spilling over
    c.rect(x, y, 16, 7, L.INK); c.rect(x+1, y, 14, 6, L.MARBLE)
    c.hline(x+1, y, 14, L.LINE)                                                  -- far bezel edge
    c.rect(x+3, y+7, 10, 9, L.INK); c.rect(x+4, y+7, 8, 8, L.MARBLE)             -- rear bulge
    c.vline(x+11, y+7, 8, L.LINE)
    for vy=y+9, y+13, 2 do c.hline(x+5, vy, 5, L.LINE) end                       -- vents
    if sticker then c.stamp(x+11, y+1, sticker, K) end
  end

  -- keyboard + mouse on a pad (mostly hidden under the sitter's head; hands land here)
  function M.keys(c, x, y)
    c.rect(x, y, 16, 5, L.INK); c.rect(x+1, y+1, 14, 3, L.MARBLE)
    for i=0,6 do c.px(x+2+i*2, y+2, L.LINE) end
    c.rect(x+18, y, 6, 6, L.VIOLET); c.rect(x+20, y+1, 2, 3, L.MARBLE); c.px(x+20, y+1, L.INK)
  end

  -- glass front wall (seen from the camera side): rim cap, see-through glass with glints, kick plate.
  -- Drawn into the front overlay so it covers the chair bases behind it.
  function M.glassFront(c, x0, x1, yRim, posts, face)
    face = face or L.TEAL
    c.hline(x0, yRim-1, x1-x0+1, L.INK)
    c.hline(x0, yRim, x1-x0+1, L.MARBLE); c.hline(x0, yRim+1, x1-x0+1, face)
    c.hline(x0, yRim+2, x1-x0+1, L.INK)
    for _, px in ipairs(posts) do c.vline(px-1, yRim+3, 6, L.INK); c.vline(px, yRim+3, 6, L.MARBLE); c.vline(px+1, yRim+3, 6, L.INK) end
    -- glints (diagonal, sparse so the sitter reads through)
    for gx=x0+4, x1-6, 13 do
      for i=0,3 do c.px(gx+i, yRim+7-i, L.MARBLE) end
      c.px(gx+5, yRim+6, L.MARBLE)
    end
    L.plate(c, x0, yRim+10, x1-x0+1, 6, face, L.MARBLE, L.LINE)
  end

  return M
end
