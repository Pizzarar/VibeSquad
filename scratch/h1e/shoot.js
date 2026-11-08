async (page) => {
  const out = 'C:/Users/Fugma/AppData/Local/VibeSquad/worktrees/VibeSquad/art-h1e/scratch/shots/';
  const browser = page.context().browser();
  const res = [];
  for (const [tag, vp, dpr] of [['4k120', {width:3200,height:1800}, 1.2], ['1080p', {width:1920,height:1080}, 1]]) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dpr });
    const p = await ctx.newPage();
    for (const theme of ['dark','light']) for (const v of ['before','after','wall']) {
      await p.goto(`http://127.0.0.1:8765/scratch/h1e/mock.html?theme=${theme}&v=${v}&t=${Date.now()}`);
      await p.waitForTimeout(400);
      const holes = await p.$$eval('.sky-zone', els => els.map(e => e.dataset.hole));
      const box = await p.$eval('.sky-zones', e => { const r = e.getBoundingClientRect(); return { x: r.x, y: 0, width: r.width, height: r.bottom + 4 }; });
      await p.screenshot({ path: `${out}h1e-bezel-${v}-${theme}-${tag}.png`, clip: box });
      res.push(`${tag} ${theme} ${v} holes=${holes.join(',')}`);
    }
    await ctx.close();
  }
  return res.join('\n');
}
