import { open, state } from "./lib.mjs";
const port = +process.argv[2];
for (const q of ["?demo=&team=vibesquad", "?demo=&team=vibesquad&tab=inbox", "?demo=&team=vibesquad&tab=standup", "?demo=&team=efi&slot=overlord", "?demo=&team=efi&slot=riffbot", "?demo=&team=vibesquad&slot=bugs", "?demo=&team=efi&agent=demo-lead-ui"]) {
  const { browser, page } = await open(port, { w: 1920, h: 1080, theme: "dark" }, q); await page.waitForTimeout(800);
  const s = await state(page); console.log(`${q.padEnd(40)} -> ${s.url} len=${s.hlen} ${s.hist}`); await browser.close();
}
