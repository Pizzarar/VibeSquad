"""MM1 gallery: every frame (idle, blink0, blink1) of both strips on the measured active-row bg,
16 native at 8x and @2x at 4x (both 128 px cells), dark row then light row.
Writes scratch/shots/main-marker-gallery.png. Run: python -I art/ui/main-marker/gallery.py <repo>"""
import sys
from PIL import Image
root = sys.argv[1]
BG = {"dark": (38, 38, 50), "light": (230, 227, 221)}
cell, pad = 128, 12
out = Image.new("RGB", (6 * (cell + pad) + pad, 2 * (cell + pad) + pad), (120, 120, 120))
for r, th in enumerate(("dark", "light")):
    x = pad
    for s, n, k in (("", 16, 8), ("@2x", 32, 4)):
        strip = Image.open(f"{root}/public/ui/main-marker-{th}{s}.png").convert("RGBA")
        for i in range(3):
            fr = strip.crop((i * n, 0, i * n + n, n)).resize((cell, cell), Image.NEAREST)
            plate = Image.new("RGB", (cell, cell), BG[th]); plate.paste(fr, (0, 0), fr)
            out.paste(plate, (x, pad + r * (cell + pad))); x += cell + pad
out.save(f"{root}/scratch/shots/main-marker-gallery.png"); print(out.size)
