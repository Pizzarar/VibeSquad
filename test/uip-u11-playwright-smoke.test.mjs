// Unit U11 — Live Playwright Click-Through Smoke Suite (docs/PLAN_UI_POLISH.md §U11).
//
// Boots the app in demo mode (`?demo=1`) on a Vite dev server, routes/mocks the
// `/__vibesquad/*` + `/api/teams` endpoints in a real headless Chromium/Edge browser,
// and clicks through the 5 core UI flows:
//
//   1. Click a Squad → click a Pinned Team → single ~44px top bar (`drawer-head-compact`)
//      + Right Rail Active Buddy Card (`pin-rail-active-buddy`) render with 0 page errors.
//   2. Change `Provider ▾` (Claude → ◆ Gemini) → top bar updates in place without wiping the
//      timeline or firing `/__vibesquad/brainstorm-restart`; type + Enter → restart is called
//      with `reason: "provider-switch"`, `profileName: "Brainstorm - Gemini"`, and a
//      `pendingPrompt` containing the typed message.
//   3. Change `Model ▾` while staged on Gemini → the selected model updates in place.
//   4. Click `★ Lead` and a worker under `Team under this Buddy` → the center chat switches
//      while `pinFocus` (the right rail) stays active.
//   5. Click `SQUADS` / Breadcrumb / `⊞` → one-click return to the clean Squads/PinGrid screen.
//
// The test is self-contained: it resolves Playwright (local, `PLAYWRIGHT_DIR`, or the global
// `@playwright/mcp` bundle), launches the system Edge/Chrome with `playwright-core` (no browser
// download required), and spawns its own Vite dev server on a free port.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require2 = createRequire(import.meta.url);
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "..");

// ── Deterministic teams registry ─────────────────────────────────────────────
// The demo cast (`src/demo.tsx`) maps its VibeSquad agents to the `vibesquad` team/lane
// (labels `team: "vibesquad"` + legacy `lead: "vibesquad"`). We register an explicit
// `hub: true` RiffBot lane so the `vibesquad` lane stays a *regular* pinned team (a lane is
// only the hub when no explicit hub lane exists and its id equals the squad id).
const TEAMS_REGISTRY = {
  revision: "u11-playwright-smoke",
  teams: [
    {
      id: "vibesquad",
      name: "VibeSquad",
      color: "#b07cf5",
      leadFlagTokens: 150000,
      leadAutoHandoffTokens: 250000,
      leadHardCapTokens: 300000,
      brainstormWarnTokens: 80000,
      brainstormRestartTokens: 150000,
      lanes: [
        { id: "riffbot", name: "RiffBot", hub: true, paths: ["VibeSquad"] },
        { id: "vibesquad", name: "VibeSquad", paths: ["VibeSquad"] },
      ],
      paths: ["VibeSquad"],
    },
  ],
};

// The demo cast (fixed in src/demo.tsx) — used to build precise selectors/assertions.
const SQUAD_ID = "vibesquad";
const LANE_ID = "vibesquad";
const WORKER_ID = "demo-art-o"; // claude worker, status running

// ── Playwright / browser resolution ──────────────────────────────────────────
function resolvePlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_DIR) candidates.push(path.join(process.env.PLAYWRIGHT_DIR, "playwright-core"));
  try {
    candidates.push(require2.resolve("playwright-core"));
  } catch {}
  try {
    candidates.push(require2.resolve("playwright"));
  } catch {}
  candidates.push(
    "C:/Users/Fugma/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright-core",
    "C:/Users/Fugma/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright",
  );
  for (const c of candidates) {
    try {
      return { mod: require2(c), from: c };
    } catch {
      /* keep trying */
    }
  }
  return null;
}

