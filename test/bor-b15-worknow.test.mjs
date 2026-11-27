// B15 (idea-918): full-width segregated "Working now" strip. DOM-render assertions: the real BoringWorkingNow is rendered to markup,
// mounted in Chromium inside a .drawer > header / strip / .drawer-shell(chat col + ctx panel) skeleton with the real boring.css,
// and measured. Skips the browser half cleanly when Playwright/Chromium is unavailable.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "rolldown/utils";
import { resolvePlaywright, PLAYWRIGHT_INSTALL_CMD } from "../scripts/ui-overlap/env.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const dir = mkdtempSync(join(tmpdir(), "vs-b15-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const reactUrl = import.meta.resolve("react");
writeFileSync(join(dir, "boringBusts.mjs"), `export const bustRoleForAgent = (a) => (a && a.labels && a.labels.role) || "worker"; export const bustUrl = (role) => "data:image/svg+xml;utf8," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' fill='#7a8'/></svg>");\n`);
const code = transformSync("BoringWorkingNow.tsx", read("src", "BoringWorkingNow.tsx"), { lang: "tsx", jsx: { runtime: "classic" } }).code
  .replace(/import \{ openAgent \} from "\.\/panes";/, "const openAgent = () => {};")
  .replace(/import \{ isHubLaneId \} from "\.\/teams";/, "const isHubLaneId = () => false;")
  .replace(/import \{ agentDisplayName \} from "\.\/identity";/, "const agentDisplayName = (a) => a.title;")
  .replace(/from "\.\/boringBusts"/, 'from "./boringBusts.mjs"')
  .replace(/import \{ useTheme \} from "\.\/useBotFace";/, 'const useTheme = () => "dark";')
  .replace(/import \{ etClock \} from "\.\/etTime";/, 'const etClock = (d) => new Date(d).toISOString().slice(11, 16);')
  .replace(/^import type .*$/gm, "");
writeFileSync(join(dir, "BoringWorkingNow.mjs"), `import React from ${JSON.stringify(reactUrl)};\n` + code);
const { BoringWorkingNow } = await import(pathToFileURL(join(dir, "BoringWorkingNow.mjs")).href);

const me = { id: "me", title: "Buddy", status: "idle", labels: { role: "brainstorm" } };
const run = (id, extra = {}) => ({ id, title: `Worker ${id}`, status: "running", labels: { role: "worker" }, activeTurn: { startedAt: "2026-11-25T14:05:00Z" }, ...extra });
const render = (agent, members, subs = 0, attention) => renderToStaticMarkup(React.createElement(BoringWorkingNow, { agent, members: members.map((a) => ({ agent: a })), subs, attention }));

