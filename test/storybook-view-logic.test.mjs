import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transformSync } from "rolldown/utils";

// MermaidView.tsx: load only the pure parser half (same trick as mermaid-view.test.mjs).
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      const raw = readFileSync(fileURLToPath(url), "utf8");
      const cut = raw.indexOf("// ─── React Component");
      return { format: "module-typescript", shortCircuit: true, source: cut !== -1 ? raw.slice(0, cut) : raw };
    }
    return nextLoad(url, context);
  },
});
const { parseMermaid } = await import("../src/MermaidView.tsx");
const L = await import("../src/storybookLogic.ts");

const snap = JSON.parse(readFileSync(new URL("./fixtures/storybook/efi-mini.json", import.meta.url), "utf8"));
const idx = L.indexEntities(snap.entities);

describe("storybookLogic", () => {
  test("finding→category map", () => {
    for (const c of ["#1", "#2", "#5"]) assert.equal(L.findingCategory(c), "broken");
    for (const c of ["#3", "#4", "#6", "#7", "#9", "#10", "#11"]) assert.equal(L.findingCategory(c), "inconsistent");
    assert.equal(L.findingCategory("#8"), "missing");
    assert.equal(L.findingCategory("#99"), null);
  });

  test("identity is (kind,id): doc trader and doc squad both resolve", () => {
    assert.equal(idx.get("trader", "doc").display, "Doc");
    assert.equal(idx.get("squad", "doc").display, "Saint");
  });

  test("list items: sample finding is Broken, non-OWNER-OK csv rows Unreviewed", () => {
    const items = L.buildListItems(snap);
    const broken = items.filter((i) => i.category === "broken");
    assert.equal(broken.length, 1);
    assert.deepEqual(broken[0].entityRef, { kind: "quest_step", id: "popper_2" });
    const unrev = items.filter((i) => i.category === "unreviewed");
    const csvRows = snap.entities.filter((e) => e.kind === "line" && typeof e.data.status === "string");
    assert.equal(unrev.length, csvRows.filter((e) => e.data.status.trim().toUpperCase() !== "OWNER-OK").length);
    assert.ok(unrev.length > 0);
    assert.ok(!unrev.some((i) => /^OWNER-OK/.test(i.msg)));
  });

  test("OWNER-OK rows are not unreviewed; non-csv lines never are", () => {
    const mk = (status) => ({ kind: "line", id: "x", display: "t", data: { status, text: "t" }, links: [], source: { path: "a", line: 1 } });
    assert.equal(L.isUnreviewedLine(mk("OWNER-OK")), false);
    assert.equal(L.isUnreviewedLine(mk("owner-ok ")), false);
    assert.equal(L.isUnreviewedLine(mk("DRAFT")), true);
    assert.equal(L.isUnreviewedLine({ ...mk(undefined), data: { text: "t" } }), false);
  });

  test("filter: empty = all, toggle adds/removes, counts", () => {
    const items = L.buildListItems(snap);
    assert.equal(L.filterItems(items, new Set()).length, items.length);
    const only = L.filterItems(items, L.toggleCategory(new Set(), "broken"));
    assert.ok(only.length >= 1 && only.every((i) => i.category === "broken"));
    assert.equal(L.toggleCategory(new Set(["broken"]), "broken").size, 0);
    const c = L.countByCategory(items);
    assert.equal(c.broken + c.missing + c.inconsistent + c.unreviewed, items.length);
  });

  test("quest chains: per trader, ordered; mermaid links step→target and parses", () => {
    const chains = L.questChains(idx);
    const popper = chains.find((c) => c.traderId === "popper");
    assert.deepEqual(popper.steps.map((s) => s.id), ["popper_1", "popper_2"]);
    const g = L.chainToMermaid(popper, idx);
    assert.match(g.code, /^flowchart (LR|TD)/);
    assert.match(g.code, /n0 --> n2|n0 --> n1/);
    const names = Object.values(g.nodes).map((e) => `${e.kind}:${e.id}`);
    for (const n of ["quest_step:popper_1", "quest_step:popper_2", "item:scrap_metal", "enemy:scav", "location:harbor_district"]) assert.ok(names.includes(n), n);
    const parsed = parseMermaid(g.code);
    assert.equal(parsed.ok, true);
    assert.ok(!g.code.includes("STORY-TODO"));
  });

  test("mermaid: index/rel sanitized, long chains lay out top-down", () => {
    const evil = { ...idx.get("quest_step", "popper_2"), data: { ...idx.get("quest_step", "popper_2").data, index: '1"]; n88["X' } };
    const chain = { traderId: "popper", trader: null, steps: [evil] };
    const g = L.chainToMermaid(chain, idx);
    assert.doesNotMatch(g.code, /n88\[/);
    assert.equal(g.code.split("\n").filter((l) => /^  n\d+\[/.test(l)).length, 1);
    assert.equal(L.mermaidLabel("a%%b"), "a b");
    const many = Array.from({ length: L.LONG_CHAIN + 1 }, (_, i) => ({ ...evil, id: "s" + i, data: { index: i + 1 }, links: [] }));
    assert.match(L.chainToMermaid({ traderId: "p", trader: null, steps: many }, idx).code, /^flowchart TD/);
  });

  test("mermaid labels are sanitized", () => {
    assert.equal(L.mermaidLabel('a "b" [c] {d} (e) | f'), "a b c d e f");
  });

  test("location view: enemy windows, boss, quests", () => {
    const v = L.locationView(idx.get("location", "harbor_district"), idx);
    assert.deepEqual(v.enemies.map((e) => e.id), ["scav", "armored_scav", "boss_dockmaster"]);
    assert.equal(v.enemies[1].minS, 600);
    assert.equal(v.enemies[2].boss, true);
    assert.deepEqual(v.quests.map((q) => q.id), ["popper_2"]);
    assert.ok(v.lore.some((l) => l.id === "map:harbor_district"));
    assert.equal(L.fmtWindow(600, 1800), "10m–30m");
    assert.equal(L.fmtWindow(null, null), "any time");
  });

  test("character view groups csv display-name speakers with id speakers; voice card attached", () => {
    const chars = L.characterViews(idx);
    const popper = chars.find((c) => c.id === "popper");
    assert.ok(popper.card);
    assert.equal(popper.speaker, "Popper");
    assert.ok(popper.lines.length >= 3);
    assert.ok(chars.some((c) => c.id === "narrator"));
  });

  test("entity card: text, speaker, area, status, owner_note, source file:line", () => {
    const csv = snap.entities.find((e) => e.id.startsWith("csv:data/questlines.json:12"));
    const c = L.entityCard(csv, idx);
    assert.equal(c.status, "DRAFT");
    assert.equal(c.ownerNote, "keep it short");
    assert.equal(c.source, "data/questlines.json:12");
    assert.equal(c.speaker, "Popper");
    assert.match(c.text, /thirty casings/);
    const q = L.entityCard(idx.get("quest_step", "popper_2"), idx);
    assert.equal(q.area, "Harbor District");
    assert.match(q.text, /Kill scav ×10/);
  });

  test("load/refresh interpretation: 404 → none, fetched=false → rate-limit notice", () => {
    assert.equal(L.interpretLoad(404, { error: "x" }).kind, "none");
    assert.equal(L.interpretLoad(200, snap).kind, "ok");
    assert.equal(L.interpretLoad(500, { error: "boom" }).message, "boom");
    const r = L.interpretRefresh(200, { fetched: false, skipped: "rate-limited", nextFetchAt: new Date(Date.now() + 3600e3).toISOString(), ...snap });
    assert.match(r.notice, /one fetch per hour; showing the pinned sha\. Next fetch allowed after/);
    assert.match(r.status, /^Checked .* next fetch /);
    assert.ok(r.snap);
    assert.equal(L.interpretRefresh(200, { fetched: true, nextFetchAt: null, ...snap }).notice, null);
    assert.match(L.interpretRefresh(200, { fetched: true, ...snap }).status, /^Up to date · checked /);
    assert.equal(L.interpretLoad(200, { entities: [] }).kind, "error"); // no sha: malformed payload
    assert.equal(L.interpretRefresh(404, {}).error, L.NO_STORYBOOK);
  });
});

// The known-missing probe (StorybookView.tsx) must notify subscribers when a probe resolves, so a consumer that read the
// cache at render (the phone drawer's "Open Storybook" entry) re-renders once the HEAD request lands — otherwise a slow
// host link leaves the entry visible for a project with no Storybook (UX R21 m1).
test("StorybookView probe notify path: subscribe/notify re-renders consumers when a probe resolves", () => {
  const s = readFileSync(new URL("../src/StorybookView.tsx", import.meta.url), "utf8");
  assert.ok(s.includes("const probeSubs = new Set<() => void>();"), "probe subscriber set");
  assert.ok(s.includes("const probeEmit = () => probeSubs.forEach((f) => f());"), "probe notify");
  assert.ok(s.includes('probe.set(projectId, "missing"); probeEmit();'), "404 resolves → notify (missing)");
  assert.ok(s.includes('probe.set(projectId, "present"); probeEmit();'), "2xx resolves → notify (present)");
  assert.ok(s.includes("probe.delete(projectId); probeEmit();"), "non-ok / network error → notify (retry)");
  assert.ok(s.includes("export function useStorybookMissing"), "missing consumer hook");
  assert.ok(s.includes("export function useStorybookPresent"), "present consumer hook");
  assert.ok(s.includes('probe.get(projectId) === "missing"'), "missing hook reads missing status");
  assert.ok(s.includes('probe.get(projectId) === "present"'), "present hook reads present status");
  assert.ok(s.includes("probeSubs.add(cb)") && s.includes("probeSubs.delete(cb)"), "hooks subscribe via useSyncExternalStore");
  assert.ok(s.includes("useSyncExternalStore("), "uses useSyncExternalStore");
});

// ── idea-947: behavioural tests for Storybook probe re-probe on focus/visibilitychange after error ──
describe("Storybook probe re-probe on focus / visibilitychange (idea-947)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-sb-probe-"));
  const origWindow = globalThis.window;
  const origDocument = globalThis.document;
  const origFetch = globalThis.fetch;
  const origDateNow = Date.now;

  const winListeners = new Map();
  const docListeners = new Map();
  const addL = (map) => (ev, fn) => {
    if (!map.has(ev)) map.set(ev, new Set());
    map.get(ev).add(fn);
  };
  const remL = (map) => (ev, fn) => { map.get(ev)?.delete(fn); };
  const fire = (map, ev) => { for (const fn of [...(map.get(ev) ?? [])]) fn(); };

  let fakeNow = 10_000;
  let visibilityState = "visible";
  let fetchHandler = async () => ({ ok: false, status: 500 });
  const fetchCalls = [];

  globalThis.window = {
    addEventListener: addL(winListeners),
    removeEventListener: remL(winListeners),
  };
  globalThis.document = {
    get visibilityState() { return visibilityState; },
    addEventListener: addL(docListeners),
    removeEventListener: remL(docListeners),
  };
  globalThis.fetch = (url, init) => {
    fetchCalls.push({ url, init });
    return fetchHandler(url, init);
  };
  Date.now = () => fakeNow;

  after(() => {
    globalThis.window = origWindow;
    globalThis.document = origDocument;
    globalThis.fetch = origFetch;
    Date.now = origDateNow;
    rmSync(dir, { recursive: true, force: true });
  });

  // Minimal React hook runtime: supports mount, re-render, subscriber notifications, and unmount cleanup.
  const runtime = { active: null };
  globalThis.__sbProbeReact = {
    useSyncExternalStore(sub, getSnap) {
      const inst = runtime.active;
      if (!inst.unsub) inst.unsub = sub(() => { inst.notifies++; });
      return getSnap();
    },
    useEffect(fn, deps) {
      const inst = runtime.active;
      const same = inst.deps && deps && inst.deps.length === deps.length && inst.deps.every((d, i) => Object.is(d, deps[i]));
      if (same) return;
      if (typeof inst.cleanup === "function") inst.cleanup();
      inst.deps = deps;
      inst.cleanup = fn();
    },
  };

  writeFileSync(
    join(dir, "react.mjs"),
    `export default { createElement() { return null; } };
export const useSyncExternalStore = (...a) => globalThis.__sbProbeReact.useSyncExternalStore(...a);
export const useEffect = (...a) => globalThis.__sbProbeReact.useEffect(...a);
export const useCallback = (f) => f;
export const useLayoutEffect = () => {};
export const useMemo = (f) => f();
export const useRef = (v) => ({ current: v });
export const useState = (v) => [typeof v === "function" ? v() : v, () => {}];`,
  );
  writeFileSync(join(dir, "stub.mjs"), `export const createPortal = () => null; export const MermaidView = () => null; export const rootZoom = () => 1; export const ProjectTabs = () => null; export const SB_CATEGORIES = []; export const SB_CATEGORY_LABEL = {}; export const NO_STORYBOOK = ""; export const SB_CATEGORY_HELP = {}; export const buildListItems = () => []; export const chainToMermaid = () => ({}); export const checkLabel = () => ""; export const plainText = (s) => s; export const characterViews = () => []; export const countByCategory = () => ({}); export const entityCard = () => ({}); export const filterItems = () => []; export const fmtSource = () => ""; export const fmtWindow = () => ""; export const indexEntities = () => ({}); export const interpretLoad = () => ({}); export const interpretRefresh = () => ({}); export const locationView = () => ({}); export const questChains = () => []; export const shortSha = () => ""; export const toggleCategory = () => new Set(); export const cleanTodo = (s) => s;`);

  const sbCode = transformSync("StorybookView.tsx", readFileSync(new URL("../src/StorybookView.tsx", import.meta.url), "utf8"), { lang: "tsx", jsx: { runtime: "classic" } })
    .code.replace(/^/, `import React from "./react.mjs";\n`)
    .replace(/import "\.\/storybook\.css";\n?/, "")
    .replace(/from "react"/g, `from "./react.mjs"`)
    .replace(/from "(react-dom|\.\/MermaidView|\.\/pinMenuPlace|\.\/storybookLogic|\.\/ProjectTabs)"/g, `from "./stub.mjs"`);
  writeFileSync(join(dir, "StorybookView.mjs"), sbCode);

  let mod;
  const loadMod = async () => { if (!mod) mod = await import(pathToFileURL(join(dir, "StorybookView.mjs")).href); return mod; };
  const flush = () => new Promise((r) => setImmediate(r));

  function mountHook(hook, projectId) {
    const inst = { deps: null, cleanup: null, unsub: null, notifies: 0, value: false };
    const render = (id = projectId) => {
      projectId = id;
      runtime.active = inst;
      try { inst.value = hook(projectId); } finally { runtime.active = null; }
      return inst.value;
    };
    const unmount = () => {
      if (typeof inst.cleanup === "function") { inst.cleanup(); inst.cleanup = null; }
      if (typeof inst.unsub === "function") { inst.unsub(); inst.unsub = null; }
    };
    render(projectId);
    return { inst, render, unmount };
  }

  test("5xx / network error → window focus → re-probe → 200 flips useStorybookPresent to true", async () => {
    const { useStorybookPresent } = await loadMod();
    fetchCalls.length = 0;
    fakeNow = 10_000;
    fetchHandler = async () => ({ ok: false, status: 503 });

    const h = mountHook(useStorybookPresent, "proj-focus-5xx");
    assert.equal(h.inst.value, false);
    assert.equal(fetchCalls.length, 1);
    await flush();
    assert.equal(h.render(), false);

    // Server recovers; window focus triggers re-probe.
    fetchHandler = async () => ({ ok: true, status: 200 });
    fire(winListeners, "focus");
    assert.equal(fetchCalls.length, 2);
    await flush();
    assert.equal(h.render(), true);
    assert.ok(h.inst.notifies >= 2, "subscriber notified on resolution");
    h.unmount();
  });

  test("network rejection → visibilitychange (only when visible) → re-probe → 404 flips useStorybookMissing to true", async () => {
    const { useStorybookMissing } = await loadMod();
    fetchCalls.length = 0;
    fakeNow = 20_000;
    fetchHandler = async () => { throw new Error("offline"); };

    const h = mountHook(useStorybookMissing, "proj-vis-neterr");
    assert.equal(fetchCalls.length, 1);
    await flush();
    assert.equal(h.render(), false);

    // Hidden transition must not re-probe.
    visibilityState = "hidden";
    fire(docListeners, "visibilitychange");
    assert.equal(fetchCalls.length, 1);

    // Visible transition re-probes and caches definite 404.
    visibilityState = "visible";
    fetchHandler = async () => ({ ok: false, status: 404 });
    fire(docListeners, "visibilitychange");
    assert.equal(fetchCalls.length, 2);
    await flush();
    assert.equal(h.render(), true);
    h.unmount();
  });

  test("throttle: at most once per 5s per project on repeated errors, independent across projects", async () => {
    const { useStorybookPresent } = await loadMod();
    fetchCalls.length = 0;
    fakeNow = 30_000;
    fetchHandler = async () => ({ ok: false, status: 502 });

    const hA = mountHook(useStorybookPresent, "proj-throttle-a");
    const hB = mountHook(useStorybookPresent, "proj-throttle-b");
    assert.equal(fetchCalls.length, 2);
    await flush();

    // First focus re-probes both projects (both fail again).
    fire(winListeners, "focus");
    assert.equal(fetchCalls.length, 4);
    await flush();

    // Within 5s: focus and visibilitychange are both throttled (no spam).
    fakeNow += 2_000;
    fire(winListeners, "focus");
    visibilityState = "visible";
    fire(docListeners, "visibilitychange");
    assert.equal(fetchCalls.length, 4);

    // At +4999ms: still throttled.
    fakeNow = 34_999;
    fire(winListeners, "focus");
    assert.equal(fetchCalls.length, 4);

    // At +5000ms: allowed again.
    fakeNow = 35_000;
    fetchHandler = async (url) => (url.includes("proj-throttle-a") ? { ok: true, status: 200 } : { ok: false, status: 502 });
    fire(winListeners, "focus");
    assert.equal(fetchCalls.length, 6);
    await flush();
    assert.equal(hA.render(), true);
    assert.equal(hB.render(), false);

    hA.unmount();
    hB.unmount();
  });

  test("no re-probe after a definite answer (200 or 404)", async () => {
    const { useStorybookPresent, useStorybookMissing } = await loadMod();
    fetchCalls.length = 0;
    fakeNow = 50_000;

    fetchHandler = async () => ({ ok: true, status: 200 });
    const hPresent = mountHook(useStorybookPresent, "proj-def-200");
    fetchHandler = async () => ({ ok: false, status: 404 });
    const hMissing = mountHook(useStorybookMissing, "proj-def-404");
    assert.equal(fetchCalls.length, 2);
    await flush();
    assert.equal(hPresent.render(), true);
    assert.equal(hMissing.render(), true);

    // Advance well past throttle window and fire both events: zero extra fetches.
    fakeNow += 60_000;
    fire(winListeners, "focus");
    visibilityState = "visible";
    fire(docListeners, "visibilitychange");
    assert.equal(fetchCalls.length, 2);

    hPresent.unmount();
    hMissing.unmount();
  });

  test("unmount cleans up focus and visibilitychange listeners", async () => {
    const { useStorybookPresent } = await loadMod();
    fetchCalls.length = 0;
    fakeNow = 120_000;
    fetchHandler = async () => ({ ok: false, status: 500 });

    const beforeWin = winListeners.get("focus")?.size ?? 0;
    const beforeDoc = docListeners.get("visibilitychange")?.size ?? 0;
    const h = mountHook(useStorybookPresent, "proj-unmount");
    assert.equal(winListeners.get("focus")?.size ?? 0, beforeWin + 1);
    assert.equal(docListeners.get("visibilitychange")?.size ?? 0, beforeDoc + 1);
    await flush();

    h.unmount();
    assert.equal(winListeners.get("focus")?.size ?? 0, beforeWin);
    assert.equal(docListeners.get("visibilitychange")?.size ?? 0, beforeDoc);

    // Subsequent events must not re-probe the unmounted project.
    fire(winListeners, "focus");
    visibilityState = "visible";
    fire(docListeners, "visibilitychange");
    assert.equal(fetchCalls.length, 1);
  });
});
