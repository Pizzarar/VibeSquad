// UX R31 independent B2 probe: from a chat in project A, cross-project nav by each route; history delta, pushes, mixed entries,
// Back/Back#2/Forward, and reload of every visited URL. Usage: node b2.mjs <port> <w> <h> <zoom> <theme> <dir: fwd|rev> [shotdir]
import { open, state } from "./lib.mjs";
const [port, w, h, zoom, theme, dir, out] = [+process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5], process.argv[6], process.argv[7], process.argv[8]];
const sb = ".boring-sidebar";
const needs = (p, t) => p.locator(`${sb} .boring-needs-open`, { hasText: t }).first().click();
const ctrlk = async (p, t) => { await p.keyboard.press("Control+k"); await p.waitForTimeout(400); await p.keyboard.type(t); await p.waitForTimeout(400); await p.keyboard.press("Enter"); };
const projRow = (p, t) => p.locator(`${sb} .boring-project-row`, { hasText: t }).first().click();
const projBadge = (p, t) => p.locator(`${sb} .boring-project-row`, { hasText: t }).first().locator(".boring-badge").click();
const expandThen = async (p, team, rowSel, t) => { const tg = p.getByTestId(`boring-project-toggle-${team}`); if ((await tg.getAttribute("aria-expanded")) !== "true") await tg.click(); await p.waitForTimeout(400); await p.locator(`${sb} ${rowSel}`, { hasText: t }).first().click(); };
const CFG = {
  fwd: { start: "?demo=&team=vibesquad", enter: (p) => needs(p, "Audit - token scout"), A: "vibesquad", B: "efi",
    routes: { "ctrlk": (p) => ctrlk(p, "UI Lab"), "needs-row": (p) => needs(p, "Lead 75"), "proj-badge(pill)": (p) => projBadge(p, "Main Game Project"),
      "sidebar-row": (p) => expandThen(p, "efi", ".boring-conv-row", "UI"), "sidebar-mate": (p) => expandThen(p, "efi", ".boring-mate-name", "Overlord"), "proj-row": (p) => projRow(p, "Main Game Project") } },
  rev: { start: "?demo=&team=efi", enter: (p) => needs(p, "Lead 75"), A: "efi", B: "vibesquad",
    routes: { "ctrlk": (p) => ctrlk(p, "Audit - token scout"), "needs-row": (p) => needs(p, "Review - Sonnet"), "proj-badge(pill)": (p) => projBadge(p, "VibeSquad"),
      "sidebar-row": (p) => expandThen(p, "vibesquad", ".boring-worker-row", "Review - Gemini"), "proj-row": (p) => projRow(p, "Site") } },
}[dir];
const q = (u) => new URLSearchParams(u);
const fmt = (s) => `${s.url} ${s.chat ? "chat" : "ov"}:${s.crumb} on=${s.on.length}`;
const inv = (s) => s.on.length === 1 && (s.chat ? /agent=/.test(s.url) : !/agent=/.test(s.url));
let fails = 0;
for (const [name, act] of Object.entries(CFG.routes)) {
  const { browser, page, errs } = await open(port, { w, h, zoom, theme }, CFG.start);
  const settle = async () => { await page.waitForTimeout(700); return state(page); };
  await CFG.enter(page); const s0 = await settle();
  const startAgent = q(s0.url).get("agent");
  await act(page); const s1 = await settle();
  const pushes = s1.hist.split(" | ").filter((x) => x.startsWith("pushState")).map((x) => x.slice(10));
  const mixed = pushes.filter((u) => q(u).get("team") === CFG.B && q(u).get("agent") === startAgent);
  if (out && ["ctrlk", "needs-row", "proj-row"].includes(name)) await page.screenshot({ path: `${out}/${theme}-${w}-b2-${dir}-${name}-after.png` });
  await page.goBack(); const s2 = await settle();
  await page.goBack(); const s3 = await settle();
  await page.goForward(); const s4 = await settle();
  await page.goForward(); const s5 = await settle();
  // reload each visited URL fresh and compare screen
  const rl = [];
  for (const [label, ref] of [["start", s0], ["final", s1], ["back2", s3]]) { await page.goto(`http://127.0.0.1:${port}/${ref.url}`); await page.waitForSelector(".boring-sidebar"); const r = await settle(); rl.push(`${label}:${r.url === ref.url && r.crumb === ref.crumb && r.chat === ref.chat && r.on.length === 1 ? "ok" : "MISMATCH " + fmt(r) + " vs " + fmt(ref)}`); }
  const ok = { d1: s1.hlen - s0.hlen === 1 && pushes.length === 1, noMixed: mixed.length === 0, crossProj: q(s1.url).get("team") === CFG.B || name === "ctrlj",
    backToStart: s2.url === s0.url && s2.crumb === s0.crumb && s2.chat === s0.chat, back2Live: s3.url !== s2.url, fwdMirror: s4.url === s2.url ? false : true,
    fwd2Final: s5.url === s1.url && s5.crumb === s1.crumb && s5.chat === s1.chat, inv: [s0, s1, s2, s3, s5].every(inv), errs: errs.length === 0, reload: rl.every((x) => x.endsWith("ok")) };
  // Forward #1 from back2 returns to start (mirror of Back#2), Forward #2 to final (mirror of Back#1)
  ok.fwdMirror = s4.url === s2.url && s4.crumb === s2.crumb;
  const pass = Object.values(ok).every(Boolean); if (!pass) fails++;
  console.log(`${pass ? "PASS" : "FAIL"} ${theme}-${w} ${dir} ${name.padEnd(17)} start=${fmt(s0)} len=${s0.hlen}`);
  console.log(`   act  -> ${fmt(s1)} dLen=${s1.hlen - s0.hlen} pushes=[${pushes.join(", ")}] mixed=[${mixed}] :: ${s1.hist}`);
  console.log(`   back -> ${fmt(s2)} :: ${s2.hist}`);
  console.log(`   back2-> ${fmt(s3)} :: ${s3.hist}`);
  console.log(`   fwd  -> ${fmt(s4)} :: ${s4.hist}`);
  console.log(`   fwd2 -> ${fmt(s5)} len=${s5.hlen} :: ${s5.hist}`);
  console.log(`   reload ${rl.join(" ")} errs=${errs.length} ${pass ? "" : JSON.stringify(ok)}`);
  await browser.close();
}
console.log(`fails=${fails}`);
