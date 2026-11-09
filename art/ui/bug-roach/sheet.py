"""BC-art review-gate sheets: scratch/shots/bc-roach-{dark,light}.png = in-place crops (project row
with the roach .bug-btn idle at full row height, row below: twitch1/twitch2 clones, A0 bugs chip +
badge dot, S2b squads/teams) at 4K@120% and 1080, 1:1 device px and 2x nearest, + the bare frames
(idle, twitch1, twitch2), the chip + dot and the S2b icons at 8x (16 native) / 4x (@2x).
In-place crops come from art/ui/bug-roach/shoot.js into scratch/bc-roach/inplace/row-<theme>-<tag>.png.
Run: python -I art/ui/bug-roach/sheet.py <repo>"""
import sys
from PIL import Image, ImageDraw, ImageFont
root = sys.argv[1]
src = f"{root}/scratch/bc-roach/inplace"
P = {"dark": {"bg": (20, 12, 38), "panel": (33, 22, 61), "text": (247, 240, 255)},
     "light": {"bg": (253, 244, 236), "panel": (245, 230, 239), "text": (43, 24, 64)}}
try:
    font = ImageFont.truetype("consola.ttf", 22); small = ImageFont.truetype("consola.ttf", 16)
except OSError:
    font = small = ImageFont.load_default()

def up(im, k):
    return im.resize((im.width * k, im.height * k), Image.NEAREST)

def on_panel(im, th):
    plate = Image.new("RGB", im.size, P[th]["panel"]); plate.paste(im, (0, 0), im); return plate

def png(name, th, s):
    return Image.open(f"{root}/public/ui/{name}-{th}{s}.png").convert("RGBA")

for th in ("dark", "light"):
    cells = []
    for tag, label in (("4k120", "4K@120% (3200x1800 @1.2)"), ("1080", "1080 (1920x1080 @1)")):
        im = Image.open(f"{src}/row-{th}-{tag}.png").convert("RGB")
        cells.append((f"{label} in place 1:1 device px", im))
        cells.append((f"{label} in place 2x nearest", up(im, 2)))
    rows = []
    for s, k in (("", 8), ("@2x", 4)):
        n = 16 if not s else 32
        strip = png("bug-roach", th, s)
        r = [(f"{f}{' @2x' if s else ''}", on_panel(up(strip.crop((i * n, 0, i * n + n, n)), k), th))
             for i, f in enumerate(("idle", "twitch1", "twitch2"))]
        chip = png("chip-bugs", th, s); chip.alpha_composite(png("chip-dot", th, s))
        r.append(("chip+dot", on_panel(up(chip, k), th)))
        r += [(nm.split("-", 1)[1], on_panel(up(png(nm, th, s), k), th)) for nm in ("icon-squads", "icon-teams")]
        rows.append(r)
    pad, lab = 24, 26
    rowW = lambda r: sum(im.width + pad for _, im in r)
    W = max(max(im.width for _, im in cells), *(rowW(r) for r in rows)) + 2 * pad
    H = 64 + sum(im.height + lab + pad for _, im in cells) + sum(r[0][1].height + lab + pad for r in rows)
    sheet = Image.new("RGB", (W, H), P[th]["bg"]); d = ImageDraw.Draw(sheet)
    d.text((pad, 18), f"BC-art Hypnospace roach ({th}) - 16 native / @2x, .bug-btn full row height, shown calc(var(--u3-px)*16) = 32 device px", fill=P[th]["text"], font=font)
    y = 64
    for name, im in cells:
        d.text((pad, y), name, fill=P[th]["text"], font=small); sheet.paste(im, (pad, y + lab - 4)); y += im.height + lab + pad
    for r in rows:
        x = pad
        for name, im in r:
            d.text((x, y), name, fill=P[th]["text"], font=small); sheet.paste(im, (x, y + lab - 4)); x += im.width + pad
        y += r[0][1].height + lab + pad
    out = f"{root}/scratch/shots/bc-roach-{th}.png"
    sheet.save(out); print(out, sheet.size)
