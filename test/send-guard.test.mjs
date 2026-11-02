import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createSendLock, guardedSend, restoredDraft } from "../src/sendGuard.ts";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const defer = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};

// Mirrors AgentDrawer: a box, a sendMessage spy, and the guard around them. (A real DOM test isn't available under plain node.)
function rig({ restart = false } = {}) {
  const lock = createSendLock();
  const st = { box: "hello", calls: [], restarts: 0, errors: [], d: defer() };
  const press = () => {
    if (!st.box.trim()) return Promise.resolve(false); // mirrors the empty-draft early return
    const typed = st.box;
    return guardedSend({
      lock,
      clear: () => (st.box = ""),
      restore: () => (st.box = restoredDraft(typed, st.box)),
      onError: (e) => st.errors.push(String(e.message ?? e)),
      run: async () => {
        if (restart) {
          st.restarts++;
          await Promise.resolve();
        }
        st.calls.push(typed);
        await st.d.promise;
        return true;
      },
    });
  };
  return { st, press, lock };
}

test("two Enters in the same tick → exactly one sendMessage", async () => {
  const { st, press } = rig();
  const a = press();
  const b = press(); // same tick: React state would still say busy=false
  st.d.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(st.calls, ["hello"]);
});

test("restart path: two Enters in the same tick → one restart, one send", async () => {
  const { st, press } = rig({ restart: true });
  const a = press();
  const b = press();
  st.d.resolve();
  await Promise.all([a, b]);
  assert.equal(st.restarts, 1);
  assert.equal(st.calls.length, 1);
});

test("the box clears before sendMessage resolves", async () => {
  const { st, press } = rig();
  const p = press();
  assert.equal(st.box, "");
  assert.equal(st.calls.length, 1);
  st.d.resolve();
  await p;
  assert.equal(st.box, "");
});

test("on reject the text is restored (plus anything typed meanwhile), error is reported, lock released", async () => {
  const { st, press, lock } = rig();
  const p = press();
  st.box = "more";
  st.d.reject(new Error("daemon down"));
  await p;
  assert.equal(st.box, "hello\nmore");
  assert.deepEqual(st.errors, ["daemon down"]);
  assert.equal(lock.held, false);
  st.d = defer();
  st.d.resolve();
  await press(); // can send again
  assert.equal(st.calls.length, 2);
});

test("wiring: lock + Enter guards + no alert + SQUADS tab", () => {
  const drawer = src("AgentDrawer.tsx");
  assert.match(drawer, /guardedSend\(/);
  assert.doesNotMatch(drawer.slice(drawer.indexOf("const sendWithBehavior"), drawer.indexOf("const send = ")), /alert\(/);
  assert.match(src("Composer.tsx"), /if \(e\.repeat \|\| busy\) return;\s*send\(\);/);
});

test("wrap: markdown code blocks wrap inside the pane and the selected message makes room for its action bar", () => {
  const css = src("styles.css");
  assert.match(css, /\.tl-code-block pre \{[^}]*white-space: pre-wrap/);
  assert.match(css, /\.tl-assistant\[data-selected="true"\][^{]*\{ padding-top: 40px; \}/);
});
