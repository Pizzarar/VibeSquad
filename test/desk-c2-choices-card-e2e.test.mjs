// @desk C2 e2e (docs/PLAN_DESK_DD_CHOICES.md):
// Drives the built app in Playwright at 1920x1080 and 3200x1800@1.2, dark and light,
// verifying option definitions wrap, Show source expands to plain-text excerpt (HTML-looking
// context renders as literal text), picking B + typing a veto reply sends ONE prompt with
// both lines through buildAnswerPrompt/quoteLine, and staged answers survive F1 toggles.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, ensureDist, findBrowser, resolvePlaywright, browserSkipReason } from "../scripts/ui-overlap/env.mjs";
import { buildAnswerPrompt, validateAnswerBatch } from "../server/decisions.mjs";

let pw, exe, server, baseUrl, browser, unavailable;
const SHOTS_DIR = path.join(REPO_ROOT, "docs", "shots", "desk-c2");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml" };

const TEAMS = [
  { id: "vibesquad", name: "VibeSquad", color: "#58a6ff", paths: [], lanes: [{ id: "vibesquad", name: "Hub", hub: true }, { id: "desk", name: "Desk", code: "desk" }] },
  { id: "ledger", name: "Ledger", color: "#a371f7", paths: [], lanes: [{ id: "ledger", name: "Hub", hub: true }, { id: "data", name: "Data", code: "dat" }] },
];

const HTML_CONTEXT = [
  "Source check with HTML-like tokens:",
  `<img src=x onerror="window.__c2xss=1"><script>window.__c2xss=2</script><b>not-bold</b>`,
  "(a) survivor-only: keep only listed tickers and report coverage %",
  "(b) stop at A1: ship the A1 universe and defer delisted data",
].join("\n");

let state;
function resetBackend() {
  const now = Date.now();
  const m = (mins) => now - mins * 60_000;
  const iso = (mins) => new Date(m(mins)).toISOString();
  state = {
    deliveredPrompts: [],
    items: [
      {
        id: "ny-00000000000000000001",
        source: "log",
        squad: "vibesquad",
        squadName: "VibeSquad",
        lane: "desk",
        askerId: "a-vs-ov",
        asker: { id: "a-vs-ov", title: "Overlord", live: true },
        ask: "Partial-fill entry handling: A, B, or C? Also add a veto window on the check-5 same-ticker block?",
        decides: "A spec change for partial-fill entries, plus whether the owner can veto the check-5 block.",
        lean: "",
        alts: [
          "A: fill-or-kill at entry — cancel the order unless it fills completely",
          "B: keep the partial fill and resize the stop to the filled size",
          "C: top up the remainder at the next bar's open",
        ],
        kind: "yesno",
        structured: false,
        inferred: true,
        rawText: "Partial-fill entry handling: A, B, or C? Also add a veto window on the check-5 same-ticker block?",
        context: [
          "Partial fills are the last open question on the entry path.",
          "A) fill-or-kill at entry: cancel the order unless it fills completely",
          "B) keep the partial fill and resize the stop to the filled size",
          "C) top up the remainder at the next bar's open",
          "Separately: should I add a 30s veto window on the check-5 same-ticker block?",
        ].join("\n"),
        ts: m(40),
      },
      {
        id: "ny-00000000000000000002",
        source: "label",
        squad: "ledger",
        squadName: "Ledger",
        lane: "data",
        askerId: "a-ld-1",
        asker: { id: "a-ld-1", title: "Data · Lead 1", live: true },
        ask: "U11 survivorship: (a) survivor-only with coverage %, or (b) stop at A1?",
        decides: "Sets U11 scope and whether delisted rows are deferred.",
        lean: "",
        alts: [
          "a: survivor-only — keep only listed tickers and report coverage %",
          "b: stop at A1 — ship the A1 universe and defer delisted data",
        ],
        kind: "yesno",
        structured: false,
        inferred: true,
        context: HTML_CONTEXT,
        ts: m(25),
      },
      {
        id: "ny-00000000000000000003",
        source: "log",
        squad: "vibesquad",
        squadName: "VibeSquad",
        lane: "desk",
        askerId: "a-vs-ld",
        asker: { id: "a-vs-ld", title: "Desk · Lead 2", live: true },
        ask: "Ship C2 choice definitions card?",
        decides: "Plain structured card with no context should not show Show source.",
        lean: "Yes, ship C2",
        alts: ["Hold"],
        kind: "yesno",
        structured: true,
        ts: m(10),
      },
    ],
    logs: {
      vibesquad: [{ ts: iso(15), lane: "desk", agent: "Desk · Lead 2", type: "done", text: "C1 choices context merged", refs: [] }],
      ledger: [{ ts: iso(20), lane: "data", agent: "Data · Lead 1", type: "done", text: "U11 coverage benchmark ready", refs: [] }],
    },
  };
}

