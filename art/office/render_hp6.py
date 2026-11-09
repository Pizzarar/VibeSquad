"""HP6 floor shots (from render_hp5.py) (docs/PLAN_FLOOR_LABELS.md HP6): the floor plate composed like the UI (plate -> y-sorted cast ->
front -> bubbles, via render_f4.py's helpers) plus one rider in the mid-shaft lift car.
Writes scratch/shots/hp6-floor-{mode}-{7x,3x}.png and hp6-before-after-{mode}.png (master | this tree, 3x).
Usage: python -I art/office/render_hp6.py [old-ref]   (repo root; old-ref defaults to master)"""
import io, json, sys
from PIL import Image, ImageDraw

old_ref = sys.argv[1] if len(sys.argv) > 1 else 'master'
src = open('art/office/render_f4.py', encoding='utf-8').read().split("for mode in ('dark', 'light'):")[0]
g = {'__name__': 'render_f4_helpers'}
sys.argv = ['render_f4.py', 'scratch', old_ref]
exec(compile(src, 'render_f4.py', 'exec'), g)

def shot(plate, front, sheet, fl, mode):
    img = g['compose'](plate, front, sheet, fl)
    if 'counter' in fl['elevator']:   # HP6: doors closed at idle, no rider drawn in the car
        g['blips'](img, fl['teamA']['statsTv'], mode, 7, 2)
        g['blips'](img, fl['teamB']['statsTv'], mode, 3, 1)
        return img
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
        up(new, s).save(f'scratch/shots/hp6-floor-{mode}-{s}x.png')
    gb = g['git_bytes']
    ofl = json.loads(gb('public/office/floor.json'))
    old = shot(Image.open(io.BytesIO(gb(f'public/office/floor-{mode}.png'))).convert('RGBA'),
               Image.open(io.BytesIO(gb(f'public/office/floor-front-{mode}.png'))).convert('RGBA'), sheet, ofl, mode)
    o3, n3 = up(old, 3), up(new, 3)
    gap, top = 24, 40
    bg, fg = ((20, 12, 38, 255), (247, 240, 255)) if mode == 'dark' else ((253, 244, 236, 255), (43, 24, 64))
    sbs = Image.new('RGBA', (o3.width + gap + n3.width, top + max(o3.height, n3.height)), bg)
    d = ImageDraw.Draw(sbs)
    d.text((8, 12), f'BEFORE ({old_ref}) {old.width}x{old.height}: baked VIBESQUAD/HYPERDESK + 07', fill=fg)
    d.text((o3.width + gap + 8, 12), f'AFTER (HP6): blank signs + counter, solid lift wall, doors at floor, < > call buttons', fill=fg)
    sbs.paste(o3, (0, top)); sbs.paste(n3, (o3.width + gap, top))
    sbs.save(f'scratch/shots/hp6-before-after-{mode}.png')
    print(f'scratch/shots/hp6-floor-{mode}-7x.png  -3x.png  hp6-before-after-{mode}.png')

# HP6 overlay: the 5 new floor.json slots + the moved doorA/doorB/car outlined (1px plate-space boxes at 7x) on the after shot, dark + light
COLS = {'teamA.sign': (255, 0, 255), 'teamB.sign': (255, 0, 255), 'elevator.counter': (0, 255, 0),
        'elevator.callPrev': (0, 200, 255), 'elevator.callNext': (0, 200, 255),
        'elevator.doorA': (255, 255, 0), 'elevator.doorB': (255, 160, 0), 'elevator.car': (255, 60, 60)}
fl = json.load(open('public/office/floor.json'))
for mode in ('dark', 'light'):
    s = 7
    img = up(Image.open(f'public/office/floor-{mode}.png').convert('RGBA'), s)
    img.alpha_composite(up(Image.open(f'public/office/floor-front-{mode}.png').convert('RGBA'), s))
    d = ImageDraw.Draw(img)
    for k, col in COLS.items():
        a, b = k.split('.')
        r = fl[a][b]
        d.rectangle((r['x'] * s, r['y'] * s, (r['x'] + r['w']) * s - 1, (r['y'] + r['h']) * s - 1), outline=col, width=3)
        d.text((r['x'] * s + 4, (r['y'] + r['h']) * s + 4), f"{k} {r['x']},{r['y']} {r['w']}x{r['h']}", fill=col)
    img.save(f'scratch/shots/hp6-overlay-{mode}-7x.png')
    img.crop((100 * s, 0, 540 * s, 332 * s)).save(f'scratch/shots/hp6-overlay-{mode}-crop.png')
    print(f'scratch/shots/hp6-overlay-{mode}-7x.png  -crop.png')
