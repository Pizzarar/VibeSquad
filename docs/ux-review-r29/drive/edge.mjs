// R27 probe: Back onto a gone team / unknown agent then click (must push); a click fired right after Back (no settle wait)
import { open, state } from "./lib.mjs";
const [port, w, h, zoom, theme, out] = [+process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5], process.argv[6], process.argv[7]];
const { browser, page, errs } = await open(port, { w, h, zoom, theme }, "?demo=&team=vibesquad");
const tag = `${theme}-${w}`;
const step = async (n, shot) => { await page.waitForTimeout(700); const s = await state(page); if (shot && out) await page.screenshot({ path: `${out}/${tag}-edge-${n}.png` }); const inv = s.on.length === 1 && (s.chat ? /agent=/.test(s.url) : !/agent=/.test(s.url)); console.log(`${n.padEnd(14)} ${s.url.padEnd(42)} ${s.chat ? "chat" : "ov"}:${s.crumb} on=${s.on.length} inv=${inv} len=${s.hlen} :: ${s.hist}`); return s; };
const needs = (t) => page.locator(".boring-sidebar .boring-needs-open", { hasText: t }).first().click();
// A: gone team. Plant a real history entry for a team that no longer exists, then a real entry matching the screen, then Back onto it.
await page.evaluate(() => { history.pushState(null, "", "?demo=&team=ghostteam"); history.pushState(null, "", "?demo=&team=vibesquad"); }); await step("plant-ghost");
await needs("Audit - token scout"); await step("A-chat");
await page.goBack(); await step("A-back1");
await page.goBack(); await step("A-back(ghost)", true);
await needs("Review - Sonnet"); await step("A-click", true);
await page.goForward(); await step("A-fwd(none)");
await page.goBack(); await step("A-back2");
// B: unknown agent in a known team, same shape
await page.evaluate(() => { history.pushState(null, "", "?demo=&team=vibesquad&agent=demo-gone-agent"); history.pushState(null, "", "?demo=&team=vibesquad"); }); await step("plant-unk");
await needs("Audit - token scout"); await step("B-chat");
await page.goBack(); await step("B-back1");
await page.goBack(); await step("B-back(unk)", true);
await page.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).first().click(); await step("B-click", true);
await page.goForward(); await step("B-fwd(none)");
await page.goBack(); await step("B-back2");
// C: click right after Back (same tick, no settle wait)
await needs("Audit - token scout"); await step("C-chat");
await page.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).first().click(); await step("C-proj");
await page.goBack(); await step("C-back");
await page.goForward(); await step("C-fwd");
await page.evaluate(() => { history.back(); }); await needs("Review - Gemini"); await step("C-back+click0", true);
await page.goBack(); await step("C-back-after", true);
// D: click 50ms after Back
await page.evaluate(() => history.back()); await page.waitForTimeout(50); await needs("Review - Sonnet"); await step("D-back+click50", true);
await page.goBack(); await step("D-back-after");
console.log("pageerrors=" + errs.length);
await browser.close();