const CANDIDATE_EXECUTABLES = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Microsoft/Edge/Application/msedge.exe`,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
].filter(Boolean);

// ── Shared state (populated in `before`) ─────────────────────────────────────
let pw = null;
let executablePath = null;
let server = null;
let browser = null;
let context = null;
let page = null;
let baseUrl = "";
let unavailable = null;

const pageErrors = [];
const consoleErrors = [];
const restartBodies = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 15000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(120);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Assert no uncaught page errors and no (non-benign) console errors since the last check. */
function assertNoErrors() {
  const realConsoleErrors = consoleErrors.filter((m) => !/failed to load resource/i.test(m));
  assert.deepEqual(pageErrors, [], `uncaught page errors:\n${pageErrors.join("\n")}`);
  assert.deepEqual(realConsoleErrors, [], `console errors:\n${realConsoleErrors.join("\n")}`);
}

function resetErrors() {
  pageErrors.length = 0;
  consoleErrors.length = 0;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
before(async () => {
  pw = resolvePlaywright();
  if (!pw) {
    unavailable = "Playwright not found (set PLAYWRIGHT_DIR, or install playwright locally/globally).";
    return;
  }
  executablePath = CANDIDATE_EXECUTABLES.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }) ?? null;
  if (!executablePath) {
    unavailable = "No Edge/Chrome executable found (set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH).";
    return;
  }

  // Spawn the Vite dev server (bundled middleware serves /__vibesquad/* and /api/teams; we mock
  // them in Playwright anyway so the smoke test never touches the real daemon/registry).
  const viteBin = path.join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");
  const port = 5211;
  baseUrl = `http://localhost:${port}`;
  server = spawn(process.execPath, [viteBin, "--port", String(port), "--strictPort"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let viteErr = "";
  server.stderr?.on("data", (d) => (viteErr += String(d)));

  // Wait for the server to answer.
  const up = await (async () => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${baseUrl}/`, { method: "GET" });
        if (r.ok) return true;
      } catch {}
      await sleep(400);
    }
    return false;
  })();
  if (!up) {
    throw new Error(`Vite dev server failed to boot:\n${viteErr.slice(0, 4000)}`);
  }

  // Launch headless Chromium (system Edge) and install route mocks.
  browser = await pw.mod.chromium.launch({ executablePath, headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();

  page.on("pageerror", (e) => pageErrors.push(String(e?.message ?? e)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const pathname = url.pathname;

    // Fonts are served from a junction outside Vite's fs.allow list → would 403; stub them.
    if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(pathname)) {
      return route.fulfill({ status: 200, contentType: "font/woff2", body: "" });
    }
    if (pathname === "/api/teams" && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(TEAMS_REGISTRY) });
    }
    if (pathname === "/__vibesquad/brainstorm-restart" && method === "POST") {
      let body = {};
      try {
        body = (req.postDataJSON?.() ?? JSON.parse(req.postData() || "{}")) || {};
      } catch {}
      restartBodies.push(body);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, newAgentId: "demo-bs-restart", title: "BRAINSTORM · smoke" }),
      });
    }
    if (pathname.startsWith("/__vibesquad/")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    return route.continue();
  });

  await page.goto(`${baseUrl}/?demo=1`, { waitUntil: "domcontentloaded", timeout: 30000 });
});

after(async () => {
  try {
    await browser?.close();
  } catch {}
  if (server && !server.killed) server.kill();
});

// ── The 5 core flows ─────────────────────────────────────────────────────────
test("U11: live click-through of the 5 core UI flows", { timeout: 180000 }, async (t) => {
  if (unavailable) {
    t.skip(unavailable);
    return;
  }

  // ── Flow 1 ────────────────────────────────────────────────────────────────
  await t.test("flow 1: Squad → Pinned Team → compact top bar + Active Buddy Card", async () => {
    resetErrors();

    // Land on Squads Home deterministically.
    await page.getByRole("button", { name: "SQUADS", exact: true }).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "SQUADS", exact: true }).click();
    await page.locator(`[data-testid="squad-home-tile-${SQUAD_ID}"]`).waitFor({ timeout: 15000 });

    // Click the Squad → its pinned teams grid.
    await page.locator(`[data-testid="squad-home-tile-${SQUAD_ID}"]`).click();
    await page.locator(`[data-testid="pin-tile-${LANE_ID}"]`).waitFor({ timeout: 15000 });

    // Click the Pinned Team → pin-focus view (center drawer + right rail).
    await page.locator(`[data-testid="pin-tile-${LANE_ID}"]`).click();

    await page.locator('[data-testid="drawer-head-compact"]').waitFor({ timeout: 15000 });
    await page.locator('[data-testid="pin-rail-active-buddy"]').waitFor({ timeout: 15000 });
    assert.ok(
      await page.locator('[data-testid="drawer-head-compact"]').count(),
      "compact top bar (drawer-head-compact) should render",
    );
    assert.ok(
      await page.locator('[data-testid="pin-rail-active-buddy"]').count(),
      "Active Buddy Card (pin-rail-active-buddy) should render",
    );
    assertNoErrors();
  });

  // ── Flow 2 ────────────────────────────────────────────────────────────────
  await t.test("flow 2: Provider ▾ Claude → ◆ Gemini stages in place, then sends a seamless switch", async () => {
    resetErrors();

    const provider = page.locator('[data-testid="drawer-provider-select"]');
    await provider.waitFor({ timeout: 15000 });
    // The demo Brainstorm is Claude.
    assert.equal(await provider.inputValue(), "claude", "demo Brainstorm should start on Claude");

    const restartCountBefore = restartBodies.length;

    // Stage the switch: pick ◆ Gemini.
    await provider.selectOption("antigravity-cli");
    await waitFor(async () => (await provider.inputValue()) === "antigravity-cli", 10000, "provider to stage Gemini");

    // The provider + model options update in place, without a restart and without wiping the timeline.
    assert.equal(restartBodies.length, restartCountBefore, "staging must not fire /__vibesquad/brainstorm-restart");
    const modelOptions = await page
      .locator('[data-testid="drawer-model-select"] option')
      .evaluateAll((opts) => opts.map((o) => o.value));
    assert.ok(modelOptions.some((v) => v === "gemini-4-argon"), "Model options should show Gemini models");
    const timelineStillThere = await page
      .locator(".timeline")
      .first()
      .textContent()
      .catch(() => "");
    assert.ok(timelineStillThere && timelineStillThere.length > 0, "staging must not wipe the chat timeline");

    // Type a message and press Enter → seamless provider switch.
    const msg = "smoke-test-gemini-switch-42";
    const composer = page.locator('textarea[placeholder^="Message"]');
    await composer.waitFor({ timeout: 15000 });
    await composer.fill(msg);
    await composer.press("Enter");

    // The restart request must carry the provider-switch payload.
    await waitFor(() => restartBodies.length > restartCountBefore, 15000, "/__vibesquad/brainstorm-restart");
    const body = restartBodies[restartBodies.length - 1];
    assert.equal(body.reason, "provider-switch");
    assert.equal(body.profileName, "Brainstorm - Gemini");
    assert.equal(typeof body.pendingPrompt, "string", "pendingPrompt should be a string carrying the typed message");
    assert.ok(
      body.pendingPrompt.includes(msg),
      `pendingPrompt should contain the typed message; got: ${JSON.stringify(body.pendingPrompt)}`,
    );
    assertNoErrors();
  });

  // ── Flow 3 ────────────────────────────────────────────────────────────────
  await t.test("flow 3: Model ▾ changes while staged on Gemini", async () => {
    resetErrors();

    // Re-stage Gemini (flow 2 already committed its switch, so stage again).
    const provider = page.locator('[data-testid="drawer-provider-select"]');
    await provider.waitFor({ timeout: 15000 });
    await provider.selectOption("antigravity-cli");
    await waitFor(async () => (await provider.inputValue()) === "antigravity-cli", 10000, "re-stage Gemini");

    const model = page.locator('[data-testid="drawer-model-select"]');
    await model.waitFor({ timeout: 15000 });
    assert.equal(await model.inputValue(), "gemini-4-argon", "staged model should default to gemini-4-argon");

    await model.selectOption("gemini-3.8-flash");
    await waitFor(async () => (await model.inputValue()) === "gemini-3.8-flash", 10000, "model to update");
    assert.equal(await model.inputValue(), "gemini-3.8-flash", "selected model should update in place");
    assertNoErrors();
  });

  // ── Flow 4 ────────────────────────────────────────────────────────────────
  await t.test("flow 4: click ★ Lead and a worker while keeping pinFocus", async () => {
    resetErrors();

    const activeBuddy = page.locator('[data-testid="pin-rail-active-buddy"]');
    await activeBuddy.waitFor({ timeout: 15000 });

    // Click the Lead (★).
    const leadRow = page.locator('[data-testid="pin-team-lead"]');
    await leadRow.waitFor({ timeout: 15000 });
    await leadRow.click();
    await waitFor(
      async () => (await page.locator(".drawer-head-compact-title").first().textContent().catch(() => ""))?.includes("VIBESQUAD"),
      10000,
      "center chat to switch to the Lead",
    );
    assert.ok(await page.locator('[data-testid="pin-rail"]').count(), "pin rail must stay visible");
    assert.ok(await activeBuddy.count(), "Active Buddy Card must stay visible");

    // Click a worker.
    const workerRow = page.locator(`[data-testid="pin-team-worker-${WORKER_ID}"]`);
    await workerRow.waitFor({ timeout: 15000 });
    await workerRow.click();
    await waitFor(
      async () => (await page.locator(".drawer-head-compact-title").first().textContent().catch(() => ""))?.includes("Art Painter"),
      10000,
      "center chat to switch to the worker",
    );
    assert.ok(await page.locator('[data-testid="pin-rail"]').count(), "pin rail must stay visible");
    assert.ok(await activeBuddy.count(), "Active Buddy Card must stay visible");
    assertNoErrors();
  });

  // ── Flow 5 ────────────────────────────────────────────────────────────────
  await t.test("flow 5: one-click return to the clean Squads/PinGrid screen", async () => {
    resetErrors();

    // ⊞ (pin-focus home) → back to the pin grid.
    const homeBtn = page.locator('[data-testid="pin-focus-home"]');
    await homeBtn.waitFor({ timeout: 15000 });
    await homeBtn.click();
    await page.locator('[data-testid="pin-grid"]').waitFor({ timeout: 15000 });

    // SQUADS toolbar button → Squads Home.
    await page.getByRole("button", { name: "SQUADS", exact: true }).click();
    await page.locator('[data-testid="squads-home"]').waitFor({ timeout: 15000 });
    assert.ok(await page.locator('[data-testid="squads-home"]').count(), "should return to Squads Home");

    // Re-enter focus and use the breadcrumb Squads crumb as the second path.
    await page.locator(`[data-testid="squad-home-tile-${SQUAD_ID}"]`).click();
    await page.locator(`[data-testid="pin-tile-${LANE_ID}"]`).waitFor({ timeout: 15000 });
    await page.locator(`[data-testid="pin-tile-${LANE_ID}"]`).click();
    await page.locator('[data-testid="drawer-head-compact"]').waitFor({ timeout: 15000 });
    await page.locator('[data-testid="breadcrumb-squads"]').click();
    await page.locator('[data-testid="squads-home"]').waitFor({ timeout: 15000 });
    assert.ok(await page.locator('[data-testid="squads-home"]').count(), "breadcrumb Squads should land on Squads Home");
    assertNoErrors();
  });
});
