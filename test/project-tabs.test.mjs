// T1 (docs/PLAN_CODE_STORYBOOK_TABS.md): shared Code | Storybook segmented pill + the present probe it gates on.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { transformSync } from "rolldown/utils";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

// ── ProjectTabs clicks (transpiled with a stubbed ./StorybookView so openStorybook/closeStorybook record their args) ──
const dir = mkdtempSync(join(tmpdir(), "vs-project-tabs-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const reactUrl = import.meta.resolve("react");
globalThis.__sbCalls = [];
writeFileSync(
  join(dir, "StorybookView.mjs"),
  `export const openStorybook = (...a) => { globalThis.__sbCalls.push(["openStorybook", ...a]); };
export const closeStorybook = (...a) => { globalThis.__sbCalls.push(["closeStorybook", ...a]); };`,
);
const tabsCode = transformSync("ProjectTabs.tsx", src("ProjectTabs.tsx"), { lang: "tsx", jsx: { runtime: "classic" } })
  .code.replace(/^/, `import React from ${JSON.stringify(reactUrl)};\n`)
  .replace(/from "react"/, `from ${JSON.stringify(reactUrl)}`)
  .replace(/from "\.\/StorybookView"/, `from "./StorybookView.mjs"`);
writeFileSync(join(dir, "ProjectTabs.mjs"), tabsCode);
const { ProjectTabs } = await import(pathToFileURL(join(dir, "ProjectTabs.mjs")).href);

function find(n, testid) {
  if (!n || typeof n !== "object") return null;
  if (Array.isArray(n)) return n.map((x) => find(x, testid)).find(Boolean) ?? null;
  if (n.props?.["data-testid"] === testid) return n;
  return find(n.props?.children, testid);
}

test("ProjectTabs: Storybook click calls openStorybook(id, name); Code click from Storybook closes with Back semantics (no mode)", () => {
  globalThis.__sbCalls = [];
  const codeView = ProjectTabs({ projectId: "p1", name: "Proj", active: "code" });
  find(codeView, "project-tab-storybook").props.onClick();
  assert.deepEqual(globalThis.__sbCalls, [["openStorybook", "p1", "Proj"]]);

  globalThis.__sbCalls = [];
  const storybookView = ProjectTabs({ projectId: "p1", name: "Proj", active: "storybook" });
  find(storybookView, "project-tab-code").props.onClick();
  // No "replace" argument = user-Back semantics (closeStorybook's mode defaults to Back).
  assert.deepEqual(globalThis.__sbCalls, [["closeStorybook"]]);
});

test("ProjectTabs: the active tab is inert (no re-open / no redundant close)", () => {
  globalThis.__sbCalls = [];
  find(ProjectTabs({ projectId: "p1", name: "Proj", active: "code" }), "project-tab-code").props.onClick();
  find(ProjectTabs({ projectId: "p1", name: "Proj", active: "storybook" }), "project-tab-storybook").props.onClick();
  assert.deepEqual(globalThis.__sbCalls, []);
});

test("ProjectTabs: active tab gets aria-pressed + .on, and the other is a boring-switch-pill", () => {
  const codeView = ProjectTabs({ projectId: "p1", name: "Proj", active: "code" });
  const code = find(codeView, "project-tab-code");
  const sb = find(codeView, "project-tab-storybook");
  assert.equal(code.props["aria-pressed"], true);
  assert.match(code.props.className, /\bon\b/);
  assert.match(sb.props.className, /boring-switch-pill/);
  assert.equal(sb.props["aria-pressed"], false);
});

// ── StorybookView present probe + ?sb= round-trip (structural: StorybookView.tsx imports a CSS file, so it is
//    verified as source text, the same technique the probe-notify test in storybook-view-logic.test.mjs uses) ──
test("useStorybookPresent: known 2xx -> present; 404/error/unknown stay hidden; one HEAD per project", () => {
  const s = src("StorybookView.tsx");
  // One status map behind both hooks; present is only ever set from a HEAD 2xx (r.ok), never optimistically.
  assert.ok(s.includes('const probe = new Map<string, "unknown" | "present" | "missing">();'), "single status map");
  assert.ok(s.includes('probe.set(projectId, "unknown");'), "first read starts unknown");
  assert.ok(s.includes("else if (r.ok) { probe.set(projectId, \"present\"); probeEmit(); }"), "2xx -> present + notify");
  assert.ok(s.includes('if (r.status === 404) { probe.set(projectId, "missing"); probeEmit(); }'), "404 -> missing + notify");
  assert.ok(s.includes('probe.get(projectId) === "present"'), "present hook reads present status");
  // The guard means a second probe of the same project never re-fetches: one HEAD per project until an error clears it.
  assert.ok(s.includes("if (!probe.has(projectId))"), "one HEAD per project (guarded)");
});

test("?sb= round-trips: open pushes ?sb=, and a reload restores the target from the URL", () => {
  const s = src("StorybookView.tsx");
  assert.ok(s.includes('history.pushState({ sb: projectId }, "", withSb(projectId))'), "openStorybook writes ?sb=");
  assert.ok(s.includes("const id0 = urlProject();"), "reload reads ?sb=");
  assert.ok(s.includes("target = id0 ? { projectId: id0, name: id0 } : null;"), "reload restores the Storybook target");
  assert.ok(s.includes('new URLSearchParams(location.search).get("sb")'), "?sb= parsed from the query string");
});

test("BoringAde topbar: pill renders right of the breadcrumb only when the project is known-present", () => {
  const a = src("BoringAde.tsx");
  assert.ok(a.includes("const storybookPresent = useStorybookPresent(view?.team.id ?? null);"), "gate reads useStorybookPresent");
  assert.ok(a.includes("{view && storybookPresent && <ProjectTabs projectId={view.team.id} name={view.team.name} active=\"code\" />}"), "pill gated on known-present, Code active");
  assert.match(a, /className="boring-topbar-lead"/, "breadcrumb + pill grouped so the breadcrumb ellipsizes first");
});

test("StorybookView sb-head: pill always shows with Storybook selected; Esc handler is untouched", () => {
  const s = src("StorybookView.tsx");
  assert.ok(s.includes("<ProjectTabs projectId={projectId} name={name} active=\"storybook\" />"), "pill in sb-head, Storybook active");
  assert.ok(s.includes('addEventListener("keydown", onKey, true)'), "Esc stays a capture-phase handler");
  assert.ok(s.includes('data-testid="sb-back"'), "← Back stays");
});

test("fix round (UX R22 M1/m1/m2/m3 + review M1): sb-head pill placement, active cue, phone title, Psycho base rules", () => {
  const css = src("storybook.css"), b = src("boring.css"), s = src("StorybookView.tsx");
  assert.match(css, /\.sb-title \{[^}]*flex: 0 1 auto/, "title no longer grows, so the pill follows it");
  assert.match(css, /\.sb-head-right \{[^}]*margin-left: auto/, "right cluster pushed to the end");
  assert.match(css, /\n\.sb-head \.project-tabs \.boring-switch-pill \{/, "unscoped (Psycho) pill base rule");
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*\.sb-root \.sb-head \.project-tabs \.boring-switch-pill \{ min-height: 40px; \}/, "phone 40px segments");
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*\.sb-word \{ display: none; \}/, "phone keeps the project name, drops the Storybook word");
  assert.ok(s.includes('<span className="sb-word">Storybook </span>'), "sb-word wrapper");
  assert.match(b, /\.project-tabs \.boring-switch-pill\.on \{ color: var\(--accent\); box-shadow: inset 0 0 0 1px var\(--accent\); \}/, "active cue scoped to .project-tabs, existing token");
  assert.ok(!/project-tabs[^{]*\{[^}]*opacity/.test(b + css), "dim by colour, never opacity");
});

test("probe hooks share one stable subscribeProbe", () => {
  const s = src("StorybookView.tsx");
  assert.ok(s.includes("const subscribeProbe = (cb: () => void) =>"));
  assert.ok(!s.includes("(cb) => { probeSubs.add(cb)"), "no inline per-render subscribe arrows");
  assert.equal(s.split("    subscribeProbe,\n").length - 1, 2, "both probe hooks use it");
});

test("T2: ⋯ menu entry removed; palette command 'Open Storybook: <project>' for non-missing projects; phone entry untouched", () => {
  const c = src("CommandPalette.tsx"), p = src("PhoneCockpit.tsx");
  assert.ok(!c.includes('label: "Open Storybook"'), "interim ⋯ item gone");
  assert.ok(c.includes("label: `Open Storybook: ${v.team.name}`"), "palette command label");
  assert.ok(c.includes("filter((v) => !probeStorybook(v.team.id))"), "hidden when known-missing");
  assert.ok(c.includes('id.startsWith("storybook:")') && c.includes("openStorybook(v.team.id, v.team.name)"), "command opens Storybook");
  assert.ok(p.includes('data-testid="phone-storybook-btn"') && p.includes("view && !sbMissing"), "phone ⋯ entry stays (own button, not teamCtxItems)");
});
