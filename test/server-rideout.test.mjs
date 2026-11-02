import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("logServerStart appends a metric server-start line with pid, version and reason", async () => {
  const home = mkdtempSync(join(tmpdir(), "vs-start-"));
  process.env.VIBESQUAD_HOME = home;
  const { logServerStart } = await import("../server/server-start.mjs");
  const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const r = logServerStart({ rootDir: root, env: { VIBESQUAD_START_REASON: "merge", VIBESQUAD_TEAM: "vibesquad" }, pid: 4242 });
  assert.ok(r, "returned an entry");
  const line = JSON.parse(readFileSync(join(home, "teams", "vibesquad", "log.jsonl"), "utf8").trim().split("\n").pop());
  assert.equal(line.type, "metric");
  assert.equal(line.agent, "server");
  assert.match(line.text, /^server-start: pid=4242 version=\d+\.\d+\.\d+\S* reason=merge$/);
  assert.ok(readdirSync(join(home, "logs")).length > 0);
});

test("logServerStart never throws", async () => {
  const { logServerStart } = await import("../server/server-start.mjs");
  assert.doesNotThrow(() => logServerStart({ rootDir: "/nonexistent", env: { VIBESQUAD_HOME: "\0bad" } }));
});

test("serve.mjs logs server-start once the listener is up", () => {
  const s = src("server/serve.mjs");
  assert.match(s, /import \{ logServerStart \} from "\.\/server-start\.mjs"/);
  assert.match(s, /serving \$\{distDir\} on \$\{url\}`\);\n\s+logServerStart\(\{ rootDir \}\);/);
});

test("Squads Home is carried in the URL (?view=squads) so a reconnect restores it", async () => {
  assert.match(src("src/pinFocus.ts"), /startOnSquadsHome[\s\S]*get\("view"\) === "squads"/);
  assert.match(src("src/CommandPalette.tsx"), /p\.set\("view", "squads"\)/);
  assert.match(src("src/App.tsx"), /squadsHome: pinLayout && pinsHome && squadsHome/);
});

test("lead role pack tells leads to restart the server only when needed and log it", () => {
  assert.match(src("plugin/index.server.ts"), /Restart the VibeSquad server only when a merged change needs it, and log it/);
});

test("useDraft persists composer drafts per agent in localStorage", () => {
  const s = src("src/drafts.ts");
  assert.match(s, /localStorage/);
  assert.match(s, /export function useDraft/);
});

test("popstate applies Squads Home both ways and the saved pin never beats ?view=squads", () => {
  const app = src("src/App.tsx");
  assert.match(app, /act === "squads-home"\) enterSquadsHome\(\);\s+else exitSquadsHome\(\)/);
  assert.match(src("src/pinFocus.ts"), /state\.home && state\.squadsHome\) return;[^\n]*\n\s+const saved = loadSavedFocus/);
});

test("popAction: Back from a chat returns to the squad page; view=squads goes to Squads Home", async () => {
  const { popAction } = await import("../src/pinFocusLogic.ts");
  assert.equal(popAction("?team=x&agent=abc"), "agent");
  assert.equal(popAction("?team=x"), "squad-page");
  assert.equal(popAction(""), "squad-page");
  assert.equal(popAction("?view=squads"), "squads-home");
  assert.equal(popAction("?team=x&view=squads"), "squads-home");
  assert.match(src("src/App.tsx"), /const act = popAction\(location\.search\)/);
});
