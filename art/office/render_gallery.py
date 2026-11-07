"""S1v2 gallery: every role in cast.json at 4x, per mode on the carpet colour (PANEL).
Cols: work0 work1 needs0 needs1 idle ride, then the bubble. Dark left, light right.
Usage: python -I art/office/render_gallery.py <out.png>   (run from the repo root)"""
import json, sys
from PIL import Image
cj = json.load(open('public/office/cast.json'))
ROLES = list(cj['roles'])
FLOOR = {'dark': (33, 22, 61, 255), 'light': (245, 230, 239, 255)}
Z, P = 4, 36
cols = []
for mode in ('dark', 'light'):
    sheet = Image.open(f'public/office/cast-{mode}.png').convert('RGBA')
    im = Image.new('RGBA', ((7 * P + 4) * Z, (len(ROLES) * P + 4) * Z), FLOOR[mode])
    for j, r in enumerate(ROLES):
        c = cj['roles'][r]
        for k, f in enumerate(c['work'] + c['needs'] + c['idle'] + c['ride']):
            cell = sheet.crop((f['x'], f['y'], f['x'] + 32, f['y'] + 32)).resize((32 * Z, 32 * Z), Image.NEAREST)
            im.alpha_composite(cell, ((k * P + 4) * Z, (j * P + 4) * Z))
    b = cj['bubble']
    bub = sheet.crop((b['x'], b['y'], b['x'] + b['w'], b['y'] + b['h'])).resize((b['w'] * Z, b['h'] * Z), Image.NEAREST)
    im.alpha_composite(bub, ((6 * P + 8) * Z, 8 * Z))
    cols.append(im)
out = Image.new('RGBA', (cols[0].width * 2 + 8 * Z, cols[0].height), (0, 0, 0, 255))
out.paste(cols[0], (0, 0)); out.paste(cols[1], (cols[0].width + 8 * Z, 0))
out.save(sys.argv[1]); print(sys.argv[1], out.size, ROLES)