before(async () => {
  pw = resolvePlaywright();
  exe = findBrowser();
  const why = browserSkipReason({ pw, exe });
  if (why) { unavailable = why; return; }
  await ensureDist();
  mkdirSync(SHOTS_DIR, { recursive: true });
  resetBackend();
  const dist = path.join(REPO_ROOT, "dist");
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(u.pathname);
    if (pathname === "/api/teams" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ teams: TEAMS, folders: [], revision: "c2-demo" }));
      return;
    }
    if (pathname === "/__vibesquad/decisions" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, items: state.items, count: state.items.length, agentsOk: true, generatedAt: new Date().toISOString() }));
      return;
    }
    if (pathname === "/__vibesquad/decisions/answer" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        const validated = validateAnswerBatch(body);
        const results = [];
        for (const ans of validated) {
          const item = state.items.find((i) => i.id === ans.id);
          if (!item) { results.push({ id: ans.id, choice: ans.choice, status: "rejected", error: "unknown" }); continue; }
          const prompt = buildAnswerPrompt(item, ans, { ownerName: "Owner", target: item.asker?.title, via: "asker" });
          state.deliveredPrompts.push({ id: ans.id, choice: ans.choice, altIndex: ans.altIndex, text: ans.text, prompt });
          state.items = state.items.filter((i) => i.id !== ans.id);
          results.push({ id: ans.id, choice: ans.choice, status: ans.choice === "dismiss" ? "dismissed" : "delivered", target: item.askerId, via: "asker", logged: true });
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, results }));
      });
      return;
    }
    if (pathname === "/__vibesquad/log" && req.method === "GET") {
      const team = u.searchParams.get("team") || "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(state.logs[team] ?? []));
      return;
    }
    let fp = path.join(dist, pathname === "/" ? "index.html" : pathname);
    if (!existsSync(fp) || statSync(fp).isDirectory()) { res.statusCode = 404; res.end("nf"); return; }
    res.setHeader("content-type", MIME[path.extname(fp).toLowerCase()] ?? "application/octet-stream");
    createReadStream(fp).on("error", () => { res.statusCode = 404; res.end(); }).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] });
});

after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r()));
});

