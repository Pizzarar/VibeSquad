import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlugin, parseAgentMessageEnvelope, retiredHolderRole } from "../server/hooks/agent-duties.ts";

const CWD = "/projects/VibeSquad";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function withEnv(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-misroute-test-"));
    const vsHome = join(dir, ".vibesquad");
    mkdirSync(vsHome, { recursive: true });
    const teamsFile = join(vsHome, "teams.json");
    writeFileSync(
      teamsFile,
      JSON.stringify({
        teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "vibesquad", name: "VibeSquad", paths: ["VibeSquad"] }], paths: ["VibeSquad"] }],
      }),
      "utf8",
    );
    const profilesFile = join(vsHome, "profiles.json");
    writeFileSync(profilesFile, JSON.stringify({ profiles: [] }), "utf8");
    const prev = {
      VIBESQUAD_HOME: process.env.VIBESQUAD_HOME,
      VIBESQUAD_TEAMS_FILE: process.env.VIBESQUAD_TEAMS_FILE,
      VIBESQUAD_PROFILES_PATH: process.env.VIBESQUAD_PROFILES_PATH,
    };
    process.env.VIBESQUAD_HOME = vsHome;
    process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
    process.env.VIBESQUAD_PROFILES_PATH = profilesFile;
    try {
      await fn({ vsHome });
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function readMetrics(vsHome) {
  const file = join(vsHome, "teams", "vibesquad", "log.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "metric")
    .map((e) => e.text);
}

test("parseAgentMessageEnvelope extracts sender, title, messageId and body only for agent-message envelopes", () => {
  const env = `<paseo-system version="1" kind="agent-message" source-agent-id="32baf0c7" message-id="m1" source-agent-title="RiffBot">\nHello &amp; welcome\n</paseo-system>`;
  assert.deepEqual(parseAgentMessageEnvelope(env), {
    senderId: "32baf0c7",
    senderTitle: "RiffBot",
    messageId: "m1",
    body: "Hello & welcome",
  });
  assert.equal(parseAgentMessageEnvelope("Plain user prompt with no envelope"), null);
  assert.equal(retiredHolderRole({ labels: { role: "former-brainstorm" } }), "brainstorm");
  assert.equal(retiredHolderRole({ labels: { role: "former-lead" } }), "lead");
});

test(
  "agent.turn_started on a retired Buddy redirects agent-message to the live Buddy, notifies sender, and dedupes repeat turns",
  withEnv(async ({ vsHome }) => {
    const oldBuddy = {
      id: "a38b803b",
      title: "(old) RiffBot",
      cwd: CWD,
      status: "idle",
      labels: { team: "vibesquad", lane: "vibesquad", role: "former-brainstorm" },
    };
    const liveBuddy = {
      id: "32baf0c7",
      title: "RiffBot",
      cwd: CWD,
      status: "idle",
      updatedAt: new Date().toISOString(),
      labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm" },
    };
    const senderLead = {
      id: "b6e18e7d",
      title: "★ Hub9",
      cwd: CWD,
      status: "idle",
      labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "9" },
    };
    const agents = new Map([
      [oldBuddy.id, oldBuddy],
      [liveBuddy.id, liveBuddy],
      [senderLead.id, senderLead],
    ]);
    const sent = [];
    const on = new Map();
    const server = {
      before: () => () => {},
      on(name, fn) {
        on.set(name, fn);
        return () => on.delete(name);
      },
    };
    const stop = createPlugin({
      startWatcher: false,
      setLabels: async () => {},
      archiveAgent: async () => {},
    })(server);

    const timelineByAgent = new Map([
      [
        oldBuddy.id,
        [
          {
            item: {
              type: "user_message",
              messageId: "msg-101",
              text: `<paseo-system version="1" kind="agent-message" source-agent-id="b6e18e7d" message-id="msg-101" source-agent-title="★ Hub9">\nStatus update for RiffBot\n</paseo-system>`,
            },
          },
        ],
      ],
    ]);

    const paseo = {
      agents: {
        ref(id) {
          return {
            async refresh() {
              const a = agents.get(id);
              return a ? { agent: a } : null;
            },
            async send(text) {
              sent.push({ to: id, text });
            },
            timeline: {
              async refetch() {
                return { entries: timelineByAgent.get(id) ?? [] };
              },
            },
          };
        },
        async list() {
          return { entries: [...agents.values()].map((agent) => ({ agent })) };
        },
      },
    };

    try {
      await on.get("agent.turn_started")({ agent: oldBuddy }, { paseo });
      // Repeat turn_started with same messageId must not forward a second time
      await on.get("agent.turn_started")({ agent: oldBuddy }, { paseo });
      await wait(40);

      assert.equal(sent.length, 2);
      assert.equal(sent[0].to, "32baf0c7");
      assert.match(sent[0].text, /Status update for RiffBot/);
      assert.equal(sent[1].to, "b6e18e7d");
      assert.equal(sent[1].text, "(old) RiffBot is retired; delivered to RiffBot");

      const m = readMetrics(vsHome);
      assert.equal(m.filter((t) => t.startsWith("misroute-old:")).length, 1);

      // Routine turn_ended relay on a former lead logs relay-old, never misroute-old
      const oldLead = {
        id: "old-lead-1",
        title: "(old) Hub8",
        cwd: CWD,
        status: "idle",
        labels: { team: "vibesquad", lane: "vibesquad", role: "former-lead", ord: "8" },
      };
      agents.set(oldLead.id, oldLead);
      await on.get("agent.turn_ended")({ agent: oldLead, turnId: "t1", outcome: { kind: "completed" } }, { paseo });

      const mAfter = readMetrics(vsHome);
      assert.equal(mAfter.filter((t) => t.startsWith("misroute-old:")).length, 1, "relay must not increment misroute-old");
      assert.equal(mAfter.filter((t) => t.startsWith("relay-old:")).length, 1, "relay logs relay-old");
    } finally {
      stop?.();
    }
  }),
);
