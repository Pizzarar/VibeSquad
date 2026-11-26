import { start, stop, openDesk, CFGS, SHOTS, resetBackend } from "./common.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
await start();
const out = {};
mkdirSync(SHOTS + "/logs", { recursive: true });
for (const cfg of CFGS) {
  resetBackend();
  const { context, page, errs } = await openDesk(cfg);
  await page.screenshot({ path: `${SHOTS}/r46-${cfg.name}-default.png`, scale: "css" });
  const info = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const bar = q('[data-testid="boring-decision-pills-on-hold"]')?.parentElement;
    const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
    const pills = [...document.querySelectorAll('[data-testid^="boring-decision-pill-"],[data-testid^="boring-decision-preset-"]')].map((el) => {
      const cs = getComputedStyle(el);
      return { id: el.dataset.testid, text: el.innerText, title: el.title, aria: el.getAttribute("aria-pressed"), label: el.getAttribute("aria-label"), rect: r(el), font: cs.fontSize, color: cs.color, bg: cs.backgroundColor, border: cs.borderTopStyle + " " + cs.borderTopColor, opacity: cs.opacity, tag: el.tagName, tabindex: el.tabIndex };
    });
    let anc = bar; const chain = [];
    for (let i = 0; i < 4 && anc; i++, anc = anc.parentElement) chain.push(anc.className + " " + (anc.dataset.testid || ""));
    return { barHTML: bar?.outerHTML.slice(0, 3000), chain, barRect: bar && r(bar), pills, summary: q('[data-testid="boring-decision-summary"]')?.textContent, url: location.search,
      headings: [...document.querySelectorAll("main h1, main h2, main h3, [class*=decision] h2, [class*=decision] h3")].slice(0, 20).map((h) => [h.tagName, h.innerText.slice(0, 80), r(h)]) };
  });
  info.errs = errs;
  out[cfg.name] = info;
  await context.close();
}
writeFileSync(SHOTS + "/logs/pass1.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify(out["dark-1920"], null, 1).slice(0, 6000));
await stop();
