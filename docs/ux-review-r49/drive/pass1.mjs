// R49 pass1: per config, measure the two C2 cards, Show source, keyboard, mixed ask.
import * as C from "./common.mjs";
import path from "node:path";
import { writeFileSync } from "node:fs";
const PF = "ny-00000000000000000013", SV = "ny-00000000000000000014", PARRY = "ny-00000000000000000006";
const out = {};
await C.start();
for (const cfg of C.CFGS) {
  const r = (out[cfg.name] = {});
  const { page, errs, context } = await C.open(cfg);
  await page.waitForSelector(`[data-testid="boring-decision-card-${PF}"]`, { timeout: 20000 });
  await page.waitForTimeout(500);
  const shot = (n, el) => (el ?? page).screenshot({ path: path.join(C.SHOTS, `r49-${cfg.name}-${n}.png`) });
  const measure = async (id) => page.evaluate((id) => {
    const card = document.querySelector(`[data-testid="boring-decision-card-${id}"]`);
    if (!card) return null;
    const alts = [...card.querySelectorAll(`[data-testid^="boring-decision-alt-${id}-"]`)].map((b) => {
      const cs = getComputedStyle(b); const lh = parseFloat(cs.lineHeight) || 18;
      return { text: b.innerText, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height), lines: Math.round((b.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / lh), clipped: b.scrollWidth > b.clientWidth + 1, ws: cs.whiteSpace, to: cs.textOverflow, fs: cs.fontSize, title: b.title, aria: b.getAttribute("aria-label"), pressed: b.getAttribute("aria-pressed") };
    });
    const tog = card.querySelector(`[data-testid="boring-decision-source-toggle-${id}"]`);
    const tcs = tog && getComputedStyle(tog);
    return { cardH: Math.round(card.getBoundingClientRect().height), cardW: Math.round(card.getBoundingClientRect().width), alts,
      toggle: tog && { text: tog.innerText, tag: tog.tagName, type: tog.type, expanded: tog.getAttribute("aria-expanded"), controls: tog.getAttribute("aria-controls"), fs: tcs.fontSize, color: tcs.color, h: Math.round(tog.getBoundingClientRect().height), w: Math.round(tog.getBoundingClientRect().width) },
      order: [...card.children].map((c) => (c.getAttribute("data-testid") || c.className).slice(0, 60)) };
  }, id);
  r.pf = await measure(PF); r.sv = await measure(SV); r.parry = await measure(PARRY);
  r.cardHeights = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="boring-decision-card-"]')].map((c) => [c.dataset.testid.slice(-2), Math.round(c.getBoundingClientRect().height)]));
  r.counts = await page.evaluate(() => ({ nav: document.querySelector('[data-testid="boring-decisions-nav-count"]')?.innerText, summary: document.body.innerText.match(/\d+ open[^\n]*/)?.[0] }));
  const pfCard = page.locator(`[data-testid="boring-decision-card-${PF}"]`);
  const svCard = page.locator(`[data-testid="boring-decision-card-${SV}"]`);
  await pfCard.scrollIntoViewIfNeeded();
  await shot("pf-closed", pfCard); await shot("sv-closed", svCard);
  // hover tooltip on option?
  // Show source via keyboard: focus toggle, press Enter
  const tog = page.locator(`[data-testid="boring-decision-source-toggle-${PF}"]`);
  await tog.focus();
  r.focusRing = await page.evaluate(() => { const a = document.activeElement; const cs = getComputedStyle(a); return { tag: a.tagName, outline: cs.outlineStyle + " " + cs.outlineWidth + " " + cs.outlineColor, boxShadow: cs.boxShadow }; });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const body = page.locator(`[data-testid="boring-decision-source-body-${PF}"]`);
  r.pfSource = await page.evaluate((id) => { const b = document.getElementById(`boring-decision-source-body-${id}`); if (!b) return null; const cs = getComputedStyle(b); return { role: b.getAttribute("role"), tabindex: b.getAttribute("tabindex"), aria: b.getAttribute("aria-label"), h: Math.round(b.getBoundingClientRect().height), scrollH: b.scrollHeight, overflowY: cs.overflowY, maxH: cs.maxHeight, ws: cs.whiteSpace, fs: cs.fontSize, ff: cs.fontFamily.slice(0, 40), color: cs.color, bg: cs.backgroundColor, text: b.innerText, expanded: document.querySelector(`[data-testid="boring-decision-source-toggle-${id}"]`).getAttribute("aria-expanded"), cardH: Math.round(document.querySelector(`[data-testid="boring-decision-card-${id}"]`).getBoundingClientRect().height) }; }, PF);
  await shot("pf-source-open", pfCard);
  // Space toggles closed
  await tog.focus(); await page.keyboard.press("Space"); await page.waitForTimeout(150);
  r.spaceCloses = (await body.count()) === 0;
  await tog.focus(); await page.keyboard.press("Space"); await page.waitForTimeout(150);
  // Tab order after toggle
  const tabSeq = [];
  for (let i = 0; i < 6; i++) { await page.keyboard.press("Tab"); tabSeq.push(await page.evaluate(() => (document.activeElement?.dataset?.testid || document.activeElement?.tagName) + "|" + (document.activeElement?.innerText || document.activeElement?.placeholder || "").slice(0, 30))); }
  r.tabSeq = tabSeq;
  // U11 source open
  await page.locator(`[data-testid="boring-decision-source-toggle-${SV}"]`).click(); await page.waitForTimeout(150);
  await svCard.scrollIntoViewIfNeeded();
  await shot("sv-source-open", svCard);
  r.svSource = await page.evaluate((id) => { const b = document.getElementById(`boring-decision-source-body-${id}`); return b && { h: Math.round(b.getBoundingClientRect().height), scrollH: b.scrollHeight, text: b.innerText }; }, SV);
  // Parry (inferred, no context)
  await page.locator(`[data-testid="boring-decision-source-toggle-${PARRY}"]`).click().catch(() => {}); await page.waitForTimeout(150);
  r.parrySource = await page.evaluate((id) => document.getElementById(`boring-decision-source-body-${id}`)?.innerText ?? null, PARRY);
  await shot("parry-source-open", page.locator(`[data-testid="boring-decision-card-${PARRY}"]`));
  // Mixed ask: pick B, type veto
  const send = page.locator('[data-testid="boring-decision-send-btn"]');
  r.sendBefore = await send.innerText();
  await page.locator(`[data-testid="boring-decision-alt-${PF}-1"]`).click();
  r.sendAfterB = await send.innerText();
  await page.locator(`[data-testid="boring-decision-input-${PF}"]`).fill("Yes, add the 30s veto window");
  r.sendAfterBType = await send.innerText();
  r.afterMixed = await measure(PF);
  r.inputVal = await page.locator(`[data-testid="boring-decision-input-${PF}"]`).inputValue();
  r.footer = await page.evaluate(() => document.querySelector('[data-testid="boring-decision-send-btn"]')?.closest("div")?.parentElement?.innerText);
  await pfCard.scrollIntoViewIfNeeded();
  await shot("pf-mixed", pfCard);
  await shot("page-mixed");
  // switch to C, then unpick C -> reply should survive
  await page.locator(`[data-testid="boring-decision-alt-${PF}-2"]`).click();
  r.afterSwitchC = { pressed: (await measure(PF)).alts.map((a) => a.pressed), input: await page.locator(`[data-testid="boring-decision-input-${PF}"]`).inputValue(), send: await send.innerText() };
  await page.locator(`[data-testid="boring-decision-alt-${PF}-2"]`).click();
  r.afterUnpick = { pressed: (await measure(PF)).alts.map((a) => a.pressed), input: await page.locator(`[data-testid="boring-decision-input-${PF}"]`).inputValue(), send: await send.innerText() };
  await page.locator(`[data-testid="boring-decision-alt-${PF}-1"]`).click();
  // Not that + text
  await page.locator(`[data-testid="boring-decision-not-${PF}"]`).click();
  r.afterNot = { pressed: (await measure(PF)).alts.map((a) => a.pressed), notPressed: await page.locator(`[data-testid="boring-decision-not-${PF}"]`).getAttribute("aria-pressed"), input: await page.locator(`[data-testid="boring-decision-input-${PF}"]`).inputValue(), send: await send.innerText() };
  await page.locator(`[data-testid="boring-decision-alt-${PF}-1"]`).click();
  // Send -> review step
  await send.click(); await page.waitForTimeout(400);
  r.review = await page.evaluate(() => { const n = document.querySelector('[data-testid="boring-decision-send-now-btn"]'); return n ? (n.closest('[role="dialog"]') || n.parentElement.parentElement).innerText.slice(0, 1500) : null; });
  await shot("send-review");
  r.errs = errs;
  await context.close();
}
await C.stop();
writeFileSync(path.join(C.SHOTS, "logs", "pass1.json"), JSON.stringify(out, null, 1));
console.log("ok");
