import assert from "node:assert/strict";
import test from "node:test";
import { BACKEND_METHODS, PaseoBackend, getBackend, getCliBackend } from "../server/backend/index.mjs";

function fakeClient() {
  const calls = [];
  const client = { marker: "raw" };
  for (const name of BACKEND_METHODS) {
    client[name] = function (...args) {
      calls.push({ name, args, self: this });
      return Promise.resolve({ from: name });
    };
  }
  return { client, calls };
}

test("PaseoBackend delegates every method with the same args, receiver and return value", async () => {
  const { client, calls } = fakeClient();
  const backend = getBackend(client);
  for (const name of BACKEND_METHODS) {
    const out = await backend[name]("a", { b: 1 });
    assert.deepEqual(out, { from: name });
  }
  assert.equal(calls.length, BACKEND_METHODS.length);
  for (const c of calls) {
    assert.deepEqual(c.args, ["a", { b: 1 }]);
    assert.equal(c.self, client);
  }
});

test("PaseoBackend only exposes methods the client has, so typeof guards behave as on the raw client", () => {
  const backend = getBackend({ fetchAgents: async () => [], listAgents: undefined });
  assert.equal(typeof backend.fetchAgents, "function");
  assert.equal(typeof backend.listAgents, "undefined");
  assert.equal(typeof backend.createAgent, "undefined");
  assert.equal(backend.cancelAgent?.("x"), undefined);
});

test("PaseoBackend picks up methods added to the client after wrapping", async () => {
  const client = {};
  const backend = getBackend(client);
  assert.equal(typeof backend.archiveAgent, "undefined");
  client.archiveAgent = async (id) => id;
  assert.equal(await backend.archiveAgent("z"), "z");
});

test("PaseoBackend propagates rejections and sync throws unchanged", async () => {
  const boom = new Error("boom");
  const backend = getBackend({
    cancelAgent: () => Promise.reject(boom),
    subscribe: () => {
      throw boom;
    },
  });
  await assert.rejects(backend.cancelAgent("x"), boom);
  assert.throws(() => backend.subscribe(() => {}), boom);
});

test("getBackend is idempotent and passes null/undefined through", () => {
  const b = getBackend({});
  assert.equal(getBackend(b), b);
  assert.ok(b instanceof PaseoBackend);
  assert.equal(getBackend(null), null);
  assert.equal(getBackend(undefined), undefined);
});

test("subscribe returns the client's unsubscribe function", () => {
  const unsub = () => {};
  const backend = getBackend({ subscribe: () => unsub, subscribeConnectionStatus: () => unsub });
  assert.equal(backend.subscribe(() => {}), unsub);
  assert.equal(backend.subscribeConnectionStatus(() => {}), unsub);
});

test("CLI backend returns null for an unsafe agent id without spawning", () => {
  const cli = getCliBackend();
  assert.equal(cli.runCli("/nonexistent-home", ["inspect", "bad id!", "--json"]), null);
  assert.equal(cli.runCli("/nonexistent-home", ["agent", "reload", "../x"]), null);
});
