// EXP8 spike (throwaway proof, not the build): where can a pull-only first-prompt trim live?
//
// Gating question: can the before.agent.create hook (server/hooks/agent-duties.ts) rewrite the
// successor's FIRST prompt, or must the trim live in lead-handoff.mjs (right after
// buildSuccessorPrompt at :871)?
//
// Answer (see the last two tests): the hook CANNOT — runner-backend.mjs only feeds the hook's
// return value back into config/env/labels (runner-backend.mjs:751-756) and posts the ORIGINAL
// `initialPrompt || prompt` arg to /agents (runner-backend.mjs:792), ignoring any prompt the hook
// returns. The trim must live in lead-handoff.mjs (or its createAgent shim).
import assert from "node:assert/strict";
import test from "node:test";
import { buildSuccessorPrompt } from "../server/lead-handoff.mjs";
import { measureFirstPromptParts } from "../server/hooks/agent-duties.ts";
import { RunnerBackend } from "../server/backend/runner-backend.mjs";

// --- throwaway pullify: the EXP8 §3 pure-function design, inlined for the spike -------------
function pullifyHandoffPrompt(prompt, { packetHead = 1500, briefHead = 2000 } = {}) {
  let out = String(prompt ?? "");
  out = truncateBlock(out, "--- BEGIN HANDOFF PACKET", "--- END HANDOFF PACKET ---", packetHead);
  out = truncateBlock(out, "--- BEGIN BRAINSTORM SUMMARY", "--- END BRAINSTORM SUMMARY ---", briefHead);
  return out;
}

function truncateBlock(text, beginMarker, endMarker, head) {
  const b = text.indexOf(beginMarker);
  if (b < 0) return text;
  const bodyStart = text.indexOf("\n", b) + 1;
  const e = text.indexOf(endMarker, bodyStart);
  if (e < 0) return text;
  const body = text.slice(bodyStart, e);
  if (body.length <= head) return text;
  const kept = body.slice(0, head);
  const omitted = body.length - kept.length;
  const note = `[... ${omitted} chars omitted — read the packet/summary path above]`;
  return text.slice(0, bodyStart) + kept + "\n" + note + "\n" + text.slice(e);
}

// A realistic successor prompt, in the shape buildSuccessorPrompt emits (large packet + brief).
function makePrompt() {
  const packetBody = ("HEADER: successor handoff\n" + "Judgment: keep the build moving.\n" + "- open worker w1 running\n".repeat(120)).trim();
  const briefBody = ("# bug-chaser brainstorm\n" + "Current state: mid-flight on EXP8.\n" + "Decision log: ".repeat(400)).trim();
  return buildSuccessorPrompt({
    laneId: "bug-chaser",
    laneName: "Bug Chaser",
    nextOrd: 3,
    newTitle: "★ Bug3",
    oldLead: { id: "rn-old", title: "★ Bug2" },
    oldTitle: "★ Bug2 (old)",
    trigger: "auto-250",
    packetPath: "C:/x/packet.md",
    packetContent: packetBody,
    summaryPath: "C:/x/summary.md",
    summaryContent: briefBody,
    latestPlan: "docs/PLAN_X.md",
    openWorkers: [{ id: "rn-w1", title: "worker", status: "running" }],
    provider: "claude",
  });
}