async function openDesk({ theme, width, height, dpr = 1 }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, colorScheme: theme });
  await context.addInitScript(`try{ localStorage.setItem("vs.vibePicked","1"); const p=JSON.parse(localStorage.getItem("vs.prefs.v1")||"{}"); localStorage.setItem("vs.prefs.v1", JSON.stringify({...p,"app.theme":"${theme}"})); }catch{}`);
  const page = await context.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${baseUrl}/?demo=`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="boring-decision-card-ny-00000000000000000001"]', { timeout: 20000 });
  await page.waitForTimeout(400);
  return { context, page, errs };
}

for (const cfg of [
  { name: "dark-1920", theme: "dark", width: 1920, height: 1080, dpr: 1, fullDrive: true },
  { name: "light-1920", theme: "light", width: 1920, height: 1080, dpr: 1, fullDrive: false },
  { name: "dark-3200", theme: "dark", width: 3200, height: 1800, dpr: 1.2, fullDrive: false },
  { name: "light-3200", theme: "light", width: 3200, height: 1800, dpr: 1.2, fullDrive: false },
]) {
  test(`C2 e2e (${cfg.name}): option definitions wrap, Show source plain text, mixed ask sends one prompt`, async (t) => {
    if (unavailable) { t.skip(unavailable); return; }
    resetBackend();
    const { context, page, errs } = await openDesk(cfg);
    try {
      const pfId = "ny-00000000000000000001";
      const svId = "ny-00000000000000000002";
      const plainId = "ny-00000000000000000003";

      // 1. Option buttons show full definitions and wrap instead of truncating
      const altA = page.locator(`[data-testid="boring-decision-alt-${pfId}-0"]`);
      const altB = page.locator(`[data-testid="boring-decision-alt-${pfId}-1"]`);
      const altC = page.locator(`[data-testid="boring-decision-alt-${pfId}-2"]`);
      assert.equal(await altA.textContent(), "A: fill-or-kill at entry — cancel the order unless it fills completely");
      assert.equal(await altB.textContent(), "B: keep the partial fill and resize the stop to the filled size");
      assert.equal(await altC.textContent(), "C: top up the remainder at the next bar's open");
      assert.equal(await altA.evaluate((el) => getComputedStyle(el).whiteSpace), "normal", "option buttons wrap");

      const svA = page.locator(`[data-testid="boring-decision-alt-${svId}-0"]`);
      const svB = page.locator(`[data-testid="boring-decision-alt-${svId}-1"]`);
      assert.equal(await svA.textContent(), "a: survivor-only — keep only listed tickers and report coverage %");
      assert.equal(await svB.textContent(), "b: stop at A1 — ship the A1 universe and defer delisted data");

      // Plain structured card without context has no Show source toggle
      assert.equal(await page.locator(`[data-testid="boring-decision-source-toggle-${plainId}"]`).count(), 0);

      // 2. Show source expands to the excerpt (keyboard accessible, aria-expanded)
      const pfToggle = page.locator(`[data-testid="boring-decision-source-toggle-${pfId}"]`);
      assert.equal(await pfToggle.getAttribute("aria-expanded"), "false");
      await pfToggle.focus();
      await page.keyboard.press("Enter");
      assert.equal(await pfToggle.getAttribute("aria-expanded"), "true");
      const pfBody = page.locator(`[data-testid="boring-decision-source-body-${pfId}"]`);
      assert.match((await pfBody.textContent()) ?? "", /A\) fill-or-kill at entry/);
      const bodyStyle = await pfBody.evaluate((el) => ({
        ws: getComputedStyle(el).whiteSpace,
        ovY: getComputedStyle(el).overflowY,
        maxH: parseFloat(getComputedStyle(el).maxHeight),
      }));
      assert.equal(bodyStyle.ws, "pre-wrap");
      assert.equal(bodyStyle.ovY, "auto");
      assert.ok(bodyStyle.maxH > 180 && bodyStyle.maxH <= 260, `max-height ~12 lines: ${bodyStyle.maxH}`);

      // Capture viewport shot with Show source expanded on card 1
      await page.screenshot({ path: path.join(SHOTS_DIR, `${cfg.name}.png`), fullPage: false });

      if (cfg.fullDrive) {
        // 3. HTML-looking context renders strictly as plain text (no DOM injection, no script execution)
        const svToggle = page.locator(`[data-testid="boring-decision-source-toggle-${svId}"]`);
        await svToggle.click();
        const svBody = page.locator(`[data-testid="boring-decision-source-body-${svId}"]`);
        const svCheck = await svBody.evaluate((el) => ({
          text: el.textContent,
          childElements: el.querySelectorAll("*").length,
          xss: window.__c2xss,
        }));
        assert.equal(svCheck.childElements, 0, "HTML-looking context creates zero child DOM elements");
        assert.equal(svCheck.xss, undefined, "no script/onerror executed");
        assert.match(svCheck.text ?? "", /<script>window\.__c2xss=2<\/script>/, "tags appear literally as text");
        assert.match(svCheck.text ?? "", /<b>not-bold<\/b>/, "bold tag appears literally as text");

        // 4. Mixed ask: pick B + type veto reply, verify survives F1 toggle, then send ONE prompt with both lines
        await altB.click();
        assert.equal(await altB.getAttribute("aria-pressed"), "true");
        const pfInput = page.locator(`[data-testid="boring-decision-input-${pfId}"]`);
        await pfInput.fill("Yes, add a 30s veto window");

        // F1 filter toggle preserves staged mixed-ask answer
        await page.locator('[data-testid="boring-decision-pill-vibesquad"]').click();
        assert.equal(await page.locator('[data-testid="boring-decision-send-btn"]').textContent(), "Send 0 answers (+1 hidden)");
        await page.locator('[data-testid="boring-decision-pill-vibesquad"]').click();
        assert.equal(await altB.getAttribute("aria-pressed"), "true", "option B survived F1 toggle");
        assert.equal(await pfInput.inputValue(), "Yes, add a 30s veto window", "veto reply survived F1 toggle");
        assert.equal(await page.locator('[data-testid="boring-decision-send-btn"]').textContent(), "Send 1 answer");

        // Send now (skipping 5s undo wait via Send now button)
        await page.locator('[data-testid="boring-decision-send-btn"]').click();
        await page.waitForSelector('[data-testid="boring-decision-send-now-btn"]', { timeout: 5000 });
        await page.locator('[data-testid="boring-decision-send-now-btn"]').click();
        await page.waitForFunction(() => !document.querySelector('[data-testid="boring-decision-card-ny-00000000000000000001"]'), { timeout: 10000 });

        assert.equal(state.deliveredPrompts.length, 1, "sent ONE prompt for the mixed ask");
        const delivered = state.deliveredPrompts[0];
        assert.equal(delivered.choice, "alt");
        assert.equal(delivered.altIndex, 1);
        assert.equal(delivered.text, "Yes, add a 30s veto window");
        assert.match(delivered.prompt, /Owner's answer: Go with option 2: "B: keep the partial fill and resize the stop to the filled size"\./);
        assert.match(delivered.prompt, /--- BEGIN owner reply \(Owner\) ---\nYes, add a 30s veto window\n--- END owner reply ---/);
      }

      assert.deepEqual(errs, [], `no pageerrors: ${errs.join("; ")}`);
    } finally {
      await context.close();
    }
  });
}
