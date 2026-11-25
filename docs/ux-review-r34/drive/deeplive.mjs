// R34 live deep-link check: cold-load deep links to a non-first project's agent / slot / tab against the live server
// (via live.mjs), watch every URL write until data lands, then reload. Usage: node deeplive.mjs <port> <w> <h> <zoom> <theme> [shotdir] [tag]
import { open, state } from "../../ux-review-r33/drive/lib.mjs";
const [port, w, h, zoom, theme, out, tag] = [+process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5], process.argv[6], process.argv[7], process.argv[8] || ""];
const LINKS = [
  "?team=team-forgewirk&agent=rn-7527ce836fe2",
  "?team=site&agent=rn-8b756e01c830",
  "?agent=rn-7527ce836fe2",
  "?team=team-forgewirk&slot=riffbot",
  "?team=site&slot=overlord",
  "?team=site&tab=inbox",
  "?team=team-forgewirk&tab=standup",
];
const fmt = (s) => `${s.url} | ${s.chat ? "chat" : "ov[tab=" + s.tab + "]"} crumb=${s.crumb} on=${JSON.stringify(s.on)} len=${s.hlen}`;
const keep = (want, got) => [...new URLSearchParams(want)].every(([k, v]) => new URLSearchParams(got).get(k) === v);
let lost = 0;
for (const [i, q] of LINKS.entries()) {
  const { browser, page, errs } = await open(port, { w, h, zoom, theme }, q);
  const seen = [];
  for (let t = 0; t < 80; t++) { const u = await page.evaluate(() => location.search); if (seen.at(-1) !== u) seen.push(u); await page.waitForTimeout(100); }
  const s1 = await state(page);
  const first = await page.evaluate(() => (document.querySelector(".boring-sidebar .boring-project-row")?.textContent || "").trim().slice(0, 30));
  if (out) await page.screenshot({ path: `${out}/${tag}${theme}-${w}-live-${i}.png` });
  await page.reload(); await page.waitForTimeout(8000);
  const s2 = await state(page);
  const ok1 = keep(q, s1.url), ok2 = keep(q, s2.url); if (!ok1 || !ok2) lost++;
  console.log(`== ${q} (${theme} ${w}x${h}@${zoom}) firstProject=${first}`);
  console.log(`  urls seen     ${seen.join(" -> ")}`);
  console.log(`  load  ${ok1 ? "KEPT" : "LOST"} ${fmt(s1)}  :: ${s1.hist}`);
  console.log(`  reload ${ok2 ? "KEPT" : "LOST"} ${fmt(s2)}  :: ${s2.hist}`);
  console.log(`  pageerrors=${errs.length} ${errs.slice(0, 2).join(" ; ").slice(0, 200)}`);
  await browser.close();
}
console.log(`LOST=${lost}/${LINKS.length}`);
