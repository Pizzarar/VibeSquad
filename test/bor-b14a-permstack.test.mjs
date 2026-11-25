// B14a: Normal-mode pending-permission stack (n7 idea-751) + Working-now strip suppression (n8 UX R17).
//   n7 — pending permission cards stack inside .boring-perm-stack with max-height + overflow-y:auto, so 2-3 cards at
//        1280x720 never crush the timeline to 0px or clip Allow/Deny.
//   n8 — when a permission card renders below the Working-now strip, the strip's redundant "needs your OK" is collapsed
//        via a data-has-perm hook (boring.css display:none); non-permission needs-you states keep the strip.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "rolldown/utils";

const root = resolve(import.meta.dirname, "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const drawer = read("src", "AgentDrawer.tsx");
const css = read("src", "boring.css");

// ---- n7: perm-card stack (source + css) ----
test("n7 (idea-751): pending permission cards are wrapped in .boring-perm-stack inside .boring-convo-col", () => {
  assert.match(drawer, /\{permCards\?\.length \? <div className="boring-perm-stack">\{permCards\}<\/div> : null\}/);
  // Psycho keeps its cards above the shell, unwrapped.
  assert.match(drawer, /\{!boringChat && permCards\}/);
});

test("n7 (idea-751) CSS: the stack is capped and scrolls so 2-3 cards never crush the timeline", () => {
  assert.match(css, /\.boring-convo-col > \.boring-perm-stack \{ min-height: 0; max-height: 55%; overflow-y: auto; \}/);
  assert.match(css, /\.boring-convo-col > \.boring-now,[\s\S]*?\.boring-convo-col > \.boring-perm-stack \{ flex: none; \}/);
});

// ---- n8: strip suppression (DOM-level render) ----
const dir = mkdtempSync(join(tmpdir(), "vs-b14a-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const reactUrl = import.meta.resolve("react");

writeFileSync(
  join(dir, "boringBusts.mjs"),
  `import React from ${JSON.stringify(reactUrl)};\nexport const bustRoleForAgent = (a) => (a && a.labels && a.labels.role) || "worker"; export const bustUrl = (role) => "/ui/busts/" + role + ".png";\n`,
);
const code = transformSync("BoringWorkingNow.tsx", read("src", "BoringWorkingNow.tsx"), { lang: "tsx", jsx: { runtime: "classic" } }).code
  .replace(/import \{ openAgent \} from "\.\/panes";/, "const openAgent = () => {};")
  .replace(/import \{ isHubLaneId \} from "\.\/teams";/, "const isHubLaneId = () => false;")
  .replace(/import \{ agentDisplayName \} from "\.\/identity";/, "const agentDisplayName = (a) => a.title;")
  .replace(/from "\.\/boringBusts"/, 'from "./boringBusts.mjs"')
  .replace(/import \{ useTheme \} from "\.\/useBotFace";/, 'const useTheme = () => "dark";')
  .replace(/import \{ etClock \} from "\.\/etTime";/, 'const etClock = (d) => new Date(d).toISOString().slice(11, 16);')
  .replace(/^import type .*$/gm, "");
writeFileSync(join(dir, "BoringWorkingNow.mjs"), `import React from ${JSON.stringify(reactUrl)};\n` + code);
const { BoringWorkingNow } = await import(pathToFileURL(join(dir, "BoringWorkingNow.mjs")).href);

test("n8 (UX R17): a pending permission marks the strip data-has-perm (collapsed by CSS) while keeping data-state=needs-you", () => {
  const agent = { id: "a", title: "Audit", status: "idle", labels: { role: "worker" }, pendingPermissions: [{}] };
  const html = renderToStaticMarkup(React.createElement(BoringWorkingNow, { agent, members: [], subs: 2 }));
  assert.match(html, /data-testid="boring-working-now"/);
  assert.match(html, /data-state="needs-you"/); // L5 invariant preserved (raw pendingPermissions -> needs-you)
  assert.match(html, /data-has-perm="true"/); // n8: boring.css collapses this redundant strip
  assert.match(html, /Audit needs your OK/);
});

test("n8 (UX R17): non-permission needs-you states keep the strip (no data-has-perm)", () => {
  const q = renderToStaticMarkup(
    React.createElement(BoringWorkingNow, { agent: { id: "a", title: "Buddy", status: "idle", labels: { role: "brainstorm" } }, members: [], subs: 0, attention: { tone: "needs-you", reason: "pick" } }),
  );
  assert.match(q, /data-state="needs-you"/);
  assert.doesNotMatch(q, /data-has-perm/);

  const err = renderToStaticMarkup(
    React.createElement(BoringWorkingNow, { agent: { id: "a", title: "Buddy", status: "error", labels: { role: "brainstorm" } }, members: [], subs: 0 }),
  );
  assert.match(err, /hit an error/);
  assert.doesNotMatch(err, /data-has-perm/);

  const fin = renderToStaticMarkup(
    React.createElement(BoringWorkingNow, { agent: { id: "a", title: "Buddy", status: "idle", attentionReason: "finished", labels: { role: "brainstorm" } }, members: [], subs: 0 }),
  );
  assert.match(fin, /finished · waiting on you/);
  assert.doesNotMatch(fin, /data-has-perm/);
});

test("n8 (UX R17) CSS: the data-has-perm strip is collapsed", () => {
  assert.match(css, /\.boring-now\[data-has-perm\] \{ display: none; \}/);
});
