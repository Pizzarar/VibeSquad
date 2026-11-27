"""MM1 contrast check: WCAG ratio of the marker against the Normal-mode active project row bg
(.boring-project-line .boring-project-row.on = --surface-3, measured by shoot.js).
Reports per colour, the outer ring (opaque px touching transparency = INK outline/shadow) and the
fill edge (non-INK px touching INK or transparency = the visible filled shape), per strip.
Run: python -I art/ui/main-marker/contrast.py <repo>"""
import sys
from PIL import Image
root = sys.argv[1]
BG = {"dark": (38, 38, 50), "light": (230, 227, 221)}

def lum(c):
    f = lambda v: v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (f(x / 255) for x in c[:3]); return 0.2126 * r + 0.7152 * g + 0.0722 * b

def ratio(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True); return (la + 0.05) / (lb + 0.05)

for th in ("dark", "light"):
    pal = Image.open(f"{root}/public/ui/main-marker-{th}.png").convert("RGBA")
    ink = min({pal.getpixel((x, y))[:3] for x in range(pal.width) for y in range(pal.height) if pal.getpixel((x, y))[3]}, key=lum)
    print(f"[{th}] active-row bg rgb{BG[th]}")
    cols = sorted({pal.getpixel((x, y))[:3] for x in range(pal.width) for y in range(pal.height) if pal.getpixel((x, y))[3]}, key=lum)
    for c in cols: print(f"  colour #{c[0]:02x}{c[1]:02x}{c[2]:02x}  {ratio(c, BG[th]):.2f}:1")
    for s in ("", "@2x"):
        im = Image.open(f"{root}/public/ui/main-marker-{th}{s}.png").convert("RGBA")
        W, H = im.size
        a = lambda x, y: 0 <= x < W and 0 <= y < H and im.getpixel((x, y))[3] > 0
        N = ((1, 0), (-1, 0), (0, 1), (0, -1))
        outer = [ratio(im.getpixel((x, y)), BG[th]) for x in range(W) for y in range(H)
                 if a(x, y) and any(not a(x + i, y + j) for i, j in N)]
        fill = [ratio(im.getpixel((x, y)), BG[th]) for x in range(W) for y in range(H)
                if a(x, y) and im.getpixel((x, y))[:3] != ink
                and any(not a(x + i, y + j) or im.getpixel((x + i, y + j))[:3] == ink for i, j in N)]
        print(f"  {W}x{H} outer ring min {min(outer):.2f}:1 ({len(outer)} px) | fill edge min {min(fill):.2f}:1 ({len(fill)} px)")
