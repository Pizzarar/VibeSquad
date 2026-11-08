"""H1d Director gate sheet: canon on the left (H0 cast sheet + the H1a gallery floor crop), the H1d world art on
the right (floor plate with cast + front overlay at 3x via render_f4.py, roof band 3x, sky band 2x + sky-CRT 3x).
Writes scratch/shots/h1d-gate-{mode}-r<round>.png.
Usage: python -I art/office/render_h1d.py <round>   (repo root; runs render_f4.py into scratch/h1d first)"""
import subprocess, sys
from PIL import Image, ImageDraw

rnd = sys.argv[1] if len(sys.argv) > 1 else '1'
subprocess.run([sys.executable, '-I', 'art/office/render_f4.py', 'scratch/h1d'], check=True, capture_output=True)

def up(img, s):
    return img.resize((img.width * s, img.height * s), Image.NEAREST)

for mode in ('dark', 'light'):
    bg = (20, 12, 38) if mode == 'dark' else (253, 244, 236)
    fg = (247, 240, 255) if mode == 'dark' else (43, 24, 64)
    h0 = Image.open(f'scratch/shots/cast-h0-{mode}.png').convert('RGBA')
    gal = Image.open(f'scratch/shots/h1-gallery-{mode}-3x.png').convert('RGBA')
    crop = gal.crop((774, 1050, 1410, 1362))
    floor = Image.open(f'scratch/h1d/f4a-{mode}.png').convert('RGBA')
    roof = up(Image.open(f'public/office/roof-{mode}.png').convert('RGBA'), 3)
    sky = up(Image.open(f'public/office/sky-{mode}.png').convert('RGBA'), 2)
    crt = up(Image.open(f'public/office/sky-crt-{mode}.png').convert('RGBA'), 3)
    W = 40 + h0.width + 40 + floor.width + 40
    H = 60 + max(h0.height + 60 + crop.height, floor.height + 30 + roof.height + 30 + sky.height) + 40
    out = Image.new('RGBA', (W, H), bg)
    d = ImageDraw.Draw(out)
    x0, x1 = 40, 40 + h0.width + 40
    d.text((x0, 20), 'CANON: H0 CAST SHEET', fill=fg)
    out.paste(h0, (x0, 60), h0)
    d.text((x0, 60 + h0.height + 25), 'CANON: H1a FLOOR CROP (owner OK, 3x)', fill=fg)
    out.paste(crop, (x0, 60 + h0.height + 60), crop)
    d.text((x1, 20), f'H1d ROUND {rnd} ({mode}): FLOOR PLATE + CAST + FRONT 3x | ROOF 3x | SKY 2x + SKY-CRT 3x', fill=fg)
    y = 60
    out.paste(floor, (x1, y), floor); y += floor.height + 30
    out.paste(roof, (x1, y), roof); y += roof.height + 30
    out.paste(sky, (x1, y), sky)
    out.paste(crt, (x1 + sky.width + 40, y), crt)
    p = f'scratch/shots/h1d-gate-{mode}-r{rnd}.png'
    out.convert('RGB').save(p)
    print('wrote', p, out.size)
