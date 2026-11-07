"""Contract v2 variant shots.
<p>-gallery-{dark,light}.png: one row per role, 4 variant blocks: floor work0 + needs0 at 4x, then the
matching public/cast.png bust (column v) at 2x (same on-screen size as a 4x floor cell).
<p>-floor-3x.png: the dark + light floor plates at 3x with a mixed-variant cast (plate -> y-sorted
sprites -> front overlay, bubbles on needs), stacked.
Usage: python -I art/office/render_variants.py <outprefix>   (run from the repo root)"""
import json, sys
from PIL import Image, ImageDraw

out = sys.argv[1]
cj = json.load(open('public/office/cast.json'))
fl = json.load(open('public/office/floor.json'))
CELL, Z, NV = cj['cell'], 4, 4
ROLES = list(cj['roles'])
BUST_ROW = {'lead': 0, 'retired-lead': 1, 'buddy': 2, 'implement': 3, 'mechanical': 4,
            'review': 5, 'audit': 6, 'spec': 7, 'art': 8, 'unknown': 9}  # = src/cast.ts CAST_ROWS
BG = {'dark': ((33, 22, 61, 255), (20, 12, 38, 255)), 'light': ((245, 230, 239, 255), (233, 213, 232, 255))}
bust = Image.open('public/cast.png').convert('RGBA')

def cell(sheet, f, n=CELL):
    return sheet.crop((f['x'], f['y'], f['x'] + n, f['y'] + n))

for mode in ('dark', 'light'):
    sheet = Image.open(f'public/office/cast-{mode}.png').convert('RGBA')
    S = CELL * Z
    blk = S * 3 + 24
    im = Image.new('RGBA', (NV * blk + 24, len(ROLES) * (S + 16) + 16), BG[mode][1])
    d = ImageDraw.Draw(im)
    for j, r in enumerate(ROLES):
        y = 16 + j * (S + 16)
        for v, var in enumerate(cj['roles'][r]['variants']):
            x = 24 + v * blk
            d.rectangle((x - 4, y - 4, x + S * 3 + 3, y + S + 3), fill=BG[mode][0])
            for k, f in enumerate((var['work'][0], var['needs'][0])):
                im.alpha_composite(cell(sheet, f).resize((S, S), Image.NEAREST), (x + k * S, y))
            b = bust.crop((v * 64, BUST_ROW[r] * 64, v * 64 + 64, BUST_ROW[r] * 64 + 64)).resize((S, S), Image.NEAREST)
            im.alpha_composite(b, (x + 2 * S, y))
    im.save(f'{out}-gallery-{mode}.png'); print(f'{out}-gallery-{mode}.png', im.size)

# floor composite: every role at least twice, variants mixed, no identical neighbours
A, B, E = fl['teamA'], fl['teamB'], fl['elevator']
cast = [
    (A['buddyOffice'], 'buddy', 1, 'work'), (A['lead'], 'lead', 2, 'work'),
    (A['desks'][0], 'implement', 1, 'work'), (A['desks'][1], 'review', 3, 'needs'), (A['desks'][2], 'implement', 3, 'work'),
    (A['desks'][3], 'spec', 2, 'work'), (A['desks'][4], 'art', 1, 'needs'), (A['desks'][5], 'unknown', 3, 'work'),
    (B['buddyOffice'], 'buddy', 3, 'needs'), (B['lead'], 'lead', 1, 'needs'),
    (B['desks'][0], 'review', 2, 'work'), (B['desks'][1], 'mechanical', 1, 'work'), (B['desks'][2], 'audit', 3, 'work'),
    (B['desks'][3], 'mechanical', 2, 'needs'), (B['desks'][4], 'retired-lead', 2, 'work'), (B['desks'][5], 'spec', 3, 'work'),
    (E['car'], 'unknown', 1, 'ride'),
]
lob = A['lobby']
for i, (r, v) in enumerate([('implement', 2), ('implement', 0), ('audit', 2)]):
    cast.append(({'x': lob['x'] + lob['w'] - 24 - i * 22 - (CELL - 24) // 2, 'y': lob['y'], 'w': 24, 'h': lob['h']}, r, v, 'idle'))
lob = B['lobby']
for i, (r, v) in enumerate([('art', 3), ('retired-lead', 1)]):
    cast.append(({'x': lob['x'] + i * 22 - (CELL - 24) // 2 + 4, 'y': lob['y'], 'w': 24, 'h': lob['h']}, r, v, 'idle'))

rows = []
for mode in ('dark', 'light'):
    sheet = Image.open(f'public/office/cast-{mode}.png').convert('RGBA')
    img = Image.open(f'public/office/floor-{mode}.png').convert('RGBA')
    bub = cj['bubble']
    bimg = sheet.crop((bub['x'], bub['y'], bub['x'] + bub['w'], bub['y'] + bub['h']))
    bubbles = []
    for s, r, v, pose in sorted(cast, key=lambda t: t[0]['y'] + t[0]['h']):
        f = cj['roles'][r]['variants'][v][pose][0]
        ax, ay = s['x'] + s['w'] // 2, s['y'] + s['h']
        img.alpha_composite(cell(sheet, f), (ax - CELL // 2, ay - CELL))
        if pose == 'needs':
            bubbles.append((ax + bub['offset']['x'], ay + bub['offset']['y']))
    if fl.get('front'):
        img.alpha_composite(Image.open(f'public/office/floor-front-{mode}.png').convert('RGBA'))
    for bx, by in bubbles:
        img.alpha_composite(bimg, (bx, by))
    rows.append(img.resize((img.width * 3, img.height * 3), Image.NEAREST))
both = Image.new('RGBA', (rows[0].width, rows[0].height * 2 + 12), (0, 0, 0, 255))
both.paste(rows[0], (0, 0)); both.paste(rows[1], (0, rows[0].height + 12))
both.save(f'{out}-floor-3x.png'); print(f'{out}-floor-3x.png', both.size)
