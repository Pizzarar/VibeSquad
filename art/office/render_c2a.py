"""C2a face sheet: the H0 alien (bust 64 + floor 32, both frames) beside every 48px face frame,
at 4x and 8x (nearest), labelled. One PNG per mode.
Usage: python -I art/office/render_c2a.py   (repo root; needs scratch/c2a/alien-* from export_alien_ref.lua)"""
import json
from PIL import Image, ImageDraw, ImageFont
fj = json.load(open('public/office/faces.json'))
CW, CH = fj['cell']['w'], fj['cell']['h']
BG = {'dark': (20, 12, 38, 255), 'light': (245, 230, 239, 255)}
FG = {'dark': (247, 240, 255, 255), 'light': (43, 24, 64, 255)}
try:
    FONT = ImageFont.truetype('consola.ttf', 18)
except OSError:
    FONT = ImageFont.load_default()
for mode in ('dark', 'light'):
    alien = [('H0 alien bust 64', Image.open(f'scratch/c2a/alien-bust-{mode}.png').convert('RGBA')),
             ('H0 alien floor', Image.open(f'scratch/c2a/alien-floor1-{mode}.png').convert('RGBA')),
             ('H0 alien needs', Image.open(f'scratch/c2a/alien-floor2-{mode}.png').convert('RGBA'))]
    rows = []
    for bot in ('riffbot', 'overlord'):
        sheet = Image.open(f'public/office/face-{bot}-{mode}.png').convert('RGBA')
        cells = []
        for tag, frames in fj[bot].items():
            for i, f in enumerate(frames):
                cells.append((f'{bot} {tag}[{i}]', sheet.crop((f['x'], f['y'], f['x'] + CW, f['y'] + CH))))
        rows.append(cells)
    blocks = []
    for z in (4, 8):
        pad, lab = 6 * z, 30
        d0 = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
        colw = lambda n, c: max(c.width * z, int(d0.textlength(n, font=FONT)) + 8)
        W = max(sum(colw(n, c) + pad for n, c in alien + r) for r in rows) + pad
        H = sum(64 * z + lab + pad for _ in rows) + pad + 40
        im = Image.new('RGBA', (W, H), BG[mode]); d = ImageDraw.Draw(im)
        d.text((pad, 8), f'C2a faces vs H0 alien - {mode} - {z}x (cell {CW}x{CH})', font=FONT, fill=FG[mode])
        y = 40 + pad
        for r in rows:
            x = pad
            for name, cell in alien + r:
                d.text((x, y), name, font=FONT, fill=FG[mode])
                big = cell.resize((cell.width * z, cell.height * z), Image.NEAREST)
                im.alpha_composite(big, (x, y + lab + (64 - cell.height) * z))
                x += colw(name, cell) + pad
            y += 64 * z + lab + pad
        blocks.append(im)
    out = Image.new('RGBA', (max(b.width for b in blocks), sum(b.height for b in blocks)), BG[mode])
    yy = 0
    for b in blocks:
        out.paste(b, (0, yy)); yy += b.height
    p = f'scratch/shots/c2a-faces-vs-alien-{mode}.png'
    out.save(p); print(p, out.size)
    # small 4x preview of the faces only, for quick looks
    prev = blocks[0]; prev.save(f'scratch/c2a/preview-{mode}-4x.png')
