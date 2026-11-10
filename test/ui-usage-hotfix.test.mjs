// Usage hotfix: 'Loading usage…' must not hang forever, and art that exists must not stay hidden after one failed probe.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fetchJsonTimeout, imageRetryDelay } from "../src/fetchTimeout.ts";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("fetchJsonTimeout: a request that never answers rejects with a timeout instead of hanging", async () => {
  const hang = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
  await assert.rejects(fetchJsonTimeout("/x/usage", 30, hang), /timed out/);
});

test("fetchJsonTimeout: data passes through, http errors surface", async () => {
  const ok = async () => ({ ok: true, json: async () => ({ a: 1 }) });
  assert.deepEqual(await fetchJsonTimeout("/x/usage", 1000, ok), { a: 1 });
  const bad = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(fetchJsonTimeout("/x/usage", 1000, bad), /usage 503/);
});

test("useUsage loads through the timeout helper and the dashboard shows the error", () => {
  const s = src("UsageDashboard.tsx");
  assert.match(s, /fetchJsonTimeout\("\/__vibesquad\/providers\/usage"/);
  assert.doesNotMatch(s, /await fetch\("\/__vibesquad\/providers\/usage"\)/);
  assert.match(s, /Usage unavailable: \$\{error\}/);
});

test("image probe retries a failed load on a backoff instead of staying hidden", () => {
  assert.equal(imageRetryDelay(0), 1500);
  assert.equal(imageRetryDelay(99), null);
  const b = src("useBotFace.ts");
  const fn = b.slice(b.indexOf("export function useImageOk"), b.indexOf("export const FACE_URL"));
  assert.match(fn, /imageRetryDelay/);
});

const server = () => readFileSync(new URL("../server/providers-catalog.mjs", import.meta.url), "utf8");

test("usage: the per-cwd unit name is memoised (attributeImplementer ran it units x agents times and blocked the runtime ~6s per request)", () => {
  const s = server();
  assert.match(s, /const unitNameCache = new Map\(\)/);
  assert.match(s, /unitNameCache\.get\(cwd\)/);
});

test("art hooks: module-scope caches give a synchronous initial state, and the sheet loads in parallel with faces.json", () => {
  const b = src("useBotFace.ts");
  assert.match(b, /const loadedImages = new Set<string>\(\)/);
  assert.match(b, /useState\(\(\) => !!url && loadedImages\.has\(url\)\)/);
  assert.match(b, /const jsonModels = new Map<string, unknown>\(\)/);
  assert.match(b, /useState<T \| null>\(\(\) => \(jsonModels\.get\(url\)/);
  assert.match(b, /useFacesModel = \(\): FacesModel \| null => useJsonModel\(/);
  assert.match(b, /const sheetOk = useImageOk\(sheetUrl\)/);
  assert.doesNotMatch(b, /useImageOk\(faces\?\.bots\[bot\]/);
});
