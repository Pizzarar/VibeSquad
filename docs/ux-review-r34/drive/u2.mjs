// UX R34 independent U2 probe: fast double Back/Forward, stale ?sb= entries, pasted non-canonical URLs, gone-team slot/tab.
// THROTTLE=<n> env applies CDP CPU throttling to the double-press sessions after the trail is built.
// Usage: node u2.mjs <port> <w> <h> <zoom> <theme> [shotdir] [only]
import { open, state } from "./lib.mjs";
const [port, w, h, zoom, theme, out, only] = [+process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5], process.argv[6], process.argv[7], process.argv[8]];
const sb = ".boring-sidebar"; const base = `http://127.0.0.1:${port}/`;
async function st(page) {
  const s = await state(page);
  const x = await page.evaluate(() => {
    const t = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
    const card = document.querySelector("[data-testid=boring-empty-card]");
    return { card: card ? t(card).slice(0, 40) : "", sbOpen: !document.querySelector(".boring-sidebar") && !!document.body.textContent.match(/Storybook/), blank: location.href === "about:blank" };
  });
  return { ...s, ...x };
}
const scr = (s) => s.blank ? "BLANK" : s.sbOpen ? "SB" : s.chat ? "chat" : s.card ? "CARD[" + s.card + "]" : "ov[tab=" + s.tab + "]";
const fmt = (s) => `${s.url} | ${scr(s)} crumb=${s.crumb} on=${JSON.stringify(s.on)} len=${s.hlen}`;
const key = (s) => `${s.url}|${scr(s)}|${s.crumb}|${s.on.join(",").replace(/\d+m ago/g, "")}`; // row ages tick during long runs
let fails = 0; const FAIL = (m) => { fails++; console.log("  !! FAIL " + m); };
async function session(name, start, fn) {
  if (only && !name.startsWith(only)) return;
  const { browser, page, errs } = await open(port, { w, h, zoom, theme }, start); page.setDefaultTimeout(6000);
  const settle = async (label, ms = 900) => { await page.waitForTimeout(ms); const s = await st(page); console.log(`  ${label.padEnd(16)} ${fmt(s)}${s.hist ? "  :: " + s.hist : ""}`);
    if (!s.blank && !s.sbOpen && s.on.length !== 1) FAIL(`${label}: ${s.on.length} .on rows`); return s; };
  const shot = async (n) => { if (out) await page.screenshot({ path: `${out}/${theme}-${w}-${n}.png` }); };
  console.log(`== ${name} (${theme} ${w}x${h}@${zoom})`);
  try { await fn({ page, settle, shot }); } catch (e) { FAIL("ERROR " + String(e).slice(0, 200)); }
  console.log(`  pageerrors=${errs.length} ${errs.slice(0, 2).join(" ; ").slice(0, 200)}`); if (errs.length) fails++;
  await browser.close();
}
const expand = async (p, team) => { const tg = p.getByTestId(`boring-project-toggle-${team}`); if ((await tg.getAttribute("aria-expanded")) !== "true") await tg.click(); await p.waitForTimeout(400); };
const mate = async (p, team, t) => { await expand(p, team); await p.locator(`${sb} [data-testid=boring-project-group-${team}] .boring-mate-name, ${sb} .boring-mate-name`, { hasText: t }).first().click(); };
const ctrlk = async (p, q) => { await p.keyboard.press("Control+k"); await p.waitForTimeout(400); await p.keyboard.type(q); await p.waitForTimeout(400); await p.keyboard.press("Enter"); };
const needs = (p, t) => p.locator(`${sb} .boring-needs-open`, { hasText: t }).first().click();
const projRow = (p, t) => p.locator(`${sb} .boring-project-row`, { hasText: t }).first().click();
const tab = (p, id) => p.getByTestId(`boring-tab-${id}`).click();
const sbBtn = (p) => p.getByRole("button", { name: "Storybook" }).first().click();

