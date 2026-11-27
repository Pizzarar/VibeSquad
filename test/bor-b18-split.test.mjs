// B18e (@bor, idea-1085 = @bug 1075 UX m1/m2):
// - m1: "◫ Back to split" button over full-screen dormant card restores parked split without collapsing it.
// - m2: Shift+click on dormant Bugs/Desk sidebar row while split opens B17's right-pane card (clearing right tab if needed) without collapsing split.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { resolvePlaywright, PLAYWRIGHT_INSTALL_CMD } from "../scripts/ui-overlap/env.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

test("B18e static: Back to split pill, clearRightPane, Shift+click dormant Desk/Bugs", () => {
  const ade = read("src", "BoringAde.tsx");
  const panes = read("src", "panes.ts");
  assert.match(panes, /export function clearRightPane\(\)/);
  assert.match(ade, /dormantSlot && panes\.split/);
  assert.ok(ade.includes("◫ Back to split"), "Back to split label present");
  assert.match(ade, /openRightSlotCard/);
  assert.match(ade, /clearRightPane\(\)/);
});

const chromium = resolvePlaywright({ npx: false })?.chromium ?? null;
const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const skip = chromium && exe ? false : `no Playwright/Chromium (set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH; Playwright: ${PLAYWRIGHT_INSTALL_CMD})`;

const init = (theme) => `try{localStorage.setItem("vs.vibeMigratedNormal","1");localStorage.setItem("vs.vibePicked","1");const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}");localStorage.setItem("vs.prefs.v1",JSON.stringify({...p,"app.vibe":"boring","app.theme":"${theme}"}));}catch{}`;

async function openSplitApp(b, E, baseUrl, w, h, theme) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: theme });
  await ctx.addInitScript(init(theme));
  await E.installRoutes(ctx);
  const page = await ctx.newPage();
  await page.goto(`${baseUrl}/?demo=1`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="boring-worker-demo-aud"]').click({ timeout: 15000 });
  await page.locator('[data-testid="boring-chat-column"]').waitFor();
  await page.waitForTimeout(400);
  return { ctx, page };
}

