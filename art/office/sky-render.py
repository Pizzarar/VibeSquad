"""C2 phase 2 review renders: per mode, a 4x gallery (sky band 1.5 tiles to show the seam, sky-CRT raw with
slice guides, the CRT 9-sliced into a wide box, next to the R3 faces + H0 alien) and a 1920-wide mock
(sky band at 3x, two framed zones with the R3 lookDown faces, above the top of a tower floor at 3x).
The 9-slice follows CSS `border-image: <png> T R B L / <slice*scale>px repeat` (edge tiles centred).
Usage: python -I art/office/sky-render.py   (repo root; needs scratch/c2a/alien-* from export_alien_ref.lua)"""
import json, math
from PIL import Image, ImageDraw, ImageFont

PAL = {}
for mode in ('dark', 'light'):
    rows = [l.split() for l in open(f'art/palette/pc98-{mode}.gpl') if l[:1].isspace() or l[:1].isdigit()]
    PAL[mode] = [tuple(int(v) for v in r[:3]) + (255,) for r in rows if len(r) >= 3]
SJ = json.load(open('public/office/sky-crt.json'))
SL = SJ['slice']; SCALE = SJ['scale']
FJ = json.load(open('public/office/faces.json'))
CW, CH = FJ['cell']['w'], FJ['cell']['h']
try:
    FONT = ImageFont.truetype('consola.ttf', 18); BIG = ImageFont.truetype('consola.ttf', 26)
except OSError:
    FONT = BIG = ImageFont.load_default()
up = lambda im, z: im.resize((im.width * z, im.height * z), Image.NEAREST)


def tile_run(src, length, horizontal):
    """CSS `repeat` along one edge: whole tiles, one centred, cut at both ends."""
    t = src.width if horizontal else src.height
    out = Image.new('RGBA', (length, src.height) if horizontal else (src.width, length))
    n = math.ceil(length / t) + 2
    start = (length - t) // 2 - (n // 2) * t
    for i in range(n):
        o = start + i * t
        out.paste(src, (o, 0) if horizontal else (0, o), src)   # empty canvas: paste == composite, and it clips
    return out


def nine(src, w, h):
    """9-slice `src` into a w x h native box (transparent centre)."""
    T, R, B, Lf = SL['top'], SL['right'], SL['bottom'], SL['left']
    sw, sh = src.size
    out = Image.new('RGBA', (w, h))
    crop = lambda x0, y0, x1, y1: src.crop((x0, y0, x1, y1))
    out.alpha_composite(crop(0, 0, Lf, T), (0, 0))
    out.alpha_composite(crop(sw - R, 0, sw, T), (w - R, 0))
    out.alpha_composite(crop(0, sh - B, Lf, sh), (0, h - B))
    out.alpha_composite(crop(sw - R, sh - B, sw, sh), (w - R, h - B))
    out.alpha_composite(tile_run(crop(Lf, 0, sw - R, T), w - Lf - R, True), (Lf, 0))
    out.alpha_composite(tile_run(crop(Lf, sh - B, sw - R, sh), w - Lf - R, True), (Lf, h - B))
    out.alpha_composite(tile_run(crop(0, T, Lf, sh - B), h - T - B, False), (0, T))
    out.alpha_composite(tile_run(crop(sw - R, T, sw, sh - B), h - T - B, False), (w - R, T))
    return out


def face(bot, mode, tag='lookDown'):
    f = FJ[bot][tag][0]
    return Image.open(f'public/office/face-{bot}-{mode}.png').convert('RGBA').crop((f['x'], f['y'], f['x'] + CW, f['y'] + CH))


