import { start, stop, openDesk, CFGS, SHOTS, resetBackend } from "./common.mjs";
import { writeFileSync } from "node:fs";
await start();
const out = {};
const pick = process.argv[2] ? CFGS.filter((c) => process.argv.slice(2).includes(c.name)) : [CFGS[0], CFGS[3]];
for (const cfg of pick) {
  resetBackend();
  const { context, page, errs } = await openDesk(cfg);
  const log = [];
  const T = (id) => page.locator(`[data-testid="${id}"]`);
  const snap = async (label, shot) => {
    const s = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const p = {};
      document.querySelectorAll('[data-testid^="boring-decision-pill-"],[data-testid^="boring-decision-preset-"]').forEach((el) => (p[el.dataset.testid.replace("boring-decision-", "")] = el.getAttribute("aria-pressed")));
      return {
        pressed: p,
        summary: q('[data-testid="boring-decision-summary"]')?.textContent,
        squads: [...document.querySelectorAll('[data-testid^="boring-decision-squad-"]')].map((e) => e.dataset.testid.slice(22)),
        strip: [...document.querySelectorAll('[data-testid^="boring-decision-strip-squad-"]')].map((e) => e.dataset.testid.slice(28)),
        offscreen: [...document.querySelectorAll('[data-testid^="boring-decision-offscreen-"]')].map((e) => e.dataset.testid.slice(26)),
        send: q('[data-testid="boring-decision-send-btn"]')?.textContent, sendDisabled: q('[data-testid="boring-decision-send-btn"]')?.disabled,
        footer: q('[data-testid="boring-decision-send-btn"]')?.closest("div")?.parentElement?.innerText.replace(/\n/g, " | ").slice(0, 200),
        sideBadge: q('[data-testid="boring-decisions-nav-count"]')?.textContent,
        empty: q('[data-testid="boring-decision-empty"]')?.innerText.replace(/\n/g, " | "),
        labels: [...document.querySelectorAll('[data-testid^="boring-decision-pill-"]')].map((e) => [e.dataset.testid.slice(21), e.getAttribute("aria-label"), e.title]),
        railHead: [...document.querySelectorAll("*")].find((e) => /^\d+ lanes?$/.test(e.textContent?.trim() ?? "") && e.children.length === 0)?.textContent,
        decHead: [...document.querySelectorAll("*")].find((e) => /^Oldest first/.test(e.textContent?.trim() ?? "") && e.children.length === 0)?.textContent,
        active: document.activeElement?.dataset?.testid || document.activeElement?.tagName,
        ls: Object.fromEntries(Object.keys(localStorage).filter((k) => /decision|filter|pill/i.test(k)).map((k) => [k, localStorage.getItem(k)])),
        url: location.search,
      };
    });
    const navN = Number((s.sideBadge || "").replace(/[^0-9]/g, "")); const sumN = /^(\d+) open/.exec(s.summary || "")?.[1]; s.parity = String(navN) === String(sumN ?? (s.summary?.startsWith("0 open") ? 0 : "?")) ? "OK" : `MISMATCH nav ${navN} vs summary ${s.summary}`;
    log.push({ label, ...s });
    if (shot) await page.screenshot({ path: `${SHOTS}/r46-${cfg.name}-${shot}.png`, scale: "css", clip: shot.endsWith("-full") ? undefined : { x: 0, y: 0, width: cfg.width, height: Math.min(cfg.height, 1080) } });
  };
  await snap("default");
  // awake OFF
  await T("boring-decision-pill-site").click();
  await snap("site off", "site-off");
  // 3 toggles: forework on, sbb on
  await T("boring-decision-pill-forework").click();
  await T("boring-decision-pill-sbb").click();
  await snap("site off, fw+sbb on", "three-toggled");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="boring-decision-pills-on-hold"]');
  await page.waitForTimeout(400);
  await snap("after reload");
  await T("boring-decision-preset-all").click();
  await snap("All", "all");
  await T("boring-decision-preset-active").click();
  await snap("Active");
  // all off
  for (const id of ["vibesquad", "efi", "site"]) await T(`boring-decision-pill-${id}`).click();
  await snap("none on", "none-on");
  await T("boring-decision-empty-show-all").click();
  await snap("empty Show all clicked");
  await T("boring-decision-preset-active").click();
  // stage + hide
  await T("boring-decision-lean-ny-f1-01").click();
  await snap("staged vs");
  await T("boring-decision-pill-vibesquad").click();
  await snap("vs hidden", "staged-hidden");
  await T("boring-decision-pill-vibesquad").click();
  await snap("vs unhidden");
  // staged then preset All/Active doesn't drop
  await T("boring-decision-preset-all").click(); await T("boring-decision-preset-active").click();
  await snap("after presets");
  // staged typed answer on Site then hide site and reload
  await page.locator('[data-testid="boring-decision-squad-site"] input, [data-testid="boring-decision-squad-site"] textarea').first().fill("3600");
  await T("boring-decision-pill-site").click();
  await snap("typed site, site hidden");
  await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForSelector('[data-testid="boring-decision-pills-on-hold"]'); await page.waitForTimeout(400);
  await snap("reload with staged");
  await T("boring-decision-pill-site").click();
  await snap("site back after reload");
  // keyboard
  await T("boring-decision-preset-active").focus();
  const kb = [];
  for (let i = 0; i < 8; i++) { await page.keyboard.press("Tab"); kb.push(await page.evaluate(() => { const a = document.activeElement; const cs = getComputedStyle(a); return [a.dataset.testid || a.tagName + ":" + a.innerText.slice(0, 20), cs.outlineStyle + " " + cs.outlineWidth + " " + cs.outlineColor, cs.boxShadow.slice(0, 60)]; })); if (i === 2) await page.screenshot({ path: `${SHOTS}/r46-${cfg.name}-focus.png`, scale: "css", clip: { x: 300, y: 60, width: 900, height: 120 } }); }
  log.push({ label: "tab order", kb });
  await T("boring-decision-pill-efi").focus();
  await page.keyboard.press("Space"); await snap("space on efi");
  await page.keyboard.press("Enter"); await snap("enter on efi");
  log.push({ label: "errs", errs });
  out[cfg.name] = log;
  await context.close();
}
writeFileSync(SHOTS + "/logs/pass2.json", JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) { console.log("##", k); for (const l of v) console.log(JSON.stringify(l)); }
await stop();
