// U4b real-app shots: 3200x1800 CSS viewport at deviceScaleFactor 1.2 = 3840x2160 px at 120% zoom.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchWithLocalToken } from "../../../../server/local-token.mjs";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || join(homedir(), "projects/VibeSquad/scratch/pw/node_modules/playwright-core"));
const [,, url, out, theme, click] = process.argv;
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
const ctx = await browser.newContext({ viewport: { width: 3200, height: 1800 }, deviceScaleFactor: 1.2, colorScheme: theme });
await ctx.addInitScript(() => localStorage.setItem("vs.firstRunDone", "1"));
// Owner access via the single-use login nonce (vs_local cookie), never the raw local token on the wire:
// the nonce is minted through fetchWithLocalToken (loopback proof first), and the login hop sets the cookie on
// the same host as `url` so the shots see the owner UI.
const port = Number(new URL(url).port || process.env.VIBESQUAD_PORT || 4180);
const nonceRes = await fetchWithLocalToken("/__vibesquad/local-login/nonce", { method: "POST", port });
if (!nonceRes.ok) throw new Error(`VibeSquad server on port ${port} refused a login nonce (${nonceRes.status})`);
const { path: loginPath } = await nonceRes.json();
if (typeof loginPath !== "string" || !loginPath.startsWith("/__vibesquad/local-login?t=")) throw new Error("unexpected nonce response");
const page = await ctx.newPage();
await page.goto(new URL(loginPath, url).toString());
await page.goto(url);
await page.waitForTimeout(6000);
await page.evaluate((t) => { document.documentElement.setAttribute("data-theme", t); }, theme);
if (click) { for (const c of click.split("|")) { await page.locator(c).first().click(); await page.waitForTimeout(2500); } }
await page.waitForTimeout(1500);
console.log(await page.evaluate(() => [document.title, location.href, document.querySelectorAll("select").length, [...document.querySelectorAll("button")].length]));
await page.screenshot({ path: out });
await browser.close();