test("browser B18e m1 + m2: Back to split restores parked split; Shift+click dormant Bugs/Desk opens right-pane card", { skip, timeout: 240000 }, async () => {
  const E = await import(pathToFileURL(join(root, "scripts", "ui-overlap", "env.mjs")).href);
  await E.ensureDist();
  const { server, baseUrl } = await E.serveDist();
  const b = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  try {
    // 1) m1: both panes open -> plain click dormant Bugs -> "◫ Back to split" -> click restores both panes intact
    {
      const { ctx, page } = await openSplitApp(b, E, baseUrl, 1280, 720, "dark");
      const leftBefore = await page.locator('[data-testid="boring-agent-header"]').first().getAttribute("data-agent-id");
      await page.locator('[data-testid="boring-split-toggle"]').click();
      await page.locator('[data-testid="boring-split-empty"]').waitFor();
      // Open a live agent in the right pane via the picker filter
      const f = page.locator('[data-testid="boring-pp-filter"]');
      await f.fill("ui bois");
      await f.press("Enter");
      await page.locator('[data-testid="boring-pane-right"] [data-testid="boring-agent-header"]').waitFor({ timeout: 5000 });
      const rightBefore = await page.locator('[data-testid="boring-pane-right"] [data-testid="boring-agent-header"]').getAttribute("data-agent-id");
      assert.ok(leftBefore && rightBefore && leftBefore !== rightBefore, `both panes open: ${leftBefore} vs ${rightBefore}`);

      // Plain click dormant Bugs -> full-screen dormant card with "◫ Back to split"
      await page.locator('[data-testid="boring-core-bugs"]').click();
      await page.locator('[data-testid="boring-empty-card"]').waitFor({ timeout: 5000 });
      assert.equal(await page.locator('[data-testid="boring-chat-split"]').count(), 0, "m1: full-screen dormant card replaces split view");
      const btn = page.locator('[data-testid="boring-split-toggle"]');
      assert.equal((await btn.innerText()).trim(), "◫ Back to split", "m1: button reads Back to split");
      assert.equal(await btn.getAttribute("aria-pressed"), "false", "m1: Back to split is not aria-pressed=true");

      // Click Back to split -> restores BOTH panes intact
      await btn.click();
      await page.locator('[data-testid="boring-chat-split"]').waitFor({ timeout: 5000 });
      assert.equal(await page.locator('[data-testid="boring-pane-left"] [data-testid="boring-agent-header"]').getAttribute("data-agent-id"), leftBefore, "m1: left pane restored");
      assert.equal(await page.locator('[data-testid="boring-pane-right"] [data-testid="boring-agent-header"]').getAttribute("data-agent-id"), rightBefore, "m1: right pane restored");
      assert.equal((await btn.innerText()).trim(), "◫ Unsplit", "m1: toggle returns to Unsplit");
      assert.equal(await btn.getAttribute("aria-pressed"), "true", "m1: toggle aria-pressed=true again");
      await ctx.close();
    }

    // 2) m1: left active + right picker -> plain click dormant Overlord -> Back to split restores left + picker
    {
      const { ctx, page } = await openSplitApp(b, E, baseUrl, 1280, 720, "dark");
      const leftBefore = await page.locator('[data-testid="boring-agent-header"]').first().getAttribute("data-agent-id");
      await page.locator('[data-testid="boring-split-toggle"]').click();
      await page.locator('[data-testid="boring-split-empty"]').waitFor();
      await page.locator('[data-testid="boring-pane-left"]').click({ position: { x: 20, y: 20 } });
      await page.locator('[data-testid="boring-core-overlord"]').click();
      await page.locator('[data-testid="boring-empty-card"]').waitFor({ timeout: 5000 });
      const btn = page.locator('[data-testid="boring-split-toggle"]');
      assert.equal((await btn.innerText()).trim(), "◫ Back to split");
      await btn.click();
      await page.locator('[data-testid="boring-chat-split"]').waitFor({ timeout: 5000 });
      assert.equal(await page.locator('[data-testid="boring-pane-left"] [data-testid="boring-agent-header"]').getAttribute("data-agent-id"), leftBefore, "m1 picker: left pane intact");
      assert.equal(await page.locator('[data-testid="boring-split-empty"]').count(), 1, "m1 picker: right picker intact");
      await ctx.close();
    }

    // 3) m2: Shift+click dormant Bugs/Overlord while split (both with right picker AND with live right agent)
    {
      const { ctx, page } = await openSplitApp(b, E, baseUrl, 1280, 720, "dark");
      const leftBefore = await page.locator('[data-testid="boring-agent-header"]').first().getAttribute("data-agent-id");
      await page.locator('[data-testid="boring-split-toggle"]').click();
      await page.locator('[data-testid="boring-split-empty"]').waitFor();

      // 3a) Right pane on picker -> Shift+click dormant Bugs -> B17 right card opens, left pane untouched, no ?slot=
      await page.locator('[data-testid="boring-core-bugs"]').click({ modifiers: ["Shift"] });
      await page.locator('[data-testid="boring-pp-empty"] [data-testid="boring-empty-card"]').waitFor({ timeout: 5000 });
      assert.equal(await page.locator('[data-testid="boring-chat-split"]').count(), 1, "m2 (picker): split stays open");
      assert.equal(await page.locator('[data-testid="boring-pane-left"] [data-testid="boring-agent-header"]').getAttribute("data-agent-id"), leftBefore, "m2 (picker): left pane untouched");
      assert.equal((await page.locator('[data-testid="boring-pp-empty"] [data-testid="boring-empty-lane"]').innerText()).trim(), "Bugs");
      assert.ok(!page.url().includes("slot=bugs"), `m2 (picker): URL has no ?slot=bugs (${page.url()})`);

      // 3b) Open a live agent in the right pane, then Shift+click dormant Overlord -> clears right tab without collapsing split, opens Overlord right card
      await page.locator('[data-testid="boring-pp-back"]').click();
      const f = page.locator('[data-testid="boring-pp-filter"]');
      await f.fill("ui bois");
      await f.press("Enter");
      await page.locator('[data-testid="boring-pane-right"] [data-testid="boring-agent-header"]').waitFor({ timeout: 5000 });
      await page.locator('[data-testid="boring-core-overlord"]').click({ modifiers: ["Shift"] });
      await page.locator('[data-testid="boring-pp-empty"] [data-testid="boring-empty-card"]').waitFor({ timeout: 5000 });
      assert.equal(await page.locator('[data-testid="boring-chat-split"]').count(), 1, "m2 (live right): split stays open");
      assert.equal(await page.locator('[data-testid="boring-pane-left"] [data-testid="boring-agent-header"]').getAttribute("data-agent-id"), leftBefore, "m2 (live right): left pane untouched");
      assert.equal((await page.locator('[data-testid="boring-pp-empty"] [data-testid="boring-empty-lane"]').innerText()).trim(), "Overlord");
      assert.ok(!page.url().includes("slot=overlord"), `m2 (live right): URL has no ?slot=overlord (${page.url()})`);

      // 3c) Shift+click dormant Bugs while Overlord right card is open -> swaps right card to Bugs
      await page.locator('[data-testid="boring-core-bugs"]').click({ modifiers: ["Shift"] });
      await page.waitForTimeout(200);
      assert.equal(await page.locator('[data-testid="boring-chat-split"]').count(), 1, "m2 (swap card): split stays open");
      assert.equal((await page.locator('[data-testid="boring-pp-empty"] [data-testid="boring-empty-lane"]').innerText()).trim(), "Bugs");
      await ctx.close();
    }
  } finally { await b.close(); server.close(); }
});
