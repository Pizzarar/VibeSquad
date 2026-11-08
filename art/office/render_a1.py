"""A1 Director gate shots for the hub backdrop (docs/PLAN_NEON_OFFICE.md "A1").
Per mode writes scratch/shots/review-gate/:
  a1-backdrop-{mode}.png      sheet: 2x2 wrap check at 2x (seams marked by ticks outside the image) + the 1080 mock
  a1-backdrop-{mode}-4k.png   3840x2160 mock = 3200x1800 CSS at DSF 1.2: tower (roof + floor plate with cast + front)
                              centred at 5 device px per native px, backdrop tiled on x behind it, tile centred on the
                              tower, bottom row aligned with the floor plate, flat `top` colour above the tile
  a1-backdrop-{mode}-1080.png 1920x1080 mock, same at 2 device px per native px
The mocks show the bottom of the scrolled Tower page (the tower is taller than the viewport at both sizes).
Usage: python -I art/office/render_a1.py   (repo root)"""
import json, os, subprocess, sys
from PIL import Image, ImageDraw

OUT = 'scratch/shots/review-gate'
os.makedirs(OUT, exist_ok=True)
os.makedirs('scratch/h1d', exist_ok=True)
subprocess.run([sys.executable, '-I', 'art/office/render_f4.py', 'scratch/h1d'], check=True, capture_output=True)
meta = json.load(open('public/office/hub-backdrop.json', encoding='utf8'))


def up(img, s):
    return img.resize((img.width * s, img.height * s), Image.NEAREST)


def hexrgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def mock(mode, vw, vh, s):
    bd = Image.open(f'public/office/hub-backdrop-{mode}.png').convert('RGB')
    f4 = Image.open(f'scratch/h1d/f4a-{mode}.png').convert('RGB')        # 1920x1080 = floor at 3x
    floor = f4.resize((640, 360), Image.NEAREST)
    roof = Image.open(f'public/office/roof-{mode}.png').convert('RGB')
    tower = Image.new('RGB', (640, 560)); tower.paste(roof, (0, 0)); tower.paste(floor, (0, 200))
    out = Image.new('RGB', (vw, vh), hexrgb(meta['top'][mode]))
    tw, th = 640 * s, 560 * s
    tx, ty = (vw - tw) // 2, vh - th                                      # page scrolled to the bottom
    bw, bh = meta['w'] * s, meta['h'] * s
    by = ty + th - bh                                                     # tile bottom = floor bottom
    tile = up(bd, s)
    x = tx - ((tx + bw - 1) // bw) * bw                                   # tile centred on the tower
    while x < vw:
        out.paste(tile, (x, by)); x += bw
    out.paste(up(tower, s), (tx, ty))
    return out


for mode in ('dark', 'light'):
    bd = Image.open(f'public/office/hub-backdrop-{mode}.png').convert('RGB')
    fg = (247, 240, 255) if mode == 'dark' else (43, 24, 64)
    bg = (20, 12, 38) if mode == 'dark' else (253, 244, 236)
    k4 = mock(mode, 3840, 2160, 5); k4.save(f'{OUT}/a1-backdrop-{mode}-4k.png')
    hd = mock(mode, 1920, 1080, 2); hd.save(f'{OUT}/a1-backdrop-{mode}-1080.png')
    wrap = Image.new('RGB', (1280, 720))
    for i in range(2):
        for j in range(2):
            wrap.paste(bd, (i * 640, j * 360))
    wrap = up(wrap, 2)
    pad = 40
    sheet = Image.new('RGB', (pad * 2 + wrap.width, pad * 3 + 30 + wrap.height + 30 + hd.height), bg)
    d = ImageDraw.Draw(sheet)
    d.text((pad, 12), f'A1 HUB BACKDROP ({mode}) 2x2 WRAP CHECK @2x (ticks = tile seams x=640 / y=360)', fill=fg)
    sheet.paste(wrap, (pad, pad))
    for sx in (pad + 1280,):
        d.rectangle((sx - 1, pad - 14, sx, pad - 4), fill=(255, 104, 168))
        d.rectangle((sx - 1, pad + wrap.height + 4, sx, pad + wrap.height + 14), fill=(255, 104, 168))
    d.rectangle((pad - 14, pad + 719, pad - 4, pad + 720), fill=(255, 104, 168))
    y = pad + wrap.height + pad
    d.text((pad, y), 'BESIDE THE TOWER @1920x1080 (2 device px / native px, bottom of the Tower page)', fill=fg)
    sheet.paste(hd, (pad, y + 30))
    sheet.save(f'{OUT}/a1-backdrop-{mode}.png')
    print('wrote', f'{OUT}/a1-backdrop-{mode}.png', sheet.size)
