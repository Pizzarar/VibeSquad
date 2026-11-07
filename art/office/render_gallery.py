"""S1 gallery: all 10 roles, 4x. Per mode: 64px busts row + the cast sheet (work0 work1 needs0 needs1 idle ride).
Usage: python -I art/office/render_gallery.py <out.png>   (busts from scratch/s1-busts, run build_extra.lua first)"""
import json, sys
from PIL import Image
ROLES = ["lead", "buddy", "implement", "review", "retired-lead", "mechanical", "audit", "spec", "art", "unknown"]
cj = json.load(open('public/office/cast.json'))
BG = {'dark': (20, 12, 38, 255), 'light': (253, 244, 236, 255)}
Z = 4
cols = []
for mode in ('dark', 'light'):
    sheet = Image.open(f'public/office/cast-{mode}.png').convert('RGBA')
    W = 10 * 68 * Z
    H = (68 + len(ROLES) * 34 + 4) * Z
    im = Image.new('RGBA', (W, H), BG[mode])
    for i, r in enumerate(ROLES):
        b = Image.open(f'scratch/s1-busts/{r}-{mode}.png').convert('RGBA').resize((64 * Z, 64 * Z), Image.NEAREST)
        im.alpha_composite(b, (i * 68 * Z + 2 * Z, 2 * Z))
    for j, r in enumerate(ROLES):
        c = cj['roles'][r]
        frames = c['work'] + c['needs'] + c['idle'] + c['ride']
        for k, f in enumerate(frames):
            cell = sheet.crop((f['x'], f['y'], f['x'] + 32, f['y'] + 32)).resize((32 * Z, 32 * Z), Image.NEAREST)
            im.alpha_composite(cell, ((k * 34 + 2) * Z, (68 + j * 34) * Z))
    b = cj['bubble']
    bub = sheet.crop((b['x'], b['y'], b['x'] + b['w'], b['y'] + b['h'])).resize((b['w'] * Z, b['h'] * Z), Image.NEAREST)
    im.alpha_composite(bub, (6 * 34 * Z + 8 * Z, 72 * Z))
    cols.append(im)
out = Image.new('RGBA', (cols[0].width * 2 + 8 * Z, cols[0].height), (0, 0, 0, 255))
out.paste(cols[0], (0, 0)); out.paste(cols[1], (cols[0].width + 8 * Z, 0))
out.save(sys.argv[1]); print(sys.argv[1], out.size)
