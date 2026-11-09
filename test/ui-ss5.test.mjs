// SS5: integer device-px art under the UI zoom (cast avatar, brand mark, hub floor) + Settings reset clears the chat override.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { snapDeviceSize, setUiScale, setChatScale, resetAllScales, resetUiScale, getChatScaleOverride, getUiScale } from '../src/uiScale.ts';
import { floorFitScale } from '../src/squadFloorLogic.ts';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const whole = (n) => Math.abs(n - Math.round(n)) < 1e-6;
const CASES = [[1, 1], [1.2, 1], [1, 1.25], [1.2, 1.25], [1, 1.5], [1.2, 1.5], [1, 1.75]]; // [dpr, ui zoom]

test('snapDeviceSize: device px is a whole multiple of the step for every dpr x UI zoom, css maps back exactly', () => {
  for (const [dpr, zoom] of CASES) {
    for (const [target, step] of [[32, 32], [64, 32], [16, 16], [22, 16]]) {
      const { device, css } = snapDeviceSize(target, step, dpr, zoom);
      assert.ok(device >= step && device % step === 0, `${target}/${step} @${dpr}x${zoom}: ${device}`);
      assert.ok(whole(css * dpr * zoom), `css ${css} -> ${css * dpr * zoom} device px`);
    }
  }
  assert.deepEqual(snapDeviceSize(32, 32, NaN, NaN), { device: 32, css: 32 });
});

