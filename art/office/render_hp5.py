"""HP5 floor shots (docs/PLAN_HUB_PAGES.md HP5): the floor plate composed like the UI (plate -> y-sorted cast ->
front -> bubbles, via render_f4.py's helpers) plus one rider in the mid-shaft lift car.
Writes scratch/shots/hp5-floor-{mode}-{7x,3x}.png and hp5-before-after-{mode}.png (master | this tree, 3x).
Usage: python -I art/office/render_hp5.py [old-ref]   (repo root; old-ref defaults to master)"""
import io, json, sys
from PIL import Image, ImageDraw

old_ref = sys.argv[1] if len(sys.argv) > 1 else 'master'
src = open('art/office/render_f4.py', encoding='utf-8').read().split("for mode in ('dark', 'light'):")[0]
g = {'__name__': 'render_f4_helpers'}
sys.argv = ['render_f4.py', 'scratch', old_ref]
exec(compile(src, 'render_f4.py', 'exec'), g)

def shot(plate, front, sheet, fl, mode):
    img = g['compose'](plate, front, sheet, fl)
    car = fl['elevator']['car']
    f = g['frame']('implement', 'work', 2)
    c = g['CELL']
    rider = sheet.crop((f['x'], f['y'], f['x'] + c, f['y'] + c))
    base = plate.copy(); base.alpha_composite(rider, (car['x'] + car['w'] // 2 - c // 2, car['y'] + car['h'] - c))
    base.alpha_composite(front)
    box = (car['x'] - 4, car['y'] - 4, car['x'] + car['w'] + 4, car['y'] + car['h'] + 4)
    img.paste(base.crop(box), box[:2])
    g['blips'](img, fl['teamA']['statsTv'], mode, 7, 2)
    g['blips'](img, fl['teamB']['statsTv'], mode, 3, 1)
    return img

def up(img, s):
    return img.resize((img.width * s, img.height * s), Image.NEAREST)

for mode in ('dark', 'light'):
    sheet = Image.open(f'public/office/cast-{mode}.png').convert('RGBA')
    fl = json.load(open('public/office/floor.json'))
    new = shot(Image.open(f'public/office/floor-{mode}.png').convert('RGBA'),
               Image.open(f'public/office/floor-front-{mode}.png').convert('RGBA'), sheet, fl, mode)
    for s in (7, 3):
        up(new, s).save(f'scratch/shots/hp5-floor-{mode}-{s}x.png')
    gb = g['git_bytes']
    ofl = json.loads(gb('public/office/floor.json'))
    old = shot(Image.open(io.BytesIO(gb(f'public/office/floor-{mode}.png'))).convert('RGBA'),
               Image.open(io.BytesIO(gb(f'public/office/floor-front-{mode}.png'))).convert('RGBA'), sheet, ofl, mode)
    o3, n3 = up(old, 3), up(new, 3)
    gap, top = 24, 40
    bg, fg = ((20, 12, 38, 255), (247, 240, 255)) if mode == 'dark' else ((253, 244, 236, 255), (43, 24, 64))
    sbs = Image.new('RGBA', (o3.width + gap + n3.width, top + max(o3.height, n3.height)), bg)
    d = ImageDraw.Draw(sbs)
    d.text((8, 12), f'BEFORE ({old_ref}) {old.width}x{old.height}: slab strip, car at floor', fill=fg)
    d.text((o3.width + gap + 8, 12), f'AFTER (HP5) {new.width}x{new.height}: flush bottom, car mid-shaft', fill=fg)
    sbs.paste(o3, (0, top)); sbs.paste(n3, (o3.width + gap, top))
    sbs.save(f'scratch/shots/hp5-before-after-{mode}.png')
    print(f'scratch/shots/hp5-floor-{mode}-7x.png  -3x.png  hp5-before-after-{mode}.png')
