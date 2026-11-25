// UX R34: a history entry whose ?team= is gone (project removed after the entry was made), reached by Back/Forward.
// The entry is planted with history.pushState (no app navigation), then the user navigates on; Back pops into it.
// Usage: node gonepop.mjs <port> <w> <h> <zoom> <theme> [shotdir]
import { open, state } from "./lib.mjs";
const [port, w, h, zoom, theme, out] = [+process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5], process.argv[6], process.argv[7]];
const sb = ".boring-sidebar"; let fails = 0; const FAIL = (m) => { fails++; console.log("  !! FAIL " + m); };
const fmt = (s) => `${s.url} | ${s.card ? "CARD[" + s.card + "]" : s.chat ? "chat" : "ov[" + s.tab + "]"} crumb=${s.crumb} on=${s.on.length} len=${s.hlen}`;
for (const q of ["?demo=&team=gone&slot=overlord", "?demo=&team=gone&tab=inbox", "?demo=&team=gone&slot=bugs&tab=standup", "?demo=&team=gone&agent=demo-aud"]) {
  for (const start of ["?demo=&team=efi&tab=standup", "?demo=&team=vibesquad"]) {
    const { browser, page, errs } = await open(port, { w, h, zoom, theme }, start); page.setDefaultTimeout(6000);
    const settle = async (l) => { await page.waitForTimeout(900); const s = await state(page); s.card = await page.evaluate(() => (document.querySelector("[data-testid=boring-empty-card]")?.textContent || "").slice(0, 40)); console.log(`  ${l.padEnd(16)} ${fmt(s)}${s.hist ? "  :: " + s.hist : ""}`); if (s.on.length !== 1) FAIL(l + " on=" + s.on.length); return s; };
    console.log(`== plant ${q} on ${start} (${theme} ${w}@${zoom})`);
    try {
      const s0 = await settle("start");
      await page.evaluate((q) => history.pushState(null, "", location.pathname + q), q); await page.waitForTimeout(200);
      await page.locator(`${sb} .boring-needs-open`, { hasText: "Lead 75" }).first().click(); const s1 = await settle("needs Lead 75");
      await page.goBack(); const s2 = await settle("back → gone");
      const p = new URLSearchParams(s2.url);
      if (p.get("team") === "gone") FAIL("URL still names the gone team");
      if (!/agent=/.test(q) && (p.get("slot") || p.get("tab") || s2.card || s2.chat || !/Overview/.test(s2.tab))) FAIL("gone slot/tab applied, or not a plain Overview");
      if (out && q.includes("slot=overlord") && start.includes("efi")) await page.screenshot({ path: `${out}/${theme}-${w}-gonepop-back.png` });
      await page.goBack(); const s3 = await settle("back2"); if (s3.url !== s0.url || s3.crumb !== s0.crumb) FAIL("back2 not start (dead or wrong)");
      await page.goForward(); const s4 = await settle("fwd"); if (s4.url !== s2.url) FAIL("fwd differs from healed entry");
      await page.goForward(); const s5 = await settle("fwd2"); if (s5.url !== s1.url) FAIL("fwd2");
    } catch (e) { FAIL("ERROR " + String(e).slice(0, 200)); }
    console.log(`  pageerrors=${errs.length}`); if (errs.length) fails++; await browser.close();
  }
}
console.log(`fails=${fails}`);
