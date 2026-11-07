"""S1 shots: plate + cast placed per the contract (public/office/*.json), 3x (1920x1080) and 480px.
Sprite bottom-centre sits on the slice bottom-centre; the "!" bubble sits at anchor + bubble.offset.
Usage: python -I art/office/render_shots.py <outprefix> [frame]   (run from the repo root)"""
import json, sys
from PIL import Image

fl = json.load(open('public/office/floor.json'))
cj = json.load(open('public/office/cast.json'))
CELL = cj['cell']
frame = int(sys.argv[2]) if len(sys.argv) > 2 else 0

def role(r):
    return r if r in cj['roles'] else cj['fallback'][r]

# a busy floor: (slice, role, pose)
A, B, E = fl['teamA'], fl['teamB'], fl['elevator']
cast = [
    (A['buddyOffice'], 'buddy', 'work'), (A['lead'], 'lead', 'work'),
    (A['desks'][0], 'implement', 'work'), (A['desks'][1], 'review', 'needs'), (A['desks'][2], 'implement', 'work'),
    (A['desks'][3], 'spec', 'work'), (A['desks'][4], 'art', 'work'),
    (B['buddyOffice'], 'buddy', 'needs'), (B['lead'], 'lead', 'work'),
    (B['desks'][0], 'review', 'work'), (B['desks'][1], 'implement', 'work'), (B['desks'][2], 'audit', 'work'),
    (B['desks'][3], 'mechanical', 'work'), (B['desks'][5], 'retired-lead', 'work'),
    (E['car'], 'unknown', 'ride'),
]
# overflow queue in team A's lobby: 3 idle, packed from the door side
lob = A['lobby']
for i, r in enumerate(['implement', 'review', 'lead']):
    cast.append(({'x': lob['x'] + lob['w'] - 24 - i * 22 - (CELL - 24) // 2, 'y': lob['y'], 'w': 24, 'h': lob['h']}, r, 'idle'))

def compose(mode):
    plate = Image.open(f'public/office/floor-{mode}.png').convert('RGBA')
    sheet = Image.open(f'public/office/cast-{mode}.png').convert('RGBA')
    bub = cj['bubble']
    bimg = sheet.crop((bub['x'], bub['y'], bub['x'] + bub['w'], bub['y'] + bub['h']))
    for s, r, pose in cast:
        fr = cj['roles'][role(r)][pose]
        f = fr[frame % len(fr)]
        spr = sheet.crop((f['x'], f['y'], f['x'] + CELL, f['y'] + CELL))
        ax, ay = s['x'] + s['w'] // 2, s['y'] + s['h']
        plate.alpha_composite(spr, (ax - CELL // 2, ay - CELL))
        if pose == 'needs':
            plate.alpha_composite(bimg, (ax + bub['offset']['x'], ay + bub['offset']['y']))
    return plate

out = sys.argv[1]
for mode in ('dark', 'light'):
    im = compose(mode)
    big = im.resize((1920, 1080), Image.NEAREST); big.save(f'{out}-{mode}-3x.png')
    small = im.resize((480, 270), Image.LANCZOS); small.save(f'{out}-{mode}-480.png')
    print(f'{out}-{mode}-3x.png', big.size, f'{out}-{mode}-480.png', small.size)

# penthouse: roof plate stacked on top of the floor plate (roof rects are roof-plate px)
PH = fl['penthouse']
pcast = [(PH['riffbot']['seat'], 'riffbot', 'work'), (PH['overlord']['seat'], 'overlord', 'work'),
         (PH['elevatorTop'], 'review', 'ride')]
pcast_needs = [(PH['riffbot']['seat'], 'riffbot', 'needs'), (PH['overlord']['seat'], 'overlord', 'needs'),
               (PH['elevatorTop'], 'review', 'ride')]

def place(plate, sheet, items, dy=0):
    bub = cj['bubble']
    bimg = sheet.crop((bub['x'], bub['y'], bub['x'] + bub['w'], bub['y'] + bub['h']))
    for s, r, pose in items:
        fr = cj['roles'][role(r)][pose]
        f = fr[frame % len(fr)]
        spr = sheet.crop((f['x'], f['y'], f['x'] + CELL, f['y'] + CELL))
        ax, ay = s['x'] + s['w'] // 2, s['y'] + s['h'] + dy
        plate.alpha_composite(spr, (ax - CELL // 2, ay - CELL))
        if pose == 'needs':
            plate.alpha_composite(bimg, (ax + bub['offset']['x'], ay + bub['offset']['y']))

for mode in ('dark', 'light'):
    sheet = Image.open(f'public/office/cast-{mode}.png').convert('RGBA')
    roof = Image.open(f'public/office/roof-{mode}.png').convert('RGBA')
    floor = compose(mode)
    st = Image.new('RGBA', (640, PH['h'] + 360))
    st.paste(roof, (0, 0)); st.paste(floor, (0, PH['h']))
    place(st, sheet, pcast)
    st.resize((1920, st.height * 3), Image.NEAREST).save(f'{out}-pent-{mode}-3x.png')
    st.resize((480, st.height * 3 // 4), Image.LANCZOS).save(f'{out}-pent-{mode}-480.png')
    r2 = roof.copy(); place(r2, sheet, pcast_needs)
    r2.resize((1920, 600), Image.NEAREST).save(f'{out}-roof-needs-{mode}-3x.png')
    print(f'{out}-pent-{mode}-3x.png', (1920, st.height * 3), f'{out}-roof-needs-{mode}-3x.png (1920, 600)')
