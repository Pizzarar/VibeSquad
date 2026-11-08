// S2b-2 in-place mock (DOM injection only, no src edit) on the real ?demo app: puts the
// shipping public/ui/icon-* PNGs in .pin-focus-home (Squads) and the squad-full-toggle
// (Teams) at the proposed size calc(var(--u3-px) * 16) with a 1x/2x srcset, and lets the
// home button grow to calc(var(--u3-px) * 18) so the icon fills ~80% of the 22-kit-px bar.
// Run via Playwright MCP browser_run_code_unsafe (paste as code: the worktree is outside the
// MCP file roots). Edit base/out below.
async (page) => {
  const base = 'http://127.0.0.1:5391';
  const out = process.env.S2B_SHOTS_DIR || 'scratch/icons-s2b/inplace-big';
  const browser = page.context().browser();
  const log = [];
  const img = (n, th) => `<img alt="" src="${base}/ui/icon-${n}-${th}.png" srcset="${base}/ui/icon-${n}-${th}.png 1x, ${base}/ui/icon-${n}-${th}@2x.png 2x" style="width:calc(var(--u3-px) * 16);height:calc(var(--u3-px) * 16);image-rendering:pixelated;vertical-align:middle;display:inline-block">`;
  for (const [tag, vp, dpr] of [['4k120', {width:3200,height:1800}, 1.2], ['1080', {width:1920,height:1080}, 1]]) {
    for (const th of ['dark', 'light']) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dpr, colorScheme: th });
      const p = await ctx.newPage();
      await p.goto(`${base}/?demo`);
      await p.waitForTimeout(2500);
      await p.click('[data-testid="pin-handle-art-direction"]');
      await p.waitForTimeout(1200);
      const m = await p.$eval('[data-testid="pin-focus-home"]', (e, h) => {
        e.innerHTML = h;
        e.style.height = 'calc(var(--u3-px) * 18)';
        e.style.display = 'inline-flex'; e.style.alignItems = 'center'; e.style.justifyContent = 'center';
        const b = e.closest('.pin-focus-bar').getBoundingClientRect(); const r = e.getBoundingClientRect();
        const i = e.querySelector('img').getBoundingClientRect();
        return { clip: { x: Math.max(0, r.x - 14), y: b.y - 8, width: 720, height: b.height + 16 }, bar: b.height, btn: r.height, icon: [i.width, i.height], src: e.querySelector('img').currentSrc };
      }, img('squads', th));
      await p.waitForTimeout(400);
      await p.waitForFunction(() => [...document.querySelectorAll('img[src*="/ui/icon-"]')].every(i => i.complete && i.naturalWidth > 0));
      await p.screenshot({ path: `${out}/squads-${th}-${tag}.png`, clip: m.clip });
      await p.click('[data-testid="pin-focus-home"]');
      await p.waitForTimeout(1000);
      await p.click('[data-testid="squad-full-toggle"]');
      await p.waitForTimeout(800);
      const t = p.locator('[data-testid="squad-full-toggle"]');
      await t.evaluate((e, h) => { e.innerHTML = h + ' TEAMS'; }, img('teams', th));
      await p.waitForTimeout(400);
      await p.waitForFunction(() => [...document.querySelectorAll('img[src*="/ui/icon-"]')].every(i => i.complete && i.naturalWidth > 0));
      const r = await t.boundingBox();
      await p.screenshot({ path: `${out}/teams-${th}-${tag}.png`, clip: { x: r.x - 420, y: r.y - 14, width: 720, height: r.height + 28 } });
      log.push(`${tag} ${th} bar=${m.bar} btn=${m.btn} icon=${m.icon} src=${m.src.split('/').pop()} teamsBtn=${r.height}`);
      await ctx.close();
    }
  }
  return log.join('\n');
}
