"""H1c-v4 mock sheet: v3 idle[0] (shipped) | A | B | B-pulse at 7x (4K@120% TV size) + a 1080p 3x row.
Writes scratch/shots/overlord-v4-AB-{dark,light}.png. Usage (repo root): python -I scratch/overlord-v4/sheet.py"""
from PIL import Image, ImageDraw, ImageFont

BG = {'dark': (20, 12, 38, 255), 'light': (245, 230, 239, 255)}
FG = {'dark': (247, 240, 255, 255), 'light': (43, 24, 64, 255)}
try:
    FONT = ImageFont.truetype('consola.ttf', 22)
except OSError:
    FONT = ImageFont.load_default()
CW, CH, PAD, LAB = 80, 48, 24, 32
NAMES = ['v3 shipped idle[0]', 'A wallpaper', 'B giant brain', 'B-pulse talk']


def big(im, z):
    return im.resize((im.width * z, im.height * z), Image.NEAREST)


for mode in ('dark', 'light'):
    v3 = Image.open(f'public/office/face-overlord-{mode}.png').convert('RGBA').crop((160, 0, 240, 48))
    mock = Image.open(f'scratch/overlord-v4/overlord-v4-{mode}.png').convert('RGBA')
    cells = [v3] + [mock.crop((i * CW, 0, (i + 1) * CW, CH)) for i in range(3)]
    W = PAD + 4 * (CW * 7 + PAD)
    H = PAD + LAB + CH * 7 + PAD + LAB + CH * 3 + PAD
    im = Image.new('RGBA', (W, H), BG[mode]); d = ImageDraw.Draw(im)
    for i, (c, n) in enumerate(zip(cells, NAMES)):
        x = PAD + i * (CW * 7 + PAD)
        d.text((x, PAD), f'{n}  7x (4K@120%)  {mode}', font=FONT, fill=FG[mode])
        im.alpha_composite(big(c, 7), (x, PAD + LAB))
    y = PAD + LAB + CH * 7 + PAD
    d.text((PAD, y), '1080p crop row 3x: v3 | A | B | B-pulse', font=FONT, fill=FG[mode])
    for i, c in enumerate(cells):
        im.alpha_composite(big(c, 3), (PAD + i * (CW * 3 + PAD), y + LAB))
    out = f'scratch/shots/overlord-v4-AB-{mode}.png'
    im.save(out); print(out, im.size)
