"""H1c-v4 Overlord review sheet: v3 (scratch/h1c-v4 backup of the shipped 8380fed strip) vs v4 (public/office),
every faces.json frame at 7x (4K@120% TV size) + a 3x (1080p) strip of both.
Writes scratch/shots/h1c-v4-overlord-{dark,light}.png. Usage (repo root): python -I scratch/h1c-v4/sheet.py"""
import json
from PIL import Image, ImageDraw, ImageFont

BG = {'dark': (20, 12, 38, 255), 'light': (245, 230, 239, 255)}
FG = {'dark': (247, 240, 255, 255), 'light': (43, 24, 64, 255)}
try:
    FONT = ImageFont.truetype('consola.ttf', 22)
except OSError:
    FONT = ImageFont.load_default()
fj = json.load(open('public/office/faces.json'))
CW, CH = fj['cell']['w'], fj['cell']['h']
NAMES = [(f'{m}[{i}]', f) for m, fr in fj['overlord'].items() if m != 'bg' for i, f in enumerate(fr)]
PAD, LAB, Z = 20, 30, 7


def big(im, z):
    return im.resize((im.width * z, im.height * z), Image.NEAREST)


for mode in ('dark', 'light'):
    src = {'v3': Image.open(f'scratch/h1c-v4/face-overlord-{mode}.png').convert('RGBA'),
           'v4': Image.open(f'public/office/face-overlord-{mode}.png').convert('RGBA')}
    cells = {k: [(n, s.crop((f['x'], f['y'], f['x'] + CW, f['y'] + CH))) for n, f in NAMES] for k, s in src.items()}
    W = PAD + 5 * (CW * Z + PAD)
    H = PAD + 2 * (LAB + 2 * (LAB + CH * Z + PAD)) + 2 * (LAB + CH * 3 + PAD) + PAD
    im = Image.new('RGBA', (W, H), BG[mode]); d = ImageDraw.Draw(im)
    y = PAD
    for k in ('v4', 'v3'):
        d.text((PAD, y), f'Overlord {k} {"(H1c-v4 giant brain B)" if k == "v4" else "(shipped 8380fed)"} - all frames 7x (4K@120%) - {mode}',
               font=FONT, fill=FG[mode]); y += LAB
        for r in range(2):
            for c, (n, cell) in enumerate(cells[k][r * 5:(r + 1) * 5]):
                x = PAD + c * (CW * Z + PAD)
                d.text((x, y), n, font=FONT, fill=FG[mode])
                im.alpha_composite(big(cell, Z), (x, y + LAB))
            y += LAB + CH * Z + PAD
    for k in ('v4', 'v3'):
        d.text((PAD, y), f'{k} 3x (1080p): ' + ' | '.join(n for n, _ in NAMES), font=FONT, fill=FG[mode]); y += LAB
        for c, (n, cell) in enumerate(cells[k]):
            im.alpha_composite(big(cell, 3), (PAD + c * (CW * 3 + 8), y))
        y += CH * 3 + PAD
    out = f'scratch/shots/h1c-v4-overlord-{mode}.png'
    im.save(out); print(out, im.size)
