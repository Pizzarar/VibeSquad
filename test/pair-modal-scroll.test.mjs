// Pair a Device modal: viewport-bound scroll (both vibes) + phone path (APK, QR, CA) sits above the desktop block.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const tsx = readFileSync(resolve(root, "src", "PairDeviceModal.tsx"), "utf8");
const css = readFileSync(resolve(root, "src", "styles.css"), "utf8");
const boring = readFileSync(resolve(root, "src", "boring.css"), "utf8");

describe("PairDeviceModal scroll", () => {
  test("dialog is tagged and its CSS bounds height + scrolls the body", () => {
    assert.match(tsx, /className="pair-modal-dialog"/);
    assert.match(css, /\.modal\.pair-modal-dialog\s*\{[^}]*max-height:\s*calc\(100(d?v)h \/ var\(--vs-ui-scale, 1\) - 32px\)/);
    assert.match(css, /\.modal\.pair-modal-dialog\s*\{[^}]*overflow:\s*hidden/);
    assert.match(css, /\.pair-modal-dialog \.modal-body\s*\{[^}]*overflow-y:\s*auto/);
    assert.match(css, /\.pair-modal-dialog \.modal-body\s*\{[^}]*min-height:\s*0/);
  });
  test("header and Close footer are pinned", () => {
    assert.match(css, /\.pair-modal-dialog \.modal-head\s*\{[^}]*position:\s*sticky/);
    assert.match(css, /\.pair-modal-dialog \.modal-foot\s*\{[^}]*position:\s*sticky/);
  });
  test("pinned bars keep the titlebar background (no contrast-breaking override)", () => {
    assert.doesNotMatch(css, /\.pair-modal-dialog \.modal-(head|foot)\s*\{[^}]*background/);
  });
  test("boring vibe does not override the pair dialog scroll", () => {
    assert.doesNotMatch(boring, /pair-modal-dialog/);
    assert.doesNotMatch(boring, /\.modal(-body)?\b[^{]*\{[^}]*overflow:\s*(visible|hidden)/);
  });
  test("order: APK card, QR, CA steps, then desktop hero", () => {
    const at = (s) => {
      const i = tsx.indexOf(s);
      assert.ok(i > 0, s);
      return i;
    };
    const apk = at('data-testid="android-apk-card"');
    const qr = at("SCAN QR TO PAIR");
    const ca = at("INSTALL ROOT CA");
    const hero = at('data-testid="desktop-pair-hero"');
    assert.ok(apk < qr && qr < ca && ca < hero);
  });
});