test("pullify truncates packet + brief bodies but keeps markers, and the parts still partition", () => {
  const prompt = makePrompt();
  const before = measureFirstPromptParts(prompt);
  assert.ok(before.firstPacket > 1500, "fixture packet is large enough to truncate");
  assert.ok(before.firstBrief > 2000, "fixture brief is large enough to truncate");

  const trimmed = pullifyHandoffPrompt(prompt);
  const after = measureFirstPromptParts(trimmed);

  // Both markers survive (the agent can still pull the full bodies from the named paths).
  assert.ok(trimmed.includes("--- BEGIN HANDOFF PACKET"), "packet begin kept");
  assert.ok(trimmed.includes("--- END HANDOFF PACKET ---"), "packet end kept");
  assert.ok(trimmed.includes("--- BEGIN BRAINSTORM SUMMARY"), "brief begin kept");
  assert.ok(trimmed.includes("--- END BRAINSTORM SUMMARY ---"), "brief end kept");
  assert.match(trimmed, /chars omitted/, "an omitted-count line is left in each truncated block");

  // The truncated spans shrink and the four parts still partition the (shorter) prompt.
  assert.ok(after.firstPacket < before.firstPacket, "packet span shrank");
  assert.ok(after.firstBrief < before.firstBrief, "brief span shrank");
  assert.equal(after.firstPlan, before.firstPlan, "plan/framing is untouched");
  assert.equal(
    after.firstPacket + after.firstArtifact + after.firstBrief + after.firstPlan,
    trimmed.length,
    "parts still partition the trimmed prompt (measureFirstPromptParts integrity)",
  );
  assert.ok(trimmed.length < prompt.length, "overall prompt is shorter");
});

test("HOOK PATH (negative): the before.agent.create return value cannot rewrite the first prompt", async () => {
  const prompt = makePrompt();
  const trimmed = pullifyHandoffPrompt(prompt);
  assert.notEqual(trimmed, prompt, "sanity: trim changed the prompt");

  const posts = [];
  const backend = new RunnerBackend({
    client: {
      async requireRunning() {},
      async request(method, route, body) {
        if (method === "POST" && route === "/agents") { posts.push(body); return { id: "rn-x" }; }
        if (method === "GET" && route === "/agents/rn-x") return { id: "rn-x", provider: "claude", cwd: ".", status: "idle", meta: { title: "T" } };
        throw new Error(`unexpected ${method} ${route}`);
      },
    },
    buildPrefix: async () => "",
    whosHere: async () => {},
    lanes: () => new Set(),
    // Mimic the plugin's before(agent.create) return shape — INCLUDING an attempt to replace the
    // prompt at both the top level (`prompt`) and inside `config.prompt`, exactly what the spike's
    // "hook can rewrite request.prompt" hypothesis would need to work.
    hooks: {
      before: async (name, { request }) => {
        if (name !== "agent.create") return undefined;
        return { ...request, prompt: trimmed, config: { ...request.config, prompt: trimmed } };
      },
    },
  });

  await backend.createAgent({ config: { provider: "claude", cwd: "." }, prompt, labels: {}, env: {} });

  assert.equal(posts.length, 1, "one /agents POST");
  assert.equal(posts[0].prompt, prompt, "runner posts the ORIGINAL prompt — the hook's prompt rewrite is ignored");
  assert.notEqual(posts[0].prompt, trimmed, "the trimmed prompt never reached the spawn");
});

test("LEAD-HANDOFF PATH (positive): trimming the prompt arg before createAgent reaches the spawn", async () => {
  const prompt = makePrompt();
  const trimmed = pullifyHandoffPrompt(prompt);

  const posts = [];
  const backend = new RunnerBackend({
    client: {
      async requireRunning() {},
      async request(method, route, body) {
        if (method === "POST" && route === "/agents") { posts.push(body); return { id: "rn-x" }; }
        if (method === "GET" && route === "/agents/rn-x") return { id: "rn-x", provider: "claude", cwd: ".", status: "idle", meta: { title: "T" } };
        throw new Error(`unexpected ${method} ${route}`);
      },
    },
    buildPrefix: async () => "",
    whosHere: async () => {},
    lanes: () => new Set(),
    hooks: false,
  });

  // This is what the 3-line fallback does in lead-handoff.mjs (~:871): trim before the spawn.
  await backend.createAgent({ config: { provider: "claude", cwd: "." }, prompt: trimmed, labels: {}, env: {} });

  assert.equal(posts.length, 1, "one /agents POST");
  assert.equal(posts[0].prompt, trimmed, "the trimmed packet/brief arrives in the spawned agent's first prompt");
  assert.notEqual(posts[0].prompt, prompt, "the full body was not re-attached");
});
