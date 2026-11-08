// C2b G6: big faces filling the sky zones, Overlord expands over Riff (Riff scared), faces.json `scared`.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const logic = await import("../src/skyZonesLogic.ts");
import { SKY_COLUMNS, SKY_POPOVER_SELECTOR, faceBg, faceContain, hasFaceMode, skyEffectiveOpen, skyEscCloses, skyExit, skyOutsideCloses, skyFaceClick, skyRiffMode } from "../src/skyZonesLogic.ts";
import { faceFrame, validateFaces } from "../src/squadFloorLogic.ts";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const can = { riffbot: true, overlord: true };
const noOverlord = { riffbot: true, overlord: false };

test("rest -> riff -> rest: clicking Riff's face opens his chat, clicking it again closes", () => {
  const open = skyFaceClick(null, "riffbot", can);
  assert.equal(open, "riffbot");
  assert.equal(skyRiffMode(open, true), null); // Riff keeps his own faces; no takeover
  assert.equal(skyFaceClick(open, "riffbot", can), null);
});

test("rest -> overlord -> rest: the Overlord opens (Riff scared), re-click of the left TV (the open bot's face) closes", () => {
  const open = skyFaceClick(null, "overlord", can);
  assert.equal(open, "overlord");
  assert.equal(skyRiffMode(open, true), "scared");
  assert.equal(skyRiffMode(open, false), "idle"); // no scared in faces.json
  assert.equal(skyFaceClick(open, "riffbot", can), null);
});

test("Esc, a click outside the sky and the chat's x all go back to rest from either open state", () => {
  for (const o of ["riffbot", "overlord"]) assert.equal(skyExit(o), null);
  assert.equal(skyExit(null), null);
});

test("the right TV's face is not a click target while a chat covers it", () => {
  assert.equal(skyFaceClick("riffbot", "overlord", can), "riffbot");
  assert.equal(skyFaceClick("overlord", "overlord", can), "overlord");
});

test("no Overlord: Riff still opens (his chat covers the static), the Overlord cannot be opened", () => {
  assert.equal(skyFaceClick(null, "riffbot", noOverlord), "riffbot");
  assert.equal(skyFaceClick(null, "overlord", noOverlord), null);
  assert.equal(skyEffectiveOpen("riffbot", noOverlord), "riffbot");
});

test("the Overlord going away under its open chat drops to rest; no RiffBot agent cannot open Riff", () => {
  assert.equal(skyEffectiveOpen("overlord", noOverlord), null);
  assert.equal(skyEffectiveOpen("overlord", can), "overlord");
  assert.equal(skyEffectiveOpen(null, can), null);
  assert.equal(skyFaceClick(null, "riffbot", { riffbot: false, overlord: true }), null);
  assert.equal(skyEffectiveOpen("riffbot", { riffbot: false, overlord: true }), null);
});

test("width never changes: one fixed 50/50 grid, whatever is open; no expand/squeeze code is left", () => {
  assert.equal(SKY_COLUMNS, "minmax(0, 1fr) minmax(0, 1fr)");
  const sky = src("SkyZones.tsx");
  const logic = src("skyZonesLogic.ts");
  const css = src("styles.css");
  assert.ok(sky.includes('["--sky-cols" as string]: SKY_COLUMNS'));
  for (const gone of ["OVERLORD_EXPAND_PCT", "skyLayout", "skyColumns", "riffMinWidth", "onReclaim", "squeezed"]) {
    assert.ok(!sky.includes(gone) && !logic.includes(gone), `${gone} is gone`);
  }
  assert.ok(!css.includes("is-expanded") && !css.includes("--sky-chat-h"));
  assert.ok(!/\.sky-zones \{[^}]*transition: grid-template-columns/.test(css));
  // Open state is click-set only: no focus handlers, no talking/pose input.
  assert.ok(!sky.includes("onFocus") && !sky.includes("overlordTalking") && !/pose === "work"/.test(sky));
});