for mode in ('dark', 'light'):
    P = PAL[mode]
    BG, PANEL, PHI, LINE, TEXT, MUTED, TEAL, VIOLET = P[0], P[1], P[2], P[3], P[5], P[6], P[7], P[8]
    sky = Image.open(f'public/office/sky-{mode}.png').convert('RGBA')
    crt = Image.open(f'public/office/sky-crt-{mode}.png').convert('RGBA')

    # ---------------- gallery @4x ----------------
    Z, pad = 4, 24
    band = Image.new('RGBA', (sky.width * 3 // 2, sky.height))
    band.paste(sky, (0, 0)); band.paste(sky, (sky.width, 0))
    guide = up(crt, Z); gd = ImageDraw.Draw(guide)
    for x in (SL['left'], crt.width - SL['right']):
        gd.line([(x * Z, 0), (x * Z, guide.height)], fill=(0, 255, 255, 255))
    for y in (SL['top'], crt.height - SL['bottom']):
        gd.line([(0, y * Z), (guide.width, y * Z)], fill=(0, 255, 255, 255))
    demo = Image.new('RGBA', (150, 84)); demo.paste(sky.crop((100, 92, 250, 176)), (0, 0))
    demo.alpha_composite(nine(crt, 150, 84))
    items = [('sky-crt raw (slice guides)', guide), ('sky-crt 9-sliced 150x84 on sky', up(demo, Z)),
             ('RiffBot R3 lookDown', up(face('riffbot', mode), Z)), ('Overlord R3 lookDown', up(face('overlord', mode), Z)),
             ('H0 alien bust 64', up(Image.open(f'scratch/c2a/alien-bust-{mode}.png').convert('RGBA'), Z)),
             ('H0 alien floor', up(Image.open(f'scratch/c2a/alien-floor1-{mode}.png').convert('RGBA'), Z))]
    bandZ = up(band, Z)
    rowh = max(i.height for _, i in items) + 30
    GW = max(bandZ.width, sum(i.width + pad for _, i in items) + pad) + 2 * pad
    GH = 50 + bandZ.height + 40 + rowh + pad
    g = Image.new('RGBA', (GW, GH), PANEL); d = ImageDraw.Draw(g)
    d.text((pad, 12), f'C2 phase 2 - {mode} - 4x - sky {sky.width}x{sky.height} (1.5 tiles: seam at x={sky.width * Z}) | sky-crt {crt.width}x{crt.height} slice T{SL["top"]} R{SL["right"]} B{SL["bottom"]} L{SL["left"]}', font=FONT, fill=TEXT)
    g.alpha_composite(bandZ, (pad, 50))
    d.line([(pad + sky.width * Z, 44), (pad + sky.width * Z, 50)], fill=TEXT, width=3)
    x, y = pad, 50 + bandZ.height + 40
    for name, im in items:
        d.text((x, y - 26), name, font=FONT, fill=TEXT)
        g.alpha_composite(im, (x, y)); x += im.width + pad
    p = f'scratch/shots/c2-p2-gallery-{mode}.png'; g.save(p); print(p, g.size)

    # ---------------- mock 1920 ----------------
    MW, SKYH, STRIP, TOWER = 1920, sky.height * 3, 14, 120 * 3
    PT, PS, GAP, PB = 12, 18, 18, 90          # C2b padding/gap, padding-bottom raised from 22 (see report)
    m = Image.new('RGBA', (MW, SKYH + STRIP + TOWER), BG)
    sky3 = up(sky, 3)
    for ox in range(0, MW, sky3.width): m.alpha_composite(sky3, (ox, 0))
    zw, zh = (MW - 2 * PS - GAP) // 2, SKYH - PT - PB
    md = ImageDraw.Draw(m)
    for i, (bot, label) in enumerate((('riffbot', 'RiffBot'), ('overlord', 'Overlord'))):
        zx, zy = PS + i * (zw + GAP), PT
        bl, bt, br, bb = SL['left'] * SCALE, SL['top'] * SCALE, SL['right'] * SCALE, SL['bottom'] * SCALE
        cx0, cy0, cx1, cy1 = zx + bl, zy + bt, zx + zw - br, zy + zh - bb
        md.rectangle([cx0, cy0, cx1 - 1, cy1 - 1], fill=BG)                      # background-clip: padding-box
        md.rectangle([cx0, cy0, cx1 - 1, cy0 + 156], fill=PANEL)                  # .sky-crt-head (well)
        md.line([(cx0, cy0 + 156), (cx1 - 1, cy0 + 156)], fill=LINE)
        fc = up(face(bot, mode), 3)
        nw = md.textlength(label, font=BIG)
        fx = (cx0 + cx1 - fc.width - 12 - nw) // 2
        m.alpha_composite(fc, (int(fx), cy0 + 6))
        md.text((fx + fc.width + 12, cy0 + 64), label, font=BIG, fill=TEAL if bot == 'riffbot' else VIOLET)
        yy = cy0 + 170
        for j, wfrac in enumerate((0.62, 0.45)):
            right = j % 2 == 1
            bw = int((cx1 - cx0 - 40) * wfrac)
            bx = cx1 - 20 - bw if right else cx0 + 20
            if yy + 30 > cy1 - 50: break
            md.rectangle([bx, yy, bx + bw, yy + 30], fill=PHI if right else PANEL, outline=LINE)
            md.line([(bx + 10, yy + 15), (bx + bw - 30, yy + 15)], fill=MUTED, width=3)
            yy += 40
        md.rectangle([cx0 + 12, cy1 - 44, cx1 - 12, cy1 - 10], fill=PANEL, outline=LINE)   # composer
        md.text((cx0 + 22, cy1 - 37), f'Message {label}...', font=FONT, fill=MUTED)
        nb = nine(crt, round(zw / SCALE), round(zh / SCALE))
        m.alpha_composite(up(nb, SCALE).resize((zw, zh), Image.NEAREST), (zx, zy))
    md.rectangle([0, SKYH, MW, SKYH + STRIP - 1], fill=(0x3b, 0x32, 0x78, 255) if mode == 'dark' else (0xee, 0xf8, 0xff, 255))  # C2b .sq-strip.is-empty
    floor = Image.open(f'public/office/floor-{mode}.png').convert('RGBA').crop((0, 0, 640, 120))
    m.alpha_composite(up(floor, 3), (0, SKYH + STRIP))
    p = f'scratch/shots/c2-p2-mock-{mode}.png'; m.save(p); print(p, m.size)
