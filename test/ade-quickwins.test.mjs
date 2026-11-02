import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  attentionTotal,
  fullTime,
  pruneView,
  renameKeyAction,
  renameOutcome,
  tabTitle,
} from "../src/quickwins.ts";
import { planAgentRename, renameDraftFor } from "../src/renameAgent.ts";
import { expectedV2TitleFor } from "../src/teams.ts";

// prefs.ts reads localStorage lazily; give it an in-memory one before it loads.
const mem = new Map();
Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => void mem.set(k, String(v)), removeItem: (k) => void mem.delete(k) },
  configurable: true,
  writable: true,
});
const P = await import("../src/prefs.ts");
const fresh = (seed = {}) => {
  mem.clear();
  for (const [k, v] of Object.entries(seed)) mem.set(k, v);
  P._resetPrefsCache();
};

// Block 2 quick wins (walk rows 42/57/58/62/63/64): node-only logic plus source wiring checks.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("57: tab title carries the needs-you count; zero clears it", () => {
  assert.equal(tabTitle(0), "VibeSquad");
  assert.equal(tabTitle(3), "(3) VibeSquad");
  assert.equal(tabTitle(250), "(99+) VibeSquad");
  assert.equal(attentionTotal([{ needsYou: 2 }, { needsYou: 1 }, { needsYou: 0 }]), 3);
  assert.equal(attentionTotal([]), 0);
  assert.equal(attentionTotal([{ needsYou: -4 }, { needsYou: NaN }]), 0);
});

test("57: wired to the same per-team needsYou that already skips archived/closed agents", () => {
  assert.match(read("src/App.tsx"), /useAttentionTitle\(views\)/);
  assert.match(read("src/QuickWinsUi.tsx"), /canvas/i);
  assert.match(read("src/attentionItems.ts"), /archivedAt \|\| m\.agent\.status === "closed"/);
});

test("64: stamps use prefs.formatTimestamp and follow chat.timestampFormat live", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const iso = new Date(now - 300_000).toISOString();
  assert.equal(P.formatTimestamp(iso, "relative", now), "5m ago");
  assert.match(P.formatTimestamp(iso, "both", now), / · 5m ago$/);
  assert.equal(P.formatTimestamp("bad", "relative", now), "");
  fresh({});
  assert.equal(P.getTimestampFormat(), "relative");
  P.setPref("chat.timestampFormat", "absolute");
  assert.equal(P.getTimestampFormat(), "absolute");
  const ui = read("src/QuickWinsUi.tsx");
  assert.ok(ui.includes(`usePref("chat.timestampFormat")`));
  assert.ok(ui.includes("title={fullTime(iso)}"));
  assert.doesNotMatch(read("src/quickwins.ts"), /vs.prefs.v1/);
});

test("62: rename keys and outcome", () => {
  assert.equal(renameKeyAction("Enter"), "save");
  assert.equal(renameKeyAction("Escape"), "cancel");
  assert.equal(renameKeyAction("a"), null);
  assert.equal(renameOutcome("  New  ", "Old"), "New");
  assert.equal(renameOutcome("Old", "Old"), null);
  assert.equal(renameOutcome("   ", "Old"), null);
});

test("62: lane-coded agents rename the job/topic and keep the code in the title; others take the typed name", () => {
  const mk = (title, labels) => ({ id: "a1", title, status: "idle", labels });
  const worker = mk("Hub · drop files", { team: "vibesquad", lane: "vibesquad", role: "worker", job: "drop files" });
  assert.equal(renameDraftFor(worker), "drop files");
  const plan = planAgentRename(worker, "paste files");
  assert.equal(plan.name, "Hub · paste files");
  assert.equal(plan.labels.job, "paste files");
  assert.equal(expectedV2TitleFor({ ...worker, title: plan.name, labels: plan.labels }), plan.name);
  const bs = mk("Hub Buddy", { team: "vibesquad", lane: "vibesquad", role: "brainstorm" });
  assert.equal(planAgentRename(bs, "naming").name, "Hub Buddy · naming");
  const plain = mk("scratch", {});
  assert.equal(renameDraftFor(plain), "scratch");
  assert.deepEqual(planAgentRename(plain, "throwaway"), { name: "throwaway" });
});

