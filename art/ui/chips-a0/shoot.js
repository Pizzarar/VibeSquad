// A0 in-place mock (DOM injection only, no src edit) on the real ?demo app: puts the
// public/ui/chip-* PNGs (Bugs + stacked dot, Workflows) after the first .team-head at
// calc(var(--u3-px) * 16) with a 1x/2x srcset, S2b squads/teams on a row below, measures the
// row height before/after, and writes scratch/chips-a0/inplace/row-<theme>-<4k120|1080>.png.
// Run via Playwright MCP browser_run_code_unsafe (paste as code). Then: python -I art/ui/chips-a0/sheet.py <repo>
async (page) => {
  const base = 'http://127.0.0.1:5391';
  const out = process.env.A0_SHOTS_DIR || 'scratch/chips-a0/inplace';
  const browser = page.context().browser();
  const log = [];
  const v = Date.now();
  const im = (n, th, extra='') => `<img alt="" src="${base}/ui/${n}-${th}.png?v=${v}" srcset="${base}/ui/${n}-${th}.png?v=${v} 1x, ${base}/ui/${n}-${th}@2x.png?v=${v} 2x" style="width:calc(var(--u3-px) * 16);height:calc(var(--u3-px) * 16);image-rendering:pixelated;display:block;${extra}">`;
  const chip = (n, th, dot) => `<span style="position:relative;display:inline-flex;align-self:center;flex:none">${im(n, th)}${dot ? im('chip-dot', th, 'position:absolute;left:0;top:0') : ''}</span>`;
  for (const [tag, vp, dpr] of [['4k120', {width:3200,height:1800}, 1.2], ['1080', {width:1920,height:1080}, 1]]) {
    for (const th of ['dark', 'light']) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dpr, colorScheme: th });
      const p = await ctx.newPage();
      await p.goto(`${base}/?demo`);
      await p.waitForSelector('.team-head-line', { timeout: 20000 });
      await p.waitForTimeout(2000);
      const m = await p.evaluate(({ c1, c2, s1, s2 }) => {
        const line = document.querySelector('.team-head-line');
        const before = line.getBoundingClientRect().height;
        line.querySelector('.team-head').insertAdjacentHTML('afterend', c1 + c2);
        const chipsOnly = line.getBoundingClientRect().height;
        line.insertAdjacentHTML('afterend', `<div class="team-head-line a0-cmp" style="padding:4px 0">${s1}${s2}<span style="align-self:center;font-size:11px;opacity:.7">S2b squads / teams (same 16-kit-px box)</span></div>`);
        const r = line.getBoundingClientRect(); const r2 = line.nextElementSibling.getBoundingClientRect();
        const dev = [...line.querySelectorAll('img')].map(i => (i.getBoundingClientRect().height * devicePixelRatio).toFixed(2));
        return { before, chipsOnly, dev, clip: { x: Math.max(0, r.x - 8), y: r.y - 8, width: r.width + 16, height: r2.bottom - r.y + 16 } };
      }, { c1: chip('chip-bugs', th, true), c2: chip('chip-workflows', th, false), s1: chip('icon-squads', th, false), s2: chip('icon-teams', th, false) });
      await p.waitForFunction(() => [...document.querySelectorAll('img[src*="/ui/"]')].every(i => i.complete && i.naturalWidth > 0));
      await p.waitForTimeout(300);
      await p.screenshot({ path: `${out}/row-${th}-${tag}.png`, clip: m.clip });
      log.push(`${tag} ${th} rowCSS before=${m.before} withChips=${m.chipsOnly} chipDevicePx=${m.dev.join(',')}`);
      await ctx.close();
    }
  }
  return log.join('\n');
}
