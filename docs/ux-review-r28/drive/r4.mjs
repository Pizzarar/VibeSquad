// R28 probe (B1 r4: App-owned popTarget cleared by first pointerdown/keydown): fast double Back, Storybook ?sb= round trip, keyboard-only nav after Back
import { open, state } from "./lib.mjs";
const [port, w, h, zoom, theme, out] = [+process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5], process.argv[6], process.argv[7]];
const { browser, page, errs } = await open(port, { w, h, zoom, theme }, "?demo=&team=vibesquad");
const tag = `${theme}-${w}`;
const step = async (n, shot) => { await page.waitForTimeout(700); const s = await state(page); if (shot && out) await page.screenshot({ path: `${out}/${tag}-r4-${n}.png` }); const sb = await page.evaluate(() => !!document.querySelector("[class*=storybook], .sb-root, .sb-view")); const inv = sb || (s.on.length === 1 && (s.chat ? /agent=/.test(s.url) : !/agent=/.test(s.url))); console.log(`${n.padEnd(16)} ${s.url.padEnd(46)} ${sb ? "SB" : s.chat ? "chat" : "ov"}:${sb ? "" : s.crumb} on=${s.on.length} inv=${inv} len=${s.hlen} :: ${s.hist}`); return s; };
const needs = (t) => page.locator(".boring-sidebar .boring-needs-open", { hasText: t }).first().click();
const palette = async (q) => { await page.keyboard.press("Control+k"); await page.waitForTimeout(400); await page.keyboard.type(q); await page.waitForTimeout(400); await page.keyboard.press("Enter"); };
// E: fast double Back (no wait), then Forward x2, then click
await needs("Audit - token scout"); await step("E-1aud");
await needs("Review - Sonnet"); await step("E-2rev");
await page.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).first().click(); await step("E-3efi");
await page.evaluate(() => { history.back(); history.back(); }); await step("E-back2x(js)", true);
await page.goForward(); await step("E-fwd1");
await page.goForward(); await step("E-fwd2");
await page.goBack(); await page.goBack(); await step("E-back2x(pw)", true);
await needs("Review - Gemini"); await step("E-click", true);
await page.goForward(); await step("E-fwd(none)");
await page.goBack(); await step("E-back");
// F: Storybook. open via project ⋯ menu (pushes ?sb=), Back out, Forward into ?sb=, Back to Normal and click; also nav straight from SB
await page.locator('[data-testid="boring-project-menu-vibesquad"]').click({ force: true }); await page.waitForTimeout(300);
await page.locator('[data-testid="custom-context-menu"] >> text=Open Storybook').click(); await step("F-sb-open", true);
await page.goBack(); await step("F-back(normal)", true);
await page.goForward(); await step("F-fwd(sb)", true);
await page.goBack(); await step("F-back2(normal)");
await needs("Audit - token scout"); await step("F-click(push?)", true);
await page.goBack(); await step("F-back3");
await page.goForward(); await step("F-fwd3");
// F2: Back INTO sb (no input), then keyboard palette nav from inside Storybook
await page.locator('[data-testid="boring-project-menu-vibesquad"]').click({ force: true }); await page.waitForTimeout(300);
await page.locator('[data-testid="custom-context-menu"] >> text=Open Storybook').click(); await step("F2-sb-open");
await needs("Review - Sonnet").catch(() => {}); await step("F2-nav-from-sb");
await page.goBack(); await step("F2-back(into sb?)", true);
await palette("UI Lab"); await step("F2-pal-from-sb", true);
await page.goBack(); await step("F2-back");
await page.goForward(); await step("F2-fwd(none?)");
// G: keyboard-only nav after Back
await needs("Audit - token scout"); await step("G-aud");
await palette("UI Bois"); await step("G-uibois");
await page.goBack(); await step("G-back");
await palette("UI Lab"); await step("G-kbd-pal(push)", true);
await page.goBack(); await step("G-back2");
await page.goForward(); await step("G-fwd");
await page.goBack(); await page.waitForTimeout(300);
await page.keyboard.press("Control+j"); await step("G-ctrlj(push)", true);
await page.goBack(); await step("G-back3");
console.log("pageerrors=" + errs.length + (errs.length ? " " + errs.join(" ; ") : ""));
await browser.close();
