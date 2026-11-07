"""C2a-R2 combined sheet, one PNG per mode: rows H0 alien | RiffBot R2 | Overlord O-A | Overlord O-B,
every frame labelled, at 4x then 8x (nearest).
Usage (repo root): python -I art/office/faces/render_r2.py [<O-B worktree root>]
Needs scratch/c2a/alien-* (art/office/export_alien_ref.lua). O-B strips are read from
<O-B root>/scratch/office/overlord-b-{mode}.png + overlord-b.json (default: sibling art-sky-gods-ob)."""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont
OB = sys.argv[1] if len(sys.argv) > 1 else os.path.join('..', 'art-sky-gods-ob')
BG = {'dark': (20, 12, 38, 255), 'light': (245, 230, 239, 255)}
FG = {'dark': (247, 240, 255, 255), 'light': (43, 24, 64, 255)}
try:
    FONT = ImageFont.truetype('consola.ttf', 18)
except OSError:
    FONT = ImageFont.load_default()


def strip(png, js, bot, label):
    fj = json.load(open(js))
    cw, ch = fj['cell']['w'], fj['cell']['h']
    sheet = Image.open(png).convert('RGBA')
    out = []
    for tag, frames in fj[bot].items():
        for i, f in enumerate(frames):
            out.append((f'{label} {tag}[{i}]', sheet.crop((f['x'], f['y'], f['x'] + cw, f['y'] + ch))))
    return out


for mode in ('dark', 'light'):
    rows = [
        [('H0 alien bust 64', Image.open(f'scratch/c2a/alien-bust-{mode}.png').convert('RGBA')),
         ('H0 alien floor', Image.open(f'scratch/c2a/alien-floor1-{mode}.png').convert('RGBA')),
         ('H0 alien needs', Image.open(f'scratch/c2a/alien-floor2-{mode}.png').convert('RGBA'))],
        strip(f'public/office/face-riffbot-{mode}.png', 'public/office/faces.json', 'riffbot', 'riffbot R2'),
        strip(f'art/office/faces/overlord-a-{mode}.png', 'art/office/faces/overlord-a.json', 'overlord', 'O-A house'),
        strip(os.path.join(OB, f'scratch/office/overlord-b-{mode}.png'), os.path.join(OB, 'scratch/office/overlord-b.json'),
              'overlord', 'O-B blues'),
    ]
    blocks = []
    d0 = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
    for z in (4, 8):
        pad, lab = 6 * z, 30
        colw = lambda n, c: max(c.width * z, int(d0.textlength(n, font=FONT)) + 8)
        rowh = lambda r: max(c.height for _, c in r) * z + lab + pad
        W = max(sum(colw(n, c) + pad for n, c in r) for r in rows) + pad
        H = sum(rowh(r) for r in rows) + pad + 40
        im = Image.new('RGBA', (W, H), BG[mode]); d = ImageDraw.Draw(im)
        d.text((pad, 8), f'C2a-R2 faces: H0 alien | RiffBot R2 | O-A | O-B - {mode} - {z}x (cell 48x48)', font=FONT, fill=FG[mode])
        y = 40 + pad
        for r in rows:
            x, hmax = pad, max(c.height for _, c in r)
            for name, cell in r:
                d.text((x, y), name, font=FONT, fill=FG[mode])
                big = cell.resize((cell.width * z, cell.height * z), Image.NEAREST)
                im.alpha_composite(big, (x, y + lab + (hmax - cell.height) * z))
                x += colw(name, cell) + pad
            y += rowh(r)
        blocks.append(im)
    out = Image.new('RGBA', (max(b.width for b in blocks), sum(b.height for b in blocks)), BG[mode])
    yy = 0
    for b in blocks:
        out.paste(b, (0, yy)); yy += b.height
    p = f'scratch/shots/c2a-r2-{mode}.png'
    out.save(p); print(p, out.size)
    blocks[0].save(f'scratch/c2a/r2-preview-{mode}-4x.png')
