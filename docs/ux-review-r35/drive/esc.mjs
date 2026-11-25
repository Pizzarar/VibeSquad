// R35: does a bare Escape (no drag) on a Normal Overview push ?view=squads? And grip press without Esc.
import { open, state } from "./lib.mjs";
const [port, mode] = [+process.argv[2], process.argv[3]];
for (const q of ["?demo&team=site&tab=inbox", "?demo&team=site", "?demo&team=efi&agent=demo-lead-efi"]) {
  const { browser, page } = await open(port, { w: 1920, h: 1080 }, q);
  const a = await state(page);
  if (mode === "grip") { const g = page.getByTestId("boring-project-grip-vibesquad"); const bx = await g.boundingBox(); await page.mouse.move(bx.x + 4, bx.y + 4); await page.mouse.down(); await page.mouse.move(bx.x + 4, bx.y + 40, { steps: 4 }); await page.mouse.up(); }
  else if (mode === "gripesc") { const g = page.getByTestId("boring-project-grip-vibesquad"); const bx = await g.boundingBox(); await page.mouse.move(bx.x + 4, bx.y + 4); await page.mouse.down(); await page.keyboard.press("Escape"); await page.mouse.up(); }
  else if (mode === "click-esc") { await page.locator(".boring-main").first().click({ position: { x: 5, y: 5 } }).catch(()=>{}); await page.keyboard.press("Escape"); }
  else await page.keyboard.press("Escape");
  await page.waitForTimeout(900); const b = await state(page);
  console.log(`${mode} ${q}: ${a.url} len=${a.hlen} -> ${b.url} len=${b.hlen} :: ${b.hist} | crumb ${a.crumb} -> ${b.crumb}`);
  if (b.hlen > a.hlen) { await page.goBack(); await page.waitForTimeout(800); const c = await state(page); console.log(`   back -> ${c.url} crumb=${c.crumb} on=${JSON.stringify(c.on)} :: ${c.hist}`); }
  await browser.close();
}