test("faceContain: integer scale, whole cell fits (never cropped), centred sideways, anchored to the bottom", () => {
  const cell = { w: 48, h: 48 };
  assert.deepEqual(faceContain(cell, { w: 700, h: 400 }), { k: 8, left: 158, top: 16 }); // wide box: height decides, side gutters, slack (16) at the top
  assert.deepEqual(faceContain(cell, { w: 200, h: 500 }), { k: 4, left: 4, top: 308 }); // squeezed/tall: width decides, the gap is at the TOP only
  assert.deepEqual(faceContain(cell, { w: 480, h: 480 }), { k: 10, left: 0, top: 0 }); // square
  assert.deepEqual(faceContain({ w: 128, h: 96 }, { w: 500, h: 300 }), { k: 3, left: 58, top: 12 }); // cell from faces.json, never hardcoded
  assert.equal(faceContain(cell, { w: 0, h: 0 }).k, 0); // not measured yet
  assert.equal(faceContain(cell, { w: 30, h: 30 }).k, 1); // smaller than one cell: min 1 (the only crop case)
  for (const box of [{ w: 700, h: 400 }, { w: 200, h: 500 }, { w: 560, h: 497 }, { w: 1306, h: 497 }, { w: 96, h: 96 }, { w: 143, h: 400 }]) {
    const c = faceContain(cell, box);
    assert.ok(Number.isInteger(c.k) && Number.isInteger(c.left) && Number.isInteger(c.top));
    assert.ok(c.left >= 0 && c.top >= 0 && c.left + cell.w * c.k <= box.w && c.top + cell.h * c.k <= box.h, `face fits inside ${JSON.stringify(box)}`);
  }
});

test("faceContain bottom anchoring: the face's bottom edge is the box's bottom edge, never a gap below", () => {
  const cell = { w: 48, h: 48 };
  for (const box of [{ w: 700, h: 400 }, { w: 1306, h: 497 }, { w: 560, h: 497 }, { w: 368, h: 497 }, { w: 216, h: 497 }, { w: 143, h: 400 }, { w: 480, h: 481 }, { w: 481, h: 999 }]) {
    const c = faceContain(cell, box);
    assert.equal(c.top + cell.h * c.k, box.h, `no gap below at ${JSON.stringify(box)}`);
  }
  // Height-driven (normal) case: the slack at the top is under one scale step.
  const c = faceContain(cell, { w: 1306, h: 497 });
  assert.ok(c.top >= 0 && c.top < cell.h);
  // Width-forced (squeezed Riff): the gap goes to the top, larger than a step, still nothing below.
  const sq = faceContain(cell, { w: 100, h: 497 });
  assert.equal(sq.k, 2);
  assert.ok(sq.top > cell.h);
  assert.equal(sq.top + cell.h * sq.k, 497);
});

// ── faces.json `scared` ──
const frames = (...xs) => xs.map((x) => ({ x, y: 0 }));
const faces = (extra = {}) => ({
  cell: { w: 48, h: 48 },
  fps: 3,
  riffbot: { idle: frames(0), ...extra },
  overlord: { idle: frames(0) },
});

test("validateFaces: scared is optional and parsed when present", () => {
  const without = validateFaces(faces());
  assert.equal(without.ok, true);
  assert.equal(hasFaceMode(without.value, "riffbot", "scared"), false);
  const withS = validateFaces(faces({ scared: frames(48, 96) }));
  assert.equal(withS.ok, true);
  assert.equal(hasFaceMode(withS.value, "riffbot", "scared"), true);
  assert.deepEqual(faceFrame(withS.value, "riffbot", "scared", 1), { x: 96, y: 0 });
  assert.deepEqual(faceFrame(without.value, "riffbot", "scared", 1), { x: 0, y: 0 }); // missing mode → idle
  assert.equal(hasFaceMode(null, "riffbot", "scared"), false);
});

test("validateFaces: idle stays required, an unknown extra mode is ignored, a malformed scared is rejected", () => {
  assert.equal(validateFaces({ ...faces(), riffbot: { scared: frames(0) } }).ok, false);
  const extra = validateFaces(faces({ scared: frames(0), wobble: frames(5) }));
  assert.equal(extra.ok, true);
  assert.equal("wobble" in extra.value.bots.riffbot, false);
  assert.equal(validateFaces(faces({ scared: [] })).ok, false);
});

