import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// unit-queue-persist: the composer queue outlives the drawer (module store + localStorage text),
// flushes whenever the agent goes idle, and Cancel restores ALL queued text.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
};
const q = await import("../src/composerQueue.ts");
const item = (id, text, images) => ({ id, text, createdAt: 1, ...(images ? { images } : {}) });

test("queue: enqueue persists text (not images) and survives a reload", () => {
  q.__resetQueueForTest();
  q.enqueueQueued("a1", item("x", "one", [{ name: "i.png", mimeType: "image/png", blob: {} }]));
  q.enqueueQueued("a1", item("y", "two"));
  assert.deepEqual(q.getQueued("a1").map((i) => i.text), ["one", "two"]);
  const raw = JSON.parse(store.get(q.QUEUE_STORAGE_KEY));
  assert.equal(raw.a1.length, 2);
  assert.ok(!JSON.stringify(raw).includes("blob"), "images are memory-only");
  q.__resetQueueForTest({ keepStorage: true }); // simulated page reload: memory gone, storage kept
  assert.deepEqual(q.getQueued("a1").map((i) => i.text), ["one", "two"]);
});

test("queue: flush runs on idle without any drawer, combines items, clears the queue", async () => {
  q.__resetQueueForTest();
  const sent = [];
  let status = "running";
  let notify = () => {};
  const stop = q.startQueueFlusher({
    getStatus: (id) => (id === "a1" ? status : undefined),
    subscribe: (l) => ((notify = l), () => {}),
    send: async (id, text, images) => void sent.push([id, text, images.length]),
  });
  q.enqueueQueued("a1", item("x", "one", [{ name: "i.png", mimeType: "image/png", blob: {} }]));
  q.enqueueQueued("a1", item("y", "two"));
  notify();
  assert.equal(sent.length, 0, "still running: nothing sent");
  status = "idle";
  notify();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent, [["a1", "one\n\ntwo", 1]]);
  assert.equal(q.getQueued("a1").length, 0);
  notify();
  assert.equal(sent.length, 1, "no double send");
  stop();
});

test("queue: closed agents are not flushed; send failure re-queues", async () => {
  q.__resetQueueForTest();
  let status = "closed";
  let notify = () => {};
  let fail = true;
  const sent = [];
  const stop = q.startQueueFlusher({
    getStatus: () => status,
    subscribe: (l) => ((notify = l), () => {}),
    send: async (id, text) => {
      if (fail) throw new Error("boom");
      sent.push(text);
    },
  });
  q.enqueueQueued("a2", item("x", "hi"));
  notify();
  assert.equal(q.getQueued("a2").length, 1);
  status = "idle";
  notify();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(q.getQueued("a2").length, 1, "failed send keeps the text queued");
  fail = false;
  notify();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent, ["hi"]);
  stop();
});

test("queue: takeAll (Send now) and cancel-all return every item", () => {
  q.__resetQueueForTest();
  q.enqueueQueued("a3", item("x", "one"));
  q.enqueueQueued("a3", item("y", "two"));
  assert.deepEqual(q.takeQueued("a3").map((i) => i.text), ["one", "two"]);
  assert.equal(q.getQueued("a3").length, 0);
  assert.equal(q.restoreText([item("x", "one"), item("y", "two")]), "one\n\ntwo");
});

test("drawer wiring: no local queue state, store used, cancel restores all", () => {
  const drawer = readFileSync(new URL("../src/AgentDrawer.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(drawer, /useState<Record<string, QueuedTurnItem\[\]>>/);
  assert.match(drawer, /from "\.\/composerQueue"/);
  assert.match(drawer, /takeQueued\(agent\.id\)/);
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.match(main, /startComposerQueueFlusher|composerQueue/);
});
