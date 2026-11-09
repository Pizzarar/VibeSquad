"""FT shots (docs/PLAN_FLOOR_TIGHT.md): floor people at 64px + the tighter 960x440 floor kit.
Writes scratch/shots/ (prefix ft-):
  ft-bust-vs-floor-{mode}.png  every role x variant: the 64px bust (public/cast.png) next to its 48px floor
                               work / needs / idle frames, 3x, nearest
  ft-floor-{mode}-4k.png       the composed floor (plate -> y-sorted cast -> front -> "!" bubbles, like the UI)
                               at 3x = 2880x1494 (4K at 120%: the whole-device-pixel scale for a ~3000px column)
  ft-floor-{mode}-1080.png     the same at 2x = 1920x996 (1080 full width) and -1080-1x.png (960x498)
  ft-before-after-{mode}.png   <old-ref> (640 plate, 32px cast) at 3x | this tree (960 plate, 48px cast) at 2x:
                               the same on-screen width, so the people grow and the layout does not move
  ft-cursor-{mode}.png         the FS-b cursor over three heads, placed with the floor-cursor.json rule (+21), 6x
  ft-gate-{mode}-4k.png        BEFORE (old-ref) | AFTER, both at k=2 (the integer scale both plates get in the
                               ~2387 device-px hub column at 4K 120%), labelled
  ft-gate-{mode}-1080.png      the same at k=1 (1080 UI 100)
Usage: python -I art/office/render_ft.py [old-ref]   (repo root; old-ref defaults to master)"""
import io, json, subprocess, sys
from PIL import Image, ImageDraw

old_ref = sys.argv[1] if len(sys.argv) > 1 else 'master'
OUT = 'scratch/shots'
ROWS = ['lead', 'retired-lead', 'buddy', 'implement', 'mechanical', 'review', 'audit', 'spec', 'art', 'unknown']  # = public/cast.png rows
BUSY = ['implement', 'review', 'spec', 'art', 'audit', 'mechanical', 'unknown', 'implement', 'review', 'spec', 'art']
BG = {'dark': (20, 12, 38, 255), 'light': (253, 244, 236, 255)}
FG = {'dark': (247, 240, 255), 'light': (43, 24, 64)}


def git_bytes(path):
    return subprocess.run(['git', 'show', f'{old_ref}:{path}'], capture_output=True, check=True).stdout


def up(img, s):
    return img.resize((img.width * s, img.height * s), Image.NEAREST)


def frame(cj, role, pose, variant, i=0):
    r = cj['roles'][role]
    v = r.get('variants', [r])[variant % len(r.get('variants', [r]))]
    return v[pose][i]


