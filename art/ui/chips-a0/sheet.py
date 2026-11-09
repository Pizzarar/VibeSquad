"""A0 review-gate sheets: scratch/shots/a0-chips-{dark,light}.png = in-place crops (Squad header
row with Bugs+dot / Workflows chips, S2b squads/teams below, device px, 1:1 and 2x nearest) at
4K@120% and 1080, + bare chips next to the S2b icons at 8x (16 native) / 4x (@2x).
In-place crops come from a Playwright DOM-injection mock on ?demo (no src edit) into
scratch/chips-a0/inplace/row-<theme>-<4k120|1080>.png.
Run: python -I art/ui/chips-a0/sheet.py <repo>"""
import sys
from PIL import Image, ImageDraw, ImageFont
root = sys.argv[1]
src = f"{root}/scratch/chips-a0/inplace"
P = {"dark": {"bg": (20, 12, 38), "panel": (33, 22, 61), "text": (247, 240, 255)},
     "light": {"bg": (253, 244, 236), "panel": (245, 230, 239), "text": (43, 24, 64)}}
try:
    font = ImageFont.truetype("consola.ttf", 22); small = ImageFont.truetype("consola.ttf", 16)
except OSError:
    font = small = ImageFont.load_default()

def up(im, k):
    return im.resize((im.width * k, im.height * k), Image.NEAREST)

def bare(name, th, s, k):
    im = up(Image.open(f"{root}/public/ui/{name}-{th}{s}.png").convert("RGBA"), k)
    plate = Image.new("RGB", im.size, P[th]["panel"]); plate.paste(im, (0, 0), im)
    return plate

for th in ("dark", "light"):
    cells = []
    for tag, label in (("4k120", "4K@120% (3200x1800 @1.2)"), ("1080", "1080 (1920x1080 @1)")):
        im = Image.open(f"{src}/row-{th}-{tag}.png").convert("RGB")
        cells.append((f"{label} in place 1:1 device px", im))
        cells.append((f"{label} in place 2x nearest", up(im, 2)))
    names = ("icon-squads", "icon-teams", "chip-bugs", "chip-workflows", "chip-dot")
    icons = [(f"{n.split('-', 1)[1]}{' @2x @4x' if s else ' @8x'}", bare(n, th, s, 4 if s else 8))
             for s in ("", "@2x") for n in names]
    pad, lab = 24, 26
    rowW = lambda r: sum(im.width + pad for _, im in r)
    W = max(max(im.width for _, im in cells), rowW(icons[:5]), rowW(icons[5:])) + 2 * pad
    H = 64 + sum(im.height + lab + pad for _, im in cells) + 2 * (icons[0][1].height + lab + pad)
    sheet = Image.new("RGB", (W, H), P[th]["bg"]); d = ImageDraw.Draw(sheet)
    d.text((pad, 18), f"A0 Squad-header chips ({th}) - 16 native / @2x, shown calc(var(--u3-px)*16) = 32 device px", fill=P[th]["text"], font=font)
    y = 64
    for name, im in cells:
        d.text((pad, y), name, fill=P[th]["text"], font=small); sheet.paste(im, (pad, y + lab - 4)); y += im.height + lab + pad
    for r in (icons[:5], icons[5:]):
        x = pad
        for name, im in r:
            d.text((x, y), name, fill=P[th]["text"], font=small); sheet.paste(im, (x, y + lab - 4)); x += im.width + pad
        y += r[0][1].height + lab + pad
    out = f"{root}/scratch/shots/a0-chips-{th}.png"
    sheet.save(out); print(out, sheet.size)
