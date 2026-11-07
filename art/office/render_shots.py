"""S1v2 shots, drawn the way the UI will: plate -> sprites (y-sorted, lower anchor in front) -> front overlay.
Sprite bottom-centre sits on the slice bottom-centre; the "!" bubble sits at anchor + bubble.offset.
Writes <p>-{mode}-3x.png (floor plate), <p>-pent-{mode}-3x.png (roof plate),
<p>-composite-{mode}-3x.png (+ -480.png): roof stacked on the floor, busy cast placed, front overlays on top.
Usage: python -I art/office/render_shots.py <outprefix> [frame]   (run from the repo root)"""
import json, sys
from PIL import Image

fl = json.load(open('public/office/floor.json'))
cj = json.load(open('public/office/cast.json'))
CELL = cj['cell']
frame = int(sys.argv[2]) if len(sys.argv) > 2 else 0
out = sys.argv[1]

def role(r):
    return r if r in cj['roles'] else cj['fallback'][r]

A, B, E, PH = fl['teamA'], fl['teamB'], fl['elevator'], fl['penthouse']
RH = PH['h']
def at(s, dy=0): return {'x': s['x'], 'y': s['y'] + dy, 'w': s['w'], 'h': s['h']}
cast = [
    (A['buddyOffice'], 'buddy', 'work'), (A['lead'], 'lead', 'work'),
    (A['desks'][0], 'implement', 'work'), (A['desks'][1], 'review', 'needs'), (A['desks'][2], 'implement', 'work'),
    (A['desks'][3], 'spec', 'work'), (A['desks'][4], 'art', 'work'), (A['desks'][5], 'unknown', 'work'),
    (B['buddyOffice'], 'buddy', 'needs'), (B['lead'], 'lead', 'needs'),
    (B['desks'][0], 'review', 'work'), (B['desks'][1], 'implement', 'work'), (B['desks'][2], 'audit', 'work'),
    (B['desks'][3], 'mechanical', 'work'), (B['desks'][4], 'retired-lead', 'needs'), (B['desks'][5], 'retired-lead', 'work'),
    (E['car'], 'unknown', 'ride'),
]
lob = A['lobby']
for i, r in enumerate(['implement', 'review', 'lead']):
    cast.append(({'x': lob['x'] + lob['w'] - 24 - i * 22 - (CELL - 24) // 2, 'y': lob['y'], 'w': 24, 'h': lob['h']}, r, 'idle'))
cast = [(at(s, RH), r, p) for s, r, p in cast]
cast += [(PH['riffbot']['seat'], 'riffbot', 'work'), (PH['overlord']['seat'], 'overlord', 'needs'),
         (PH['elevatorTop'], 'review', 'ride')]

def place(img, sheet, items):
    bub = cj['bubble']
    bimg = sheet.crop((bub['x'], bub['y'], bub['x'] + bub['w'], bub['y'] + bub['h']))
    bubbles = []
    for s, r, pose in sorted(items, key=lambda t: t[0]['y'] + t[0]['h']):
        fr = cj['roles'][role(r)][pose]
        f = fr[frame % len(fr)]
        spr = sheet.crop((f['x'], f['y'], f['x'] + CELL, f['y'] + CELL))
        ax, ay = s['x'] + s['w'] // 2, s['y'] + s['h']
        img.alpha_composite(spr, (ax - CELL // 2, ay - CELL))
        if pose == 'needs':
            bubbles.append((ax + bub['offset']['x'], ay + bub['offset']['y']))
    return bimg, bubbles

for mode in ('dark', 'light'):
    floor = Image.open(f'public/office/floor-{mode}.png').convert('RGBA')
    roof = Image.open(f'public/office/roof-{mode}.png').convert('RGBA')
    floor.resize((1920, 1080), Image.NEAREST).save(f'{out}-{mode}-3x.png')
    roof.resize((1920, RH * 3), Image.NEAREST).save(f'{out}-pent-{mode}-3x.png')
    sheet = Image.open(f'public/office/cast-{mode}.png').convert('RGBA')
    st = Image.new('RGBA', (640, RH + 360))
    st.paste(roof, (0, 0)); st.paste(floor, (0, RH))
    bimg, bubbles = place(st, sheet, cast)
    if fl.get('front'):
        st.alpha_composite(Image.open(f'public/office/floor-front-{mode}.png').convert('RGBA'), (0, RH))
    if PH.get('front'):
        st.alpha_composite(Image.open(f'public/office/roof-front-{mode}.png').convert('RGBA'), (0, 0))
    for b in bubbles: st.alpha_composite(bimg, b)
    st.resize((1920, st.height * 3), Image.NEAREST).save(f'{out}-composite-{mode}-3x.png')
    st.resize((480, st.height * 3 // 4), Image.LANCZOS).save(f'{out}-composite-{mode}-480.png')
    print(f'{out}-{{,pent-,composite-}}{mode}-3x.png')
