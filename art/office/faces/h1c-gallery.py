"""H1c review gallery, one PNG per mode: canon (H0 sheet + H1a approved faces) beside every new
RiffBot/Overlord frame. Writes scratch/shots/h1c-gallery-{mode}.png (labels, 4x frames),
scratch/shots/h1c-native-{mode}.png (1x strips) and scratch/shots/h1c-10x-{mode}.png (key frames 10x).
Usage (repo root): python -I art/office/faces/h1c-gallery.py"""
import json
from PIL import Image, ImageDraw, ImageFont

BG = {'dark': (20, 12, 38, 255), 'light': (245, 230, 239, 255)}
FG = {'dark': (247, 240, 255, 255), 'light': (43, 24, 64, 255)}
try:
    FONT = ImageFont.truetype('consola.ttf', 20)
except OSError:
    FONT = ImageFont.load_default()
fj = json.load(open('public/office/faces.json'))
cw, ch = fj['cell']['w'], fj['cell']['h']
Z, PAD, LAB = 4, 24, 28


def big(im, z):
    return im.resize((im.width * z, im.height * z), Image.NEAREST)


for mode in ('dark', 'light'):
    cells = {}
    for bot in ('riffbot', 'overlord'):
        sheet = Image.open(f'public/office/face-{bot}-{mode}.png').convert('RGBA')
        cells[bot] = [(f'{m}[{i}]', sheet.crop((f['x'], f['y'], f['x'] + cw, f['y'] + ch)), sheet)
                      for m, fr in fj[bot].items() if m not in ('bg',) for i, f in enumerate(fr)]
    h0 = Image.open(f'scratch/shots/cast-h0-{mode}.png').convert('RGBA')
    h1a = Image.open(f'scratch/shots/h1-gallery-{mode}.png').convert('RGBA').crop((248, 276, 480, 332))
    cellW = cw * Z + PAD
    right = 5 * cellW + PAD
    W = PAD + h0.width + PAD * 2 + right
    H = max(h0.height + 60, 60 + h1a.height * 3 + LAB + 4 * (ch * Z + LAB + PAD) + 120)
    im = Image.new('RGBA', (W, H), BG[mode]); d = ImageDraw.Draw(im)
    d.text((PAD, 14), f'CANON: H0 cast sheet (1x) - {mode}', font=FONT, fill=FG[mode])
    im.alpha_composite(h0, (PAD, 50))
    x0 = PAD + h0.width + PAD * 2
    d.line([(x0 - PAD, 0), (x0 - PAD, H)], fill=FG[mode], width=2)
    d.text((x0, 14), 'CANON: H1a approved faces (3x)  riff rest/yo | overlord rest/yo', font=FONT, fill=FG[mode])
    im.alpha_composite(big(h1a, 3), (x0, 50))
    y = 50 + h1a.height * 3 + PAD
    for bot in ('riffbot', 'overlord'):
        d.text((x0, y), f'H1c {bot.upper()} - every faces.json frame, 4x', font=FONT, fill=FG[mode])
        y += LAB + 6
        for r in range(2):
            x = x0
            for n, c, _ in cells[bot][r * 5:(r + 1) * 5]:
                d.text((x, y), n, font=FONT, fill=FG[mode])
                im.alpha_composite(big(c, Z), (x, y + LAB))
                x += cellW
            y += LAB + ch * Z + PAD
    im.save(f'scratch/shots/h1c-gallery-{mode}.png'); print(f'scratch/shots/h1c-gallery-{mode}.png', im.size)

    # native 1x strips beside the H1a canon crop
    n = Image.new('RGBA', (cw * 10 + 16, ch * 3 + 32), BG[mode])
    n.alpha_composite(h1a, (8, 8))
    n.alpha_composite(cells['riffbot'][0][2], (8, 8 + ch + 8))
    n.alpha_composite(cells['overlord'][0][2], (8, 8 + 2 * (ch + 8)))
    n.save(f'scratch/shots/h1c-native-{mode}.png')

    # 10x key frames (zone size on a 4K screen): riff idle/needs/scared, overlord idle/needs[0]/needs[1]
    pick = [('riffbot', 'idle[0]'), ('riffbot', 'needs[1]'), ('riffbot', 'scared[0]'),
            ('overlord', 'idle[0]'), ('overlord', 'needs[0]'), ('overlord', 'talk[1]')]
    t = Image.new('RGBA', (3 * 480 + 4 * PAD, 2 * 480 + 3 * PAD + 2 * LAB), BG[mode]); dt = ImageDraw.Draw(t)
    for i, (bot, name) in enumerate(pick):
        c = next(c for nm, c, _ in cells[bot] if nm == name)
        x, yy = PAD + (i % 3) * (480 + PAD), PAD + (i // 3) * (480 + PAD + LAB)
        dt.text((x, yy), f'{bot} {name} 10x', font=FONT, fill=FG[mode])
        t.alpha_composite(big(c, 10), (x, yy + LAB))
    t.save(f'scratch/shots/h1c-10x-{mode}.png')
