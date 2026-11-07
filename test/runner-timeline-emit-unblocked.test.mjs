// Timeline emits (what makes the browser refetch) must never wait behind roster fetches on the serialized live chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RunnerBackend } from "../server/backend/runner-backend.mjs";

const rec = (id, status = "idle") => ({ id, provider: "claude", model: "m", cwd: ".", status, meta: { labels: {} }, createdAt: 1, lastSeq: 0 });

function harness({ hangAgent }) {
  let push;
  const client = {
    home: "/nonexistent",
    stream: (h) => { push = h.onMessage; return { close() {} }; },
    request: async (_m, route) => {
      if (route === "/agents") return { ids: ["rn-a"] };
      if (/^\/agents\/rn-a$/.test(route)) return hangAgent && globalThis.__hang ? new Promise(() => {}) : rec("rn-a");
      return { events: [] };
    },
  };
  const backend = new RunnerBackend({ client });
  const seen = [];
  const off = backend.subscribeEvents((ev) => { if (ev.kind === "timeline") seen.push(ev.seq); });
  return { backend, seen, off, push: (id, event) => push({ id, event }) };
}

test("a hung fetchAgent does not delay later timeline emits", async () => {
  const h = harness({ hangAgent: true });
  await new Promise((r) => setTimeout(r, 50)); // initial roster seeded
  globalThis.__hang = true;
  h.push("rn-a", { seq: 1, ts: 1, type: "status", status: "running" }); // roster event: its fetchAgent never returns
  h.push("rn-a", { seq: 2, ts: 2, type: "output", text: "x" });
  h.push("rn-a", { seq: 3, ts: 3, type: "output", text: "y" });
  assert.deepEqual(h.seen, [1, 2, 3], "emitted synchronously, before the chain gets to the hung fetch");
  globalThis.__hang = false;
  h.off();
});

test("each log event emits exactly one timeline event", async () => {
  const h = harness({ hangAgent: false });
  await new Promise((r) => setTimeout(r, 50));
  h.push("rn-a", { seq: 1, ts: 1, type: "status", status: "running" });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(h.seen, [1]);
  h.off();
});