test("markup: single agent has no data-multi and no chip row; 2+ agents set data-multi with a bust row + aria labels", () => {
  const one = render(me, [run("w1")]);
  assert.doesNotMatch(one, /data-multi/);
  assert.doesNotMatch(one, /boring-now-chips/);
  const many = render(me, [run("w1"), run("w2"), run("w3")]);
  assert.match(many, /data-multi="true"/);
  assert.match(many, /data-testid="boring-working-now-w2"[^>]*aria-label="Open Worker w2, thinking"/);
  assert.match(many, /title="Open Worker w3 · thinking"/);
  assert.doesNotMatch(many, /boring-working-now-w1"/); // focal agent is the big bust, not a chip
  assert.match(many, /width="48" height="48"/); // focal bust
});

test("markup: more than six others collapse to a +N badge; needs-you suppresses the row", () => {
  const eight = render(me, Array.from({ length: 9 }, (_, i) => run(`w${i}`)));
  assert.equal((eight.match(/boring-now-chip"/g) ?? []).length, 6);
  assert.match(eight, /data-testid="boring-working-now-more"[^>]*>\+2</);
  const blocked = render(me, [run("w1"), run("w2")], 0, { tone: "permission", reason: "x" });
  assert.doesNotMatch(blocked, /boring-now-chip/);
  assert.match(blocked, /data-state="needs-you"/);
});

const chromium = resolvePlaywright({ npx: false })?.chromium ?? null;
const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const skip = chromium && exe ? false : `no Playwright/Chromium (set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH; Playwright: ${PLAYWRIGHT_INSTALL_CMD})`;

const page = (strip, perm = false) => `<!doctype html><html data-vibe="boring" data-theme="dark"><head><meta charset="utf-8"><style>${read("src", "boring.css")}</style></head><body style="margin:0;width:1280px;height:720px;display:flex">
<div class="boring-drawer drawer" id="d"><div id="hdr" style="height:56px;flex:none">header</div>${strip}
<div class="drawer-shell"><div class="boring-convo-col"><div class="boring-perm-stack" style="height:${perm ? 120 : 0}px"></div><div class="timeline-col" style="flex:1">chat</div></div><aside id="panel" style="width:340px;flex:none">panel</aside></div></div></body></html>`;

async function measure(strip, perm = false) {
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  try {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await p.setContent(page(strip, perm));
    return await p.evaluate(() => {
      const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, display: getComputedStyle(e).display }; };
      const cs = getComputedStyle(document.querySelector(".boring-now") ?? document.body);
      return { drawer: r("#d"), hdr: r("#hdr"), strip: r(".boring-now"), big: r(".boring-now-big"), chip: r(".boring-now-chip"), col: r(".boring-convo-col"), panel: r("#panel"), radius: cs.borderTopLeftRadius, bottom: cs.borderBottomWidth, scrollW: document.querySelector(".boring-now")?.scrollWidth, clientW: document.querySelector(".boring-now")?.clientWidth };
    });
  } finally { await browser.close(); }
}

test("DOM: single-agent strip is one compact line (<=48px), full drawer width, directly under the header, above chat + panel", { skip }, async () => {
  const m = await measure(render(me, [run("w1")], 1));
  assert.ok(m.strip.h <= 48 && m.strip.h >= 44, `strip height ${m.strip.h}`);
  assert.equal(m.strip.w, m.drawer.w);
  assert.equal(m.strip.x, m.drawer.x);
  assert.equal(m.strip.y, m.hdr.y + m.hdr.h);
  assert.ok(m.col.y >= m.strip.y + m.strip.h - 0.5 && m.panel.y >= m.strip.y + m.strip.h - 0.5, "chat + panel start below the strip");
  assert.ok(m.big.w >= 32 && m.big.w <= 36);
  assert.equal(m.radius, "0px"); // flush bar, not a floating card
  assert.equal(m.bottom, "1px");
});

test("DOM: multi-agent strip grows the focal bust to 48px and shows a row of 30px busts, still full width", { skip }, async () => {
  const m = await measure(render(me, [run("w1"), run("w2"), run("w3"), run("w4")], 0));
  assert.equal(m.strip.w, m.drawer.w);
  assert.equal(Math.round(m.big.w), 48);
  assert.equal(Math.round(m.chip.w), 30);
  assert.ok(m.strip.h <= 66, `multi strip height ${m.strip.h}`);
  assert.ok(m.scrollW <= m.clientW + 1, "no horizontal overflow");
});

test("DOM: strip with a pending permission is collapsed (n8) and the perm stack stays in the chat column", { skip }, async () => {
  const perm = { ...me, pendingPermissions: [{}] };
  const m = await measure(render(perm, [], 0), true);
  assert.equal(m.strip.display, "none");
  assert.ok(m.col.w < m.drawer.w, "perm stack lives inside the chat column, not full width");
});

test("DOM: Normal-only — without data-vibe=boring the strip rules do not apply (Psycho untouched)", { skip }, async () => {
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  try {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await p.setContent(page(render(me, [run("w1")], 1)).replace('data-vibe="boring"', 'data-vibe="fun"'));
    assert.notEqual(await p.evaluate(() => getComputedStyle(document.querySelector(".boring-now")).borderBottomWidth === "1px" && getComputedStyle(document.querySelector(".boring-now")).minHeight === "46px"), true);
  } finally { await browser.close(); }
});
