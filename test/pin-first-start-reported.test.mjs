import "./setup/hermetic.mjs"; // hermetic env for a direct `node --test <file>` run (run-tests.mjs preloads this)
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = resolve(ROOT_DIR, "src");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("./") && context.parentURL?.startsWith(pathToFileURL(SRC_DIR).href)) {
      if (specifier === "./paseo" || specifier === "./PinGrid" || specifier === "./ui" || specifier === "./IdeaInbox") {
        return { url: `data:text/javascript,${encodeURIComponent(stubFor(specifier))}`, shortCircuit: true };
      }
      const parentDir = dirname(fileURLToPath(context.parentURL));
      const tsCandidate = resolve(parentDir, `${specifier}.ts`);
      if (fs.existsSync(tsCandidate)) {
        return nextResolve(pathToFileURL(tsCandidate).href, context);
      }
      const tsxCandidate = resolve(parentDir, `${specifier}.tsx`);
      if (fs.existsSync(tsxCandidate)) {
        return { url: `data:text/javascript,${encodeURIComponent(stubFor(specifier))}`, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

function stubFor(specifier) {
  if (specifier === "./paseo") {
    return [
      "export const DEMO = false;",
      "export const getPaseoState = () => ({ conn: 'connected', agents: new Map() });",
      "export const subscribePaseo = () => () => {};",
      "export const archiveAgent = async () => {};",
      "export const archiveWorkspace = async () => {};",
      "export const detachAgent = async () => {};",
      "export const retireAgent = async () => {};",
      "export const sendMessage = async () => {};",
      "export const updateAgent = async () => {};",
      "export const upsertLocalAgent = () => {};",
    ].join("\n");
  }
  if (specifier === "./IdeaInbox") {
    return `export const parkIdeasInInbox = async () => {};`;
  }
  return `export {};`;
}


// idea-816: `vs pin new` starts nothing (the first click does); a refused/capped start on a real start path is reported.
const pinActionsMod = await import("../src/pinActions.ts");

const teams = [{ id: "team-9", name: "Team Nine", paths: [], lanes: [{ id: "ledger", name: "Ledger", code: "Led", state: "pinned" }] }];
const pin = { squad: teams[0], lane: teams[0].lanes[0], state: "pinned", order: 0, brainstorm: null, lead: null, workers: [], needsYou: 0, running: 0, contextUsed: 0, topicBrainstorms: [] };
const refusing = (calls) => async (url, init) => {
  calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
  if (url === "/__vibesquad/brainstorm-restart") return { ok: false, status: 429, json: async () => ({ ok: false, error: "buddy cap reached" }) };
  return { ok: true, status: 200, json: async () => ({}) };
};

test("pin new (CLI) starts nothing and says the first click starts it", () => {
  const src = fs.readFileSync(resolve(ROOT_DIR, "cli/vs.mjs"), "utf8");
  assert.match(src, /No agent started; the first click on the pin starts its Brainstorm/);
  assert.doesNotMatch(src, /startPinnedLaneBuddy/);
});

test.beforeEach(() => pinActionsMod.resetPinStartFailLog());

test("first-click start refused in a non-default team: openPin rejects AND logs a blocker for that team/lane", async () => {
  const calls = [];
  await assert.rejects(pinActionsMod.openPin(pin, { fetch: refusing(calls), logFetch: refusing(calls), agents: new Map() }), /buddy cap reached/);
  const start = calls.find((c) => c.url === "/__vibesquad/brainstorm-restart");
  await new Promise((r) => setTimeout(r, 10)); // the log post is best-effort, not awaited
  assert.equal(start.body.teamId, "team-9");
  assert.equal(start.body.laneId, "ledger");
  const log = calls.find((c) => c.url === "/__vibesquad/vs-log");
  assert.ok(log, "a vs-log event was posted");
  assert.equal(log.body.type, "blocker");
  assert.equal(log.body.team, "team-9");
  assert.match(log.body.text, /ledger.*did NOT start.*buddy cap reached/);
});

test("spin-off start failure is surfaced via onBuddyStartFailed and logged", async () => {
  const calls = [];
  const failed = [];
  const orig = console.error;
  console.error = () => {};
  try {
    const res = await pinActionsMod.createSpinOffPins("k816", "team-9", [{ name: "Payroll", brief: "pay" }], {
      logFetch: async (url) => (calls.push(url), { ok: true, status: 200, json: async () => ({}) }),
      fetch: async (url, init) => {
        if (url === "/__vibesquad/vs-log") return { ok: true };
        calls.push(url);
        if (url === "/__vibesquad/brainstorm-restart") return { ok: false, status: 429, json: async () => ({ ok: false, error: "buddy cap reached" }) };
        return { ok: true, status: 200, json: async () => ({ ok: true, revision: "r1" }) };
      },
      getTeams: () => [{ id: "team-9", name: "Team Nine", paths: [], lanes: [] }],
      saveTeams: async () => {},
      agents: new Map(),
      onBuddyStartFailed: (p, err) => failed.push([p.lane.id, String(err.message ?? err)]),
    });
    assert.ok(res?.[0]?.pin, "the pin itself landed: " + JSON.stringify(res));
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    console.error = orig;
  }
  assert.deepEqual(failed, [["payroll", "buddy cap reached"]]);
  assert.ok(calls.includes("/__vibesquad/vs-log"));
});

const logsOf = (calls) => calls.filter((c) => c.url === "/__vibesquad/vs-log");
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test("repeated clicks after a fast refusal post ONE blocker per lane+reason (60 s cooldown), a new reason posts again", async () => {
  const calls = [];
  const deps = () => ({ fetch: refusing(calls), logFetch: refusing(calls), agents: new Map() });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(pinActionsMod.openPin(pin, deps()), /buddy cap reached/);
    await tick();
  }
  assert.equal(calls.filter((c) => c.url === "/__vibesquad/brainstorm-restart").length, 3, "each click really retried the start");
  assert.equal(logsOf(calls).length, 1, "one blocker, not three");
  const other = [];
  await assert.rejects(
    pinActionsMod.openPin(pin, { fetch: async () => ({ ok: false, status: 503, json: async () => ({ error: "runner down" }) }), logFetch: refusing(other), agents: new Map() }),
    /runner down/,
  );
  await tick();
  assert.equal(logsOf(other).length, 1, "a different reason is not suppressed");
});

test("a re-click while the start is in flight shares one spawn and logs once", async () => {
  const calls = [];
  let release;
  const fetch = (url, init) => (calls.push({ url }), new Promise((res) => (release = () => res({ ok: false, status: 429, json: async () => ({ error: "buddy cap reached" }) }))));
  const a = pinActionsMod.openPin(pin, { fetch, logFetch: refusing(calls), agents: new Map() });
  const b = pinActionsMod.openPin(pin, { fetch, logFetch: refusing(calls), agents: new Map() });
  assert.equal(a, b);
  await tick(0);
  release();
  await assert.rejects(a, /buddy cap reached/);
  await tick();
  assert.equal(calls.filter((c) => c.url === "/__vibesquad/brainstorm-restart").length, 1);
  assert.equal(logsOf(calls).length, 1);
});

test("a throwing logFetch never reaches the openPin caller (the original refusal does)", async () => {
  const boom = async () => { throw new Error("log endpoint down"); };
  await assert.rejects(pinActionsMod.openPin(pin, { fetch: refusing([]), logFetch: boom, agents: new Map() }), /buddy cap reached/);
  await tick();
});
