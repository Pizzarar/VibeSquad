// HP1-HP3 (docs/PLAN_HUB_PAGES.md): Sky / Tower pages over a shared skyline backdrop.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { HUB_PAGE_KEY, backdropScale, backdropStyle, miniFaceJump, parseHubPage, readHubPage, validateHubBackdrop, writeHubPage } from "../src/hubPagesLogic.ts";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const json = JSON.parse(readFileSync(new URL("../public/office/hub-backdrop.json", import.meta.url), "utf8"));
const mem = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, v) };
};

test("page choice: defaults to Sky, persists, junk reads as Sky", () => {
  const s = mem();
  assert.equal(readHubPage(s), "sky");
  writeHubPage("tower", s);
  assert.equal(s.getItem(HUB_PAGE_KEY), "tower");
  assert.equal(readHubPage(s), "tower");
  assert.equal(parseHubPage("bogus"), "sky");
  assert.equal(readHubPage({ getItem: () => { throw new Error("denied"); }, setItem() {} }), "sky");
});

test("mini-face click: Sky page with that bot's chat open", () => {
  assert.deepEqual(miniFaceJump("riffbot"), { page: "sky", open: "riffbot" });
  assert.deepEqual(miniFaceJump("overlord"), { page: "sky", open: "overlord" });
  const hp = src("HubPages.tsx");
  assert.match(hp, /setJump\(j\.open\);\s*setPage\(j\.page\);/);
  assert.match(hp, /sky\(jump\)/);
  assert.match(src("SkyZones.tsx"), /useState<SkyOpen>\(initialOpen\)/);
  assert.match(src("App.tsx"), /initialOpen=\{open\}/);
});

test("switcher: both pages render the same needs-you strip; the tower sits in a fixed non-scrolling box", () => {
  const hp = src("HubPages.tsx");
  assert.equal((hp.match(/\{strip\}/g) || []).length, 2);
  assert.match(hp, /data-testid=\{`hub-tab-\$\{p\}`\}/);
  assert.match(hp, /role="tablist"/);
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.hub-tower-box \{[^}]*overflow: hidden/);
  assert.match(css, /\.hub-tower-box \.sq-floor \{[^}]*overflow: hidden/);
  assert.match(css, /\.hub-sky-page \.sky-zones \{ flex: none; height: clamp\(/); // HP2 cap
  assert.doesNotMatch(css, /\.hub-(tab|pages|backdrop)[^{]*\{[^}]*(transition|animation)/); // instant switch, reduced motion or not
});

test("backdrop: A1 json validates; tile centre under the tower, bottom row on the plate, repeat-x", () => {
  const m = validateHubBackdrop(json);
  assert.ok(m);
  assert.equal(m.w, 640);
  const st = backdropStyle(m, 1600, "dark", 1, 6);
  assert.equal(st.backgroundRepeat, "repeat-x");
  assert.equal(st.backgroundSize, "1280px 720px"); // 640 native * integer scale 2 (1600 / 640 = 2.5 -> 2)
  assert.equal(st.backgroundPosition, "160px calc(100% - 6px)"); // (1600 - 1280) / 2: tile x=320 sits at the centre line
  assert.equal(st.backgroundColor, json.top.dark);
  assert.equal(backdropStyle(m, 1600, "light").backgroundColor, json.top.light);
  assert.equal(backdropScale(3200, 640, 1.2), Math.floor((3200 * 1.2) / 640) / 1.2);
  assert.equal(backdropScale(500, 640, 1), 1);
});

test("backdrop absent or malformed: validate says null and the fallback band + gradient takes over", () => {
  assert.equal(validateHubBackdrop(undefined), null);
  assert.equal(validateHubBackdrop({ w: 640 }), null);
  assert.equal(validateHubBackdrop({ ...json, repeat: "none" }), null);
  const hp = src("HubPages.tsx");
  assert.match(hp, /if \(model && artOk\) return/);
  assert.match(hp, /hub-backdrop is-fallback/);
  assert.match(hp, /useImageOk\(!artOk \? SKY_URL\(theme\) : null\)/);
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.hub-backdrop\.is-fallback \{ background-image: linear-gradient/);
});

test("regression guard: Riff's TV face swap line is untouched", () => {
  assert.match(src("SkyZones.tsx"), /const shown = isRiff \? skyLeftBot\(landed\) : zone\.bot;/);
  assert.match(src("skyZonesLogic.ts"), /export const SKY_COLUMNS = "minmax\(0, 1fr\) minmax\(0, 1fr\)"/); // fixed 50/50
});
