"""T1a review sheets: the sticker at native 4x (dark/light, on a checker) plus device-px crops of the real label chip
(off = plain RiffBot chip, on = sticker laid over it with the takeover-label.json rule), at 1080 (dpr 1) and 4K@120% (dpr 1.2).
Inputs: <rawdir>/raw-{1080,4k120}-{dark,light}-{off,on}.png (element shots of the chip in its TV, scale=device).
Writes <outprefix>-gallery.png (everything) and <outprefix>-{1080,4k120}-{dark,light}.png (1:1 device-px crops).
Usage: python -I art/office/takeover-label-review.py <rawdir> <outprefix>   (run from the repo root)"""
import sys
from PIL import Image, ImageDraw

raw, out = sys.argv[1], sys.argv[2]
BG = (32, 24, 48)

def checker(w, h, s=4):
    im = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(im)
    for y in range(0, h, s):
        for x in range(0, w, s):
            d.rectangle((x, y, x + s - 1, y + s - 1), fill=(150, 150, 150) if (x // s + y // s) % 2 else (110, 110, 110))
    return im

rows = []
# native 4x
for mode in ('dark', 'light'):
    st = Image.open(f'public/office/takeover-label-{mode}.png').convert('RGBA')
    big = st.resize((st.width * 4, st.height * 4), Image.NEAREST)
    c = checker(big.width, big.height, 8).convert('RGBA')
    c.alpha_composite(big)
    rows.append(c)
# real chip crops: 1:1 save, x3 in the gallery
for tag, crop in (('1080', (0, 0, 250, 48)), ('4k120', (0, 0, 300, 58))):
    for mode in ('dark', 'light'):
        pair = [Image.open(f'{raw}/raw-{tag}-{mode}-{s}.png').convert('RGBA').crop(crop) for s in ('off', 'on')]
        one = Image.new('RGBA', (crop[2], crop[3] * 2 + 4), BG)
        one.paste(pair[0], (0, 0)); one.paste(pair[1], (0, crop[3] + 4))
        one.save(f'{out}-{tag}-{mode}.png')
        rows.append(one.resize((one.width * 3, one.height * 3), Image.NEAREST))
        full = Image.open(f'{raw}/raw-{tag}-{mode}-on.png').convert('RGBA')
        rows.append(full)

W = max(r.width for r in rows) + 16
H = sum(r.height + 8 for r in rows) + 8
sheet = Image.new('RGBA', (W, H), BG)
y = 8
for r in rows:
    sheet.paste(r, (8, y), r); y += r.height + 8
sheet.save(f'{out}-gallery.png')
print('wrote', f'{out}-gallery.png', sheet.size)
