"""Takeover overlay preview: each frame composited over RiffBot's scared frame (on the faces.json
screen bg), plus the bare overlay, at 4x and 7x. Usage (repo root): python -I art/office/faces/takeover-preview.py
Writes scratch/shots/h1c-v3-takeover-{dark,light}.png"""
import json
from PIL import Image, ImageDraw, ImageFont
BG = {'dark': (20, 12, 38, 255), 'light': (245, 230, 239, 255)}
FG = {'dark': (247, 240, 255, 255), 'light': (43, 24, 64, 255)}
try:
    FONT = ImageFont.truetype('consola.ttf', 18)
except OSError:
    FONT = ImageFont.load_default()
faces = json.load(open('public/office/faces.json'))
tj = json.load(open('public/office/takeover.json'))
cw, ch = tj['cell']['w'], tj['cell']['h']
sx, sy = faces['riffbot']['scared'][0]['x'], faces['riffbot']['scared'][0]['y']
for mode in ('dark', 'light'):
    riff = Image.open(f'public/office/face-riffbot-{mode}.png').convert('RGBA').crop((sx, sy, sx + cw, sy + ch))
    base = Image.new('RGBA', (cw, ch), faces['riffbot']['bg'][mode]); base.alpha_composite(riff)
    sheet = Image.open(f'public/office/takeover-{mode}.png').convert('RGBA')
    frames = [sheet.crop((f['x'], f['y'], f['x'] + cw, f['y'] + ch)) for f in tj['frames']]
    comp = [base] + [Image.alpha_composite(base, f) for f in frames]
    pad, lab = 16, 28
    blocks = []
    for z, row in ((4, comp), (4, [base] + frames), (7, comp[1::2] + [comp[-1]])):
        w = len(row) * (cw * z + pad) + pad
        im = Image.new('RGBA', (w, ch * z + lab + pad), BG[mode]); d = ImageDraw.Draw(im)
        for i, c in enumerate(row):
            x = pad + i * (cw * z + pad)
            d.text((x, 4), f'{z}x', font=FONT, fill=FG[mode])
            im.alpha_composite(c.resize((cw * z, ch * z), Image.NEAREST), (x, lab))
        blocks.append(im)
    W = max(b.width for b in blocks)
    out = Image.new('RGBA', (W, 40 + sum(b.height for b in blocks)), BG[mode])
    ImageDraw.Draw(out).text((pad, 10), f'takeover glitch over Riff scared[0] - {mode} - {len(frames)} frames @ {tj["fps"]} fps (row1 comp 4x, row2 overlay 4x, row3 comp 7x f1/3/5/7/8)', font=FONT, fill=FG[mode])
    y = 40
    for b in blocks:
        out.paste(b, (0, y)); y += b.height
    p = f'scratch/shots/h1c-v3-takeover-{mode}.png'
    out.save(p); print(p, out.size)
