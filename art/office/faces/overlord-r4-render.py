"""C2a-R4 Overlord review gallery, one PNG per mode: H0 alien refs | Overlord R3 frames, 4x nearest.
Usage (repo root): python -I art/office/faces/overlord-r4-render.py [tag]
Needs scratch/c2a/alien-* (art/office/export_alien_ref.lua). Writes scratch/shots/c2a-r4-overlord-<tag>-{mode}.png"""
import json, sys
from PIL import Image, ImageDraw, ImageFont
TAG = sys.argv[1] if len(sys.argv) > 1 else 'wip'
BG = {'dark': (20, 12, 38, 255), 'light': (245, 230, 239, 255)}
FG = {'dark': (247, 240, 255, 255), 'light': (43, 24, 64, 255)}
try:
    FONT = ImageFont.truetype('consola.ttf', 18)
except OSError:
    FONT = ImageFont.load_default()
Z, PAD, LAB = 4, 24, 30

fj = json.load(open('public/office/faces.json'))
cw, ch = fj['cell']['w'], fj['cell']['h']
for mode in ('dark', 'light'):
    sheet = Image.open(f'public/office/face-overlord-{mode}.png').convert('RGBA')
    frames = [(f'{tag}[{i}]', sheet.crop((f['x'], f['y'], f['x'] + cw, f['y'] + ch)))
              for tag, fr in fj['overlord'].items() for i, f in enumerate(fr)]
    ref = [(n, Image.open(f'scratch/c2a/alien-{p}-{mode}.png').convert('RGBA'))
           for n, p in (('H0 alien bust 64', 'bust'), ('H0 alien floor', 'floor1'), ('H0 alien needs', 'floor2'))]
    rows = [ref, frames[:5], frames[5:]]
    colw = max(c.width for r in rows for _, c in r) * Z
    W = max(len(r) for r in rows) * (colw + PAD) + PAD
    H = 40 + sum(max(c.height for _, c in r) * Z + LAB + PAD for r in rows) + PAD
    im = Image.new('RGBA', (W, H), BG[mode]); d = ImageDraw.Draw(im)
    d.text((PAD, 8), f'R4-overlord brain-jar TV ({TAG}) - {mode} - {Z}x nearest, cell 48x48', font=FONT, fill=FG[mode])
    y = 40
    for r in rows:
        x, hm = PAD, max(c.height for _, c in r)
        for n, c in r:
            d.text((x, y), n, font=FONT, fill=FG[mode])
            im.alpha_composite(c.resize((c.width * Z, c.height * Z), Image.NEAREST), (x, y + LAB + (hm - c.height) * Z))
            x += colw + PAD
        y += hm * Z + LAB + PAD
    p = f'scratch/shots/c2a-r4-overlord-{TAG}-{mode}.png'
    im.save(p); print(p, im.size)
