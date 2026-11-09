import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// C3: a message with an image/file attachment sent to a busy agent must queue like text-only does
// ("things dont queue if they include an image"). Source-level assertions (Node-only, no DOM).
const drawer = readFileSync(new URL("../src/AgentDrawer.tsx", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/Composer.tsx", import.meta.url), "utf8");

function queueGuard() {
  const i = drawer.indexOf("shouldQueueOnSend(agent.status, forceImmediate)");
  assert.ok(i > 0, "queue guard present");
  return drawer.slice(i, drawer.indexOf("{", i));
}

test("image-queue: the queue guard no longer bypasses on images/files/context", () => {
  const g = queueGuard();
  assert.doesNotMatch(g, /imgs\.images\.length/, "images must not bypass the queue");
  assert.doesNotMatch(g, /atts\.items\.length/, "file attachments must not bypass the queue");
  assert.doesNotMatch(g, /ctxSrc\.items\.length/, "context pills must not bypass the queue");
});

test("image-queue: queued items carry images and the idle flush sends them", () => {
  assert.match(composer, /export type QueuedTurnItem = \{[\s\S]*?images/);
  // both flush paths (store idle flusher + "Send this now") must forward the images, not call sendMessage with undefined
  const wire = readFileSync(new URL("../src/composerQueueWire.ts", import.meta.url), "utf8");
  assert.match(drawer, /flushQueued\(agent\.id, combinedText, /);
  assert.match(wire, /send: flushQueued/);
  assert.doesNotMatch(drawer, /sendMessage\(agent\.id, combinedText, undefined/);
  assert.match(wire, /flushQueued[\s\S]{0,200}blobsToPaseoImages\(images\)/);
});
