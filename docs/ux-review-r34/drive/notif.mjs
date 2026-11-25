// UX R34: notification-click route (service-worker "vs:select-agent" message) adds exactly +1, including while a pop is active.
// Usage: node notif.mjs <port> <w> <h> <zoom> <theme>
import { open, state } from "./lib.mjs";
const [port, w, h, zoom, theme] = [+process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5], process.argv[6]];
const sb = ".boring-sidebar"; let fails = 0; const FAIL = (m) => { fails++; console.log("  !! FAIL " + m); };
const fmt = (s) => `${s.url} | ${s.chat ? "chat" : "ov[" + s.tab + "]"} crumb=${s.crumb} on=${s.on.length} len=${s.hlen}`;
const notif = (p, id) => p.evaluate((id) => window.postMessage({ type: "vs:select-agent", agentId: id }, "*"), id);
async function session(name, start, fn) {
  const { browser, page, errs } = await open(port, { w, h, zoom, theme }, start); page.setDefaultTimeout(6000);
  const settle = async (l) => { await page.waitForTimeout(900); const s = await state(page); console.log(`  ${l.padEnd(18)} ${fmt(s)}${s.hist ? "  :: " + s.hist : ""}`); if (s.on.length !== 1) FAIL(l + " on=" + s.on.length); return s; };
  console.log(`== ${name} (${theme} ${w}@${zoom})`);
  try { await fn({ page, settle }); } catch (e) { FAIL("ERROR " + String(e).slice(0, 200)); }
  console.log(`  pageerrors=${errs.length}`); if (errs.length) fails++; await browser.close();
}
const needs = (p, t) => p.locator(`${sb} .boring-needs-open`, { hasText: t }).first().click();
// a. from a chat in A, notification for an agent in B
await session("notif from chat", "?demo=&team=vibesquad", async ({ page, settle }) => {
  await needs(page, "Audit - token scout"); const s0 = await settle("audit chat");
  await notif(page, "demo-lead-ui"); const s1 = await settle("notif UI Lab"); if (s1.hlen !== s0.hlen + 1 || !/agent=demo-lead-ui/.test(s1.url)) FAIL("notif dLen/url");
  await page.goBack(); const s2 = await settle("back"); if (s2.url !== s0.url) FAIL("back");
  await page.goForward(); const s3 = await settle("fwd"); if (s3.url !== s1.url) FAIL("fwd");
});
// b. on a cold load (load counts as a landing: pop armed, no input yet), notification must push, not replace
await session("notif on cold load", "?demo=&team=vibesquad&tab=inbox", async ({ page, settle }) => {
  const s0 = await settle("cold vs inbox");
  await notif(page, "demo-lead-ui"); const s1 = await settle("notif UI Lab"); if (s1.hlen !== s0.hlen + 1) FAIL("cold notif replaced the loaded entry (dLen=" + (s1.hlen - s0.hlen) + ")");
  await page.goBack(); const s2 = await settle("back"); if (s2.url !== s0.url) FAIL("back to cold entry");
});
// c. right after a Back (pop active, no input), notification must push on top of the popped entry
await session("notif after back", "?demo=&team=vibesquad", async ({ page, settle }) => {
  await needs(page, "Audit - token scout"); const s0 = await settle("audit chat");
  await needs(page, "Lead 75"); const s1 = await settle("Lead 75");
  await page.evaluate(() => history.back()); const s2 = await settle("back (pop)");
  await notif(page, "demo-lead-ui"); const s3 = await settle("notif UI Lab"); if (!/agent=demo-lead-ui/.test(s3.url)) FAIL("notif url");
  await page.goBack(); const s4 = await settle("back"); if (s4.url !== s0.url) FAIL("popped entry overwritten: back=" + s4.url);
  await page.goBack(); const s5 = await settle("back2"); if (!/team=vibesquad$/.test(s5.url)) FAIL("back2");
});
console.log(`fails=${fails}`);
