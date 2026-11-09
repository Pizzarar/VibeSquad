// BC-art in-place mock (DOM injection only, no src edit) on the real ?demo app: swaps the first
// .bug-btn emoji for the roach idle frame (full row height, sprite in the S2b 16-kit-px box with
// a 1x/2x image-set strip), adds a row below with .bug-btn clones on twitch1/twitch2, the A0 bugs
// chip + badge dot, and the S2b squads/teams icons. Writes
// scratch/bc-roach/inplace/row-<theme>-<4k120|1080>.png. Run via Playwright MCP
// browser_run_code_unsafe (paste as code). Then: python -I art/ui/bug-roach/sheet.py <repo>
async (page) => {
  const base = 'http://127.0.0.1:5391';
  const out = process.env.BC_SHOTS_DIR || 'scratch/bc-roach/inplace';
  const browser = page.context().browser();
  const log = [];
  const v = Date.now();
  const box = 'width:calc(var(--u3-px) * 16);height:calc(var(--u3-px) * 16);image-rendering:pixelated;display:block;flex:none';
  const roach = (th, f) => `<span aria-hidden="true" style="${box};background-image:image-set(url('${base}/ui/bug-roach-${th}.png?v=${v}') 1x, url('${base}/ui/bug-roach-${th}@2x.png?v=${v}') 2x);background-size:300% 100%;background-position:${f * 50}% 0;background-repeat:no-repeat"></span>`;
  const im = (n, th, extra='') => `<img alt="" src="${base}/ui/${n}-${th}.png?v=${v}" srcset="${base}/ui/${n}-${th}.png?v=${v} 1x, ${base}/ui/${n}-${th}@2x.png?v=${v} 2x" style="${box};${extra}">`;
  const chip = (n, th, dot) => `<span style="position:relative;display:inline-flex;align-self:center;flex:none">${im(n, th)}${dot ? im('chip-dot', th, 'position:absolute;left:0;top:0') : ''}</span>`;
  const label = (t) => `<span style="align-self:center;font-size:11px;opacity:.7;white-space:nowrap">${t}</span>`;
  for (const [tag, vp, dpr] of [['4k120', {width:3200,height:1800}, 1.2], ['1080', {width:1920,height:1080}, 1]]) {
    for (const th of ['dark', 'light']) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dpr, colorScheme: th });
      const p = await ctx.newPage();
      await p.goto(`${base}/?demo`);
      await p.waitForSelector('.team-head-line .bug-btn', { timeout: 20000 });
      await p.waitForTimeout(2000);
      const m = await p.evaluate(({ r0, r1, r2, cb, s1, s2, lb, lc }) => {
        const btn = document.querySelector('.team-head-line .bug-btn');
        const line = btn.closest('.team-head-line');
        const before = line.getBoundingClientRect().height;
        const fit = (b) => { b.style.alignSelf = 'stretch'; b.style.paddingTop = b.style.paddingBottom = '0'; b.classList.add('has-new'); };
        btn.firstElementChild.outerHTML = r0; fit(btn);
        const after = line.getBoundingClientRect().height;
        const row = line.cloneNode(false);
        row.classList.add('bc-cmp'); row.style.gap = '8px';
        const b1 = btn.cloneNode(true), b2 = btn.cloneNode(true);
        b1.firstElementChild.outerHTML = r1; b2.firstElementChild.outerHTML = r2;
        row.insertAdjacentHTML('beforeend', lb); row.append(b1, b2);
        const row2 = row.cloneNode(false);
        row2.insertAdjacentHTML('beforeend', lc + cb + s1 + s2);
        line.after(row, row2);
        const r = line.getBoundingClientRect(), rr = row2.getBoundingClientRect();
        const spr = [...line.parentElement.querySelectorAll('.bug-btn > span[aria-hidden]')].map(s => (s.getBoundingClientRect().height * devicePixelRatio).toFixed(2));
        return { before, after, btnH: btn.getBoundingClientRect().height, spr, clip: { x: Math.max(0, Math.min(r.x, rr.x) - 8), y: r.y - 8, width: Math.max(r.width, rr.width, row.getBoundingClientRect().width) + 16, height: rr.bottom - r.y + 16 } };
      }, { r0: roach(th, 0), r1: roach(th, 1), r2: roach(th, 2), cb: chip('chip-bugs', th, true), s1: chip('icon-squads', th, false), s2: chip('icon-teams', th, false),
           lb: label('tw1/2'), lc: label('chip+dot · S2b') });
      await p.waitForFunction(() => [...document.querySelectorAll('img[src*="/ui/"]')].every(i => i.complete && i.naturalWidth > 0));
      await p.waitForTimeout(400);
      await p.screenshot({ path: `${out}/row-${th}-${tag}.png`, clip: m.clip });
      log.push(`${tag} ${th} rowCSS before=${m.before} after=${m.after} btnH=${m.btnH} spriteDevicePx=${m.spr.join(',')}`);
      await ctx.close();
    }
  }
  return log.join('\n');
}