test('cast avatar: 32 css at 1080 / UI 150% was 48 device px (0.75x of the 64 cell); now a whole 32-multiple', () => {
  assert.equal(snapDeviceSize(32, 32, 1, 1.5).device, 64);
  assert.equal(snapDeviceSize(32, 32, 1.2, 1.5).device, 64);
  assert.equal(snapDeviceSize(32, 32, 1, 1).device, 32);
  const px = read('src/pixel.tsx');
  assert.match(px, /snapDeviceSize\(nominal/);
  assert.match(px, /useUiScale\(\)/);
  assert.match(read('src/styles.css'), /\.cast-sprite \{[^}]*image-rendering: pixelated/);
});

test('brand mark: 22px master is a whole multiple of 22 device px rounded UP, driven by --brand-mark-px, title cannot reach the status square', () => {
  for (const dpr of [1, 1.2, 1.5, 2]) for (const zoom of [1, 1.25, 1.5, 1.75, 2]) {
    const { device, css } = snapDeviceSize(22, 22, dpr, zoom, true);
    assert.equal(device % 22, 0, `${dpr}x${zoom}`);
    assert.ok(device >= 22 * dpr * zoom - 1e-6, `${dpr}x${zoom}: ${device} shrank below the target`);
    assert.ok(device < 22 * dpr * zoom + 22, `${dpr}x${zoom}: ${device} overshoots by a whole step`);
    assert.ok(Math.abs(css * dpr * zoom - device) < 1e-9);
  }
  assert.equal(snapDeviceSize(22, 22, 1.2, 1.5, true).device, 44); // 4K@120% x UI 150%: target 39.6 -> 44
  assert.equal(snapDeviceSize(22, 22, 1, 1.5, true).device, 44); // 33 -> 44
  assert.equal(snapDeviceSize(22, 22, 1, 1, true).device, 22);
  for (const bad of [NaN, 0, -5, Infinity]) assert.equal(snapDeviceSize(bad, 22, 1.2, 1.5, true).device, 22, `target ${bad}`);
  const css = read('src/styles.css');
  assert.match(css, /\.brand-mark \{[^}]*width: var\(--brand-mark-px, 22px\)/);
  assert.match(css, /\.brand-text \{\s*min-width: 0;/);
  assert.match(css, /\.conn \{\s*flex: none;/);
  assert.match(read('src/uiScale.ts'), /--brand-mark-px/);
});

test('floor scale: whole device-px multiple under the UI zoom, never clipped, never 0, plain-zoom callers unchanged', () => {
  for (const [dpr, zoom] of CASES) {
    for (const [w, h] of [[1700, 900], [1400, 560], [1150, 480], [1280, 330], [700, 420], [600, 200]]) {
      const s = floorFitScale(w, h, dpr, 640, 360, zoom);
      assert.ok(s > 0 && Number.isFinite(s), `${w}x${h} @${dpr}x${zoom}`);
      assert.ok(640 * s <= w + 1e-6 && 360 * s <= h + 1e-6, `${w}x${h} @${dpr}x${zoom}: ${s} clips`);
      if (s * dpr * zoom >= 1 - 1e-9 && Math.floor((w * dpr * zoom) / 640) >= 1 && Math.floor((h * dpr * zoom) / 360) >= 1) {
        assert.ok(whole(s * dpr * zoom), `${w}x${h} @${dpr}x${zoom}: ${s * dpr * zoom} device px per art px`);
      }
    }
  }
  // 1080 + UI 150%: a stage 1250 x 330 css (device 1875 x 495) fits 1x device (css 0.667), the old css-integer snap gave 1 css = 1.5 device and clipped
  assert.equal(floorFitScale(1250, 330, 1, 640, 360, 1.5) * 1.5, 1);
  assert.equal(floorFitScale(1300, 800, 1), 2);
  assert.match(read('src/SquadFloor.tsx'), /floorFitScale\(box\.w, box\.h, dpr, native\.w, native\.h, uiZoom\)/);
});

test('Settings Reset clears the chat override, Ctrl+0 (resetUiScale) leaves it', () => {
  setUiScale(1.5, { persist: false });
  setChatScale(1.1, { persist: false });
  resetUiScale(false);
  assert.equal(getUiScale(), 1);
  assert.equal(getChatScaleOverride(), 1.1); // Ctrl+0 stays UI-only
  setUiScale(1.5, { persist: false });
  resetAllScales(false);
  assert.equal(getUiScale(), 1);
  assert.equal(getChatScaleOverride(), null);
  const modal = read('src/TeamSettingsModal.tsx');
  assert.match(modal, /data-testid="ui-scale-reset"\s+onClick=\{\(\) => resetAllScales\(false\)\}/);
});

test('FF-ui floor snap: the (960x498) is always a whole device-px multiple, never a row-dropping fraction (no 1/n)', () => {
  const fit = (w, h, dpr, zoom) => floorFitScale(w, h, dpr, 960, 498, zoom);
  const devPer = (s, dpr, zoom) => s * dpr * zoom;
  // 1080 UI 100%: the hub gives the floor box its need (498 css) -> 1x
  assert.equal(devPer(fit(1880, 498, 1, 1), 1, 1), 1);
  // 1080 UI 150%: need = ceil(498 / 1.5) = 332 css, 1250 wide -> 1x device (the old rule gave 1/2)
  assert.equal(devPer(fit(1250, 332, 1, 1.5), 1, 1.5), 1);
  assert.equal(devPer(fit(2000, 1000, 1, 1), 1, 1), 2);
  // 4K @120%: device 3840x2160. UI 100%: stage css 2583 x 1083 -> 2x; UI 150%: css 1722 x 722 -> 2x device
  assert.equal(devPer(fit(2583, 1083, 1.2, 1), 1.2, 1), 2);
  assert.equal(devPer(fit(1722, 722, 1.2, 1.5), 1.2, 1.5), 2);
  // every result with room for 1x is exactly k device px per art px, fits the box (1 device px of measuring slack), never 0
  for (const [dpr, zoom] of [[1, 1], [1, 1.5], [1.2, 1], [1.2, 1.5]]) {
    for (let h = 150; h <= 1400; h += 37) {
      const s = fit(1800, h, dpr, zoom), d = devPer(s, dpr, zoom);
      assert.ok(s > 0 && 960 * s <= 1800 + 1e-6 && 498 * s <= h + 1 / (dpr * zoom) + 1e-6, `${h}@${dpr}x${zoom}: ${s}`);
      if (h * dpr * zoom >= 498) assert.ok(Math.abs(d - Math.round(d)) < 1e-9 && d >= 1, `${h}@${dpr}x${zoom}: ${d} device px per art px`);
    }
  }
});