test("62: plain vs lane-coded is decided from labels, not from whether a title can be computed", () => {
  const mk = (title, labels) => ({ id: "a1", title, status: "idle", labels });
  // (a) no lane/role labels + legacy "(talk here" title: plain rename, no label edit.
  const talk = mk("EFI lead (talk here, runs the work)", {});
  assert.equal(renameDraftFor(talk), "EFI lead (talk here, runs the work)");
  assert.deepEqual(planAgentRename(talk, "fresh name"), { name: "fresh name" });
  // (b) lane-coded worker with no / empty job still gets labels.job and the coded title.
  for (const labels of [{ team: "vibesquad", lane: "vibesquad", role: "worker" }, { team: "vibesquad", lane: "vibesquad", role: "worker", job: "" }]) {
    const w = mk("whatever", labels);
    assert.equal(renameDraftFor(w), "");
    const plan = planAgentRename(w, "do it");
    assert.equal(plan.labels.job, "do it");
    assert.equal(plan.name, "Hub · do it");
  }
});

test("62: wired into the drawer title, both team headers, and the existing updateAgent / saveTeams paths", () => {
  assert.match(read("src/DrawerHeader.tsx"), /<AgentTitleEdit agent=\{agent\}>/);
  assert.equal((read("src/App.tsx").match(/<TeamNameEdit team=\{view\.team\} \/>/g) ?? []).length, 2);
  const ui = read("src/QuickWinsUi.tsx");
  assert.match(ui, /updateAgent\(agent\.id/);
  assert.match(ui, /saveTeams\(/);
  assert.match(ui, /onBlur=\{\(\) => finish\(true\)\}/);
});

test("42: restore is gated by the Settings pref app.restoreLastView (default on)", () => {
  fresh({});
  assert.equal(P.getRestoreLastView(), true);
  P.setPref("app.restoreLastView", false);
  assert.equal(P.getRestoreLastView(), false);
  assert.ok(read("src/panes.ts").includes("getRestoreLastView()"));
  assert.ok(read("src/App.tsx").includes("getRestoreLastView() ?"));
});

test("42: pruneView drops missing/archived agents and repairs actives, split and pane", () => {
  const live = (id) => id !== "gone";
  const saved = { leftTabs: ["a", "gone", "b"], rightTabs: ["c"], leftActiveId: "gone", rightActiveId: "c", split: true, activePane: "right" };
  assert.deepEqual(pruneView(saved, live), { leftTabs: ["a", "b"], rightTabs: ["c"], leftActiveId: "a", rightActiveId: "c", split: true, activePane: "right" });
  const rightGone = { ...saved, rightTabs: ["gone"], rightActiveId: "gone" };
  const r = pruneView(rightGone, live);
  assert.equal(r.split, false);
  assert.equal(r.activePane, "left");
  assert.deepEqual(r.rightTabs, []);
  const leftGone = pruneView({ ...saved, leftTabs: ["gone"], leftActiveId: "gone" }, live);
  assert.deepEqual([leftGone.leftTabs, leftGone.split, leftGone.leftActiveId], [["c"], false, "c"]);
  const none = pruneView({ ...saved, leftTabs: ["gone"], rightTabs: [] }, live);
  assert.deepEqual([none.leftTabs, none.leftActiveId, none.split], [[], null, false]);
});

test("58: slow actions use a delayed indicator (open agent, load older, open diff)", () => {
  const ui = read("src/QuickWinsUi.tsx");
  assert.match(ui, /BUSY_DELAY_MS/);
  assert.match(read("src/quickwins.ts"), /BUSY_DELAY_MS = 300/);
  const tl = read("src/Timeline.tsx");
  assert.match(tl, /useDelayedBusy\(!loaded && entries\.length === 0\)/);
  assert.match(tl, /useDelayedBusy\(loadingMore\)/);
  assert.match(read("src/ChangesPanel.tsx"), /useDelayedBusy\(loading\)/);
});
