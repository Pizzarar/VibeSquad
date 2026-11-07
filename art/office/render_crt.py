"""C1 CRT shots, drawn the way the UI will: roof plate -> faces in screens.* -> roof front overlay.
Writes <p>-top-{mode}-3x.png (roof with idle/talk faces), <p>-faces-{mode}-4x.png (every frame, labelled),
<p>-stack-dark-3x.png (roof over the floor plate + front overlays, no cast).
Usage: python -I art/office/render_crt.py <outprefix> [riffPose] [lordPose]   (run from the repo root)"""
import json, sys
from PIL import Image, ImageDraw

fl = json.load(open('public/office/floor.json'))
fj = json.load(open('public/office/faces.json'))
SC = fl['screens']
CW, CHH = fj['cell']['w'], fj['cell']['h']
out = sys.argv[1]
pose = {'riffbot': sys.argv[2] if len(sys.argv) > 2 else 'talk', 'overlord': sys.argv[3] if len(sys.argv) > 3 else 'talk'}

def face(bot, mode, tag, i):
    sheet = Image.open(f'public/office/face-{bot}-{mode}.png').convert('RGBA')
    f = fj[bot][tag][i % len(fj[bot][tag])]
    return sheet.crop((f['x'], f['y'], f['x'] + CW, f['y'] + CHH))

def roof(mode, poses, idx=1):
    im = Image.open(f'public/office/roof-{mode}.png').convert('RGBA')
    for bot in ('riffbot', 'overlord'):
        s = SC[bot]
        im.alpha_composite(face(bot, mode, poses[bot], idx), (s['x'], s['y']))
    if SC.get('front'):
        im.alpha_composite(Image.open(f'public/office/roof-front-{mode}.png').convert('RGBA'))
    return im

for mode in ('dark', 'light'):
    roof(mode, pose).resize((640 * 3, SC['h'] * 3), Image.NEAREST).save(f'{out}-top-{mode}-3x.png')
    # every frame of both faces, 4x, labelled
    Z, G, LB = 4, 12, 40
    rows = [(b, t, i) for b in ('riffbot', 'overlord') for t in ('idle', 'blink', 'talk', 'needs') for i in range(len(fj[b][t]))]
    per = {b: [(t, i) for bb, t, i in rows if bb == b] for b in ('riffbot', 'overlord')}
    ncol = max(len(v) for v in per.values())
    W = ncol * (CW * Z + G) + G
    H = 2 * (CHH * Z + LB + G) + G
    bg = (20, 12, 38, 255) if mode == 'dark' else (253, 244, 236, 255)
    ink = (247, 240, 255, 255) if mode == 'dark' else (43, 24, 64, 255)
    sheet = Image.new('RGBA', (W, H), bg)
    d = ImageDraw.Draw(sheet)
    for r, b in enumerate(('riffbot', 'overlord')):
        y = G + r * (CHH * Z + LB + G)
        for c, (t, i) in enumerate(per[b]):
            x = G + c * (CW * Z + G)
            d.text((x, y + 4), f'{b} {t}[{i}]', fill=ink, font_size=26)
            sheet.alpha_composite(face(b, mode, t, i).resize((CW * Z, CHH * Z), Image.NEAREST), (x, y + LB))
    sheet.save(f'{out}-faces-{mode}-4x.png')
    print(f'{out}-{{top,faces}}-{mode}', sheet.size)

st = Image.new('RGBA', (640, SC['h'] + 360))
st.paste(roof('dark', {'riffbot': 'idle', 'overlord': 'needs'}, 0), (0, 0))
fp = Image.open('public/office/floor-dark.png').convert('RGBA')
if fl.get('front'):
    fp.alpha_composite(Image.open('public/office/floor-front-dark.png').convert('RGBA'))
st.paste(fp, (0, SC['h']))
st.resize((640 * 3, st.height * 3), Image.NEAREST).save(f'{out}-stack-dark-3x.png')
print(f'{out}-stack-dark-3x.png')
