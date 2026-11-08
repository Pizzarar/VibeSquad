// S2b in-place shots: swaps the ⊞ glyph for each candidate in the browser only (DOM
// injection, no src edit) on the real ?demo app, Squads = .pin-focus-home on the pin focus
// bar, Teams = squad-full-toggle "⊞ TEAMS". img uses srcset 16 1x / 32 2x like the wiring.
// Run via Playwright MCP browser_run_code_unsafe(filename). Edit base/out below.
async (page) => {
  const base = 'http://127.0.0.1:5391';
  const out = process.env.S2B_SHOTS_DIR || 'scratch/icons-s2b/inplace';
  const browser = page.context().browser();
  const log = [];
  const img = (n, th, label) => `<img alt="" src="${base}/scratch/icons-s2b/png/${n}-16-${th}.png" srcset="${base}/scratch/icons-s2b/png/${n}-16-${th}.png 1x, ${base}/scratch/icons-s2b/png/${n}-32-${th}.png 2x" width="16" height="16" style="image-rendering:pixelated;vertical-align:middle;display:inline-block">${label}`;
  for (const [tag, vp, dpr] of [['4k120', {width:3200,height:1800}, 1.2], ['1080p', {width:1920,height:1080}, 1]]) {
    for (const th of ['dark', 'light']) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dpr, colorScheme: th });
      const p = await ctx.newPage();
      await p.goto(`${base}/?demo`);
      await p.waitForTimeout(2500);
      await p.click('[data-testid="pin-handle-art-direction"]');
      await p.waitForTimeout(1200);
      for (const c of ['0', '1', '2', '3']) {
        await p.$eval('[data-testid="pin-focus-home"]', (e, h) => { e.innerHTML = h; }, c === '0' ? '⊞' : img(`squads-${c}`, th, ''));
        await p.waitForTimeout(300);
        const box = await p.$eval('[data-testid="pin-focus-home"]', e => { const b = e.closest('.pin-focus-bar').getBoundingClientRect(); const r = e.getBoundingClientRect(); return { x: Math.max(0, r.x - 14), y: b.y - 6, width: 300, height: b.height + 12 }; });
        await p.screenshot({ path: `${out}/squads-${c}-${th}-${tag}.png`, clip: box });
      }
      await p.click('[data-testid="pin-focus-home"]');
      await p.waitForTimeout(1000);
      await p.click('[data-testid="squad-full-toggle"]');
      await p.waitForTimeout(800);
      for (const c of ['0', '1', '2', '3']) {
        const t = p.locator('[data-testid="squad-full-toggle"]');
        await t.evaluate((e, h) => { e.innerHTML = h; }, c === '0' ? '⊞ TEAMS' : img(`teams-${c}`, th, ' TEAMS'));
        await p.waitForTimeout(300);
        const r = await t.boundingBox();
        await p.screenshot({ path: `${out}/teams-${c}-${th}-${tag}.png`, clip: { x: r.x - 120, y: r.y - 12, width: 300, height: r.height + 24 } });
      }
      log.push(`${tag} ${th} ok`);
      await ctx.close();
    }
  }
  return log.join('\n');
}
