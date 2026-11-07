#!/usr/bin/env python3
"""U3d post-pass for the U3b kit: redraw every 9-slice outline (frames, buttons, chips) as solid, unbroken 1px
bevels that close at all four corners. The U3b Aseprite batch (kit.lua) put ordered-dither teeth on the frame
highlight/recess lines and nipped the corners; at fractional device scales those read as ragged, perforated edges.
Airbrush dither stays where it belongs: the 2D washes (tb-ramp, bg-panel, cloud-corner, sel-*, meter-*).

Colours are sampled from the existing PNGs (same P0 palette, both themes), so a theme swap stays a URL swap and the
geometry (size, slice, scale) is identical to kit.json. Run from the repo root:  python art/ui/u3b/solid-bevels.py
"""
import os
import sys
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..')
KIT = os.path.join(ROOT, 'public', 'ui', 'u3')
THEMES = ('dark', 'light')


def lum(c):
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def opaque(im):
    return [im.getpixel((x, y)) for y in range(im.height) for x in range(im.width) if im.getpixel((x, y))[3] > 0]


def mix(a, b, t):
    return tuple(int(round(a[i] * (1 - t) + b[i] * t)) for i in range(3)) + (255,)


def darkest(im):
    return min(opaque(im), key=lum)


def lightest(im):
    return max(opaque(im), key=lum)


def put(im, x, y, c):
    if 0 <= x < im.width and 0 <= y < im.height:
        im.putpixel((x, y), c)


def hline(im, y, x0, x1, c):
    for x in range(x0, x1 + 1):
        put(im, x, y, c)


def vline(im, x, y0, y1, c):
    for y in range(y0, y1 + 1):
        put(im, x, y, c)


def frame(src, kind, hi):
    """32x32, slice 8, transparent centre. Left/top: INK ring + highlight (+ inner INK line for windows).
    Right/bottom: INK drop + INK ring + shade recess. Every line is solid and the corners are filled."""
    ink = darkest(src)
    w = h = src.width
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    shade = mix(hi, ink, 0.55)
    if kind == 'well':
        # sunken: INK recess line top/left, catch-light bottom/right, closed corners
        hline(im, 0, 0, w - 1, ink); vline(im, 0, 0, h - 1, ink)
        hline(im, h - 1, 1, w - 1, hi); vline(im, w - 1, 1, h - 1, hi)
        return im
    # outer ring + highlight
    hline(im, 0, 0, w - 2, ink); vline(im, 0, 0, h - 2, ink)
    hline(im, 1, 1, w - 3, hi); vline(im, 1, 1, h - 3, hi)
    if kind == 'window':
        hline(im, 2, 2, w - 4, ink); vline(im, 2, 2, h - 4, ink)
    # drop shadow + ring + recess (bottom/right)
    hline(im, h - 1, 0, w - 1, ink); vline(im, w - 1, 0, h - 1, ink)
    hline(im, h - 2, 1, w - 2, ink); vline(im, w - 2, 1, h - 2, ink)
    hline(im, h - 3, 2, w - 3, shade); vline(im, w - 3, 2, h - 3, shade)
    if kind == 'window':
        hline(im, h - 4, 3, w - 4, ink); vline(im, w - 4, 3, h - 4, ink)
    # square the top-right / bottom-left corners of the highlight into the ring
    put(im, w - 2, 0, ink); put(im, 0, h - 2, ink)
    put(im, w - 2, 1, ink); put(im, 1, h - 2, ink)
    return im


def body(w, h, ring, face, hi, sh, drop, pressed=False, rows=None):
    """Solid bevelled box: ring on the outside, 1px highlight/shade inside, 1px INK drop below/right (none if pressed)."""
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    bw = w - 1 if pressed else w - 1  # body keeps the same box either way
    bh = (rows if rows else h - 2)  # body rows 0..bh-1, drop on the next row
    x1, y1 = bw - 1, bh - 1
    # face
    for y in range(1, y1):
        hline(im, y, 1, x1 - 1, face)
    # ring (closed corners)
    hline(im, 0, 0, x1, ring); hline(im, y1, 0, x1, ring)
    vline(im, 0, 0, y1, ring); vline(im, x1, 0, y1, ring)
    # inner bevel: highlight top/left, shade bottom/right (inverted when pressed)
    top_left, bot_right = (sh, hi) if pressed else (hi, sh)
    hline(im, 1, 1, x1 - 1, top_left); vline(im, 1, 1, y1 - 1, top_left)
    hline(im, y1 - 1, 1, x1 - 1, bot_right); vline(im, x1 - 1, 2, y1 - 1, bot_right)
    if not pressed:
        hline(im, y1 + 1, 1, x1 + 1, drop); vline(im, x1 + 1, 1, y1 + 1, drop)
    return im


