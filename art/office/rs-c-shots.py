"""RS-c review shots (docs/PLAN_RIFF_SWING.md): the new frames (smear, SMACK x2, RiffBot shove beside needs) and a
6-frame mock strip (window open -> smear -> hit + star -> smacked -> dizzy) built from the shipped sheets, at 7x
(4K@120% TV size) and 3x (1080), dark + light. The swing is mocked flat (width steps); UI9 does the real rotateY.
Writes scratch/shots/rs-c-{frames,strip}-{dark,light}-{7x,3x}.png.
Usage: python -I art/office/rs-c-shots.py   (repo root = $RS_ROOT, default: the current directory)"""
import json
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.environ.get('RS_ROOT', '.')
P = lambda *a: os.path.join(ROOT, *a)
SKY = {'dark': (42, 27, 107, 255), 'light': (149, 211, 242, 255)}
BG = {'dark': (20, 12, 38, 255), 'light': (245, 230, 239, 255)}
BODY = {'dark': (20, 12, 38, 255), 'light': (253, 244, 236, 255)}
FG = {'dark': (247, 240, 255, 255), 'light': (43, 24, 64, 255)}
LINE = {'dark': (84, 66, 138, 255), 'light': (187, 163, 207, 255)}
try:
    FONT = ImageFont.truetype('consola.ttf', 22)
except OSError:
    FONT = ImageFont.load_default()

faces = json.load(open(P('public', 'office', 'faces.json')))
puffj = json.load(open(P('public', 'office', 'slam-puff.json')))
CW, CH = faces['cell']['w'], faces['cell']['h']


def cell(sheet, f, w, h):
    return sheet.crop((f['x'], f['y'], f['x'] + w, f['y'] + h))


def nine(src, sl, w, h):
    """Integer 9-slice at 1x: corners kept, edges/middle tiled (as border-image round at 1x)."""
    t, r, b, l = sl
    out = Image.new('RGBA', (w, h))
    sw, sh = src.size
    for (sx0, sx1, dx0, dx1) in ((0, l, 0, l), (l, sw - r, l, w - r), (sw - r, sw, w - r, w)):
        for (sy0, sy1, dy0, dy1) in ((0, t, 0, t), (t, sh - b, t, h - b), (sh - b, sh, h - b, h)):
            tile = src.crop((sx0, sy0, sx1, sy1))
            if tile.width == 0 or tile.height == 0:
                continue
            for y in range(dy0, dy1, tile.height):
                for x in range(dx0, dx1, tile.width):
                    out.alpha_composite(tile.crop((0, 0, min(tile.width, dx1 - x), min(tile.height, dy1 - y))), (x, y))
    return out


