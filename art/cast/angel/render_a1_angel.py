"""A1 Director gate sheet for the Perfection angel (docs/PLAN_PROJECT_CHIPS_WORKFLOWS.md A1).
Writes scratch/shots/a1-angel-{dark,light}.png per mode:
  4K@120% row : RiffBot | Overlord | angel idle | angel hover, each face at 7 device px per art px in the sky-CRT
                bezel (sky-crt.json 9-slice at 3 device px, = crispScale(3, 1.2)), then the Usage-panel top mock:
                side clouds (sky-clouds tile at the same 7x, bottom-aligned with the face, `top` colour above) | angel bezel | clouds
  1080 row    : the same at 5 device px per art px (same CSS box at DPR 1), bezel at 3 px
  frames      : all 6 angel cells at 4x with their faces.json keys + the cloud tile wrapped 3x at 4x
Usage: python -I art/cast/angel/render_a1_angel.py   (repo root)"""
import json, os
from PIL import Image, ImageDraw

OUT = 'scratch/shots'
os.makedirs(OUT, exist_ok=True)
faces = json.load(open('public/office/faces.json', encoding='utf8'))
crt = json.load(open('public/office/sky-crt.json', encoding='utf8'))
clouds = json.load(open('public/office/sky-clouds.json', encoding='utf8'))
CW, CH = faces['cell']['w'], faces['cell']['h']


def up(img, s):
    return img.resize((img.width * s, img.height * s), Image.NEAREST)


def hexrgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def cell(bot, mode, key, i=0):
    f = faces[bot][key][i]
    return Image.open(f'public/office/face-{bot}-{mode}.png').convert('RGBA').crop((f['x'], f['y'], f['x'] + CW, f['y'] + CH))


def bezel(face, k, b, mode):
    """face cell at k inside the 9-slice bezel at b device px per source px."""
    src = Image.open(f'public/office/sky-crt-{mode}.png').convert('RGBA')
    sl = crt['slice']
    t, r, bo, l = sl['top'] * b, sl['right'] * b, sl['bottom'] * b, sl['left'] * b
    iw, ih = CW * k, CH * k
    W, H = iw + l + r, ih + t + bo
    big = up(src, b)
    sw, sh = big.size
    out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    mw, mh = sw - l - r, sh - t - bo
    for y0, hh, sy in ((0, t, 0), (H - bo, bo, sh - bo)):           # top/bottom edges
        for x in range(l, W - r, mw):
            out.paste(big.crop((l, sy, l + min(mw, W - r - x), sy + hh)), (x, y0))
    for x0, ww, sx in ((0, l, 0), (W - r, r, sw - r)):              # left/right edges
        for y in range(t, H - bo, mh):
            out.paste(big.crop((sx, t, sx + ww, t + min(mh, H - bo - y))), (x0, y))
    for (x0, y0, sx, sy, ww, hh) in ((0, 0, 0, 0, l, t), (W - r, 0, sw - r, 0, r, t), (0, H - bo, 0, sh - bo, l, bo), (W - r, H - bo, sw - r, sh - bo, r, bo)):
        out.paste(big.crop((sx, sy, sx + ww, sy + hh)), (x0, y0))
    out.paste(up(face, k), (l, t))
    return out


def strip(mode, k, b, width):
    """Usage panel top: clouds | angel bezel | clouds; clouds bottom-aligned with the face bottom."""
    bz = bezel(cell('angel', mode, 'idle'), k, b, mode)
    H = bz.height
    out = Image.new('RGBA', (width, H), hexrgb(clouds['top'][mode]) + (255,))
    tile = up(Image.open(f'public/office/sky-clouds-{mode}.png').convert('RGBA'), k)
    face_bottom = H                                                     # bank meets the zone's bottom edge
    bx = (width - bz.width) // 2
    x = bx - ((bx + tile.width - 1) // tile.width) * tile.width        # tiles run outward from the bezel edge
    while x < width:
        out.paste(tile, (x, face_bottom - tile.height)); x += tile.width
    out.alpha_composite(bz, (bx, 0))
    return out


for mode in ('dark', 'light'):
    fg = (247, 240, 255) if mode == 'dark' else (43, 24, 64)
    bg = (20, 12, 38) if mode == 'dark' else (253, 244, 236)
    rows = []
    for title, k, b, sw in (('4K @120% - 7 device px per art px', 7, 3, 2400), ('1080 - 5 device px per art px', 5, 3, 1720)):
        boxes = [('RiffBot idle', bezel(cell('riffbot', mode, 'idle'), k, b, mode)),
                 ('Overlord idle', bezel(cell('overlord', mode, 'idle'), k, b, mode)),
                 ('Angel idle', bezel(cell('angel', mode, 'idle'), k, b, mode)),
                 ('Angel hover', bezel(cell('angel', mode, 'hover', 1), k, b, mode))]
        rows.append((title + ' : cast match', boxes))
        rows.append((title + ' : Usage panel top (clouds | angel | clouds)', [('', strip(mode, k, b, sw))]))
    names = [('idle', 0), ('idle', 1), ('idle', 2), ('blink', 0), ('hover', 0), ('hover', 1)]
    fr = [(f'{n}[{i}]', up(cell('angel', mode, n, i), 4)) for n, i in names]
    rows.append(('angel frames @4x (faces.json "angel")', fr))
    ct = Image.open(f'public/office/sky-clouds-{mode}.png').convert('RGBA')
    wrap = Image.new('RGBA', (ct.width * 3, ct.height)); [wrap.paste(ct, (i * ct.width, 0)) for i in range(3)]
    rows.append(('sky-clouds tile x3 @4x (seams at 1/3, 2/3)', [('', up(wrap, 4))]))
    pad, gap, lab = 40, 24, 34
    W = max(sum(im.width for _, im in r[1]) + gap * (len(r[1]) - 1) for r in rows) + pad * 2
    H = pad + sum(lab + max(im.height for _, im in r[1]) + lab + gap for r in rows)
    sheet = Image.new('RGBA', (W, H), bg + (255,))
    d = ImageDraw.Draw(sheet)
    y = pad
    for title, items in rows:
        d.text((pad, y), title, fill=fg, font_size=26)
        y += lab
        x = pad
        for name, im in items:
            sheet.alpha_composite(im, (x, y))
            if name:
                d.text((x, y + im.height + 4), name, fill=fg, font_size=22)
            x += im.width + gap
        y += max(im.height for _, im in items) + lab + gap
    sheet.convert('RGB').save(f'{OUT}/a1-angel-{mode}.png')
    print('wrote', f'{OUT}/a1-angel-{mode}.png', sheet.size)
