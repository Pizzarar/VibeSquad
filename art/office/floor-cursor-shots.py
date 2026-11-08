"""FS-b review shots: the selector cursor over a focused worker on the real floor plate, drawn the way the
UI will: plate -> sprites (bottom-centre on the slot) -> front overlay -> cursor (cell top-left at
anchor + bubble.offset + (14, 0), so the tip sits 2px above the 32px cell, centred on the worker).
Writes <out>-{mode}-{4k120,1080}.png (both bob frames side by side) + <out>-gallery-4x.png.
Usage: python -I art/office/floor-cursor-shots.py <outprefix>   (run from the repo root)"""
import json, sys
from PIL import Image

out = sys.argv[1]
fl = json.load(open('public/office/floor.json'))
cj = json.load(open('public/office/cast.json'))
cu = json.load(open('public/office/floor-cursor.json'))
CELL, CW, CH = cj['cell'], cu['cell']['w'], cu['cell']['h']
off = cj['bubble']['offset']
A = fl['teamA']
seats = [(A['desks'][0], 'implement', 'work', False), (A['desks'][1], 'review', 'work', True),
         (A['desks'][2], 'art', 'needs', False), (A['desks'][7], 'spec', 'work', False), (A['lead'], 'lead', 'work', False)]
CROP = (24, 84, 264, 222)  # native px: the team A desk rows

def frame(m, i):
    im = Image.open(f'public/office/floor-cursor-{m}.png').convert('RGBA')
    return im.crop((i * CW, 0, i * CW + CW, CH))

def scene(m, f):
    plate = Image.open(f'public/office/floor-{m}.png').convert('RGBA')
    sheet = Image.open(f'public/office/cast-{m}.png').convert('RGBA')
    front = Image.open(f'public/office/floor-front-{m}.png').convert('RGBA')
    bubble = sheet.crop((cj['bubble']['x'], cj['bubble']['y'], cj['bubble']['x'] + cj['bubble']['w'], cj['bubble']['y'] + cj['bubble']['h']))
    anchors = []
    for s, r, pose, focus in sorted(seats, key=lambda t: t[0]['y'] + t[0]['h']):
        ax, ay = s['x'] + s['w'] // 2, s['y'] + s['h']
        fr = cj['roles'][r][pose][0]
        plate.alpha_composite(sheet.crop((fr['x'], fr['y'], fr['x'] + CELL, fr['y'] + CELL)), (ax - CELL // 2, ay - CELL))
        anchors.append((ax, ay, pose, focus))
    plate.alpha_composite(front)
    for ax, ay, pose, focus in anchors:
        if pose == 'needs': plate.alpha_composite(bubble, (ax + off['x'], ay + off['y']))
        if focus: plate.alpha_composite(frame(m, f), (ax + off['x'] + 14, ay + off['y']))
    return plate.crop(CROP)

for m in ('dark', 'light'):
    for tag, k in (('4k120', 6), ('1080', 3)):
        a, b = scene(m, 0), scene(m, 1)
        w, h = a.size
        sheet = Image.new('RGBA', (w * 2 * k + k * 4, h * k), (128, 128, 128, 255))
        sheet.paste(a.resize((w * k, h * k), Image.NEAREST), (0, 0))
        sheet.paste(b.resize((w * k, h * k), Image.NEAREST), (w * k + k * 4, 0))
        sheet.save(f'{out}-{m}-{tag}.png')
g = Image.new('RGBA', ((CW * 2 + 6) * 4 * 2, (CH + 4) * 4), (128, 128, 128, 255))
for j, m in enumerate(('dark', 'light')):
    bg = (20, 12, 38, 255) if m == 'dark' else (253, 244, 236, 255)
    tile = Image.new('RGBA', (CW * 2 + 4, CH + 2), bg)
    tile.alpha_composite(frame(m, 0), (1, 1)); tile.alpha_composite(frame(m, 1), (CW + 3, 1))
    g.paste(tile.resize((tile.width * 4, tile.height * 4), Image.NEAREST), (j * (CW * 2 + 6) * 4, 4))
g.save(f'{out}-gallery-4x.png')
print('wrote', out)