def window(mode, w, h, crt):
    """Riff's chat window: the sky-CRT bevel (sky-crt.json slice) round a body with a few chat line stubs."""
    body = Image.new('RGBA', (w, h), BODY[mode])
    d = ImageDraw.Draw(body)
    d.line([(3, 6), (w - 4, 6)], fill=LINE[mode])
    for i, y in enumerate(range(10, h - 8, 5)):
        d.line([(5, y), (5 + max(2, (w - 14) * (3 + i % 3) // 5), y)], fill=LINE[mode])
    sl = json.load(open(P('public', 'office', 'sky-crt.json')))['slice']
    frame = nine(crt, (sl['top'], sl['right'], sl['bottom'], sl['left']), w, h)
    out = body.copy()
    out.alpha_composite(frame)
    return out


def smear_to(mode, sheet, h):
    s = puffj['smear']
    f = cell(sheet, s['frameList'][0], s['frameW'], s['frameH'])
    sl = s['slice']
    return nine(f, (sl['top'], sl['right'], sl['bottom'], sl['left']), f.width, h)


def big(im, z):
    return im.resize((im.width * z, im.height * z), Image.NEAREST)


def label(img, z, mode, text):
    pad = 40
    w = max(img.width, int(ImageDraw.Draw(img).textlength(text, font=FONT)) + 16)   # never clip the label
    out = Image.new('RGBA', (w, img.height + pad), BG[mode])
    out.alpha_composite(img, (0, pad))
    ImageDraw.Draw(out).text((8, 8), text, font=FONT, fill=FG[mode])
    return out


def grid(items, cols, mode, gap=24):
    rows = [items[i:i + cols] for i in range(0, len(items), cols)]
    W = max(sum(i.width for i in r) + gap * (len(r) + 1) for r in rows)
    H = sum(max(i.height for i in r) for r in rows) + gap * (len(rows) + 1)
    out = Image.new('RGBA', (W, H), BG[mode])
    y = gap
    for r in rows:
        x = gap
        for i in r:
            out.alpha_composite(i, (x, y))
            x += i.width + gap
        y += max(i.height for i in r) + gap
    return out


os.makedirs(P('scratch', 'shots'), exist_ok=True)
for mode in ('dark', 'light'):
    riff = Image.open(P('public', 'office', f'face-riffbot-{mode}.png')).convert('RGBA')
    over = Image.open(P('public', 'office', f'face-overlord-{mode}.png')).convert('RGBA')
    puff = Image.open(P('public', 'office', f'slam-puff-{mode}.png')).convert('RGBA')
    crt = Image.open(P('public', 'office', f'sky-crt-{mode}.png')).convert('RGBA')
    R = {k: [cell(riff, f, CW, CH) for f in v] for k, v in faces['riffbot'].items() if k != 'bg'}
    O = {k: [cell(over, f, CW, CH) for f in v] for k, v in faces['overlord'].items() if k != 'bg'}
    PF = [cell(puff, f, puffj['frameW'], puffj['frameH']) for f in puffj['frameList']]
    SK = [cell(puff, f, puffj['smack']['frameW'], puffj['smack']['frameH']) for f in puffj['smack']['frameList']]

    def on_sky(im):
        o = Image.new('RGBA', im.size, SKY[mode]); o.alpha_composite(im); return o

    # ---- the new frames ----
    sm = smear_to(mode, puff, 56)
    for z in (7, 3):
        items = [label(big(on_sky(R['needs'][0]), z), z, mode, 'riffbot needs[0] (wave, old)'),
                 label(big(on_sky(R['shove'][0]), z), z, mode, 'riffbot shove[0] NEW'),
                 label(big(on_sky(SK[0]), z), z, mode, 'smack[0] NEW'),
                 label(big(on_sky(SK[1]), z), z, mode, 'smack[1] NEW'),
                 label(big(on_sky(cell(puff, puffj['smear']['frameList'][0], 40, 96)), z), z, mode, 'smear[0] NEW 40x96'),
                 label(big(on_sky(sm), z), z, mode, 'smear sliced to 56')]
        grid(items, 4 if z == 3 else 3, mode).save(P('scratch', 'shots', f'rs-c-frames-{mode}-{z}x.png'))

    # ---- 6-frame mock strip: RiffBot TV | hinge at x84 | Overlord TV at x136 ----
    PW, PH, HX, OX, WY, WH = 216, 64, 84, 136, 4, 56

    def panel(rf, of, ww, smear=False, puffs=(), star=None):
        im = Image.new('RGBA', (PW, PH), SKY[mode])
        im.alpha_composite(rf, (0, PH - CH))
        im.alpha_composite(of, (OX, PH - CH))
        if ww:
            im.alpha_composite(window(mode, ww, WH, crt), (HX, WY))
            if smear:
                s = smear_to(mode, puff, WH)
                im.alpha_composite(s, (HX + ww - 1 - puffj['smear']['edgeX'], WY))
        ex = HX + ww
        for p in puffs:
            for (px, py) in ((ex, WY + 14), (ex, WY + WH - 14)):
                im.alpha_composite(p, (px - 16, py - 16))
        if star is not None:
            im.alpha_composite(star, (ex + 8 - 32, 30 - 24))
        return im

    frames = [
        ('1 open: shove, window swings', panel(R['shove'][0], O['idle'][0], 12)),
        ('2 smear mid-swing', panel(R['shove'][0], O['idle'][0], 46, smear=True)),
        ('3 hit + SMACK[0] + puff[0]', panel(R['idle'][0], O['smacked'][0], 72, puffs=[PF[0]], star=SK[0])),
        ('4 smacked[1] + SMACK[1] + puff[1]', panel(R['idle'][0], O['smacked'][1], 66, puffs=[PF[1]], star=SK[1])),
        ('5 dizzy[0], bounce-back settle', panel(R['idle'][0], O['dizzy'][0], 62, puffs=[PF[2]])),
        ('6 dizzy[1], chat settled', panel(R['idle'][0], O['dizzy'][1], 64, puffs=[PF[3]])),
    ]
    for z in (7, 3):
        items = [label(big(f, z), z, mode, t) for t, f in frames]
        grid(items, 2 if z == 7 else 3, mode).save(P('scratch', 'shots', f'rs-c-strip-{mode}-{z}x.png'))
    print('wrote rs-c shots', mode)
