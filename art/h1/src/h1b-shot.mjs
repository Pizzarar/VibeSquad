// H1b in-app shots: the live app (url) with /cast.png and /office/cast-*.png routed to this worktree's public/ files.
// 3200x1800 CSS viewport at deviceScaleFactor 1.2 = 3840x2160 px at 120% zoom.
// Usage: node art/h1/src/h1b-shot.mjs <url> <out.png> <dark|light> ["click selector|click selector"]
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchWithLocalToken } from "../../../server/local-token.mjs";
const { chromium } = createRequire(import.meta.url)(process.env.PW_CORE ?? join(homedir(), "projects/VibeSquad/scratch/pw/node_modules/playwright-core"));
const [,, url, out, theme, click] = process.argv;
const pub = fileURLToPath(new URL("../../../public/", import.meta.url));
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
const ctx = await browser.newContext({ viewport: { width: 3200, height: 1800 }, deviceScaleFactor: 1.2, colorScheme: theme });
await ctx.addInitScript(() => localStorage.setItem("vs.firstRunDone", "1"));
await ctx.route(/\/(cast\.png|office\/cast-(dark|light)\.png)(\?.*)?$/, (r) => {
  const p = new URL(r.request().url()).pathname.slice(1);
  r.fulfill({ status: 200, contentType: "image/png", body: readFileSync(pub + p) });
});
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
console.log(await page.evaluate(() => [document.title, location.href, !!document.querySelector("[data-testid=hub-body]"), document.querySelectorAll("canvas").length]));
await page.screenshot({ path: out });
await browser.close();
