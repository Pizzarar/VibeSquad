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
  assert.ok(sky.includes("faceContain(cell, box)") && !sky.includes("faceCover"));
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
  assert.ok(src("styles.css").includes(".sky-chat-panel .drawer-subagents-bar { max-height: none; overflow-y: visible; }"));
});

test("G8b: thinner bezels need no code change - small slice/scale values validate, size the border from JSON, nothing hardcodes the old 60px sides / 90px chin", async () => {
  const { validateSkyCrt, skyCrtStyle } = await import("../src/skyZonesLogic.ts");
  const v = validateSkyCrt({ slice: { top: 4, right: 4, bottom: 6, left: 4 }, scale: 2, repeat: "round" });
  assert.equal(v.ok, true);
  const st = skyCrtStyle(v.value, "/office/sky-crt-dark.png");
  assert.equal(st.borderWidth, "8px 8px 12px 8px"); // slice x scale per side: the screen inset follows the JSON
  assert.equal(st.borderImageSlice, "4 4 6 4 fill");
  assert.equal(skyCrtStyle(validateSkyCrt({ slice: { top: 1, right: 1, bottom: 1, left: 1 }, scale: 1.5 }).value, "u").borderWidth, "1.5px 1.5px 1.5px 1.5px");
  assert.equal(validateSkyCrt({ slice: { top: 0, right: 4, bottom: 6, left: 4 }, scale: 2 }).ok, false); // zero slice still rejected
  const css = src("styles.css");
  const sky = css.slice(css.indexOf(".sky-zones {"), css.indexOf("/* G7 virus takeover"));
  assert.ok(!/(60|90)px/.test(sky), "no old bezel side/chin size in the sky rules");
  assert.ok(!src("SkyZones.tsx").includes("bezelH")); // the screen is whatever is inside the border box
});

// ── G8c: the wall ──
test("G8c wall: optional sky-crt.json key, validated; absent or bad -> ignored (CSS seam)", () => {
  const { validateSkyCrt, parseWall, skyWallStyle, SKY_WALL_URL } = logic;
  const crt = (wall) => ({ slice: { top: 14, right: 20, bottom: 30, left: 20 }, scale: 3, repeat: "round", ...(wall === undefined ? null : { wall }) });
  const none = validateSkyCrt(crt());
  assert.equal(none.ok, true);
  assert.equal("wall" in none.value, false); // existing files parse exactly as before
  const ok = validateSkyCrt(crt({ w: 6, slice: { top: 4, bottom: 4 }, src: "sky-wall-{theme}.png" }));
  assert.deepEqual(ok.value.wall, { w: 6, slice: { top: 4, bottom: 4 }, src: "sky-wall-{theme}.png" });
  assert.deepEqual(parseWall({ w: 2 }), { w: 2, src: "sky-wall-{theme}.png" }); // slice + src optional
  assert.equal(SKY_WALL_URL("light", ok.value.wall), "/office/sky-wall-light.png");
  for (const bad of [{ w: 0 }, { w: -2 }, { w: 1.5 }, { w: "6" }, {}, null, 5, "x", []]) {
    const v = validateSkyCrt(crt(bad));
    assert.equal(v.ok, true, "a bad wall never rejects the bezel");
    assert.equal("wall" in v.value, false, JSON.stringify(bad));
  }
  assert.equal(parseWall({ w: 3, slice: { top: -1, bottom: 2.5 } }).slice, undefined); // bad slice dropped, wall kept
  assert.equal(parseWall({ w: 3, src: "../x/evil.png" }).src, "sky-wall-{theme}.png"); // no path tricks
  // style: width = w x scale, integer scaled, pixelated; no art -> null (CSS fallback)
  assert.equal(skyWallStyle(undefined, 3, "/u.png"), null);
  assert.equal(skyWallStyle(ok.value.wall, 3, null), null);
  const st = skyWallStyle(ok.value.wall, 3, "/office/sky-wall-dark.png");
  assert.equal(st.width, "18px");
  assert.equal(st.imageRendering, "pixelated");
  assert.equal(st.borderWidth, "12px 0 12px");
  assert.equal(st.borderImageSlice, "4 0 4 fill");
  assert.equal(skyWallStyle({ w: 6, src: "s.png" }, 3, "/s.png").backgroundSize, "18px auto");
});

test("G8c wall: absolute, above both TVs and the chat panel, never in the grid - a wide wall (w 6 x scale 3) cannot change the 50/50", () => {
  const css = src("styles.css");
  const sky = src("SkyZones.tsx");
  assert.ok(/\.sky-wall \{ position: absolute;/.test(css) && /z-index: 4; pointer-events: none;/.test(css));
  assert.ok(/\.sky-zone\.sky-chat-panel \{ grid-column: 2; grid-row: 1; z-index: 3; \}/.test(css)); // panel under the wall, on exactly the right cell
  assert.ok(sky.includes('data-testid="sky-wall"') && sky.includes("skyWallStyle(crt?.wall, crt?.scale ?? 1,"));
  assert.ok(!/\.sky-wall[^{]*\{[^}]*grid-(column|row)/.test(css)); // out of flow
  assert.equal(logic.SKY_COLUMNS, "minmax(0, 1fr) minmax(0, 1fr)"); // the columns do not depend on the wall
  const st = logic.skyWallStyle({ w: 6, src: "s.png" }, 3, "/s.png");
  assert.equal(st.width, "18px");
  for (const k of Object.keys(st)) assert.ok(!/grid|flex|gap|padding/i.test(k), k); // only its own box
});
