// idea-239: reconnect storms must not refetch the heavy /usage each time.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { cachedLoader } from "../src/cachedLoad.ts";

test("concurrent callers share one in-flight request", async () => {
  let n = 0;
  const load = cachedLoader(async () => { n++; await new Promise((r) => setTimeout(r, 10)); return n; }, 1000);
  const r = await Promise.all([load(), load(), load()]);
  assert.deepEqual(r, [1, 1, 1]);
  assert.equal(n, 1);
});

test("fresh result is reused; stale or forced refetches", async () => {
  let n = 0, t = 0;
  const load = cachedLoader(async () => ++n, 100, () => t);
  await load(); t = 50; await load();
  assert.equal(n, 1);
  t = 150; await load();
  assert.equal(n, 2);
  await load(true);
  assert.equal(n, 3);
});

test("failures are not cached and clear the in-flight slot", async () => {
  let n = 0;
  const load = cachedLoader(async () => { if (++n === 1) throw new Error("boom"); return n; }, 1000);
  await assert.rejects(load(), /boom/);
  assert.equal(await load(), 2);
});

test("loadRunnerUsage goes through the cached loader", () => {
  assert.match(readFileSync(new URL("../src/paseoProviders.ts", import.meta.url), "utf8"), /loadRunnerUsage[^\n]*=\s*cachedLoader\(/);
});
