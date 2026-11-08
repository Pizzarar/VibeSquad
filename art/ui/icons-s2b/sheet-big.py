"""S2b-2 review-gate shots: scratch/shots/review-gate/icons-s2b-big-{4k120,1080}-{dark,light}.png
= in-place crops from shoot-big.js (Squads on the pin focus bar over Teams toggle, device px,
shown 1:1 and 2x nearest) + the bare public/ui icons at 8x on the P0 PANEL colour.
Run: python -I art/ui/icons-s2b/sheet-big.py <repo>"""
import sys
from PIL import Image, ImageDraw, ImageFont
root = sys.argv[1]
src = f"{root}/scratch/icons-s2b/inplace-big"
P = {"dark": {"bg": (20, 12, 38), "panel": (33, 22, 61), "text": (247, 240, 255)},
     "light": {"bg": (253, 244, 236), "panel": (245, 230, 239), "text": (43, 24, 64)}}
try:
    font = ImageFont.truetype("consola.ttf", 22); small = ImageFont.truetype("consola.ttf", 16)
except OSError:
    font = small = ImageFont.load_default()

def up(im, k):
    return im.resize((im.width * k, im.height * k), Image.NEAREST)

def bare(path, k, th):
    im = up(Image.open(path).convert("RGBA"), k)
    plate = Image.new("RGB", im.size, P[th]["panel"]); plate.paste(im, (0, 0), im)
    return plate

for tag, label in (("4k120", "3200x1800 @1.2 (4K@120%)"), ("1080", "1920x1080 @1")):
    for th in ("dark", "light"):
        cells = []
        for kind in ("squads", "teams"):
            im = Image.open(f"{src}/{kind}-{th}-{tag}.png").convert("RGB")
            cells.append((f"{kind.upper()} in place 1:1", im))
            cells.append((f"{kind.upper()} in place 2x nearest", up(im, 2)))
        icons = [(f"{n}{s} @8x", bare(f"{root}/public/ui/icon-{n}-{th}{s}.png", 8 if not s else 4, th))
                 for n in ("squads", "teams") for s in ("", "@2x")]
        pad, lab = 24, 26
        W = max(max(im.width for _, im in cells), sum(im.width + pad for _, im in icons)) + 2 * pad
        H = 64 + sum(im.height + lab + pad for _, im in cells) + icons[0][1].height + lab + pad
        sheet = Image.new("RGB", (W, H), P[th]["bg"]); d = ImageDraw.Draw(sheet)
        d.text((pad, 18), f"S2b-2 big icons ({th}, {label}) - display calc(var(--u3-px)*16) = 32 device px", fill=P[th]["text"], font=font)
        y = 64
        for name, im in cells:
            d.text((pad, y), name, fill=P[th]["text"], font=small); sheet.paste(im, (pad, y + lab - 4)); y += im.height + lab + pad
        x = pad
        for name, im in icons:
            d.text((x, y), name.replace("@2x @8x", "@2x @4x"), fill=P[th]["text"], font=small); sheet.paste(im, (x, y + lab - 4)); x += im.width + pad
        out = f"{root}/scratch/shots/review-gate/icons-s2b-big-{tag}-{th}.png"
        sheet.save(out); print(out, sheet.size)
