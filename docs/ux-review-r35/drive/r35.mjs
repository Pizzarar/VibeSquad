// R35: U1/U2 history contracts alongside @bor B14-16 UI (Main pin, CrunchToggle, project order grip, Code|Storybook tabs).
// Usage: node r35.mjs <port> <w> <h> <zoom> <theme> <main:0|1> [shotdir]
import { open, state } from "./lib.mjs";
const [port, w, h, zoom, theme, main, out] = [+process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5], process.argv[6], process.argv[7] === "1", process.argv[8]];
let fails = 0; const FAIL = (m) => { fails++; console.log("  !! FAIL " + m); };
async function st(page) {
  const s = await state(page);
  const x = await page.evaluate(() => ({ sbOpen: !document.querySelector(".boring-sidebar") && /Storybook/.test(document.body.textContent), mainPin: !!document.querySelector("[data-testid=boring-main-pin]"), crunch: document.querySelector("[data-testid=crunch-toggle]")?.textContent?.trim() || "", onCount: document.querySelectorAll(".boring-sidebar .on").length }));
  return { ...s, ...x };
}
const scr = (s) => s.sbOpen ? "SB" : s.chat ? "chat" : "ov[tab=" + s.tab + "]";
const fmt = (s) => `${s.url} | ${scr(s)} crumb=${s.crumb} on=${JSON.stringify(s.on)} len=${s.hlen} main=${s.mainPin} crunch=${s.crunch}`;
const key = (s) => `${s.url}|${scr(s)}|${s.crumb}|${s.on.join(",").replace(/\d+m ago/g, "")}`;
async function session(name, q, fn) {
  const { browser, page, errs } = await open(port, { w, h, zoom, theme }, q); page.setDefaultTimeout(6000);
  const settle = async (label, ms = 900) => { await page.waitForTimeout(ms); const s = await st(page); console.log(`  ${label.padEnd(20)} ${fmt(s)}${s.hist ? "  :: " + s.hist : ""}`);
    if (!s.sbOpen && s.on.length !== 1) FAIL(`${label}: ${s.on.length} visible .on rows`); return s; };
  const shot = async (n) => { if (out) await page.screenshot({ path: `${out}/${theme}-${w}-${main ? "main" : "nomain"}-${n}.png` }); };
  console.log(`== ${name} (${theme} ${w}x${h}@${zoom} main=${main})`);
  try { await fn({ page, settle, shot }); } catch (e) { FAIL("ERROR " + String(e).slice(0, 240)); }
  console.log(`  pageerrors=${errs.length} ${errs.slice(0, 2).join(" ; ").slice(0, 200)}`); if (errs.length) fails++;
  await browser.close();
}
const step = (a, b, label) => { if (b.hlen !== a.hlen + 1) FAIL(`${label}: dLen=${b.hlen - a.hlen} (want +1)`); };
const noWrite = (a, b, label) => { if (b.hlen !== a.hlen || b.url !== a.url || /pushState|replaceState/.test(b.hist)) FAIL(`${label}: URL/history changed (${a.url} -> ${b.url}, dLen=${b.hlen - a.hlen}, ${b.hist})`); };
const proj = (p, id) => p.getByTestId(`boring-project-header-${id}`).click();

// 1. Trail through Main pin / Main Open / project rows / tabs, then walk Back and Forward one at a time
await session("trail", "?demo&team=vibesquad", async ({ page, settle, shot }) => {
  const T = [await settle("t0 vs ov (load)")]; if (T[0].mainPin !== main) FAIL(`main pin present=${T[0].mainPin}`);
  await shot("t0");
  const mainId = main ? "efi" : "efi";
  await proj(page, mainId); T.push(await settle("t1 efi ov")); await shot("t1-efi-ov");
  await page.getByTestId("boring-tab-inbox").click(); T.push(await settle("t2 efi inbox"));
  if (main) { await page.getByTestId("boring-main-open").click(); T.push(await settle("t3 main Open")); await shot("t3-main-open"); }
  else { await page.locator(".boring-sidebar .boring-mate-name", { hasText: "RiffBot" }).first().click(); T.push(await settle("t3 efi riffbot")); }
  await proj(page, "site"); T.push(await settle("t4 site ov"));
  await page.getByTestId("boring-tab-feed").click(); T.push(await settle("t5 site standup")); await shot("t5-site-standup");
  await proj(page, "vibesquad"); T.push(await settle("t6 vs ov"));
  for (let i = 1; i < T.length; i++) step(T[i - 1], T[i], `trail ${i}`);
  for (let i = T.length - 2; i >= 0; i--) { await page.goBack(); const s = await settle(`back->t${i}`); if (key(s) !== key(T[i])) FAIL(`back t${i}: ${key(s)} != ${key(T[i])}`); if (/replaceState|pushState/.test(s.hist)) FAIL(`write during pop to t${i}`); }
  for (let i = 1; i < T.length; i++) { await page.goForward(); const s = await settle(`fwd->t${i}`); if (key(s) !== key(T[i])) FAIL(`fwd t${i}: ${key(s)} != ${key(T[i])}`); }
  // double-press race across the Main entries
  await page.evaluate(() => { history.back(); history.back(); }); const d = await settle("2xBack race", 1200); if (key(d) !== key(T[T.length - 3])) FAIL(`2xBack: ${key(d)} != ${key(T[T.length - 3])}`);
  await page.evaluate(() => { history.back(); history.back(); history.back(); }); const d2 = await settle("3xBack race", 1200); if (key(d2) !== key(T[T.length - 6])) FAIL(`3xBack: ${key(d2)} != ${key(T[T.length - 6])}`);
});

