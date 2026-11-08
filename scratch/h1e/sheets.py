from PIL import Image, ImageDraw
S = 'scratch/shots/'
for tag in ('4k120', '1080p'):
    for t in ('dark', 'light'):
        ims = [Image.open(f'{S}h1e-bezel-{v}-{t}-{tag}.png') for v in ('before', 'after', 'wall')]
        c = Image.new('RGB', (max(i.width for i in ims), sum(i.height for i in ims) + 16), (128, 128, 128)); y = 0
        for i in ims: c.paste(i, (0, y)); y += i.height + 8
        c.save(f'{S}h1e-bezel-compare-{t}-{tag}.png')
for t in ('dark', 'light'):
    im = Image.open(f'{S}h1e-bezel-wall-{t}-4k120.png'); w, h = im.size
    top = im.crop((w // 2 - 60, 0, w // 2 + 60, 140)); bot = im.crop((w // 2 - 60, h - 150, w // 2 + 60, h - 10))
    c = Image.new('RGB', (480 * 2 + 8, 560), (128, 128, 128))
    c.paste(top.resize((480, 560), Image.NEAREST), (0, 0)); c.paste(bot.resize((480, 560), Image.NEAREST), (488, 0))
    c.save(f'{S}h1e-bezel-seam-{t}-4x.png')
# asset gallery: bezel + wall, both palettes, 12x
Z = 12; g = Image.new('RGB', (2 * (10 + 4 + 6) * Z + 3 * 16, 20 * Z + 32), (60, 120, 200)); x = 16
for t in ('dark', 'light'):
    for f in (f'public/office/sky-crt-{t}.png', f'public/office/sky-wall-{t}.png'):
        a = Image.open(f).convert('RGBA'); a = a.resize((a.width * Z, a.height * Z), Image.NEAREST)
        g.paste(a, (x, 16), a); x += a.width + 16
g.save(f'{S}h1e-bezel-assets-12x.png'); print('ok', g.size)