test("wiring: the face fills the TV, the thumbnail is gone, Riff gets the forced mode, no new loader", () => {
  const sky = src("SkyZones.tsx");
  assert.ok(sky.includes("faceContain(cell, box, dpr)") && !sky.includes("faceCover"));
  assert.ok(!sky.includes("sky-face-box") && !sky.includes("sky-crt-head"));
  assert.ok(sky.includes("force={skyRiffMode(open,"));
  assert.ok(sky.includes("taken={open === \"overlord\"}")); // G7 takeover runs off the explicit open state
  assert.equal((sky.match(/<DrawerSlot/g) || []).length, 1); // each sky bot's chat is still mounted once
  assert.ok(src("useBotFace.ts").includes("force ?? ("));
  const css = src("styles.css");
  assert.ok(/\.sky-face-area \{ position: absolute; inset: 0; \}/.test(css)); // no chat-height cut
  assert.ok(/\.sky-zone\.sky-chat-panel \{ grid-column: 2; grid-row: 1;/.test(css)); // chat lands on the right TV
  assert.ok(/prefers-reduced-motion: reduce\) \{\s*\.sky-chat-panel:not\(\[hidden\]\) \{ animation: none; \}/.test(css));
});

test("exit paths: Esc, outside click, x on the chat, face re-click are all wired; panels are hidden (not unmounted) at rest", () => {
  const sky = src("SkyZones.tsx");
  assert.ok(sky.includes('e.key !== "Escape" || !skyEscCloses(openRef.current, e.defaultPrevented,') && sky.includes("setOpen(skyExit)"));
  assert.ok(sky.includes("e.preventDefault(); // this Esc closed the chat")); // the app's Esc (to Squads Home) must not also fire
  assert.ok(sky.includes("skyOutsideCloses(!!t && !!root.current?.contains(t)"));
  assert.ok(sky.includes('document.addEventListener("pointerdown", down, true)'));
  assert.ok(sky.includes("onClick={onClose}") && sky.includes("onClick={onFace}"));
  assert.ok(sky.includes("hidden={panel && !isOpen}"));
  assert.equal((sky.match(/<Zone /g) || []).length, 2 + 2); // two TVs + two chat panels
});

// ── G6-fix2: gutter colour + Riff's minimum strip ──
test("faces.json bg: {dark, light} per bot, both valid → used per theme; any other shape → whole field ignored (CSS variable)", () => {
  const bg = { dark: "#2a1b6b", light: "#95d3f2" };
  const ok = validateFaces({ ...faces(), riffbot: { idle: frames(0), bg }, overlord: { idle: frames(0), bg: { dark: "rgb(20, 30, 40)", light: "#fff" } } });
  assert.equal(ok.ok, true);
  assert.equal(faceBg(ok.value, "riffbot", "dark"), "#2a1b6b");
  assert.equal(faceBg(ok.value, "riffbot", "light"), "#95d3f2");
  assert.equal(faceBg(ok.value, "overlord", "dark"), "rgb(20, 30, 40)");
  assert.equal(faceBg(ok.value, "overlord", "light"), "#fff");
  const bad = [
    "#2a1b6b", // the old plain-string form is dropped
    { dark: "#2a1b6b" }, // a key missing
    { light: "#95d3f2" },
    { dark: "#2a1b6b", light: "url(x)" }, // one invalid → the whole field is invalid
    { dark: "red; x:y", light: "#95d3f2" },
    { dark: 5, light: "#95d3f2" },
    { dark: "#12", light: "#95d3f2" },
    {}, [], null, 5,
  ];
  for (const b of bad) {
    const v = validateFaces({ ...faces(), riffbot: { idle: frames(0), bg: b } });
    assert.equal(v.ok, true, `invalid bg ${JSON.stringify(b)} must not reject the file`);
    for (const t of ["dark", "light"]) assert.equal(faceBg(v.value, "riffbot", t), null);
  }
  assert.equal(faceBg(validateFaces(faces()).value, "riffbot", "dark"), null);
  assert.equal(faceBg(null, "riffbot", "light"), null);
  const css = src("styles.css");
  assert.ok(/--sky-face-bg-dark: #[0-9a-f]{6}/i.test(css) && /--sky-face-bg-light: #[0-9a-f]{6}/i.test(css));
  assert.ok(css.includes("var(--sky-face-bg-custom, var(--sky-face-bg-dark))"));
  assert.ok(src("SkyZones.tsx").includes("--sky-face-bg-custom") && src("SkyZones.tsx").includes("faceBg(faces, zone.bot, theme)"));
});

test("Esc yields to a popover/dialog or an already-handled key; outside clicks inside a portalled popover do not close", () => {
  assert.equal(skyEscCloses("riffbot", false, false), true);
  assert.equal(skyEscCloses("overlord", false, false), true);
  assert.equal(skyEscCloses(null, false, false), false); // rest: the app's Esc
  assert.equal(skyEscCloses("riffbot", true, false), false); // something handled it already
  assert.equal(skyEscCloses("riffbot", false, true), false); // slash menu / modal up: it dismisses first
  assert.equal(skyOutsideCloses(false, false), true);
  assert.equal(skyOutsideCloses(true, false), false);
  assert.equal(skyOutsideCloses(false, true), false); // portalled popover
  for (const sel of [".modal-back", "[role='dialog']", "[role='menu']", "[role='listbox']", ".composer-menu"]) assert.ok(SKY_POPOVER_SELECTOR.includes(sel), sel);
  const sky = src("SkyZones.tsx");
  assert.ok(sky.includes("t?.closest(SKY_POPOVER_SELECTOR)") && sky.includes("document.querySelector(`${SKY_POPOVER_SELECTOR}:not([hidden])`)"));
});

test("a11y: while a chat is open the left TV's face button is named for the open bot (Close Overlord chat)", () => {
  const sky = src("SkyZones.tsx");
  assert.ok(sky.includes("aria-label={isOpen ? `Close ${openLabel} chat` : `Open ${label} chat`}"));
  assert.ok(sky.includes("openLabel={open ? LABEL[open] : undefined}"));
  assert.ok(sky.includes("openLabel ??= label")); // rest / the right TV keep their own name
});

test("chat-only header drops the no-op Dock button and the duplicate x; wrapped working chips are not clipped", () => {
  const h = src("DrawerHeader.tsx");
  assert.ok(h.includes("{!chatOnly && <button") && h.includes("{!compact && !chatOnly && ("));
  assert.ok(/chatOnly=\{chatOnly\}\s*\/>/.test(src("AgentDrawer.tsx")));
  assert.ok(src("styles.css").includes(".sky-chat-panel .drawer-subagents-bar { max-height: none; }"));
});

test("G8b: thinner bezels need no code change - small slice/scale values validate, size the border from JSON, nothing hardcodes the old 60px sides / 90px chin", async () => {
  const { validateSkyCrt, skyCrtStyle } = await import("../src/skyZonesLogic.ts");
  const v = validateSkyCrt({ slice: { top: 4, right: 4, bottom: 6, left: 4 }, scale: 2, repeat: "round" });
  assert.equal(v.ok, true);
  const st = skyCrtStyle(v.value, "/office/sky-crt-dark.png");
  assert.equal(st.borderWidth, "8px 8px 12px 8px"); // slice x scale per side: the screen inset follows the JSON
  assert.equal(st.borderImageSlice, "4 4 6 4 fill");
  assert.equal(skyCrtStyle(validateSkyCrt({ slice: { top: 1, right: 1, bottom: 1, left: 1 }, scale: 1.5 }).value, "u").borderWidth, "1px 1px 1px 1px"); // G8e: a fractional scale snaps down to whole device px (dpr 1: 1px)
  assert.equal(skyCrtStyle(validateSkyCrt({ slice: { top: 1, right: 1, bottom: 1, left: 1 }, scale: 1.5 }).value, "u", 2).borderWidth, "1.5px 1.5px 1.5px 1.5px"); // 3 device px at dpr 2
  assert.equal(validateSkyCrt({ slice: { top: 0, right: 4, bottom: 6, left: 4 }, scale: 2 }).ok, false); // zero slice still rejected
  const css = src("styles.css");
  const sky = css.slice(css.indexOf(".sky-zones {"), css.indexOf("/* G7 virus takeover"));
  assert.ok(!/(60|90)px/.test(sky), "no old bezel side/chin size in the sky rules");
  assert.ok(!src("SkyZones.tsx").includes("bezelH")); // the screen is whatever is inside the border box
});

// ── G8c: the wall ──
test("G8c wall (H1e contract): optional sky-crt.json key {width, scale?, slice?, repeat?}; absent or bad -> ignored (CSS seam)", () => {
  const { validateSkyCrt, parseWall, skyWallStyle, SKY_WALL_URL } = logic;
  const shipped = JSON.parse(readFileSync(new URL("../public/office/sky-crt.json", import.meta.url), "utf8"));
  assert.equal(validateSkyCrt(shipped).ok, true); // whatever sky-crt.json is on this branch parses
  const real = { slice: { top: 3, right: 3, bottom: 5, left: 3 }, scale: 3, repeat: "round", wall: { width: 4, scale: 3, slice: { top: 3, bottom: 5 }, repeat: "round" } };
  const v = validateSkyCrt(real);
  assert.equal(v.ok, true);
  assert.deepEqual(v.value.wall, { width: 4, scale: 3, slice: { top: 3, bottom: 5 }, repeat: "round" });
  const crt = (wall) => ({ slice: { top: 14, right: 20, bottom: 30, left: 20 }, scale: 3, repeat: "round", ...(wall === undefined ? null : { wall }) });
  assert.equal("wall" in validateSkyCrt(crt()).value, false); // absent -> no wall
  assert.deepEqual(parseWall({ width: 2 }), { width: 2, repeat: "round" }); // scale, slice optional; repeat defaults round
  assert.equal(parseWall({ width: 2, repeat: "stretch" }).repeat, "stretch");
  assert.equal(parseWall({ width: 2, repeat: "tile" }).repeat, "round");
  assert.equal(SKY_WALL_URL("light"), "/office/sky-wall-light.png"); // no src key: the name is fixed
  assert.equal("src" in parseWall({ width: 2, src: "x.png" }), false);
  for (const bad of [{ width: 0 }, { width: -2 }, { width: 1.5 }, { width: "6" }, { w: 6 }, {}, null, 5, "x", []]) {
    const r = validateSkyCrt(crt(bad));
    assert.equal(r.ok, true, "a bad wall never rejects the bezel");
    assert.equal("wall" in r.value, false, JSON.stringify(bad));
  }
  assert.equal(parseWall({ width: 3, slice: { top: -1, bottom: 2.5 } }).slice, undefined); // bad slice dropped, wall kept
  assert.equal("scale" in parseWall({ width: 3, scale: -1 }), false);
  // style: width = width x (wall.scale ?? bezel scale), pixelated; no art -> null (CSS fallback)
  assert.equal(skyWallStyle(undefined, 3, "/u.png"), null);
  assert.equal(skyWallStyle(v.value.wall, 3, null), null);
  const st = skyWallStyle(v.value.wall, 3, "/office/sky-wall-dark.png");
  assert.equal(st.width, "12px");
  assert.equal(st.imageRendering, "pixelated");
  assert.equal(st.borderWidth, "9px 0 15px");
  assert.equal(st.borderImageSlice, "3 0 5 fill");
  assert.equal(st.borderImageRepeat, "round");
  assert.equal(skyWallStyle({ width: 4, repeat: "stretch" }, 3, "/s.png").width, "12px"); // wall.scale absent -> the bezel's
  assert.equal(skyWallStyle({ width: 4, scale: 2, repeat: "round" }, 3, "/s.png").backgroundSize, "8px auto"); // own scale wins
  assert.equal(skyWallStyle({ width: 4, slice: { top: 3, bottom: 5 }, repeat: "stretch" }, 3, "/s.png").borderImageRepeat, "stretch");
});

test("G8c wall: absolute, above both TVs and the chat panel, never in the grid - a wide wall (w 6 x scale 3) cannot change the 50/50", () => {
  const css = src("styles.css");
  const sky = src("SkyZones.tsx");
  assert.ok(/\.sky-wall \{ position: absolute;/.test(css) && /z-index: 4; pointer-events: none;/.test(css));
  assert.ok(/\.sky-zone\.sky-chat-panel \{ grid-column: 2; grid-row: 1; z-index: 3;/.test(css)); // panel under the wall, on exactly the right cell
  assert.ok(sky.includes('data-testid="sky-wall"') && sky.includes("skyWallStyle(crt?.wall, crt?.scale ?? 1,"));
  assert.ok(!/\.sky-wall[^{]*\{[^}]*grid-(column|row)/.test(css)); // out of flow
  assert.equal(logic.SKY_COLUMNS, "minmax(0, 1fr) minmax(0, 1fr)"); // the columns do not depend on the wall
  const st = logic.skyWallStyle({ width: 6, scale: 3, repeat: "round" }, 3, "/s.png");
  assert.equal(st.width, "18px");
  for (const k of Object.keys(st)) assert.ok(!/grid|flex|gap|padding/i.test(k), k); // only its own box
});

// ── G8 follow-ups: no nested buttons, whole face when RiffBot is not running ──
test("no interactive element nested in another: .sky-face-hit is an empty sibling button; spin-up / x are siblings; the sidebar badge inside a row button is a span", () => {
  const sky = src("SkyZones.tsx");
  const hit = sky.match(/<button[^>]*?className="sky-face-hit"[\s\S]*?\/>/);
  assert.ok(hit, "the face hit button is self-closing (no children)");
  assert.ok(!hit[0].slice(1).includes("<button") && !hit[0].includes("</button>"), "no button inside .sky-face-hit");
  // Spin Up / Resume / x live in the zone body or beside the hit button, never in it.
  const zone = sky.slice(sky.indexOf("<section"), sky.indexOf("</section>"));
  assert.ok(zone.indexOf("sky-face-hit") < zone.indexOf("sky-chat-close") && zone.indexOf("sky-chat-close") < zone.indexOf("sky-start-riffbot"));
  assert.ok(/\.sky-face-hit \{ position: absolute; inset: 0;/.test(src("styles.css"))); // an absolute sibling over the face, not a wrapper
  const grid = src("PinGrid.tsx");
  assert.ok(grid.includes("export function NeedsBadgeInline") && /<span\s+role="button"\s+tabIndex=\{0\}/.test(grid));
  const row = grid.slice(grid.indexOf("const PinRow = memo"), grid.indexOf("export const SidebarRiffBot"));
  assert.ok(row.includes("<NeedsBadgeInline") && !/<NeedsBadge pin/.test(row)); // pin-row <button> no longer holds a <button>
  const riff = grid.slice(grid.indexOf("export const SidebarRiffBot"), grid.indexOf("export function SidebarPins"));
  assert.ok(riff.includes("<NeedsBadgeInline") && !/<NeedsBadge pin/.test(riff));
});

test("RiffBot not running: the face stays whole (dimmed) and the label/Spin Up strip sits below the face area, never over it", () => {
  const css = src("styles.css");
  const sky = src("SkyZones.tsx");
  assert.ok(sky.includes('idle = !panel && zone.bot === "riffbot" && !zone.agentId') && sky.includes('${idle ? " is-idle" : ""}'));
  const strip = css.match(/--sky-idle-strip: (\d+)px/);
  assert.ok(strip);
  assert.ok(css.includes(".sky-zone.is-idle .sky-face-area { bottom: var(--sky-idle-strip); }")); // face box ends where the strip starts
  assert.ok(css.includes(".sky-zone.is-idle .sky-crt-body { top: auto; height: var(--sky-idle-strip);"));
  assert.ok(/\.sky-zone\.is-idle \.sky-face \{ opacity: 0\.5;/.test(css)); // dimmed, not covered
  // Geometry: a 3200x1800-layout TV (~1300x880) still gets a whole integer-scaled face above a 34px strip.
  const box = { w: 1300, h: 880 - Number(strip[1]) };
  const { k, top } = logic.faceContain({ w: 80, h: 48 }, box);
  assert.ok(k >= 1 && top >= 0 && top + 48 * k === box.h, "face fits whole inside the box above the strip");
  // The old overlay (a translucent strip over the face's bottom) is gone.
  assert.ok(!css.includes(".sky-zone-riffbot:not(.sky-chat-panel) .sky-crt-body:has(.sky-static)"));
});

test("the pin-rail tile button also uses the inline (span) needs badge: no <button> inside <button> anywhere on the squad page", () => {
  const rail = src("PinRail.tsx");
  const tile = rail.slice(rail.indexOf('className="pin-rail-open"') - 200, rail.indexOf("<CheckinButton"));
  assert.ok(tile.includes("<NeedsBadgeInline pin={pin} />") && !/<NeedsBadge pin/.test(tile));
});

test("SquadTile's portrait button also holds the inline badge; the only plain NeedsBadge <button>s left are in div heads (tile head, rail active head)", () => {
  const grid = src("PinGrid.tsx");
  const portrait = grid.slice(grid.indexOf('className="squad-home-portrait"'), grid.indexOf('className="squad-home-lead-line'));
  assert.ok(portrait.includes("<NeedsBadgeInline pin={pin} />") && !/<NeedsBadge pin/.test(portrait));
  const plain = [...grid.matchAll(/<NeedsBadge pin=/g)].length + [...src("PinRail.tsx").matchAll(/<NeedsBadge pin=/g)].length;
  assert.equal(plain, 2); // PinTile head (div.pin-tile-head) + PinRail active head (div.pin-rail-active-head); every other site is Inline
  assert.ok(/<div className="pin-tile-head">[\s\S]*?<NeedsBadge pin=\{pin\} \/>/.test(grid));
  assert.ok(/<div className="pin-rail-active-head">[\s\S]*?<NeedsBadge pin=\{active\} \/>/.test(src("PinRail.tsx")));
});

// ── G8e: crisp device pixels at non-integer DPR ──
test("G8e faceContain: dpr 1 is exactly the old integer scale", () => {
  const cell = { w: 48, h: 48 };
  for (const box of [{ w: 700, h: 400 }, { w: 200, h: 500 }, { w: 480, h: 480 }, { w: 1306, h: 497 }, { w: 30, h: 30 }]) {
    assert.deepEqual(faceContain(cell, box, 1), faceContain(cell, box));
  }
  assert.deepEqual(faceContain(cell, { w: 700, h: 400 }, 1), { k: 8, left: 158, top: 16 });
  assert.equal(logic.safeDpr(0), 1);
  assert.equal(logic.safeDpr(NaN), 1);
  assert.equal(logic.safeDpr(undefined), 1);
  assert.equal(logic.safeDpr(0.5), 1);
});

test("G8e faceContain at dpr 1.2 (4K@120%): a whole number of DEVICE px per art px, bottom anchored, centred, device-aligned offsets", () => {
  const dpr = 1.2;
  const cell = { w: 80, h: 48 };
  const box = { w: 1291 - 6, h: 884 - 6 }; // a ~1291x884 TV minus a thin bezel (CSS px)
  const c = faceContain(cell, box, dpr);
  const kd = c.k * dpr;
  assert.ok(Math.abs(kd - Math.round(kd)) < 1e-9, `device px per art px is an integer (${kd})`);
  assert.equal(Math.round(kd), Math.floor(Math.min(box.w / cell.w, box.h / cell.h) * dpr)); // the LARGEST such scale
  for (const v of [c.left, c.top]) assert.ok(Math.abs(v * dpr - Math.round(v * dpr)) < 1e-9, "offset is a device-px multiple");
  const bottom = c.top + cell.h * c.k;
  assert.ok(bottom <= box.h + 1e-9 && box.h - bottom < 1 / dpr + 1e-9, "bottom edge within one device px of the box bottom");
  assert.ok(c.left >= 0 && c.left + cell.w * c.k <= box.w + 1e-9);
  // the old CSS-integer pick was soft: 16 CSS px per art px = 19.2 device px (the bug report)
  const old = faceContain({ w: 48, h: 48 }, { w: 1300, h: 800 }, 1);
  assert.equal(old.k * 1.2, 16 * 1.2); // 19.2: not an integer
  const fixed = faceContain({ w: 48, h: 48 }, { w: 1300, h: 800 }, 1.2);
  assert.ok(Math.abs(fixed.k * 1.2 - Math.round(fixed.k * 1.2)) < 1e-9);
  assert.equal(fixed.k * 1.2, 20); // 20 device px per art px (16.667 CSS px)
});

test("G8e faceContain at dpr 1.5 and 2; never below 1 device px; bottom anchor kept", () => {
  const cell = { w: 48, h: 48 };
  const a = faceContain(cell, { w: 1000, h: 600 }, 1.5);
  assert.equal(a.k * 1.5, Math.floor((600 / 48) * 1.5)); // 18 device px
  assert.equal(a.k * 1.5, 18);
  assert.equal(a.top + 48 * a.k, 600); // 600*1.5 = 900 device px, face 864: bottom flush
  const b = faceContain(cell, { w: 1000, h: 600 }, 2);
  assert.equal(b.k * 2, 25);
  assert.equal(b.k, 12.5);
  assert.ok(Math.abs(b.top * 2 - Math.round(b.top * 2)) < 1e-9);
  const tiny = faceContain(cell, { w: 30, h: 30 }, 1.5);
  assert.equal(tiny.k * 1.5, 1); // kd at least 1
  assert.equal(faceContain(cell, { w: 0, h: 0 }, 1.5).k, 0);
});

test("G8e bezel + wall snap to whole device px per source px; integer products are kept", () => {
  const { crispScale, snapPx, skyCrtStyle, skyWallStyle, validateSkyCrt } = logic;
  assert.equal(crispScale(3, 1), 3);
  assert.equal(crispScale(3, 2), 3); // integer product kept (6 device px)
  assert.ok(Math.abs(crispScale(3, 1.2) * 1.2 - 3) < 1e-9); // 3.6 -> 3 device px per source px
  assert.ok(Math.abs(crispScale(3, 1.5) * 1.5 - 4) < 1e-9); // 4.5 -> 4
  assert.equal(snapPx(10.3, 1.2), Math.round(10.3 * 1.2) / 1.2);
  const crt = validateSkyCrt({ slice: { top: 3, right: 3, bottom: 5, left: 3 }, scale: 3, repeat: "round", wall: { width: 4, scale: 3, slice: { top: 3, bottom: 5 }, repeat: "round" } }).value;
  const px = (s) => s.split(" ").map((v) => parseFloat(v));
  for (const dpr of [1, 1.2, 1.25, 1.5, 2]) {
    const st = skyCrtStyle(crt, "/u.png", dpr);
    for (const v of px(st.borderWidth)) assert.ok(Math.abs(v * dpr - Math.round(v * dpr)) < 1e-6, `bezel edge ${v}px is whole device px at dpr ${dpr}`);
    const w = skyWallStyle(crt.wall, crt.scale, "/w.png", dpr);
    assert.ok(Math.abs(parseFloat(w.width) * dpr - Math.round(parseFloat(w.width) * dpr)) < 1e-6, `wall width whole device px at dpr ${dpr}`);
    for (const v of px(w.borderWidth)) assert.ok(Math.abs(v * dpr - Math.round(v * dpr)) < 1e-6);
  }
  assert.equal(skyCrtStyle(crt, "/u.png", 1).borderWidth, "9px 9px 15px 9px"); // dpr 1 unchanged
  assert.equal(skyWallStyle(crt.wall, 3, "/w.png", 1).width, "12px");
});

test("G8e a DPR change triggers a recompute: the live ratio feeds the face, bezel and wall; matchMedia re-arms on the new ratio", () => {
  assert.equal(logic.dprMediaQuery(1.2), "(resolution: 1.2dppx)");
  assert.equal(logic.dprMediaQuery(NaN), "(resolution: 1dppx)");
  const hook = src("useBotFace.ts");
  assert.ok(hook.includes("export function useDpr()") && hook.includes("window.matchMedia(dprMediaQuery(dpr))"));
  assert.ok(hook.includes("}, [dpr]);")); // dep on dpr: every change tears the listener down and arms one for the new ratio
  assert.ok(hook.includes('typeof window === "undefined" ? 1'));
  const sky = src("SkyZones.tsx");
  assert.ok(sky.includes("faceContain(cell, box, dpr)") && sky.includes("faceContain(sheet.cell, box, dpr)")); // takeover shares it
  assert.ok(sky.includes("}, crt, dpr)") && sky.includes("useImageOk(wallUrl) ? wallUrl : null, dpr)"));
  // Simulated zoom: 100% -> 120% changes the pick, so a re-render with the new dpr moves the face to the new device-aligned scale.
  const cell = { w: 48, h: 48 }, box = { w: 1300, h: 800 };
  assert.notEqual(logic.faceContain(cell, box, 1).k, logic.faceContain(cell, box, 1.2).k);
});

test("G8e: the fallback seam snaps to whole device px and the DPR hook also re-reads on resize (zoom)", () => {
  const { skyWallFallbackStyle } = logic;
  assert.deepEqual(skyWallFallbackStyle(1), { width: "2px", marginLeft: "-1px" }); // today's seam at dpr 1
  const f = skyWallFallbackStyle(1.2);
  assert.ok(Math.abs(parseFloat(f.width) * 1.2 - 2) < 1e-9); // 2 device px
  assert.ok(Math.abs(parseFloat(f.marginLeft) * 1.2 + 1) < 1e-9);
  const g = skyWallFallbackStyle(1.5); // 3 device px
  assert.ok(Math.abs(parseFloat(g.width) * 1.5 - 3) < 1e-9);
  assert.ok(src("SkyZones.tsx").includes("style={wallStyle ?? skyWallFallbackStyle(dpr)}"));
  assert.ok(src("useBotFace.ts").includes('window.addEventListener("resize", onChange)') && src("useBotFace.ts").includes('window.removeEventListener("resize", onChange)'));
});
