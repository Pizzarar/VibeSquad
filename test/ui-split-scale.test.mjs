// SS: split UI scale. Chat regions counter-zoom so root zoom x --chat-zoom = chat scale; unset chat follows UI scale.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chatZoom, effectiveChatScale, CHAT_SCALE_STORAGE_KEY, readStoredChatScale, getChatScale, getChatScaleOverride, setChatScale } from '../src/uiScale.ts';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const css = read('src/styles.css');

test('chat unset follows the UI scale exactly (counter-zoom 1) at 100/125/150', () => {
  for (const ui of [1, 1.25, 1.5]) {
    assert.equal(effectiveChatScale(ui, null), ui);
    assert.equal(chatZoom(ui, null), 1);
  }
});

test('UI 150 / chat 110 counter-zooms by 110/150 so the effective chat scale is 110', () => {
  const z = chatZoom(1.5, 1.1);
  assert.ok(Math.abs(z - 1.1 / 1.5) < 1e-4);
  assert.ok(Math.abs(1.5 * z - 1.1) < 1e-3);
  assert.equal(effectiveChatScale(1.5, 1.1), 1.1);
});

test('chat override is clamped and a bad value cannot produce NaN', () => {
  assert.equal(effectiveChatScale(1, 9), 2);
  assert.equal(effectiveChatScale(1, 0.1), 0.8);
  assert.ok(Number.isFinite(chatZoom(NaN, null)));
});

test('storage: key is separate from uiScale, null clears, no window = follow', () => {
  assert.equal(CHAT_SCALE_STORAGE_KEY, 'vibesquad.chatScale');
  assert.equal(readStoredChatScale(), null);
  assert.equal(getChatScaleOverride(), null);
  setChatScale(1.1);
  assert.equal(getChatScaleOverride(), 1.1);
  assert.equal(getChatScale(), 1.1);
  setChatScale(null);
  assert.equal(getChatScaleOverride(), null);
});

test('chat containers carry the counter-zoom and the chat-snapped kit pixel', () => {
  assert.match(css, /\.drawer-shell > \.timeline,\s*\.drawer \.composer\s*\{[^}]*zoom: var\(--chat-zoom, 1\);[^}]*--u3-px: var\(--u3-px-chat, 2px\);/);
  assert.match(css, /:root \{ --chat-zoom: 1; --u3-px-chat: 2px; \}/);
});

test('uiScale effect in App re-applies on chat scale change', () => {
  assert.match(read('src/App.tsx'), /applyUiScaleToDom\(uiScale\);\s*\}, \[uiScale, chatScale\]\)/);
});
