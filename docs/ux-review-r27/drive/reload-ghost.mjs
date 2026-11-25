// R27 probe: what a fresh load of a gone-team URL shows (fallback reference for the Back-onto-gone-team case)
import { open, state } from "./lib.mjs";
const port = +process.argv[2];
for (const q of ["?demo=&team=ghostteam", "?demo=&team=ghostteam&agent=demo-aud"]) {
  const { browser, page } = await open(port, { w: 1920, h: 1080, theme: "dark" }, q);
  const s = await state(page); console.log(`${q.padEnd(40)} -> ${s.url.padEnd(40)} ${s.chat ? "chat" : "ov"}:${s.crumb} len=${s.hlen} :: ${s.hist}`);
  await browser.close();
}
