// usa-57: behavioral test of the phone Usage open/close store (history push/pop/popstate), with window/location/history stubbed.
import assert from "node:assert/strict";
import test from "node:test";

function stub(search) {
  const calls = [];
  const listeners = {};
  const loc = { pathname: "/", search, hash: "" };
  const hist = {
    state: null,
    pushState(st, _t, url) { calls.push(["push", url]); this.state = st; loc.search = url.includes("?") ? url.slice(url.indexOf("?")) : ""; },
    replaceState(st, _t, url) { calls.push(["replace", url]); this.state = st; loc.search = url.includes("?") ? url.slice(url.indexOf("?")) : ""; },
    back() { calls.push(["back"]); },
  };
  globalThis.location = loc;
  globalThis.history = hist;
  globalThis.window = { addEventListener: (n, f) => { listeners[n] = f; } };
  return { calls, listeners, loc, hist };
}
let n = 0;
const load = (search) => { const env = stub(search); return import(`../src/phoneUsageStore.ts?${++n}`).then((m) => ({ m, ...env })); };

test("open pushes ?usage=1 once; double open is a no-op; close undoes our own entry with history.back()", async () => {
  const { m, calls } = await load("?team=efi");
  m.openPhoneUsage(); m.openPhoneUsage();
  assert.deepEqual(calls, [["push", "/?team=efi&usage=1"]]);
  assert.equal(m.isPhoneUsageOpen(), true);
  m.closePhoneUsage(); m.closePhoneUsage();
  assert.deepEqual(calls.slice(1), [["back"]]);
  assert.equal(m.isPhoneUsageOpen(), false);
});
test("cold ?usage=1 starts open; close strips the param in place (no history.back)", async () => {
  const { m, calls, loc } = await load("?team=efi&usage=1");
  assert.equal(m.isPhoneUsageOpen(), true);
  m.closePhoneUsage();
  assert.deepEqual(calls, [["replace", "/?team=efi"]]);
  assert.equal(loc.search, "?team=efi");
  assert.equal(m.isPhoneUsageOpen(), false);
});
test("browser Back / Forward (popstate) syncs open state", async () => {
  const { m, listeners, loc } = await load("");
  m.openPhoneUsage();
  loc.search = ""; listeners.popstate();
  assert.equal(m.isPhoneUsageOpen(), false);
  loc.search = "?usage=1"; listeners.popstate();
  assert.equal(m.isPhoneUsageOpen(), true);
});
