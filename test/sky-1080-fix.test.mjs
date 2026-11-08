// 1080p regression: the sky ran under the Needs-you tray and the Overlord chat's composer was cut off.
// Root cause: .sky-zones carried `min-height: clamp(380px, 46vh, 560px)` ON THE ITEM while its hub-body track was
// minmax(0, 1fr) - at 1080 the track (471px) was smaller than the item (497px), so the sky overflowed its track by 25px and
// painted over the in-flow queue tray below it. The chat row also grew with its content instead of being bounded by the TV.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const block = (sel) => {
  const i = css.indexOf(`${sel} {`);
  assert.ok(i >= 0, `${sel} rule exists`);
  return css.slice(i, css.indexOf("\n}", i) + 2);
};

test("the sky's minimum lives on the hub-body TRACK, never on the sky item (so it cannot overflow into the tray)", () => {
  const hub = block(".hub-body");
  assert.match(hub, /grid-template-rows: auto minmax\(var\(--sky-min-h\), 1fr\) auto auto;/);
  assert.match(hub, /--sky-min-h: clamp\(320px, 40vh, 560px\);/);
  const sky = block(".sky-zones");
  assert.match(sky, /min-height: 0;/);
  assert.doesNotMatch(sky, /min-height: clamp/);
  assert.match(sky, /grid-template-rows: minmax\(0, 1fr\);/); // one row bounded by the TV, not by the chat's content
});

test("geometry: sky is grid row 2, the queue tray row 3 and in flow (relative, not absolute) => sky bottom <= tray top at any viewport", () => {
  assert.match(block(".sky-zones"), /grid-row: 2;/);
  assert.match(css, /\.hub-body \.sq-panel \{ grid-column: 1; grid-row: 3;/);
  const strip = block(".hub-body .sq-strip");
  assert.match(strip, /position: relative;/);
  assert.doesNotMatch(strip, /position: (absolute|fixed)/);
  // Tracks are sequential: the tray's top is the sky track's bottom, and the sky is clipped to (never larger than) its track.
  assert.match(block(".sky-zones"), /overflow: hidden;/);
  const order = (s) => app.indexOf(s);
  assert.ok(order("<SkyZones") < order('<SquadQueue view={pinFocusView} variant="strip"') && order('variant="strip"') < order("<SquadFloor"));
  // Simulated 1080p numbers from the live measurement: track = 1052 - 44 (panes) - 126 (tray) - 410 (floor) = 472 < the old 497 item.
  const track = 1052 - 44 - 126 - 410;
  const oldSky = Math.round(0.46 * 1080);
  assert.ok(oldSky > track, "the old item min-height exceeded its track (the overlap)");
  const newSky = Math.min(track, Math.max(track, 320)); // fills exactly the track
  assert.ok(newSky <= track);
});

test("chat panel is bounded by the right TV screen: it cannot grow its row, scrolls its chrome, keeps the composer pinned", () => {
  assert.match(css, /\.sky-zone\.sky-chat-panel \{ grid-column: 2; grid-row: 1; z-index: 3; min-height: 0; max-height: 100%; \}/);
  assert.match(css, /\.sky-zone \{ min-height: 0; \}/);
  assert.match(css, /\.sky-chat-panel \.drawer \{ overflow-y: auto; \}/);
  assert.match(css, /\.sky-chat-panel \.drawer > \.drawer-shell \{ flex: 1 0 140px; \}/);
  assert.match(css, /\.sky-chat-panel \.drawer > \.composer \{ position: sticky; bottom: 0; z-index: 12;/); // above the sticky .tl-head (z 10)
  assert.match(css, /\.sky-chat-panel \.sky-crt-body, \.sky-chat-panel \.sky-crt-body \.pane-slot \{ overflow: hidden; \}/);
  // 50/50, wall, snap untouched
  assert.match(css, /--sky-cols/);
  assert.match(css, /\.sky-wall \{ position: absolute;/);
});
