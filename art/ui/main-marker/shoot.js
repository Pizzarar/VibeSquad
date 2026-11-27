// MM1 in-place review shots (DOM injection only, no src edit) on the real app, after the
// art/ui/bug-roach/shoot.js pattern. Placeholders __URIS__/__OUT__/__BASE__ are filled by
// art/ui/main-marker/shots.sh: the strips are inlined as data URIs so the shots always show this
// worktree's PNGs whatever checkout the server runs. Target = the Normal-mode active project row
// (.boring-project-line .boring-project-row.on, bg --surface-3; clones get .on even when no row is
// active). Three shallow clones of that row (same classes = same bg, text replaced so no live
// data shows): "Main project" + idle at 16 CSS px, idle/blink0/blink1 at 16, the same at 32
// (1x/2x image-set strip, background-size 300% 100%, pixelated). The tree's bottom fade mask is
// switched off and any open .modal-back (fresh-context token modal) removed, so nothing dims the
// clones. Writes
// scratch/shots/main-marker-<theme>-<4k120|1080>.png (clone crop only) and returns the bg per theme.
async (page) => {
  const U = __URIS__;
  const out = __OUT__;
  const base = __BASE__;
  const browser = page.context().browser();
  const log = [];
  const mk = (th, f, px) => `<span class="mm1" aria-hidden="true" style="width:${px}px;height:${px}px;flex:none;display:inline-block;align-self:center;image-rendering:pixelated;background-image:image-set(url('${U[th]}') 1x, url('${U[th + '2x']}') 2x);background-size:300% 100%;background-position:${f * 50}% 0;background-repeat:no-repeat"></span>`;
  const lab = (t, dim) => `<span${dim ? '' : ' class="boring-project-name"'} style="flex:none;align-self:center;white-space:nowrap;${dim ? 'color:var(--text-2, var(--muted));font-size:11px;min-width:3em' : ''}">${t}</span>`;
  for (const [tag, vp, dpr] of [['4k120', { width: 3200, height: 1800 }, 1.2], ['1080', { width: 1920, height: 1080 }, 1]]) {
    for (const th of ['dark', 'light']) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dpr, colorScheme: th });
      const p = await ctx.newPage();
      await p.goto(base + '/');
      await p.waitForSelector('.boring-project-row', { timeout: 20000 });
      await p.evaluate((t) => { document.documentElement.dataset.theme = t; }, th);
      await p.waitForTimeout(1500);
      const m = await p.evaluate(({ r0, r16, r32 }) => {
        const row = document.querySelector('.boring-project-line .boring-project-row.on') || document.querySelector('.boring-project-row');
        const host = row.closest('.boring-project-line') || row;
        const mkRow = (html) => { const r = row.cloneNode(false); r.classList.add('on'); r.removeAttribute('id'); r.style.display = 'flex'; r.style.justifyContent = 'flex-start'; r.style.gap = '10px'; r.style.alignItems = 'center'; r.innerHTML = html; const w = host.cloneNode(false); w.appendChild(r); return w; };
        document.querySelectorAll('.modal-back').forEach((e) => e.remove());
        for (let e = host; e; e = e.parentElement) { e.style.maskImage = 'none'; e.style.webkitMaskImage = 'none'; }
        const rows = [mkRow(r0), mkRow(r16), mkRow(r32)];
        let prev = host; for (const w of rows) { prev.after(w); prev = w; }
        const a = rows[0].getBoundingClientRect(), b = rows[2].getBoundingClientRect();
        const bgEl = rows[0].firstElementChild;
        return { theme: document.documentElement.dataset.theme, vibe: document.documentElement.dataset.vibe, bg: getComputedStyle(bgEl).backgroundColor,
                 clip: { x: Math.max(0, a.x - 4), y: a.y - 4, width: Math.max(a.width, b.width) + 8, height: b.bottom - a.y + 8 } };
      }, { r0: mk(th, 0, 16) + lab('Main project'), r16: lab('16px', 1) + mk(th, 0, 16) + mk(th, 1, 16) + mk(th, 2, 16),
           r32: lab('32px', 1) + mk(th, 0, 32) + mk(th, 1, 32) + mk(th, 2, 32) });
      await p.waitForTimeout(300);
      await p.screenshot({ path: `${out}/main-marker-${th}-${tag}.png`, clip: m.clip });
      log.push(`${tag} ${th} data-theme=${m.theme} vibe=${m.vibe} activeRowBg=${m.bg}`);
      await ctx.close();
    }
  }
  return log.join('\n');
}