def button(src):
    w, h = src.size  # 24x14
    ink = darkest(src)
    face = src.getpixel((w // 2, h // 2 - 1))
    if face[3] == 0:
        face = lightest(src)
    ring = src.getpixel((0, h // 2))
    if ring[3] == 0:
        ring = ink
    top = [src.getpixel((x, y)) for y in (1, 2) for x in range(2, w - 2) if src.getpixel((x, y))[3] > 0]
    hi = max(top, key=lum) if top else mix(face, (255, 255, 255, 255), 0.5)
    if lum(hi) <= lum(face):
        hi = mix(face, (255, 255, 255, 255), 0.45)
    sh = mix(face, ink, 0.4)
    return face, ring, hi, sh, ink


def build_button(src, pressed):
    face, ring, hi, sh, ink = button(src)
    return body(src.width, src.height, ring, face, hi, sh, ink, pressed=pressed, rows=12)


def build_chip(src, ringonly=False):
    """16x10, slice 3/4: ring + solid highlight/shade + drop; text sits in the flat rows 2-6."""
    w, h = src.size
    ink = darkest(src)
    if ringonly:
        # teal ring chip: coloured outline, transparent inside (a chip-ring-teal outline keeps the badge readable on any wash)
        ring = max(opaque(src), key=lambda c: (c[1] + c[2]) - c[0])
        im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        hline(im, 0, 0, w - 2, ring); hline(im, h - 2, 0, w - 2, ring)
        vline(im, 0, 0, h - 2, ring); vline(im, w - 2, 0, h - 2, ring)
        hline(im, h - 1, 1, w - 1, ink); vline(im, w - 1, 1, h - 1, ink)
        return im
    face = src.getpixel((w // 2, h // 2 - 1))
    hi = mix(face, (255, 255, 255, 255), 0.5)
    sh = mix(face, ink, 0.4)
    return body(w, h, ink, face, hi, sh, ink, pressed=False, rows=h - 1)


def main():
    done = []
    for theme in THEMES:
        def path(n):
            return os.path.join(KIT, f'{n}-{theme}.png')

        def load(n):
            return Image.open(path(n)).convert('RGBA')

        # frames
        win = load('window-frame')
        pan = load('panel-frame')
        marble = lightest(win)
        # highlight colours are read from the existing panel frames (violet / pink / amber)
        def hi_of(n):
            im = load(n)
            cols = [c for c in opaque(im) if c != darkest(im)]
            return max(set(cols), key=cols.count)

        outs = {
            'window-frame': frame(win, 'window', marble),
            'panel-frame': frame(pan, 'panel', hi_of('panel-frame')),
            'panel-frame-pink': frame(load('panel-frame-pink'), 'panel', hi_of('panel-frame-pink')),
            'panel-frame-amber': frame(load('panel-frame-amber'), 'panel', hi_of('panel-frame-amber')),
            'well-frame': frame(load('well-frame'), 'well', lightest(load('well-frame'))),
        }
        for v in ('ghost', 'primary', 'hot', 'on', 'warn', 'marble'):
            for s in ('normal', 'hover', 'active'):
                n = f'btn-{v}-{s}'
                outs[n] = build_button(load(n), pressed=(s == 'active'))
        for v in ('teal', 'pink', 'mint', 'amber', 'violet', 'neutral', 'marble'):
            n = f'chip-{v}'
            outs[n] = build_chip(load(n))
        outs['chip-ring-teal'] = build_chip(load('chip-ring-teal'), ringonly=True)
        for n, im in outs.items():
            im.save(path(n))
            done.append(f'{n}-{theme}')
    print(f'rewrote {len(done)} PNGs')


if __name__ == '__main__':
    sys.exit(main())
