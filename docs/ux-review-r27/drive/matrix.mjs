import fs from "node:fs";
import { open, state } from "./lib.mjs";
const [port, label, w, h, zoom, theme, outDir] = [+process.argv[2], process.argv[3], +process.argv[4], +process.argv[5], +process.argv[6], process.argv[7], process.argv[8]];
fs.mkdirSync(outDir, { recursive: true });
const tag = `${theme}-${label}`; const rows = []; let n = 0;
const { browser, page, errs } = await open(port, { w, h, zoom, theme }, "?demo=&team=vibesquad");
const st = async () => { try { return await state(page); } catch { return { url: "(left app)", on: [], crumb: "", chat: false, tab: "", head: "", hist: "", hlen: 0 }; } };
async function step(name, expect, shot = true) {
  await page.waitForTimeout(700);
  const s = await st(); const file = `${tag}-${String(++n).padStart(2, "0")}-${name}.png`;
  if (shot && s.url !== "(left app)") await page.screenshot({ path: `${outDir}/${file}` });
  const screen = s.chat ? `chat:${s.crumb}` : `ov:${s.crumb}`;
  const urlAgrees = s.chat ? /agent=/.test(s.url) : !/agent=/.test(s.url);
  const ok = expect ? expect(s) : null;
  const inv = s.on.length === 1 && urlAgrees;
  rows.push({ name, file, url: s.url, screen, on: s.on, ok, inv, hlen: s.hlen, hist: s.hist });
  console.log(`${name.padEnd(16)} ${String(ok).padEnd(5)} inv=${inv} ${s.url.padEnd(38)} ${screen} on=${s.on.length} len=${s.hlen} :: ${s.hist}`);
  return s;
}
const isChat = (a) => (s) => s.chat && s.url.includes(`agent=${a}`);
const isOv = (t) => (s) => !s.chat && s.url.endsWith(`team=${t}`) && s.on[0]?.startsWith("boring-project-row");
const aud = async () => { await page.locator(".boring-sidebar .boring-needs-open", { hasText: "Audit - token scout" }).first().click(); };
await step("start", isOv("vibesquad"));
await aud(); await step("chat", isChat("demo-aud"));
// F1 Open in Inbox
await page.locator(".tl-ref-link", { hasText: /^idea-/ }).first().hover(); await page.waitForTimeout(700);
await page.getByRole("button", { name: "Open in Inbox" }).first().click();
await step("f1-inbox", (s) => !s.chat && /Inbox/.test(s.tab));
await page.goBack(); await step("f1-back", isChat("demo-aud"));
await page.goForward(); await step("f1-fwd", (s) => !s.chat && /Inbox/.test(s.tab));
// F3 project row
await aud(); await step("chat2", isChat("demo-aud"));
await page.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).first().click();
await step("f3-proj", isOv("efi"));
await page.goBack(); await step("f3-back", isChat("demo-aud"));
await page.goForward(); await step("f3-fwd", isOv("efi"));
// F2 Ctrl+K
await aud(); await step("chat3", isChat("demo-aud"));
await page.keyboard.press("Control+k"); await page.waitForTimeout(400); await page.keyboard.type("UI Lab"); await page.waitForTimeout(400); await page.keyboard.press("Enter");
await step("f2-pick", isChat("demo-lead-ui"));
await page.goBack(); await step("f2-back", isChat("demo-aud"));
await page.goForward(); await step("f2-fwd", isChat("demo-lead-ui"));
await page.goBack(); await step("f2-back2", null, false);
await page.goBack(); await step("f2-back3", null);
await page.goBack(); await step("f2-back4", null, false);
// F4 Ctrl+K same-project pick (VibeSquad > UI Bois Lead)
await aud(); await step("chat4", isChat("demo-aud"));
await page.keyboard.press("Control+k"); await page.waitForTimeout(400); await page.keyboard.type("UI BOIS"); await page.waitForTimeout(400); await page.keyboard.press("Enter");
await step("f4-pick", isChat("demo-lead-ui-bois"));
await page.goBack(); await step("f4-back", isChat("demo-aud"));
await page.goForward(); await step("f4-fwd", isChat("demo-lead-ui-bois"));
// F5 after Back/Forward, a fresh click must push (pop flag cleared), and Forward is cut normally
await page.goBack(); await step("f5-back", isChat("demo-aud"), false);
await page.locator(".boring-sidebar .boring-project-row", { hasText: "Main Game Project" }).first().click();
await step("f5-click", (s) => isOv("efi")(s) && /pushState/.test(s.hist), false);
await page.goBack(); await step("f5-back2", isChat("demo-aud"), false);
// F6 rapid double Back (no settle between presses), then double Forward
await page.evaluate(() => { history.back(); setTimeout(() => history.back(), 30); });
await step("f6-back2x", null);
await page.evaluate(() => { history.forward(); setTimeout(() => history.forward(), 30); });
await step("f6-fwd2x", null);
await aud(); await step("f6-click", (s) => isChat("demo-aud")(s) || /pushState/.test(s.hist), false);
// reload each distinct visited URL
const seen = [...new Map(rows.filter(r => r.url.startsWith("?")).map(r => [r.url, r])).values()];
for (const r of seen) {
  await page.goto(`http://127.0.0.1:${port}/${r.url}`); await page.waitForSelector(".boring-sidebar"); await page.waitForTimeout(900);
  const s = await st(); const screen = s.chat ? `chat:${s.crumb}` : `ov:${s.crumb}`;
  console.log(`reload ${r.url.padEnd(38)} ${screen === r.screen ? "same" : "DIFF"} ${screen} (live: ${r.screen}) tab="${s.tab}" on=${s.on.length}`);
}
console.log(`pageerrors=${errs.length}`);
fs.writeFileSync(`${outDir}/${tag}.json`, JSON.stringify(rows, null, 1));
await browser.close();
