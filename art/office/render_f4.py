"""F4a preview shots (docs/PLAN_FLOOR_RELAYOUT_F4.md), drawn the way the UI does: plate -> sprites
(y-sorted, sprite bottom-centre on the slice bottom-centre) -> front overlay -> "!" bubbles.
Every desk, the lead and the Buddy get a cast sprite; the stats TV glass gets a mock of the F4b blips
(2x2 clusters of 3px dots, cyan = working, pink = needs-you, a heartbeat line and a 2-digit count).
Writes <out>/f4a-{mode}.png (3x) and <out>/f4a-vs-old-{mode}.png (old | new, 2x).
Usage: python -I art/office/render_f4.py <outdir> [old-ref]   (run from the repo root; old-ref defaults to master)"""
import io, json, subprocess, sys
from PIL import Image, ImageDraw

out = sys.argv[1]
old_ref = sys.argv[2] if len(sys.argv) > 2 else 'master'
cj = json.load(open('public/office/cast.json'))
CELL = cj['cell']
BUSY = ['implement', 'review', 'spec', 'art', 'audit', 'mechanical', 'unknown', 'implement', 'review', 'spec', 'art']

def git_bytes(path):
    return subprocess.run(['git', 'show', f'{old_ref}:{path}'], capture_output=True, check=True).stdout

def frame(role, pose, variant):
    r = cj['roles'].get(role) or cj['roles'][cj['fallback'].get(role, 'unknown')]
    vs = r.get('variants', [r])
    v = vs[variant % len(vs)]
    return v[pose][0]

def cast_for(fl):
    items = []
    for side, t in (('A', fl['teamA']), ('B', fl['teamB'])):
        items.append((t['buddyOffice'], 'buddy', 'work' if side == 'A' else 'needs', 0))
        items.append((t['lead'], 'lead', 'work', 1 if side == 'B' else 0))
        for i, d in enumerate(t['desks']):
            needs = (side == 'A' and i in (1, 8)) or (side == 'B' and i in (4,))
            items.append((d, BUSY[(i + (3 if side == 'B' else 0)) % len(BUSY)], 'needs' if needs else 'work', i // 3 + (side == 'B')))
    return items

def compose(plate, front, sheet, fl):
    img = plate.copy()
    bub = cj['bubble']
    bimg = sheet.crop((bub['x'], bub['y'], bub['x'] + bub['w'], bub['y'] + bub['h']))
    bubbles = []
    for s, role, pose, var in sorted(cast_for(fl), key=lambda t: t[0]['y'] + t[0]['h']):
        f = frame(role, pose, var)
        spr = sheet.crop((f['x'], f['y'], f['x'] + CELL, f['y'] + CELL))
        ax, ay = s['x'] + s['w'] // 2, s['y'] + s['h']
        img.alpha_composite(spr, (ax - CELL // 2, ay - CELL))
        if pose == 'needs':
            bubbles.append((ax + bub['offset']['x'], ay + bub['offset']['y']))
    if front is not None:
        img.alpha_composite(front)
    for b in bubbles:
        img.alpha_composite(bimg, b)
    return img

def blips(img, tv, mode, n_work, n_needs):
    pal = {'dark': {'work': (79, 214, 207), 'needs': (255, 104, 168)},
           'light': {'work': (26, 134, 138), 'needs': (214, 63, 136)}}[mode]
    d = ImageDraw.Draw(img)
    x0, y0 = tv['x'] + 3, tv['y'] + 3
    states = ['work'] * n_work + ['needs'] * n_needs
    for k, st in enumerate(states):
        cl, q = k // 4, k % 4
        cx, cy = x0 + (cl % 4) * 9 + (q % 2) * 4, y0 + (cl // 4) * 9 + (q // 2) * 4
        d.rectangle((cx, cy, cx + 2, cy + 2), fill=pal[st])
    hy = tv['y'] + tv['h'] - 5
    pts = [0, 0, 0, -2, 2, -3, 1, 0, 0, 0, 0, 0, 0, 0, 0, -1, 2, -2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    for i, dy in enumerate(pts):
        d.point((tv['x'] + 2 + i, hy + dy), fill=pal['work'])
    digits = {'0': '111101101101111', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110',
              '4': '101101111001001', '5': '111100110001110', '6': '011100111101111', '7': '111001010010010',
              '8': '111101111101111', '9': '111101111001110'}
    for n, ch in enumerate(f'{n_work + n_needs:02d}'):
        g = digits[ch]
        for r in range(5):
            for q in range(3):
                if g[r * 3 + q] == '1':
                    d.point((tv['x'] + tv['w'] - 10 + n * 4 + q, tv['y'] + tv['h'] - 7 + r), fill=pal['work'])

for mode in ('dark', 'light'):
    fl = json.load(open('public/office/floor.json'))
    sheet = Image.open(f'public/office/cast-{mode}.png').convert('RGBA')
    plate = Image.open(f'public/office/floor-{mode}.png').convert('RGBA')
    front = Image.open(f'public/office/floor-front-{mode}.png').convert('RGBA')
    new = compose(plate, front, sheet, fl)
    blips(new, fl['teamA']['statsTv'], mode, 7, 2)
    blips(new, fl['teamB']['statsTv'], mode, 3, 1)
    new.resize((1920, 1080), Image.NEAREST).save(f'{out}/f4a-{mode}.png')

    ofl = json.loads(git_bytes('public/office/floor.json'))
    oplate = Image.open(io.BytesIO(git_bytes(f'public/office/floor-{mode}.png'))).convert('RGBA')
    ofront = Image.open(io.BytesIO(git_bytes(f'public/office/floor-front-{mode}.png'))).convert('RGBA')
    old = compose(oplate, ofront, sheet, ofl)
    gap = 8
    sbs = Image.new('RGBA', (1280 * 2 + gap * 2, 720), (7, 4, 15, 255))
    sbs.paste(old.resize((1280, 720), Image.NEAREST), (0, 0))
    sbs.paste(new.resize((1280, 720), Image.NEAREST), (1280 + gap * 2, 0))
    sbs.save(f'{out}/f4a-vs-old-{mode}.png')
    print(f'{out}/f4a-{mode}.png  {out}/f4a-vs-old-{mode}.png')