// Trail of 7 distinct screens across all entry kinds (chat, slot card, tab, project overview)
async function trail(page, settle) {
  const T = [];
  T.push(await settle("t0 vs ov"));
  await needs(page, "Audit - token scout"); T.push(await settle("t1 audit chat"));
  await mate(page, "efi", "Overlord"); T.push(await settle("t2 efi overlord"));
  await projRow(page, "Main Game Project"); T.push(await settle("t3 efi ov"));
  await tab(page, "feed"); T.push(await settle("t4 efi standup"));
  await ctrlk(page, "UI Lab"); T.push(await settle("t5 ctrlk UI Lab"));
  await projRow(page, "VibeSquad"); T.push(await settle("t6 vs ov"));
  await tab(page, "inbox"); T.push(await settle("t7 vs inbox"));
  for (let i = 1; i < T.length; i++) if (T[i].hlen !== T[i - 1].hlen + 1) FAIL(`trail step ${i} dLen=${T[i].hlen - T[i - 1].hlen}`);
  return T;
}
const same = (a, b) => key(a) === key(b);
async function presses(page, dir, n, gap) {
  const fn = dir < 0 ? "back" : "forward";
  if (gap === "kbd") { for (let i = 0; i < n; i++) await page.keyboard.press(dir < 0 ? "Alt+ArrowLeft" : "Alt+ArrowRight"); return; }
  await page.evaluate(async ([fn, n, gap]) => { for (let i = 0; i < n; i++) { history[fn](); if (gap) await new Promise((r) => setTimeout(r, gap)); } }, [fn, n, gap]);
}
// Walk every entry one at a time (slow) and compare with the trail: proves no entry was overwritten
async function walk(page, settle, T, from) {
  let i = from;
  while (i > 0) { await page.goBack(); i--; const s = await settle(`  walk back→t${i}`, 800); if (!same(s, T[i])) FAIL(`walk back t${i}: got ${key(s)} want ${key(T[i])}`); }
  while (i < T.length - 1) { await page.goForward(); i++; const s = await settle(`  walk fwd→t${i}`, 800); if (!same(s, T[i])) FAIL(`walk fwd t${i}: got ${key(s)} want ${key(T[i])}`); }
}
// Alt+Arrow is browser chrome, not delivered to a headless page: not usable here
for (const gap of [0, 40, 150, 400]) {
  await session(`double gap=${gap}`, "?demo=&team=vibesquad", async ({ page, settle, shot }) => {
    const T = await trail(page, settle); const L = T.length - 1;
    if (process.env.THROTTLE) { const c = await page.context().newCDPSession(page); await c.send("Emulation.setCPUThrottlingRate", { rate: +process.env.THROTTLE }); console.log(`  (CPU throttle x${process.env.THROTTLE})`); }
    // Double Back from t7 → t5, again → t3; double Forward → t5, again → t7
    let pos = L;
    for (const [dir, label] of [[-1, "2xBack"], [-1, "2xBack"], [1, "2xFwd"], [1, "2xFwd"], [-1, "2xBack"]]) {
      await presses(page, dir, 2, gap); pos += 2 * dir; const s = await settle(`${label}→t${pos}`, 1200);
      if (!same(s, T[pos])) FAIL(`${label}→t${pos}: got ${key(s)} want ${key(T[pos])}`);
      if (s.hlen !== T[L].hlen) FAIL(`history length changed ${s.hlen} vs ${T[L].hlen}`);
      if (gap === 0 && label === "2xBack" && pos === 3 && out) await shot(`double-back-t3`);
    }
    // triple Back too
    await presses(page, -1, 3, gap); pos -= 3; const s3 = await settle(`3xBack→t${pos}`, 1200); if (!same(s3, T[pos])) FAIL(`3xBack→t${pos}: got ${key(s3)} want ${key(T[pos])}`);
    await presses(page, 1, 3, gap); pos += 3; const s4 = await settle(`3xFwd→t${pos}`, 1200); if (!same(s4, T[pos])) FAIL(`3xFwd→t${pos}: got ${key(s4)} want ${key(T[pos])}`);
    await walk(page, settle, T, pos);
  });
}
// Back then immediate click (race: new push while pop settles) — the new push must land on top of the popped entry (t6), so Back = t6, Back×2 = t5
await session("back-then-click", "?demo=&team=vibesquad", async ({ page, settle }) => {
  const T = await trail(page, settle);
  await page.evaluate(() => history.back()); await projRow(page, "Main Game Project"); const s = await settle("back+efi row", 1200);
  if (new URLSearchParams(s.url).get("team") !== "efi" || s.chat) FAIL("back+row not on efi overview");
  await page.goBack(); const b = await settle("back", 1000); if (!same(b, T[6])) FAIL(`back after race: got ${key(b)} want t6 ${key(T[6])}`);
  await page.goBack(); const b2 = await settle("back2", 1000); if (!same(b2, T[5])) FAIL(`back2: want t5`);
});
// Storybook: open adds 1, Esc goes back; Back/Forward into the old sb entry reopens Storybook and Esc goes back
for (const [nm, start, pre] of [["sb-ov", "?demo=&team=vibesquad", null], ["sb-inbox", "?demo=&team=vibesquad", "inbox"], ["sb-chat", "?demo=&team=vibesquad", "chat"], ["sb-slot", "?demo=&team=efi&slot=overlord", null]]) {
  await session(nm, start, async ({ page, settle, shot }) => {
    if (pre === "inbox") await tab(page, "inbox"); if (pre === "chat") await needs(page, "Audit - token scout");
    const s0 = await settle("pre");
    await sbBtn(page); const s1 = await settle("open SB"); if (s1.hlen !== s0.hlen + 1 || !s1.sbOpen) FAIL(`open SB dLen=${s1.hlen - s0.hlen} sb=${s1.sbOpen}`);
    await page.keyboard.press("Escape"); const s2 = await settle("esc"); if (!same(s2, s0)) FAIL(`esc not back to pre: ${key(s2)}`);
    await page.goForward(); const s3 = await settle("fwd into old sb"); if (!s3.sbOpen) FAIL("fwd into sb entry did not reopen Storybook"); if (s3.url !== s1.url) FAIL("fwd sb url");
    if (out && nm === "sb-inbox") await shot("sb-fwd-reopen");
    await page.keyboard.press("Escape"); const s4 = await settle("esc"); if (!same(s4, s0)) FAIL(`esc #2 not back to pre: ${key(s4)}`);
    if (s4.hlen !== s1.hlen) FAIL("len changed");
    await page.goForward(); const s5 = await settle("fwd again"); if (!s5.sbOpen) FAIL("fwd#2 no SB");
    await page.goBack(); const s6 = await settle("browser back"); if (!same(s6, s0)) FAIL("browser back from SB");
    if (out && nm === "sb-inbox") await shot("sb-esc-after-fwd");
  });
}
// Stale sb entry deeper in history: open SB, Ctrl+K away (SB5), push 2 more, Back×N into it
await session("sb-stale-deep", "?demo=&team=vibesquad", async ({ page, settle, shot }) => {
  const s0 = await settle("vs ov");
  await sbBtn(page); const s1 = await settle("open SB");
  await page.keyboard.press("Escape"); await settle("esc");
  await needs(page, "Audit - token scout"); const s2 = await settle("audit chat (wipes fwd)");
  await sbBtn(page); const s3 = await settle("SB over chat");
  await page.goBack(); const s4 = await settle("browser back"); if (!same(s4, s2)) FAIL("back from SB-over-chat");
  await page.goBack(); const s5 = await settle("back2"); if (!same(s5, s0)) FAIL("back2 to vs ov");
  await page.goForward(); await settle("fwd"); await page.goForward(); const s7 = await settle("fwd2 → SB"); if (!s7.sbOpen) FAIL("fwd2 no SB");
  if (out) await shot("sb-stale-reopen");
  await page.keyboard.press("Escape"); const s8 = await settle("esc"); if (!same(s8, s2)) FAIL("esc to audit chat");
  await page.goBack(); const s9 = await settle("back"); if (!same(s9, s0)) FAIL("back after esc dead?");
});
// sb reached by fast double Forward / double Back across it
await session("sb-double", "?demo=&team=vibesquad", async ({ page, settle }) => {
  const s0 = await settle("vs ov");
  await needs(page, "Audit - token scout"); const s1 = await settle("chat");
  await sbBtn(page); await settle("SB"); await page.keyboard.press("Escape"); const s2 = await settle("esc");
  await page.evaluate(() => { history.back(); }); const s3 = await settle("back"); if (!same(s3, s0)) FAIL("back to vs ov");
  await presses(page, 1, 2, 0); const s4 = await settle("2xFwd → SB", 1200); if (!s4.sbOpen) FAIL("2xFwd not SB");
  await presses(page, -1, 2, 0); const s5 = await settle("2xBack → vs ov", 1200); if (!same(s5, s0)) FAIL(`2xBack over SB: ${key(s5)}`);
  await presses(page, 1, 1, 0); const s6 = await settle("fwd → chat"); if (!same(s6, s1)) FAIL("fwd chat");
});
// Pasted non-canonical / invalid URLs: no push on load; Back leaves the app (not dead); Forward returns the cleaned URL
for (const q of ["?demo=", "?demo=&team=nope", "?demo=&foo=1&team=vibesquad", "?demo=&team=vibesquad&view=bogus", "?demo=&team=vibesquad&tab=bogus", "?demo=&team=vibesquad&slot=bogus", "?demo=&team=vibesquad&tab=INBOX",
  "?demo=&team=gone&tab=inbox", "?demo=&team=gone&slot=overlord", "?demo=&slot=overlord", "?demo=&tab=inbox", "?demo=&team=efi&slot=overlord&agent=demo-aud", "?demo=&team=vibesquad&tab=inbox&tab=standup", "?demo=&tab=inbox&team=vibesquad", "?demo=&agent=demo-aud"]) {
  await session("paste " + q, q, async ({ page, settle }) => {
    const s0 = await settle("load"); if (s0.hlen !== 2) FAIL(`load pushed (len=${s0.hlen})`); if (/push/.test(s0.hist)) FAIL("pushState on load");
    if (/team=gone|team=nope|tab=bogus|slot=bogus|INBOX|view=bogus/.test(s0.url)) FAIL("bad key left in URL");
    await page.goBack(); const s1 = await settle("back"); if (!s1.blank) FAIL("Back stayed in app (dead press?)");
    await page.goForward(); await page.waitForSelector(sb, { timeout: 6000 }).catch(() => {}); const s2 = await settle("fwd"); if (s2.url !== s0.url || s2.crumb !== s0.crumb) FAIL(`fwd differs from cleaned load: ${key(s2)}`);
  });
}
// Gone team via Back: a gone-team URL pasted mid-session (new document entry), then navigate, then Back into it
for (const q of ["?demo=&team=gone&slot=overlord", "?demo=&team=gone&tab=inbox", "?demo=&team=gone&slot=riffbot&tab=standup"]) {
  await session("gone-back " + q, "?demo=&team=vibesquad&tab=standup", async ({ page, settle, shot }) => {
    const s0 = await settle("vs standup");
    await page.goto(base + q); await page.waitForSelector(sb).catch(() => {}); const s1 = await settle("paste gone");
    if (/slot=|tab=|team=gone/.test(s1.url) || s1.card || (s1.tab && !/Overview/.test(s1.tab))) FAIL("gone slot/tab applied on load");
    await needs(page, "Lead 75"); const s2 = await settle("needs Lead 75");
    await page.goBack(); const s3 = await settle("back → gone entry"); if (!same(s3, s1)) FAIL(`back into gone entry differs: ${key(s3)} vs ${key(s1)}`);
    if (/slot=overlord/.test(q) && out) await shot("gone-back");
    await page.goBack(); const s4 = await settle("back2 → vs standup"); if (!same(s4, s0)) FAIL(`back2: ${key(s4)}`);
    await page.goForward(); const s5 = await settle("fwd"); if (!same(s5, s1)) FAIL("fwd gone entry");
    await page.goForward(); const s6 = await settle("fwd2"); if (!same(s6, s2)) FAIL("fwd2");
  });
}
console.log(`fails=${fails}`);
