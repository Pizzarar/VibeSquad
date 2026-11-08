"""S2b review sheets: scratch/shots/icons-s2b-{dark,light}.png.
Rows = current glyph + candidates 1-3. Columns = Squads in place (4K@120%, 1080p),
Teams in place (4K@120%, 1080p), each crop at 2x nearest, then the bare 16 + 32 masters
at 8x on the P0 PANEL colour. Inputs come from build.lua (png/) and shoot.js (inplace/).
Run: python -I art/ui/icons-s2b/sheet.py <repo>"""
import sys
from PIL import Image, ImageDraw, ImageFont
root = sys.argv[1]
src = f"{root}/scratch/icons-s2b"
P = {"dark": {"bg": (20, 12, 38), "panel": (33, 22, 61), "text": (247, 240, 255)},
     "light": {"bg": (253, 244, 236), "panel": (245, 230, 239), "text": (43, 24, 64)}}
NAMES = {"0": "CURRENT GLYPH", "1": "1  MINI TOWER", "2": "2  TINY H0 HEADS", "3": "3  TOWER + PENNANT"}
try:
    font = ImageFont.truetype("consola.ttf", 22); small = ImageFont.truetype("consola.ttf", 16)
except OSError:
    font = small = ImageFont.load_default()

def up(im, k):
    return im.resize((im.width * k, im.height * k), Image.NEAREST)

def bare(name, n, th):
    im = Image.open(f"{src}/png/{name}-{n}-{th}.png").convert("RGBA")
    big = up(im, 8)
    plate = Image.new("RGB", big.size, P[th]["panel"]); plate.paste(big, (0, 0), big)
    return plate

for th in ("dark", "light"):
    rows = []
    for c in "0123":
        cells = []
        for kind in ("squads", "teams"):
            for tag in ("4k120", "1080p"):
                cells.append((f"{kind.upper()} {tag}", up(Image.open(f"{src}/inplace/{kind}-{c}-{th}-{tag}.png").convert("RGB"), 2)))
        if c != "0":
            for kind in ("squads", "teams"):
                for n in (16, 32):
                    cells.append((f"{kind} {n} @8x", bare(f"{kind}-{c}", n, th)))
        rows.append((NAMES[c], cells))
    pad, lab = 24, 28
    rh = [max(im.height for _, im in cells) + lab for _, cells in rows]
    # in-place columns are stacked 2 per column (4K over 1080p) to keep the sheet compact
    def layout(cells):
        cols, x = [], 0
        inplace = cells[:4]; bares = cells[4:]
        for i in range(0, 4, 2):
            w = max(inplace[i][1].width, inplace[i + 1][1].width)
            cols.append((x, [inplace[i], inplace[i + 1]])); x += w + pad
        for cell in bares:
            cols.append((x, [cell])); x += cell[1].width + pad
        return cols, x
    heights, width = [], 0
    for _, cells in rows:
        cols, w = layout(cells)
        width = max(width, w)
        heights.append(max(sum(im.height + lab for _, im in col) for _, col in cols))
    W = 260 + width + pad; H = 70 + sum(h + pad for h in heights)
    sheet = Image.new("RGB", (W, H), P[th]["bg"]); d = ImageDraw.Draw(sheet)
    d.text((pad, 18), f"S2b Squads + Teams icon candidates ({th}) - in place on the real ?demo bar (2x crops) + bare masters @8x", fill=P[th]["text"], font=font)
    y = 70
    for (name, cells), h in zip(rows, heights):
        d.text((pad, y + 6), name, fill=P[th]["text"], font=font)
        cols, _ = layout(cells)
        for x, col in cols:
            yy = y
            for label, im in col:
                d.text((260 + x, yy), label, fill=P[th]["text"], font=small)
                sheet.paste(im, (260 + x, yy + lab - 6)); yy += im.height + lab
        y += h + pad
    sheet.save(f"{root}/scratch/shots/icons-s2b-{th}.png")
    print(th, sheet.size)