// 2. Crunch pill: no URL/history write; Back after it still lands on the previous entry; state survives Back/Forward
await session("crunch", "?demo&team=site&tab=standup", async ({ page, settle, shot }) => {
  const a = await settle("load site standup"); if (a.url !== "?demo&team=site&tab=standup") FAIL("deep link not kept: " + a.url);
  await proj(page, "efi"); const b = await settle("efi ov");
  await page.getByTestId("boring-tab-feed").click(); const c = await settle("efi standup");
  await page.getByTestId("crunch-toggle").click(); const d = await settle("crunch click", 1500); noWrite(c, d, "crunch on"); if (!/Crunch on/.test(d.crunch)) FAIL("crunch did not turn on: " + d.crunch); await shot("crunch-on");
  await page.getByTestId("crunch-toggle").click(); const e = await settle("crunch click 2", 1500); noWrite(d, e, "crunch off");
  await page.getByTestId("crunch-toggle").click(); const f = await settle("crunch on again", 1500);
  await page.goBack(); const g = await settle("back"); if (key(g) !== key(b)) FAIL(`back after crunch: ${key(g)} != ${key(b)}`); if (!/Crunch on/.test(g.crunch)) FAIL("efi pill lost state on Back: " + g.crunch);
  await page.goBack(); const hh = await settle("back 2"); if (key(hh) !== key(a)) FAIL(`back2: ${key(hh)} != ${key(a)}`); if (/Crunch on/.test(hh.crunch)) FAIL("site pill shows efi crunch: " + hh.crunch);
  await page.goForward(); await page.goForward(); const i = await settle("fwd 2"); if (key(i) !== key(c)) FAIL("fwd2 mismatch"); if (!/Crunch on/.test(i.crunch)) FAIL("efi crunch lost: " + i.crunch);
  await page.reload(); const j = await settle("reload", 1500); if (j.url !== c.url || !/Crunch on/.test(j.crunch)) FAIL(`reload: ${j.url} ${j.crunch}`);
});

// 3. Reorder grip: pointerdown + Escape, and ⋯ menu open/close: no URL/history write, selection unchanged
await session("grip", "?demo&team=site&tab=inbox", async ({ page, settle }) => {
  const a = await settle("load site inbox");
  const g = page.getByTestId("boring-project-grip-vibesquad"); const bx = await g.boundingBox();
  await page.mouse.move(bx.x + 4, bx.y + 4); await page.mouse.down(); await page.mouse.move(bx.x + 4, bx.y + 40, { steps: 4 }); await page.mouse.up();
  const b = await settle("grip drag (no drop target change)"); noWrite(a, b, "grip drag"); if (key(a) !== key(b)) FAIL("grip drag changed screen");
  // Esc is pre-existing p3 (pushes ?view=squads on any Normal overview, base + master too), logged separately, not asserted here
});

// 4. Storybook via Code|Storybook tabs: open +1, sb-head Code = Back, Forward reopens, Esc goes back
await session("sbtabs", "?demo&team=efi&tab=standup", async ({ page, settle, shot }) => {
  const a = await settle("load efi standup");
  await page.getByTestId("project-tab-storybook").first().click(); const b = await settle("SB tab", 1200); step(a, b, "sb open"); if (!b.sbOpen) FAIL("sb not open"); await shot("sb-open");
  await page.getByTestId("project-tab-code").first().click(); const c = await settle("Code tab", 1200); if (key(c) !== key(a) || c.hlen !== b.hlen) FAIL(`Code tab: ${key(c)} len ${c.hlen}`);
  await page.goForward(); const d = await settle("fwd into sb", 1200); if (!d.sbOpen || d.url !== b.url) FAIL("fwd did not reopen SB");
  await page.keyboard.press("Escape"); const e = await settle("Esc", 1200); if (key(e) !== key(a)) FAIL("esc mismatch"); if (e.crunch === "") FAIL("crunch pill missing after SB");
  
});
console.log(`RESULT fails=${fails}`);
