"""C2a-R3 RiffBot review gallery, one PNG per mode: H0 alien refs | RiffBot R3 frames, 4x nearest.
Usage (repo root): python -I art/office/faces/riffbot-r3-preview.py <tag>
Needs scratch/c2a/alien-* (art/office/export_alien_ref.lua). Writes scratch/shots/c2a-r3-riff-<tag>-{mode}.png."""
import json, sys
from PIL import Image, ImageDraw, ImageFont
TAG = sys.argv[1] if len(sys.argv) > 1 else 'wip'
BG = {'dark': (20, 12, 38, 255), 'light': (245, 230, 239, 255)}
FG = {'dark': (247, 240, 255, 255), 'light': (43, 24, 64, 255)}
try:
    FONT = ImageFont.truetype('consola.ttf', 18)
except OSError:
    FONT = ImageFont.load_default()
fj = json.load(open('public/office/faces.json'))
for mode in ('dark', 'light'):
    sheet = Image.open(f'public/office/face-riffbot-{mode}.png').convert('RGBA')
    cells = [(f'{t}[{i}] x{f["x"]}', sheet.crop((f['x'], 0, f['x'] + 48, 48)))
             for t, fr in fj['riffbot'].items() for i, f in enumerate(fr)]
    refs = [('H0 alien bust 64', Image.open(f'scratch/c2a/alien-bust-{mode}.png').convert('RGBA')),
            ('H0 alien floor', Image.open(f'scratch/c2a/alien-floor1-{mode}.png').convert('RGBA'))]
    z, pad, lab = 4, 20, 26
    rows = [refs, cells[:4], cells[4:]]
    W = max(sum(max(c.width * z, 200) + pad for _, c in r) for r in rows) + pad
    H = 40 + sum(max(c.height for _, c in r) * z + lab + pad for r in rows) + pad
    im = Image.new('RGBA', (W, H), BG[mode]); d = ImageDraw.Draw(im)
    d.text((pad, 10), f'C2a-R3-riff {TAG}: RiffBot ticker face - {mode} - 4x (cell 48)', font=FONT, fill=FG[mode])
    y = 40
    for r in rows:
        x, hm = pad, max(c.height for _, c in r)
        for n, c in r:
            d.text((x, y), n, font=FONT, fill=FG[mode])
            im.alpha_composite(c.resize((c.width * z, c.height * z), Image.NEAREST), (x, y + lab + (hm - c.height) * z))
            x += max(c.width * z, 200) + pad
        y += hm * z + lab + pad
    p = f'scratch/shots/c2a-r3-riff-{TAG}-{mode}.png'
    im.save(p); print(p, im.size)