def compose(plate, front, sheet, fl, cj):
    cell = cj['cell']
    img = plate.copy()
    bub = cj['bubble']
    bimg = sheet.crop((bub['x'], bub['y'], bub['x'] + bub['w'], bub['y'] + bub['h']))
    items, bubbles = [], []
    for side, t in (('A', fl['teamA']), ('B', fl['teamB'])):
        items.append((t['buddyOffice'], 'buddy', 'work' if side == 'A' else 'needs', 0))
        items.append((t['lead'], 'lead', 'work', 1 if side == 'B' else 0))
        for i, d in enumerate(t['desks']):
            needs = (side == 'A' and i in (1, 8)) or (side == 'B' and i in (4,))
            items.append((d, BUSY[(i + (3 if side == 'B' else 0)) % len(BUSY)], 'needs' if needs else 'work', i // 3 + (side == 'B')))
    for s, role, pose, var in sorted(items, key=lambda t: t[0]['y'] + t[0]['h']):
        f = frame(cj, role, pose, var)
        spr = sheet.crop((f['x'], f['y'], f['x'] + cell, f['y'] + cell))
        ax, ay = s['x'] + s['w'] // 2, s['y'] + s['h']
        img.alpha_composite(spr, (ax - cell // 2, ay - cell))
        if pose == 'needs':
            bubbles.append((ax + bub['offset']['x'], ay + bub['offset']['y']))
    if front is not None:
        img.alpha_composite(front)
    for b in bubbles:
        img.alpha_composite(bimg, b)
    # lobby queue: two idle riders on team A's mat, one on team B's
    for t, roles in ((fl['teamA'], ('spec', 'art')), (fl['teamB'], ('audit',))):
        lb = t['lobby']
        for k, role in enumerate(roles):
            f = frame(cj, role, 'idle', k + 1)
            spr = sheet.crop((f['x'], f['y'], f['x'] + cell, f['y'] + cell))
            img.alpha_composite(spr, (lb['x'] + 8 + k * (cell - 6), lb['y'] + lb['h'] - cell))
    return img


def load(mode, ref=None):
    rd = (lambda p: Image.open(io.BytesIO(git_bytes(p))).convert('RGBA')) if ref else (lambda p: Image.open(p).convert('RGBA'))
    js = (lambda p: json.loads(git_bytes(p))) if ref else (lambda p: json.load(open(p)))
    fl, cj = js('public/office/floor.json'), js('public/office/cast.json')
    sheet = rd(f'public/office/cast-{mode}.png')
    return compose(rd(f'public/office/floor-{mode}.png'), rd(f'public/office/floor-front-{mode}.png'), sheet, fl, cj), fl, cj, sheet


busts = Image.open('public/cast.png').convert('RGBA')
for mode in ('dark', 'light'):
    new, fl, cj, sheet = load(mode)
    old, ofl, ocj, _ = load(mode, old_ref)
    cell = cj['cell']
    # 1) bust vs floor
    S, pad, lab = 3, 6, 18
    colw = 64 + 4 + cell * 3 + pad * 2
    sheetimg = Image.new('RGBA', (colw * 4 * S, (lab + 64 * len(ROWS) + pad * len(ROWS)) * S + 40), BG[mode])
    small = Image.new('RGBA', (colw * 4, lab + (64 + pad) * len(ROWS)), BG[mode])
    d = ImageDraw.Draw(small)
    for v in range(4):
        d.text((v * colw + 4, 4), f'v{v}: bust | work  needs  idle', fill=FG[mode])
    for r, role in enumerate(ROWS):
        y = lab + r * (64 + pad)
        for v in range(4):
            x = v * colw + pad
            small.alpha_composite(busts.crop((v * 64, r * 64, v * 64 + 64, r * 64 + 64)), (x, y))
            for k, pose in enumerate(('work', 'needs', 'idle')):
                f = frame(cj, role, pose, v)
                small.alpha_composite(sheet.crop((f['x'], f['y'], f['x'] + cell, f['y'] + cell)), (x + 68 + k * cell, y + 64 - cell))
        d.text((2, y + 54), role, fill=FG[mode])
    up(small, S).save(f'{OUT}/ft-bust-vs-floor-{mode}.png')
    # 2) full floor
    up(new, 3).save(f'{OUT}/ft-floor-{mode}-4k.png')
    up(new, 2).save(f'{OUT}/ft-floor-{mode}-1080.png')
    new.save(f'{OUT}/ft-floor-{mode}-1080-1x.png')
    # 3) before / after at the same on-screen width
    o3, n2 = up(old, 3), up(new, 2)
    gap, top = 24, 40
    sbs = Image.new('RGBA', (o3.width + gap + n2.width, top + max(o3.height, n2.height)), BG[mode])
    dd = ImageDraw.Draw(sbs)
    dd.text((8, 12), f'BEFORE ({old_ref}) plate {old.width}x{old.height}, cast {ocj["cell"]}px, shown 3x', fill=FG[mode])
    dd.text((o3.width + gap + 8, 12), f'AFTER (FT) plate {new.width}x{new.height}, cast {cell}px, shown 2x (same width)', fill=FG[mode])
    sbs.paste(o3, (0, top)); sbs.paste(n2, (o3.width + gap, top))
    sbs.save(f'{OUT}/ft-before-after-{mode}.png')
    # 3b) gate: both at the same integer k (4K 120% column -> k=2; 1080 UI100 -> k=1)
    for k, tag in ((2, '4k'), (1, '1080')):
        a, b = up(old, k), up(new, k)
        gap, top = 16 * k, 28 * k
        g = Image.new('RGBA', (a.width + gap + b.width, top + max(a.height, b.height)), BG[mode])
        gd = ImageDraw.Draw(g)
        gd.text((6, 8), f'BEFORE {old_ref}: plate {old.width}x{old.height}, cast {ocj["cell"]}px, k={k}', fill=FG[mode])
        gd.text((a.width + gap + 6, 8), f'AFTER FT: plate {new.width}x{new.height}, cast {cell}px, k={k}', fill=FG[mode])
        g.paste(a, (0, top)); g.paste(b, (a.width + gap, top))
        g.save(f'{OUT}/ft-gate-{mode}-{tag}.png')
    # 4) cursor over three heads, placed by the json rule
    cur = json.load(open('public/office/floor-cursor.json'))
    cimg = Image.open(f'public/office/floor-cursor-{mode}.png').convert('RGBA')
    cw, ch = cur['cell']['w'], cur['cell']['h']
    demo = new.copy()
    for k, dsk in enumerate([fl['teamA']['desks'][0], fl['teamA']['desks'][7], fl['teamA']['lead']]):
        ax, ay = dsk['x'] + dsk['w'] // 2, dsk['y'] + dsk['h']
        left = ax - cur['anchor']['x']                  # = cursorOffset() in src/squadFloorLogic.ts
        topc = ay - cell - round(ch * 1.5)
        demo.alpha_composite(cimg.crop(((k % 2) * cw, 0, (k % 2) * cw + cw, ch)), (left, topc))
    up(demo.crop((20, 120, 440, 420)), 4).save(f'{OUT}/ft-cursor-{mode}.png')
    print(mode, 'ok')
