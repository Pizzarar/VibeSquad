import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { transformSync } from "rolldown/utils";

// idea-468: BoringContextPanel must render without an agent (a lane with only workers). The BoringApp wiring
// (real lane id, key, error boundary, Desk hub fallback) is covered behaviorally in test/boring-mode.test.mjs.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(import.meta.url);
const reactUrl = pathToFileURL(req.resolve("react")).href;
const { renderToStaticMarkup } = req("react-dom/server");
const React = req("react");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-ctxpanel-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
const stub = (n, body) => fs.writeFileSync(path.join(dir, n + ".mjs"), `import React from ${JSON.stringify(reactUrl)};\n${body}\n`);
const mk = (id, status, laneId) => ({ kind: "worker", laneId, agent: { id, status, title: `T-${id}`, updatedAt: new Date().toISOString() }, attention: null });
globalThis.__members = [mk("w-run", "running", "Bug-Chaser"), mk("w-idle", "idle", "bug-chaser"), mk("w-other", "running", "other")];
stub("agentTypes", "");
for (const n of ["ChangesPanel", "FilesPanel", "TerminalPanel"]) stub(n, `export const ${n} = (p) => { if (!p.agent) throw new Error("${n} needs an agent"); return null; };`);
stub("BoringAde", `export const boringStateGlyph = (s) => (s === "running" ? "run" : "idle"); export const boringWorkerIsLive = (m) => m.agent.status === "running";`);
stub("demo", "export const demoLog = () => [];");
stub("demoFlag", "export const DEMO = true;");
stub("panes", "export const openAgent = () => {};");
stub("paseo", "export const usePaseo = () => ({ agents: new Map() });");
stub("teams", "export const resolve = () => globalThis.__members;");
stub("Timeline", "export const findPinnedTodo = () => null;");
stub("ui", "export const Ago = () => null;");
stub("condenseReason", "export const condenseReason = (s) => s;");
stub("pins", "export const isLive = () => true;");
stub("RightDock", "");
const code = transformSync("BoringContextPanel.tsx", fs.readFileSync(path.join(root, "src", "BoringContextPanel.tsx"), "utf8"), { lang: "tsx", jsx: { runtime: "classic" } }).code
  .replace(/^/, `import React from ${JSON.stringify(reactUrl)};\n`)
  .replace("useSyncExternalStore(subscribe, snapshot, () => false)", "useSyncExternalStore(subscribe, snapshot, snapshot)") // SSR snapshot = the client one, so the open pref renders
  .replace(/from "react"/, `from ${JSON.stringify(reactUrl)}`)
  .replace(/from "\.\/(\w+)"/g, (_m, n) => `from "./${n}.mjs"`);
fs.writeFileSync(path.join(dir, "BoringContextPanel.mjs"), code);

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, String(v)), removeItem: (k) => void store.delete(k) };
globalThis.window = { innerWidth: 1920, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
const { BoringContextPanel } = await import(pathToFileURL(path.join(dir, "BoringContextPanel.mjs")).href);
const html = (tab, laneId = "bug-chaser") => {
  store.set("vs.context-panel.open", "1");
  store.set("vs.context-panel.tab", tab);
  return renderToStaticMarkup(React.createElement(BoringContextPanel, { entries: [], teamId: "vs", laneId }));
};

test("agent undefined: Workers tab lists the lane's workers (case-insensitive lane match), not other lanes", () => {
  const h = html("Workers");
  assert.match(h, /data-testid="boring-ctx-worker-w-run"/);
  assert.doesNotMatch(h, /boring-ctx-worker-w-other/);
  assert.match(h, /1 idle worker/);
  assert.doesNotMatch(h, /No live workers in this lane/);
});

test("agent undefined: the sentinel lane id finds nothing (why callers must pass the real lane id)", () => {
  assert.match(html("Workers", "_bugs"), /No live workers in this lane/);
});

for (const tab of ["Changes", "Files", "Terminal"]) {
  test(`agent undefined: ${tab} tab shows boring-ctx-no-agent and does not throw`, () => {
    const h = html(tab);
    assert.match(h, /data-testid="boring-ctx-no-agent"/);
    assert.match(h, new RegExp(`Open a Lead or Brainstorm to use ${tab}`));
  });
}

test("agent undefined: Plan and Feed tabs render", () => {
  assert.match(html("Plan"), /boring-ctx-plan-empty/);
  assert.doesNotMatch(html("Feed"), /boring-ctx-no-agent/);
});
