// R52 pass2 (idea-1121): staged answer in a hidden project. Send text names projects? pill marked (dot, aria, title)? Two hidden projects; unhide; asleep project.
import { start, stop, openDesk, CFGS, SHOTS, resetBackend } from "./common46.mjs";
import { writeFileSync } from "node:fs";
await start();
const out = {};
for (const cfg of CFGS) {
  resetBackend();
  const { context, page, errs } = await openDesk(cfg);
  const log = []; const T = (id) => page.locator(`[data-testid="${id}"]`);
  const snap = async (label, shot) => {
    const s = await page.evaluate(() => {
      const q = (s) => document.querySelector(s); const btn = q('[data-testid="boring-decision-send-btn"]');
      const bar = btn?.closest("div")?.parentElement;
      return {
        send: btn?.innerText, sendDisabled: btn?.disabled, sendTitle: btn?.title, sendAria: btn?.getAttribute("aria-label"),
        bar: bar?.innerText.replace(/\n/g, " | ").slice(0, 300),
        hiddenEls: [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && /hidden/i.test(e.textContent || "") && e.offsetParent).map((e) => ({ tag: e.tagName, text: e.textContent.trim().slice(0, 160), title: e.title || e.closest("[title]")?.title || "", tid: e.dataset.testid || e.parentElement?.dataset?.testid, color: getComputedStyle(e).color, fs: getComputedStyle(e).fontSize, w: Math.round(e.getBoundingClientRect().width), clipped: e.scrollWidth > e.clientWidth + 1 })),
        pills: [...document.querySelectorAll('[data-testid^="boring-decision-pill-"]:not([data-testid*="staged-dot"])')].map((p) => { const d = p.querySelector('[data-testid^="boring-decision-pill-staged-dot-"]'); return { id: p.dataset.testid.slice(21), pressed: p.getAttribute("aria-pressed"), aria: p.getAttribute("aria-label"), title: p.title, text: p.innerText.replace(/\n/g, " "), dot: d ? { title: d.title || d.getAttribute("aria-label") || "", ariaHidden: d.getAttribute("aria-hidden"), w: Math.round(d.getBoundingClientRect().width), bg: getComputedStyle(d).backgroundColor } : null }; }),
      };
    });
    log.push({ label, ...s });
    if (shot) await page.screenshot({ path: `${SHOTS}/r52-${cfg.name}-${shot}.png`, scale: "css", clip: { x: 0, y: 0, width: cfg.width, height: Math.min(cfg.height, 1080) } });
  };
  await snap("default");
  await T("boring-decision-lean-ny-f1-01").click();
  await snap("staged vs");
  await T("boring-decision-pill-vibesquad").click();
  await snap("vs hidden", "staged-hidden");
  // pill hover tooltip shot
  await T("boring-decision-pill-vibesquad").hover(); await page.waitForTimeout(900);
  await page.locator('[data-testid="boring-decision-pills-awake"]').screenshot({ path: `${SHOTS}/r52-${cfg.name}-pills-hidden.png` }).catch(() => {});
  await page.locator('[data-testid="boring-decision-send-btn"]').evaluate((b) => b.closest("div").parentElement.scrollIntoView({ block: "center" }));
  await page.locator('[data-testid="boring-decision-send-btn"]').evaluate((b) => b.closest("div").parentElement).then(() => {});
  await page.locator('[data-testid="boring-decision-send-btn"]').locator("xpath=../..").screenshot({ path: `${SHOTS}/r52-${cfg.name}-bar-hidden1.png` }).catch(() => {});
  await page.locator('[data-testid="boring-decision-squad-site"] input, [data-testid="boring-decision-squad-site"] textarea').first().fill("3600");
  await T("boring-decision-pill-site").click();
  await snap("vs + site staged, both hidden", "staged-hidden2");
  await page.locator('[data-testid="boring-decision-send-btn"]').locator("xpath=../..").screenshot({ path: `${SHOTS}/r52-${cfg.name}-bar-hidden2.png` }).catch(() => {});
  await T("boring-decision-pill-vibesquad").click();
  await snap("vs back, site hidden");
  await T("boring-decision-pill-site").click();
  await snap("all back");
  log.errs = errs; out[cfg.name] = log;
  await context.close();
}
writeFileSync(`${SHOTS}/logs/pass2.json`, JSON.stringify(out, null, 1));
await stop(); console.log("ok");
