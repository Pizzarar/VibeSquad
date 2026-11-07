import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { checkRemoteBody } from "../server/hooks/remote-proxy-rules.ts";
import { runMarkComplete } from "../src/pinComplete.ts";

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

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

const pinActionsMod = await import("../src/pinActions.ts");

function makePin(laneId = "uip-polish") {
  const squad = { id: "vibesquad", name: "VibeSquad", color: "#00f0ff", lanes: [{ id: laneId, name: "UIP Polish", state: "pinned" }], paths: [] };
  return {
    squad,
    lane: squad.lanes[0],
    state: "pinned",
    order: 0,
    brainstorm: { agent: { id: "bs-1", status: "idle", labels: { profile: "Brainstorm - Claude" } } },
    lead: { agent: { id: "lead-1", status: "idle", labels: {} } },
    workers: [],
    needsYou: 0,
    running: 0,
    contextUsed: 0,
    topicBrainstorms: [],
  };
}

test("runMarkComplete still saves state: 'done' when readBrief or writeBrief or retire rejects", async () => {
  const now = () => new Date(2026, 10, 5, 12);

  // Case 1: readBrief rejects (e.g. network error) and retire rejects (e.g. ghost agent)
  let teams1 = [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "uip-polish", name: "UIP Polish", state: "pinned" }], paths: [] }];
  const pin1 = makePin("uip-polish");
  const res1 = await runMarkComplete(pin1, {
    now,
    readBrief: async () => {
      throw new Error("Brief read failed (500)");
    },
    writeBrief: async () => {},
    retire: async () => {
      throw new Error("Agent already archived");
    },
    archive: async () => {
      throw new Error("Archive failed");
    },
    saveTeams: async (update) => {
      teams1 = update(teams1);
    },
  });
  assert.deepEqual(res1, { ok: true });
  assert.equal(teams1[0].lanes[0].state, "done");
  assert.equal(teams1[0].lanes[0].doneAt, now().toISOString());
  assert.equal(teams1[0].lanes[0].lastProfile, "Brainstorm - Claude");

  // Case 2: writeBrief rejects (e.g. 400 oversize brief)
  let teams2 = [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "uip-polish", name: "UIP Polish", state: "pinned" }], paths: [] }];
  const pin2 = makePin("uip-polish");
  const res2 = await runMarkComplete(pin2, {
    now,
    readBrief: async () => "# Brief\n",
    writeBrief: async () => {
      throw new Error("Brief save failed (400)");
    },
    retire: async () => {},
    archive: async () => {},
    saveTeams: async (update) => {
      teams2 = update(teams2);
    },
  });
  assert.deepEqual(res2, { ok: true });
  assert.equal(teams2[0].lanes[0].state, "done");
});

test("capBriefForSave trims >20,000-char brief below 19,500 chars while preserving header and trailing Done stamp", () => {
  const short = "# Brainstorm Summary · UIP\n\nDone 2026-11-05\n";
  assert.equal(pinActionsMod.capBriefForSave(short), short);

  const header = "# Brainstorm Summary · UIP (`uip`)\n\n## Decided\n";
  const middle = "- item\n".repeat(3500);
  const tail = "\nDone 2026-11-05\n";
  const huge = header + middle + tail;
  assert.ok(huge.length > 20_000);

  const trimmed = pinActionsMod.capBriefForSave(huge);
  assert.ok(trimmed.length <= 19_500, `Expected <= 19500, got ${trimmed.length}`);
  assert.ok(trimmed.startsWith(header), "preserves header at the start");
  assert.ok(trimmed.endsWith(tail), "preserves trailing Done <date> stamp");
  assert.ok(trimmed.includes("\n\n… [trimmed for length] …\n\n"), "includes trim marker");
});

test("markPinComplete forwards revision from readBrief to writeBrief and trims oversize briefs", async () => {
  const header = "# Brainstorm Summary · UIP (`uip-rev`)\n\n## Decided\n";
  const oversizeBrief = header + "x".repeat(22_000) + "\n";
  const requests = [];
  let teams = [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "uip-rev", name: "UIP Rev", state: "pinned" }], paths: [] }];
  const pin = makePin("uip-rev");

  const res = await pinActionsMod.markPinComplete(pin, {
    retire: async () => {},
    archive: async () => {},
    saveTeams: async (update) => {
      teams = update(teams);
    },
    fetch: async (url, init) => {
      requests.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
      if (!init?.method || init.method === "GET") {
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true, content: oversizeBrief, revision: "rev-abc-123" };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, revision: "rev-abc-456" };
        },
      };
    },
  });

  assert.deepEqual(res, { ok: true });
  assert.equal(teams[0].lanes[0].state, "done");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[1].method, "POST");
  assert.equal(requests[1].url, "/__vibesquad/brainstorm-summary");
  assert.equal(requests[1].body.laneId, "uip-rev");
  assert.equal(requests[1].body.revision, "rev-abc-123");
  assert.ok(requests[1].body.content.length <= 19_500);
  assert.match(requests[1].body.content, /Done \d{4}-\d{2}-\d{2}\n$/);

  const remoteCheck = checkRemoteBody("POST", "/__vibesquad/brainstorm-summary", JSON.stringify(requests[1].body));
  assert.equal(remoteCheck.ok, true);
});
